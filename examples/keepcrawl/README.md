# KeepCrawl

A small, self-hosted **"bookmark everything"** app in the spirit of [Karakeep](https://github.com/karakeep-app/karakeep), built on two services:

- **[Firecrawl](https://firecrawl.dev)** fetches every saved link: it renders JavaScript, extracts the main content as clean markdown, and takes a screenshot.
- **Any OpenAI-compatible LLM** tags and summarises each bookmark. By default it points at a local **FreeLLMAPI** router (`http://localhost:3001/v1`, model `auto`), so the AI part runs on free tiers.

It is tuned for people who **save links and never open them again**: the home page is an inbox of unread links with an AI TL;DR on every card, forgotten links resurface daily, and a one-at-a-time "Smaltisci" (triage) mode lets you clear the backlog in minutes. The UI is in Italian.

No dependencies: plain Node.js 22 (built-in `node:sqlite` with FTS5 full-text search), no build step.

## Built for link hoarders

- **📥 Da leggere (inbox)** is the home page: only unread, unarchived links. Opening the original or pressing ✓ marks a link as read.
- **TL;DR on every card**: the AI summary is written so you can decide in seconds without opening the link.
- **✨ Riscoperti per te oggi**: three forgotten links, oldest first, a new set every day (🔄 for more).
- **🔀 Smaltisci**: one link at a time, oldest first. Keys: `L` read now, `F` done, `A` archive, `P` remind me in a week, `S` skip, `D` delete, `1`–`9` file into a section.
- **Digest**: how many links are waiting, how many are older than 30 days, and a one-click "archive the forgotten ones" (they stay searchable).
- **⚡ ≤ 5 min** filter and "shortest first" sort, based on the estimated reading time.
- **Paste anywhere**: copy a link, press `Ctrl+V` anywhere on the page, and it is saved. Several links pasted at once are all saved. A link followed by some text saves the text as a note.
- **Bookmarklet**: one click in the browser bar saves the current page, optionally straight into a section. It carries a secret token, so other websites cannot save links for you.
- **Sections**: create, rename (✎ or double-click), change icon, reorder and delete them. Put links in a section by dragging a card onto it, with the 📁 button on a card, from the detail panel, or while triaging. Each section can have **automatic rules**: `youtube.com` (a site and its subdomains), `#ricette` (a tag, including tags the AI adds), or a plain word found in the title or URL. Matching links, both new and already saved, are filed automatically. A fresh install starts with two example sections, 🎬 Video and 💻 Codice, which you can rename or delete.

## Save from other apps (TikTok, Instagram, YouTube…)

- **Android**: open KeepCrawl in Chrome on the phone → ⋮ → *Install app*. KeepCrawl then appears in the system **Share** sheet of every app (TikTok: Share → *More*). Sharing saves the link immediately; the confirmation screen lets you file it into a section with one tap. Captions shared along with the link are kept as a note. This uses the PWA Web Share Target (`manifest.webmanifest` + `/share`).
- **iPhone/iPad**: Safari does not support share targets, so the app's *📱 Salva da altre app* page explains how to create an Apple **Shortcut** shown in the share sheet. It calls `/save?token=…&url=…`, optionally with `&list=` to save straight into a section.
- **Computer**: bookmarklet in the bookmarks bar.
- The phone must reach KeepCrawl over **HTTPS**. The easiest private option is [Tailscale](https://tailscale.com): `tailscale serve --bg 3100` gives you `https://<machine>.<tailnet>.ts.net`, reachable only from your own devices. If you expose it publicly instead (e.g. Cloudflare Tunnel), set `KEEPCRAWL_API_KEY`.
- Safety: `/share` only saves for a device that holds the `kc_device` cookie (HttpOnly, set when you open the app). It saves automatically only on user-initiated navigations (`Sec-Fetch-Site: none`, as a share-sheet launch is) or same-origin requests. Another website linking to it gets a confirmation page instead.

## Features

| Feature | KeepCrawl |
| --- | --- |
| Save links and notes | ✅ paste a URL or write markdown |
| Automatic title, description, image, favicon | ✅ via Firecrawl metadata |
| Full page content (reader view) + screenshot archive | ✅ markdown from Firecrawl, screenshot stored locally |
| AI tagging + summary | ✅ reuses existing tags, AI tags shown in teal, yours in purple |
| Full-text search | ✅ SQLite FTS5 over title, description, content, summary, notes, URL |
| Favourites, archive, read/unread, snooze | ✅ |
| Sections (renamable, with auto-filing rules) | ✅ |
| Highlights | ✅ select text in the reader view |
| Tag management (rename / merge / delete) | ✅ |
| Import | ✅ browser bookmark HTML (Chrome, Firefox, Safari, Pocket…) or a URL-per-line text file |
| Export | ✅ JSON with everything |
| REST API + optional API key | ✅ |
| Works without Firecrawl | ✅ falls back to a plain fetch + HTML extraction (no JS rendering, no screenshots) |

Not included (Karakeep has them): image/PDF uploads, browser extension, mobile apps, multi-user accounts, RSS feeds, video archiving.

## Run it

```bash
cd examples/keepcrawl
cp .env.example .env      # Windows: copy .env.example .env — then put your keys in it
npm start                 # → http://127.0.0.1:3100
```

On **Windows** you can simply double-click `avvia-keepcrawl.bat`: it checks that Node.js 22+ is installed, creates `.env` from the example, starts the server and opens the browser.

`npm start` reads `.env` if it exists (Node's `--env-file-if-exists`), so the same steps work on macOS, Linux and Windows. Without keys it still runs: pages are fetched without Firecrawl and AI tagging is skipped if no LLM is reachable.

Start FreeLLMAPI first (`npm run dev` at the repo root) so tagging works, or point `LLM_BASE_URL` at any other OpenAI-compatible endpoint (OpenAI, Ollama's `http://localhost:11434/v1`, OpenRouter, …).

### Docker

```bash
cd examples/keepcrawl
cp .env.example .env    # fill in the keys
docker compose up -d
```

In Docker, `LLM_BASE_URL` defaults to `http://host.docker.internal:3001/v1` so the container can reach a FreeLLMAPI running on the host.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3100` / `127.0.0.1` | Where the server listens |
| `KEEPCRAWL_DATA_DIR` | `./data` | SQLite database and screenshots |
| `KEEPCRAWL_API_KEY` | *(empty)* | If set, the API and UI require `Authorization: Bearer <key>` (the UI asks once) |
| `FIRECRAWL_API_KEY` | *(empty)* | Without it, the plain-fetch fallback is used |
| `FIRECRAWL_BASE_URL` | `https://api.firecrawl.dev` | Use your own self-hosted Firecrawl |
| `FIRECRAWL_SCREENSHOTS` | `true` | Ask Firecrawl for a screenshot of each page |
| `LLM_BASE_URL` | `http://localhost:3001/v1` | OpenAI-compatible base URL |
| `LLM_API_KEY` | *(empty)* | Bearer key for the LLM endpoint |
| `LLM_MODEL` | `auto` | Model name (`auto`, `auto:fast`, `auto:smart` on FreeLLMAPI) |
| `LLM_ENABLED` | `true` | Set to `false` to turn off AI tagging |
| `LLM_LANGUAGE` | content language | Language for summaries, e.g. `Italian` |
| `WORKER_CONCURRENCY` | `2` | Parallel crawl/tag jobs |

## How it works

```
POST /api/bookmarks ──► bookmarks row ──► job "crawl" ──► Firecrawl /v2/scrape
                                                          (markdown, metadata, screenshot)
                                               │
                                               ▼
                                          job "tag" ──► LLM /chat/completions
                                                          → {"tags": [...], "summary": "..."}
```

Jobs live in the same SQLite file, so they survive restarts. Failures retry with backoff (rate limits and 5xx only); a link that cannot be crawled is still tagged from its URL and your title/note.

## API

All endpoints are JSON under `/api`. Add `Authorization: Bearer $KEEPCRAWL_API_KEY` if you set one.

```bash
# save a link (tags optional)
curl -X POST localhost:3100/api/bookmarks -H 'content-type: application/json' \
  -d '{"url": "https://github.com/firecrawl/firecrawl", "tags": ["to-read"]}'

# save a note
curl -X POST localhost:3100/api/bookmarks -H 'content-type: application/json' \
  -d '{"type": "note", "note": "Remember to try **self-hosted** Firecrawl"}'

# search (q = full text; also tag, list, favourited, archived, type, cursor)
curl 'localhost:3100/api/bookmarks?q=scraping&archived=false'
```

| Method | Path | |
| --- | --- | --- |
| GET | `/api/bookmarks` | list / search (`q`, `tag`, `list`, `favourited`, `archived`, `type`, `unread`, `inbox`, `maxMinutes`, `sort`=`newest\|oldest\|random\|shortest`, `limit`, `cursor`) |
| POST | `/api/bookmarks` | create `{url}` or `{type:"note", note}`, optional `title`, `tags`, `listId` |
| GET / PATCH / DELETE | `/api/bookmarks/:id` | read (with content + highlights) / update `title`, `note`, `summary`, `tags`, `favourited`, `archived` / delete |
| POST | `/api/bookmarks/:id/recrawl`, `/retag` | re-run Firecrawl or the AI |
| POST | `/api/bookmarks/:id/highlights` | `{text, note?}` |
| DELETE | `/api/highlights/:id` | |
| GET / PATCH / DELETE | `/api/tags`, `/api/tags/:id` | list; rename (merges into an existing name); delete |
| POST | `/api/bookmarks/:id/read` | `{read: true\|false}` |
| POST | `/api/bookmarks/:id/opened` | record that it was opened |
| POST | `/api/bookmarks/:id/snooze` | `{days}` (0 clears) |
| POST | `/api/bookmarks/bulk` | `{ids, action, listId?}`; action: `read`, `unread`, `archive`, `unarchive`, `delete`, `addToList`, `removeFromList` |
| GET | `/api/digest` | unread / forgotten / weekly counters |
| GET | `/api/rediscover` | `?n=3&shuffle=0` |
| POST | `/api/archive-forgotten` | `{days: 30}` archive unread links older than that |
| GET / POST / PATCH / DELETE | `/api/lists`, `/api/lists/:id` | sections: `name`, `icon`, `rules`, `position` (the response includes `added`, the number of links the rules just filed) |
| PUT / DELETE | `/api/lists/:id/bookmarks/:bookmarkId` | add to / remove from a section |
| POST | `/api/import` | body: bookmark HTML or URL-per-line text; `?list=` files them into a section |
| GET | `/api/bookmarklet`, `/save?token=&url=&title=&list=` | bookmarklet / Shortcut token; one-click save (the link can be inside shared text) |
| POST | `/api/device` | sets the device cookie used by the share target |
| GET / POST | `/share` | Web Share Target (`url`, `text`, `title`); POST `id` + `list` files into a section |
| GET | `/api/export`, `/api/status` | |

## Tests

```bash
npm test
```

Firecrawl and the LLM are mocked; the tests cover crawling, tagging, search, the fallback parser, the markdown sanitiser, section rules, the inbox/rediscover/digest logic, the bookmarklet endpoint, upgrading a database from the first version, and the HTTP API.

## Note for networks behind a proxy

Node's built-in `fetch` ignores `HTTPS_PROXY` unless you start it with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).
