// Sostituto di window.claude per l'app desktop.
// La pagina dell'Agenzia chiede a window.claude.use(...) le capacità "sample"
// (far pensare gli agenti), "db" (archivio), "tts" (voce) e "user".
// Qui le stesse funzioni sono fatte con l'app: il modello passa da un'API
// compatibile OpenAI (FreeLLMAPI di default) e l'archivio è un file sul PC.
(function () {
  "use strict";
  const host = window.agenziaHost;
  if (!host) return; // aperta fuori dall'app: la pagina si comporta come sempre

  const MAX_IMAGES = 4;
  let seq = 0;
  const err = (code, extra) => Object.assign(new Error(code), { code }, extra || {});

  /* ---------------- sample ---------------- */
  const fileToDataUrl = f => new Promise((res, rej) => {
    if (typeof f === "string") return res(f);
    if (f && typeof f.data === "string") return res(f.data.startsWith("data:") ? f.data : `data:${f.mediaType || f.type || "image/png"};base64,${f.data}`);
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(err("image_rejected"));
    r.readAsDataURL(f);
  });

  async function toMessages(input, images) {
    let msgs;
    if (typeof input === "string") msgs = [{ role: "user", content: input }];
    else if (Array.isArray(input)) msgs = input.map(m => ({ role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", content: String(m.content == null ? "" : m.content) }));
    else throw err("refused");
    // Alcuni modelli non accettano due messaggi di fila dello stesso ruolo: li unisco.
    const merged = [];
    for (const m of msgs) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role && m.role !== "system") last.content += "\n\n" + m.content;
      else merged.push({ ...m });
    }
    if (images && images.length) {
      const urls = await Promise.all([...images].slice(0, MAX_IMAGES).map(fileToDataUrl));
      let i = merged.length - 1;
      while (i >= 0 && merged[i].role !== "user") i--;
      if (i >= 0) merged[i].content = [{ type: "text", text: merged[i].content }, ...urls.map(url => ({ type: "image_url", image_url: { url } }))];
    }
    return merged;
  }

  async function sample(input, opts) {
    opts = opts || {};
    const id = "r" + Date.now().toString(36) + (++seq);
    const signal = opts.signal;
    if (signal && signal.aborted) throw err("cancelled");
    const messages = await toMessages(input, opts.images);
    let latest = "";
    const onAbort = () => host.abort(id);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await host.chat({ id, messages, quick: opts.modelTier === "quick", maxTokens: opts.maxTokens }, text => {
        latest = text;
        if (typeof opts.onText === "function") try { opts.onText({ text }); } catch {}
      });
      if (!r.ok) throw err(r.code || "http", { text: r.text || latest, detail: r.message || "" });
      return { text: r.text, truncated: !!r.truncated };
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  function parseJson(text) {
    let t = String(text || "").trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    try { return JSON.parse(t); } catch {}
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) try { return JSON.parse(t.slice(a, b + 1)); } catch {}
    return undefined;
  }

  sample.json = async (input, opts) => {
    opts = { ...(opts || {}) };
    const extra = "\n\nRispondi solo con JSON valido, senza testo prima o dopo e senza blocchi di codice.";
    const prompt = typeof input === "string" ? input + extra : input;
    const r = await sample(prompt, { ...opts, onText: undefined });
    const v = parseJson(r.text);
    if (v === undefined) throw err("invalid_json", { text: r.text });
    return v;
  };
  sample.limits = async () => ({ images: { maxCount: MAX_IMAGES } });

  /* ---------------- db ---------------- */
  const split = p => { const parts = String(p).split("/").filter(Boolean); if (parts.length !== 2) throw err("bad_path"); return parts; };
  const snapOf = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : data) });

  function docRef(c, id) {
    return {
      id,
      get: async () => snapOf(id, await host.db.get(c, id)),
      set: async data => { await host.db.set(c, id, JSON.parse(JSON.stringify(data))); },
      update: async data => { const cur = (await host.db.get(c, id)) || {}; await host.db.set(c, id, JSON.parse(JSON.stringify({ ...cur, ...data }))); },
      delete: async () => { await host.db.delete(c, id); },
    };
  }

  function query(c, q) {
    const run = async () => {
      let rows = await host.db.list(c);
      if (q.field) {
        const k = q.field, dir = q.dir === "desc" ? -1 : 1;
        rows.sort((a, b) => { const x = a.data && a.data[k], y = b.data && b.data[k]; return (x > y ? 1 : x < y ? -1 : 0) * dir; });
      }
      if (q.limit) rows = rows.slice(0, q.limit);
      return { docs: rows.map(r => snapOf(r.id, r.data)), metadata: { fromCache: false }, size: rows.length, empty: !rows.length };
    };
    return {
      orderBy: (field, dir) => query(c, { ...q, field, dir }),
      limit: n => query(c, { ...q, limit: n }),
      get: run,
      onSnapshot(cb, onErr) {
        let alive = true;
        const push = () => run().then(s => { if (alive) cb(s); }, e => { if (alive && onErr) onErr(e); });
        const off = host.db.onChange(changed => { if (changed === c) push(); });
        push();
        return () => { alive = false; off(); };
      },
    };
  }

  const db = {
    collection: c => Object.assign(query(c, {}), { doc: id => docRef(c, id || "d" + Date.now().toString(36) + (++seq)) }),
    doc: p => { const [c, id] = split(p); return docRef(c, id); },
  };

  /* ---------------- tts (voce del sistema) ---------------- */
  function makeTts() {
    if (!("speechSynthesis" in window)) return null;
    const synth = window.speechSynthesis, listeners = new Set();
    const emit = state => { for (const f of listeners) try { f({ state }); } catch {} };
    const pickVoice = lang => {
      const vs = synth.getVoices(); const l = (lang || "it").toLowerCase();
      return vs.find(v => v.lang.toLowerCase().startsWith(l) && /natural|online|neural/i.test(v.name)) || vs.find(v => v.lang.toLowerCase().startsWith(l)) || null;
    };
    synth.getVoices();
    return {
      speak(text, o) {
        o = o || {};
        return new Promise((res, rej) => {
          synth.cancel();
          const u = new SpeechSynthesisUtterance(String(text || ""));
          const lang = o.language || "it";
          const v = pickVoice(lang);
          if (v) u.voice = v;
          u.lang = v ? v.lang : lang === "it" ? "it-IT" : lang;
          u.rate = 1.02;
          u.onstart = () => emit("speaking");
          u.onend = () => { emit("idle"); res(); };
          u.onerror = e => { emit("idle"); if (e.error === "canceled" || e.error === "interrupted") res(); else rej(err("unavailable")); };
          synth.speak(u);
        });
      },
      stop() { synth.cancel(); emit("idle"); },
      onState(f) { listeners.add(f); return () => listeners.delete(f); },
    };
  }

  const caps = {
    sample: () => sample,
    db: () => db,
    tts: makeTts,
    user: () => ({ name: "", id: "locale" }),
  };

  window.claude = {
    use(name) {
      const f = caps[name];
      if (!f) return Promise.reject(err("unavailable"));
      const v = f();
      return v ? Promise.resolve(v) : Promise.reject(err("unavailable"));
    },
  };

  /* ---------------- pulsante Impostazioni nell'intestazione ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    const bar = document.querySelector(".hbar");
    if (!bar) return;
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn"; b.id = "settingsBtn"; b.textContent = "Impostazioni";
    b.title = "Collega il cervello degli agenti (FreeLLMAPI o un'altra API)";
    b.addEventListener("click", () => host.settings.open());
    bar.insertBefore(b, bar.firstChild);
  });
})();
