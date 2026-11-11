// Ponte sicuro tra la pagina e l'app: la pagina non tocca mai Node direttamente.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const chunkListeners = new Map();
ipcRenderer.on("llm:chunk", (_e, id, text) => { const f = chunkListeners.get(id); if (f) f(text); });

const dbListeners = new Set();
ipcRenderer.on("db:changed", (_e, collection) => { for (const f of dbListeners) try { f(collection); } catch {} });

const settingsListeners = new Set();
ipcRenderer.on("settings:changed", () => { for (const f of settingsListeners) try { f(); } catch {} });

contextBridge.exposeInMainWorld("agenziaHost", {
  chat(req, onText) {
    chunkListeners.set(req.id, onText);
    return ipcRenderer.invoke("llm:chat", req).finally(() => chunkListeners.delete(req.id));
  },
  abort: id => ipcRenderer.invoke("llm:abort", id),
  db: {
    get: (c, id) => ipcRenderer.invoke("db:get", c, id),
    set: (c, id, data) => ipcRenderer.invoke("db:set", c, id, data),
    delete: (c, id) => ipcRenderer.invoke("db:delete", c, id),
    list: c => ipcRenderer.invoke("db:list", c),
    onChange(f) { dbListeners.add(f); return () => dbListeners.delete(f); },
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: s => ipcRenderer.invoke("settings:save", s),
    test: s => ipcRenderer.invoke("settings:test", s),
    open: () => ipcRenderer.invoke("settings:open"),
    onChange(f) { settingsListeners.add(f); return () => settingsListeners.delete(f); },
  },
});
