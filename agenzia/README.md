# Agenzia — app per il computer

La tua Agenzia (Maggiordomo, Capo e tutti gli agenti nel palazzo) in una
finestra sua, senza aprire il browser. Si avvia dall'icona sul desktop o dal
menu Start, come un programma normale.

## Cosa cambia rispetto alla pagina su Claude

| | Pagina su Claude | App Agenzia |
|---|---|---|
| Dove si apre | nel browser, dentro Claude | in una finestra sua |
| Chi fa pensare gli agenti | Claude, con il tuo account | FreeLLMAPI (modelli gratuiti) o un'altra API compatibile OpenAI |
| Archivio, "Cosa sanno di me", arredamento, sogni | sul tuo account Claude, da PC e telefono | in un file su questo computer |
| Voce | voce di Claude | voce del sistema (Windows/Mac) |

Tutto il resto è uguale: palazzo animato, piano del Capo da confermare,
chat diretta con ogni agente, foto allo Stylist, Buonanotte e sogni.

L'archivio dell'app e quello della pagina su Claude sono separati: quello che
fai nell'app resta nell'app.

## Installare

1. Vai su GitHub, scheda **Actions** (se è la prima volta, premi il pulsante verde per attivarle), workflow **Agenzia desktop**.
2. Apri l'ultima run con la spunta verde (oppure premi **Run workflow**).
3. In fondo, sotto **Artifacts**, scarica:
   - **Agenzia-win** per Windows: dentro c'è `Agenzia-Setup-….exe` (installa e
     crea l'icona sul desktop) e `Agenzia-Portable-….exe` (si apre senza
     installare).
   - **Agenzia-mac** per Mac, **Agenzia-linux** per Linux.

L'app non ha la firma digitale: al primo avvio Windows può mostrare
"Windows ha protetto il PC". Premi **Ulteriori informazioni → Esegui comunque**.

## Collegare il cervello (una volta sola)

Al primo avvio si apre **Impostazioni** (poi la ritrovi col pulsante in alto
o con Ctrl+,).

Con FreeLLMAPI:

1. Installa e apri l'app FreeLLMAPI (dalla pagina Releases di github.com/tashfeenahmed/freellmapi).
2. Nel suo pannello aggiungi almeno una chiave gratuita di un provider
   (per esempio Groq o Google AI Studio).
3. Copia la **unified key** di FreeLLMAPI e incollala in "Chiave API".
4. Lascia indirizzo `http://127.0.0.1:31415/v1` e modello `auto`.
5. Premi **Prova il collegamento**: deve dire "Collegato".

FreeLLMAPI deve essere acceso mentre usi l'Agenzia.

Va bene anche un'altra API compatibile OpenAI (OpenRouter, Groq, un server
locale come Ollama o LM Studio): metti il suo indirizzo, la chiave e il nome
del modello.

## Dove stanno i tuoi dati

Menu **Agenzia → Apri la cartella dei dati**. Dentro trovi:

- `archivio.json` — lavori, chat salvate, contesto, arredamento, immagini, sogni
- `impostazioni.json` — indirizzo, chiave e modello dell'API

**Agenzia → Esporta archivio…** ne salva una copia dove vuoi.

## Per chi modifica l'app

```bash
cd agenzia
npm install
npm start            # apre l'app
npm test             # controlli veloci
npm run dist:win     # installer Windows (meglio da Windows o dalla Action)
```

Se aggiorni la pagina dell'Agenzia su Claude, salva il suo HTML in
`scripts/agenzia-originale.html` e lancia `npm run importa`: rigenera
`app/index.html` con il collegamento all'app.

Come è fatta:

- `src/main.cjs` — finestra, menu, chiamate all'API (in streaming) e archivio su file
- `src/preload.cjs` — ponte sicuro tra pagina e app
- `app/claude-shim.js` — fa le veci di `window.claude` (`sample`, `db`, `tts`) usando l'app
- `app/index.html` — la pagina dell'Agenzia, generata da `scripts/importa-artifact.mjs`
- `app/impostazioni.html` — la finestra delle impostazioni
