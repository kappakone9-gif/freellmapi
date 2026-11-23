import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BadRequest, NotFound } from './store.js';
import { createShareHandler, deviceCookieHeader, extractSharedUrl } from './share.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 5_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new BadRequest('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest('invalid JSON body');
  }
}

const REPLY = Symbol('reply');
const reply = (status, body = null, headers = {}) => ({ [REPLY]: true, status, body, headers });

const bool = (v) => (v == null || v === '' ? undefined : v === 'true' || v === '1');

// Netscape bookmark HTML (browser export), or plain text with one URL per line.
export function extractImportUrls(text) {
  const hrefs = [...text.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
    url: m[1],
    title: m[2].replace(/<[^>]+>/g, '').trim() || undefined,
  }));
  if (hrefs.length) return hrefs.filter((h) => /^https?:\/\//i.test(h.url));
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\/\S+$/i.test(l))
    .map((url) => ({ url }));
}

export function createServer({ store, worker, config, crawler, tagger }) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+|[^/]+)'))}$`);
    routes.push({ method, re, keys, handler });
  };

  // ---- bookmarks
  route('GET', '/api/bookmarks', ({ query }) =>
    store.search({
      q: query.get('q') || undefined,
      tag: query.get('tag') || undefined,
      listId: query.get('list') || undefined,
      favourited: bool(query.get('favourited')),
      archived: bool(query.get('archived')),
      type: query.get('type') || undefined,
      unread: bool(query.get('unread')),
      inbox: bool(query.get('inbox')),
      maxMinutes: query.get('maxMinutes') || undefined,
      sort: query.get('sort') || undefined,
      limit: query.get('limit') || undefined,
      cursor: query.get('cursor') || undefined,
    }),
  );
  route('POST', '/api/bookmarks', async ({ req }) => {
    const body = await readJson(req);
    const out = store.create(body);
    worker.poke();
    return reply(out.duplicate ? 200 : 201, out);
  });
  route('GET', '/api/bookmarks/:id', ({ params }) => store.get(Number(params.id)));
  route('PATCH', '/api/bookmarks/:id', async ({ req, params }) => store.update(Number(params.id), await readJson(req)));
  route('DELETE', '/api/bookmarks/:id', ({ params }) => (store.remove(Number(params.id)), reply(204)));
  route('POST', '/api/bookmarks/:id/recrawl', ({ params }) => {
    const b = store.recrawl(Number(params.id));
    worker.poke();
    return b;
  });
  route('POST', '/api/bookmarks/:id/retag', ({ params }) => {
    const b = store.retag(Number(params.id));
    worker.poke();
    return b;
  });
  route('POST', '/api/bookmarks/:id/highlights', async ({ req, params }) => reply(201, store.addHighlight(Number(params.id), await readJson(req))));
  route('DELETE', '/api/highlights/:id', ({ params }) => (store.deleteHighlight(Number(params.id)), reply(204)));

  route('POST', '/api/bookmarks/bulk', async ({ req }) => {
    const { ids, action, listId } = await readJson(req);
    return store.bulk(ids, action, { listId: Number(listId) || undefined });
  });
  route('POST', '/api/bookmarks/:id/read', async ({ req, params }) => {
    const { read = true } = await readJson(req);
    return store.markRead(Number(params.id), read);
  });
  route('POST', '/api/bookmarks/:id/opened', ({ params }) => store.markOpened(Number(params.id)));
  route('POST', '/api/bookmarks/:id/snooze', async ({ req, params }) => store.snooze(Number(params.id), (await readJson(req)).days));

  // ---- the "I save links and never read them" helpers
  route('GET', '/api/rediscover', ({ query }) => store.rediscover({ n: query.get('n'), shuffle: query.get('shuffle') }));
  route('GET', '/api/digest', () => store.digest());
  route('POST', '/api/archive-forgotten', async ({ req }) => store.archiveForgotten((await readJson(req)).days));
  route('GET', '/api/bookmarklet', () => ({ token: store.saveToken() }));
  // Called by the app on start: links this browser/phone so the share sheet works.
  route('POST', '/api/device', ({ req }) => reply(204, null, { 'set-cookie': deviceCookieHeader(req, store.saveToken()) }));

  // ---- tags
  route('GET', '/api/tags', () => store.tags());
  route('PATCH', '/api/tags/:id', async ({ req, params }) => {
    store.renameTag(Number(params.id), (await readJson(req)).name);
    return store.tags();
  });
  route('DELETE', '/api/tags/:id', ({ params }) => (store.deleteTag(Number(params.id)), reply(204)));

  // ---- lists
  route('GET', '/api/lists', () => store.lists());
  route('POST', '/api/lists', async ({ req }) => reply(201, store.createList(await readJson(req))));
  route('PATCH', '/api/lists/:id', async ({ req, params }) => store.updateList(Number(params.id), await readJson(req)));
  route('DELETE', '/api/lists/:id', ({ params }) => (store.deleteList(Number(params.id)), reply(204)));
  route('PUT', '/api/lists/:id/bookmarks/:bid', ({ params }) => (store.addToList(Number(params.id), Number(params.bid)), reply(204)));
  route('DELETE', '/api/lists/:id/bookmarks/:bid', ({ params }) => (store.removeFromList(Number(params.id), Number(params.bid)), reply(204)));

  // ---- import / export / status
  route('POST', '/api/import', async ({ req, query }) => {
    const listId = Number(query.get('list')) || undefined;
    const entries = extractImportUrls(await readBody(req, 20_000_000));
    let created = 0;
    let duplicates = 0;
    let invalid = 0;
    for (const e of entries) {
      try {
        const out = store.create({ type: 'link', url: e.url, title: e.title, listId });
        if (out.duplicate && listId) store.addToList(listId, out.bookmark.id);
        if (out.duplicate) duplicates++;
        else created++;
      } catch {
        invalid++;
      }
    }
    worker.poke();
    return { found: entries.length, created, duplicates, invalid };
  });
  route('GET', '/api/export', () => reply(200, store.exportAll(), { 'content-disposition': 'attachment; filename="keepcrawl-export.json"' }));
  route('GET', '/api/status', () => ({
    ...store.stats(),
    crawler: crawler.usesFirecrawl ? 'firecrawl' : 'fetch',
    ai: tagger.enabled ? { model: config.llm.model, baseUrl: config.llm.baseUrl } : null,
    authRequired: Boolean(config.apiKey),
  }));

  function authorised(req, url) {
    if (!config.apiKey) return true;
    const header = req.headers.authorization || '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('key') || '';
    const a = Buffer.from(given);
    const b = Buffer.from(config.apiKey);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // One-click save from the bookmarklet: GET /save?token=...&url=...&list=...
  function handleSave(res, url) {
    const page = (icon, msg, close) =>
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KeepCrawl</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0;background:#f6f7f9;color:#1c1f24">
<div style="text-align:center"><div style="font-size:42px">${icon}</div><p>${msg}</p></div>
${close ? '<script>setTimeout(() => window.close(), 1400)</script>' : ''}</body>`;
    const html = (status, ...a) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(...a));
    };
    const token = Buffer.from(url.searchParams.get('token') || '');
    const expected = Buffer.from(store.saveToken());
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
      return html(401, '🔒', 'Link di salvataggio non valido. Copia di nuovo il bookmarklet da KeepCrawl.', false);
    }
    const listId = Number(url.searchParams.get('list')) || undefined;
    try {
      // Apps often share "caption + link" as one string: pull the link out of it.
      const shared = url.searchParams.get('url') || url.searchParams.get('text') || '';
      const out = store.create({ type: 'link', url: extractSharedUrl(shared) || shared, title: url.searchParams.get('title') || undefined, listId });
      if (out.duplicate && listId) store.addToList(listId, out.bookmark.id);
      worker.poke();
      return html(200, out.duplicate ? '👌' : '✅', out.duplicate ? 'Era già salvato.' : 'Salvato in KeepCrawl.', true);
    } catch (err) {
      const esc = String(err.message).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
      return html(400, '⚠️', esc, false);
    }
  }

  const handleShare = createShareHandler({ store, worker, readBody });

  function serveFile(res, file, cache) {
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found');
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': cache,
        'x-content-type-options': 'nosniff',
      });
      res.end(buf);
    });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/api/health') return send(res, 200, { ok: true });
      if (p === '/save') return handleSave(res, url);
      if (p === '/share') return await handleShare(req, res, url);

      if (p.startsWith('/api/') || p.startsWith('/assets/')) {
        if (p !== '/api/status' && !authorised(req, url)) return send(res, 401, { error: 'unauthorised' });
      }

      if (p.startsWith('/assets/')) {
        const name = path.basename(decodeURIComponent(p.slice(8)));
        return serveFile(res, path.join(config.dataDir, 'assets', name), 'private, max-age=86400');
      }

      if (p.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(p);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
          const out = await r.handler({ req, params, query: url.searchParams });
          if (out && out[REPLY]) {
            const { status, body, headers } = out;
            if (status === 204) {
              res.writeHead(204, headers);
              return res.end();
            }
            return send(res, status, body, headers);
          }
          return send(res, 200, out);
        }
        return send(res, 404, { error: 'no such route' });
      }

      // Static UI (single page).
      const rel = p === '/' ? 'index.html' : path.normalize(p).replace(/^([/\\])+/, '');
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, 'no-cache');
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
    } catch (err) {
      if (err instanceof BadRequest) return send(res, 400, { error: err.message });
      if (err instanceof NotFound) return send(res, 404, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'internal error' });
    }
  });
}
