import { timingSafeEqual } from 'node:crypto';

// "Share to KeepCrawl" from other apps (TikTok, Instagram, YouTube…).
//
// Android: the installed PWA declares a Web Share Target (manifest.webmanifest),
// so it shows up in the system share sheet; sharing opens GET /share?url=&text=&title=.
// iPhone: an Apple Shortcut calls /save?token=… instead (see the app's help page).
//
// Protection against other websites saving links for you: the phone must hold
// the device cookie (set when you open the app), and an automatic save only
// happens on a navigation the browser marks as user-initiated (Sec-Fetch-Site:
// none, as for a share-sheet launch) or same-origin. Anything else gets a
// confirmation button instead.

export const DEVICE_COOKIE = 'kc_device';
const YEAR = 400 * 24 * 3600;

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function extractSharedUrl(...fields) {
  for (const f of fields) {
    const m = String(f || '').match(/https?:\/\/[^\s<>"]+/i);
    if (m) return m[0].replace(/[),.;!?]+$/, '');
  }
  return null;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = (req) => req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

export function deviceCookieHeader(req, token) {
  return `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${YEAR}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
}

function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  // Older browsers: fall back to the Origin header.
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const ago = (iso) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (d <= 0) return 'oggi';
  if (d === 1) return 'ieri';
  if (d < 60) return `${d} giorni fa`;
  return `${Math.round(d / 30)} mesi fa`;
};

function page({ icon, title, body = '' }) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#4f46e5">
<title>KeepCrawl</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--text:#1c1f24;--muted:#6b7280;--border:#e3e6eb;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#111317;--panel:#1a1d23;--text:#e7e9ee;--muted:#9aa1ad;--border:#2a2f38;--accent:#8b85ff}}
*{box-sizing:border-box}
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--text);display:grid;place-items:center;min-height:100vh}
main{width:min(440px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:24px 20px;text-align:center}
.icon{font-size:46px} h1{font-size:20px;margin:6px 0 4px} p{color:var(--muted);margin:6px 0 14px;word-break:break-word}
.sections{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:10px 0 18px}
button,a.btn{font:inherit;border:1px solid var(--border);background:var(--panel);color:var(--text);border-radius:999px;padding:10px 16px;text-decoration:none;cursor:pointer}
button.primary,a.primary{background:var(--accent);border-color:var(--accent);color:#fff}
form{display:inline}
</style></head><body><main><div class="icon">${icon}</div><h1>${title}</h1>${body}</main></body></html>`;
}

export function createShareHandler({ store, worker, readBody }) {
  function deviceOk(req) {
    const given = Buffer.from(cookies(req)[DEVICE_COOKIE] || '');
    const expected = Buffer.from(store.saveToken());
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  function send(res, status, html) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
  }

  function savedPage(bookmark, { duplicate, filedIn } = {}) {
    const sections = store.lists();
    const label = escHtml(bookmark.title || bookmark.url);
    const buttons = sections
      .map((s) => {
        const inIt = bookmark.lists.includes(s.id);
        return `<form method="post" action="/share"><input type="hidden" name="id" value="${bookmark.id}"><input type="hidden" name="list" value="${s.id}">
          <button ${inIt ? 'class="primary" disabled' : ''}>${escHtml(s.icon)} ${escHtml(s.name)}${inIt ? ' ✓' : ''}</button></form>`;
      })
      .join('');
    const head = filedIn
      ? { icon: '📁', title: `Messo in ${escHtml(filedIn.icon)} ${escHtml(filedIn.name)}` }
      : duplicate
        ? { icon: '👌', title: `Era già salvato ${ago(bookmark.created_at)}` }
        : { icon: '✅', title: 'Salvato in KeepCrawl' };
    return page({
      ...head,
      body: `<p>${label}</p>
        ${sections.length ? `<p>Vuoi metterlo in una sezione?</p><div class="sections">${buttons}</div>` : ''}
        <a class="btn primary" href="/">Apri KeepCrawl</a>`,
    });
  }

  function save(res, { url, text, title }) {
    const link = extractSharedUrl(url, text, title);
    if (!link) return send(res, 400, page({ icon: '🤔', title: 'Non ho trovato un link', body: '<p>Condividi un link (non un video o una foto come file).</p><a class="btn" href="/">Apri KeepCrawl</a>' }));
    // Text shared alongside the link (e.g. a TikTok caption) is kept as a note.
    const note = String(text || '').replace(link, '').trim();
    let out;
    try {
      out = store.create({ type: 'link', url: link, note: note.length > 2 ? note.slice(0, 2000) : undefined });
    } catch (err) {
      return send(res, 400, page({ icon: '⚠️', title: 'Link non valido', body: `<p>${escHtml(err.message)}</p><a class="btn" href="/">Apri KeepCrawl</a>` }));
    }
    worker.poke();
    return send(res, out.duplicate ? 200 : 201, savedPage(out.bookmark, { duplicate: out.duplicate }));
  }

  return async function handleShare(req, res, url) {
    if (!deviceOk(req)) {
      return send(
        res,
        401,
        page({
          icon: '📱',
          title: 'Collega prima questo telefono',
          body: '<p>Apri KeepCrawl una volta da questo telefono (con la chiave, se ne hai impostata una), poi riprova a condividere.</p><a class="btn primary" href="/">Apri KeepCrawl</a>',
        }),
      );
    }

    if (req.method === 'GET') {
      const shared = { url: url.searchParams.get('url'), text: url.searchParams.get('text'), title: url.searchParams.get('title') };
      const site = req.headers['sec-fetch-site'];
      if (site === 'none' || site === 'same-origin') return save(res, shared);
      // Opened from another website: ask before saving.
      const link = extractSharedUrl(shared.url, shared.text, shared.title);
      const fields = Object.entries(shared)
        .filter(([, v]) => v)
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${escHtml(v)}">`)
        .join('');
      return send(res, 200, page({ icon: '🔖', title: 'Salvare questo link?', body: `<p>${escHtml(link || 'nessun link')}</p><form method="post" action="/share">${fields}<button class="primary">Salva</button></form>` }));
    }

    if (req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, page({ icon: '⛔', title: 'Richiesta non permessa' }));
      const form = new URLSearchParams(await readBody(req, 100_000));
      if (form.get('id')) {
        const id = Number(form.get('id'));
        const listId = Number(form.get('list'));
        store.addToList(listId, id);
        const section = store.lists().find((l) => l.id === listId);
        return send(res, 200, savedPage(store.get(id), { filedIn: section }));
      }
      return save(res, { url: form.get('url'), text: form.get('text'), title: form.get('title') });
    }

    res.writeHead(405, { allow: 'GET, POST' });
    res.end();
  };
}
