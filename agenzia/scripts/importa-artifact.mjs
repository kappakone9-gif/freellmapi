#!/usr/bin/env node
// Prende la pagina dell'Agenzia così com'è su Claude (file HTML salvato) e
// la prepara per l'app: aggiunge il sostituto di window.claude e adatta
// qualche frase. Uso:
//   node scripts/importa-artifact.mjs [percorso/della/pagina.html]
// Senza argomento usa scripts/agenzia-originale.html. Scrive app/index.html.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || join(here, "agenzia-originale.html");
const out = join(here, "..", "app", "index.html");
let html = readFileSync(src, "utf8");

const patches = [
  {
    what: "carica il sostituto di window.claude prima dello script della pagina",
    find: "<title>Agenzia</title>",
    replace: '<title>Agenzia</title>\n<script src="claude-shim.js"></script>',
  },
  {
    what: "messaggi d'errore per l'API locale",
    find: '  piano: "Il Capo non',
    replace:
      '  offline: "Non riesco a raggiungere il cervello degli agenti. Controlla che FreeLLMAPI sia acceso, poi premi Riprendi.",\n' +
      '  auth: "La chiave API non è giusta. Aprila da Impostazioni e controllala.",\n' +
      '  not_found: "L\'indirizzo dell\'API o il modello non esistono. Controllali in Impostazioni.",\n' +
      '  http: "Il servizio dei modelli ha dato un errore. Aspetta un attimo e premi Riprendi.",\n' +
      '  piano: "Il Capo non',
  },
  {
    what: "l'archivio sta su questo computer",
    find: "I lavori finiti restano qui e li ritrovi da PC e da telefono.",
    replace: "I lavori finiti restano qui, salvati su questo computer.",
    all: true,
  },
];

for (const p of patches) {
  if (!html.includes(p.find)) {
    console.error(`Non trovo il punto da modificare (${p.what}). La pagina è cambiata: aggiorna scripts/importa-artifact.mjs.`);
    process.exit(1);
  }
  html = p.all ? html.split(p.find).join(p.replace) : html.replace(p.find, p.replace);
}

writeFileSync(out, html);
console.log("Pagina pronta:", out);
