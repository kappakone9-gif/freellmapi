// Controlli veloci, senza aprire l'app: il sostituto di window.claude e
// la preparazione della pagina.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shimSrc = readFileSync(join(root, "app", "claude-shim.js"), "utf8");

function loadShim(replies) {
  const store = {}, listeners = new Set(), calls = [];
  const host = {
    async chat(req, onText) {
      calls.push(req);
      const r = replies.shift();
      if (r.ok) onText(r.text);
      return r;
    },
    abort: async () => true,
    db: {
      get: async (c, id) => (store[c] && store[c][id] !== undefined ? structuredClone(store[c][id]) : null),
      set: async (c, id, d) => { (store[c] ||= {})[id] = structuredClone(d); for (const f of listeners) f(c); },
      delete: async (c, id) => { if (store[c]) delete store[c][id]; for (const f of listeners) f(c); },
      list: async c => Object.entries(store[c] || {}).map(([id, data]) => ({ id, data: structuredClone(data) })),
      onChange: f => { listeners.add(f); return () => listeners.delete(f); },
    },
    settings: { open: async () => true },
  };
  const window = { agenziaHost: host };
  const document = { addEventListener() {} };
  vm.runInNewContext(shimSrc, { window, document, FileReader: class {}, structuredClone, console, setTimeout, Promise, JSON, Object, Error, String, Array, Date });
  return { claude: window.claude, calls };
}

test("sample: testo in streaming, modello veloce, messaggi uniti", async () => {
  const { claude, calls } = loadShim([{ ok: true, text: "ciao", truncated: false }]);
  const sample = await claude.use("sample");
  const seen = [];
  const r = await sample([{ role: "user", content: "a" }, { role: "user", content: "b" }], { modelTier: "quick", onText: u => seen.push(u.text) });
  assert.equal(r.text, "ciao");
  assert.deepEqual(seen, ["ciao"]);
  assert.equal(calls[0].quick, true);
  assert.equal(calls[0].messages.length, 1);
  assert.equal(calls[0].messages[0].content, "a\n\nb");
});

test("sample: un errore porta il suo codice", async () => {
  const { claude } = loadShim([{ ok: false, code: "rate_limited", text: "" }]);
  const sample = await claude.use("sample");
  await assert.rejects(sample("x"), e => e.code === "rate_limited");
});

test("sample.json: legge il JSON anche dentro un blocco di codice", async () => {
  const { claude } = loadShim([{ ok: true, text: 'Ecco:\n```json\n{"passi":[1]}\n```' }, { ok: true, text: "niente json" }]);
  const sample = await claude.use("sample");
  assert.deepEqual(await sample.json("p"), { passi: [1] });
  await assert.rejects(sample.json("p"), e => e.code === "invalid_json");
});

test("db: documenti, ordinamento, limite e aggiornamenti in diretta", async () => {
  const { claude } = loadShim([]);
  const db = await claude.use("db");
  await db.doc("contesto/principale").set({ testo: "turni" });
  assert.equal((await db.doc("contesto/principale").get()).data().testo, "turni");
  assert.equal((await db.doc("sogni/ultimo").get()).exists, false);
  for (const n of [1, 3, 2]) await db.collection("lavori").doc("l" + n).set({ creato: n });
  const q = await db.collection("lavori").orderBy("creato", "desc").limit(2).get();
  assert.deepEqual(q.docs.map(d => d.id), ["l3", "l2"]);
  const snaps = [];
  const off = db.collection("lavori").orderBy("creato", "desc").onSnapshot(s => snaps.push(s.docs.length));
  await new Promise(r => setTimeout(r, 10));
  await db.collection("lavori").doc("l1").delete();
  await new Promise(r => setTimeout(r, 10));
  off();
  assert.deepEqual(snaps, [3, 2]);
});

test("la pagina si prepara e carica il sostituto prima del suo script", () => {
  const orig = join(root, "scripts", "agenzia-originale.html");
  if (!existsSync(orig)) return;
  execFileSync(process.execPath, [join(root, "scripts", "importa-artifact.mjs")]);
  const html = readFileSync(join(root, "app", "index.html"), "utf8");
  const shimAt = html.indexOf('<script src="claude-shim.js">');
  assert.ok(shimAt > 0 && shimAt < html.indexOf('"use strict";'));
  assert.ok(html.includes("offline:"));
});
