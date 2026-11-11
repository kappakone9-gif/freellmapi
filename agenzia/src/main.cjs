// Agenzia — app desktop. Apre la pagina dell'Agenzia in una finestra sua e fa
// da "Claude" per lei: le richieste agli agenti vanno a un'API compatibile
// OpenAI (di default FreeLLMAPI su questo computer), l'archivio sta in un file
// JSON nella cartella dati dell'app.
"use strict";
const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const APP_DIR = path.join(__dirname, "..", "app");
const DEFAULTS = {
  baseUrl: "http://127.0.0.1:31415/v1",
  apiKey: "",
  model: "auto",
  quickModel: "",
};

app.setName("Agenzia");
// Per i test: una cartella dati separata, così non si tocca l'archivio vero.
if (process.env.AGENZIA_DATA_DIR) app.setPath("userData", path.resolve(process.env.AGENZIA_DATA_DIR));
const dataDir = () => app.getPath("userData");
const settingsFile = () => path.join(dataDir(), "impostazioni.json");
const dbFile = () => path.join(dataDir(), "archivio.json");

/* ---------- file JSON scritti in modo sicuro ---------- */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/* ---------- impostazioni ---------- */
function getSettings() { return { ...DEFAULTS, ...readJson(settingsFile(), {}) }; }
function saveSettings(s) {
  const clean = {
    baseUrl: String(s.baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, ""),
    apiKey: String(s.apiKey || "").trim(),
    model: String(s.model || DEFAULTS.model).trim(),
    quickModel: String(s.quickModel || "").trim(),
  };
  writeJson(settingsFile(), clean);
  return clean;
}

/* ---------- archivio (collezioni di documenti) ---------- */
let db = null;
let dbTimer = null;
function loadDb() { if (!db) db = readJson(dbFile(), { collezioni: {} }); if (!db.collezioni) db.collezioni = {}; return db; }
function flushDb() { clearTimeout(dbTimer); dbTimer = null; if (db) writeJson(dbFile(), db); }
function scheduleFlush() { clearTimeout(dbTimer); dbTimer = setTimeout(flushDb, 250); }
function col(name) { const d = loadDb(); return (d.collezioni[name] ||= {}); }

ipcMain.handle("db:get", (_e, c, id) => {
  const v = col(c)[id];
  return v === undefined ? null : v;
});
ipcMain.handle("db:set", (_e, c, id, data) => {
  col(c)[id] = data; scheduleFlush();
  broadcast("db:changed", c);
  return true;
});
ipcMain.handle("db:delete", (_e, c, id) => {
  delete col(c)[id]; scheduleFlush();
  broadcast("db:changed", c);
  return true;
});
ipcMain.handle("db:list", (_e, c) => Object.entries(col(c)).map(([id, data]) => ({ id, data })));

function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

/* ---------- modello linguistico (API compatibile OpenAI) ---------- */
const running = new Map();

class LlmError extends Error {
  constructor(code, message, text) { super(message || code); this.code = code; this.text = text || ""; }
}

function codeForStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 413) return "prompt_too_large";
  if (status === 404) return "not_found";
  return "http";
}

async function chat(event, req) {
  const s = getSettings();
  const ctl = new AbortController();
  running.set(req.id, ctl);
  let text = "";
  try {
    const model = req.quick && s.quickModel ? s.quickModel : s.model || "auto";
    const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
    if (s.apiKey) headers.Authorization = "Bearer " + s.apiKey;
    let res;
    try {
      res = await fetch(s.baseUrl + "/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: req.messages, stream: true, max_tokens: req.maxTokens || 4096 }),
        signal: ctl.signal,
      });
    } catch (e) {
      if (ctl.signal.aborted) throw new LlmError("cancelled");
      throw new LlmError("offline", "Non riesco a raggiungere " + s.baseUrl);
    }
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || j.message || ""; } catch {}
      throw new LlmError(codeForStatus(res.status), String(detail || "HTTP " + res.status).slice(0, 300));
    }
    const ctype = res.headers.get("content-type") || "";
    let finish = null;
    if (!ctype.includes("event-stream")) {
      const j = await res.json();
      const ch = j.choices && j.choices[0];
      text = (ch && ch.message && ch.message.content) || "";
      finish = ch && ch.finish_reason;
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch (e) { if (ctl.signal.aborted) throw new LlmError("cancelled", "", text); throw new LlmError("offline", "Collegamento interrotto", text); }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new LlmError("http", String(j.error.message || j.error).slice(0, 300), text);
          const ch = j.choices && j.choices[0];
          if (!ch) continue;
          const piece = ch.delta && typeof ch.delta.content === "string" ? ch.delta.content : "";
          if (piece) { text += piece; if (!event.sender.isDestroyed()) event.sender.send("llm:chunk", req.id, text); }
          if (ch.finish_reason) finish = ch.finish_reason;
        }
      }
    }
    if (!text.trim()) throw new LlmError("empty_completion");
    return { ok: true, text, truncated: finish === "length" };
  } catch (e) {
    if (ctl.signal.aborted) return { ok: false, code: "cancelled", text };
    return { ok: false, code: e.code || "http", message: e.message || "", text: e.text || text };
  } finally {
    running.delete(req.id);
  }
}

ipcMain.handle("llm:chat", (e, req) => chat(e, req));
ipcMain.handle("llm:abort", (_e, id) => { const c = running.get(id); if (c) c.abort(); return true; });

async function testConnection(s) {
  const headers = {};
  if (s.apiKey) headers.Authorization = "Bearer " + s.apiKey;
  try {
    const res = await fetch(String(s.baseUrl).replace(/\/+$/, "") + "/models", { headers, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return { ok: false, msg: "La chiave API non è giusta." };
    if (!res.ok) return { ok: false, msg: "Il server risponde con errore " + res.status + "." };
    let n = 0; try { const j = await res.json(); n = Array.isArray(j.data) ? j.data.length : 0; } catch {}
    return { ok: true, msg: n ? `Collegato. Modelli disponibili: ${n}.` : "Collegato." };
  } catch {
    return { ok: false, msg: "Non riesco a raggiungere il server. FreeLLMAPI è acceso?" };
  }
}

ipcMain.handle("settings:get", () => getSettings());
ipcMain.handle("settings:save", (_e, s) => { const out = saveSettings(s); broadcast("settings:changed"); return out; });
ipcMain.handle("settings:test", (_e, s) => testConnection({ ...getSettings(), ...s }));
ipcMain.handle("settings:open", () => { openSettings(); return true; });

/* ---------- finestre ---------- */
let mainWin = null;
let settingsWin = null;

const webPrefs = () => ({
  preload: path.join(__dirname, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
});

function lockNavigation(win) {
  // I link esterni si aprono nel browser, la finestra resta sull'Agenzia.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (ev, url) => { if (!url.startsWith("file:")) { ev.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
}

function createMain() {
  mainWin = new BrowserWindow({
    width: 1320, height: 900, minWidth: 380, minHeight: 500,
    title: "Agenzia", backgroundColor: "#0d111e", show: false,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: webPrefs(),
  });
  lockNavigation(mainWin);
  mainWin.once("ready-to-show", () => mainWin.show());
  mainWin.loadFile(path.join(APP_DIR, "index.html"));
  mainWin.on("closed", () => { mainWin = null; });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 560, height: 720, minWidth: 360, parent: mainWin || undefined,
    title: "Impostazioni — Agenzia", autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: webPrefs(),
  });
  lockNavigation(settingsWin);
  settingsWin.loadFile(path.join(APP_DIR, "impostazioni.html"));
  settingsWin.on("closed", () => { settingsWin = null; });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Agenzia",
      submenu: [
        { label: "Impostazioni…", accelerator: "CmdOrCtrl+,", click: openSettings },
        { label: "Apri la cartella dei dati", click: () => shell.openPath(dataDir()) },
        {
          label: "Esporta archivio…",
          click: async () => {
            flushDb();
            const r = await dialog.showSaveDialog(mainWin, { defaultPath: "agenzia-archivio.json", filters: [{ name: "JSON", extensions: ["json"] }] });
            if (!r.canceled && r.filePath) fs.copyFileSync(dbFile(), r.filePath);
          },
        },
        { type: "separator" },
        isMac ? { role: "close", label: "Chiudi finestra" } : { role: "quit", label: "Esci" },
      ],
    },
    { label: "Modifica", submenu: [{ role: "undo", label: "Annulla" }, { role: "redo", label: "Ripeti" }, { type: "separator" }, { role: "cut", label: "Taglia" }, { role: "copy", label: "Copia" }, { role: "paste", label: "Incolla" }, { role: "selectAll", label: "Seleziona tutto" }] },
    { label: "Vista", submenu: [{ role: "reload", label: "Ricarica" }, { role: "togglefullscreen", label: "Schermo intero" }, { type: "separator" }, { role: "zoomIn", label: "Ingrandisci" }, { role: "zoomOut", label: "Rimpicciolisci" }, { role: "resetZoom", label: "Dimensione normale" }, { type: "separator" }, { role: "toggleDevTools", label: "Strumenti sviluppatore" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });
  app.whenReady().then(() => {
    buildMenu();
    createMain();
    // Primo avvio: apre subito le impostazioni per collegare il "cervello".
    if (!fs.existsSync(settingsFile())) setTimeout(openSettings, 800);
    app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createMain(); });
  });
  app.on("before-quit", flushDb);
  app.on("window-all-closed", () => { flushDb(); if (process.platform !== "darwin") app.quit(); });
}
