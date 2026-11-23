import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createStore, normaliseUrl, parseRules, matchesRules } from '../src/store.js';
import { DatabaseSync } from 'node:sqlite';
import { createCrawler, parseHtml } from '../src/crawler.js';
import { createTagger, parseAiResponse } from '../src/ai.js';
import { createWorker } from '../src/worker.js';
import { createServer, extractImportUrls } from '../src/server.js';
import { renderMarkdown } from '../public/markdown.js';

const quiet = { info() {}, warn() {}, error() {} };

function baseConfig(dataDir) {
  return {
    dataDir,
    apiKey: '',
    firecrawl: { apiKey: 'fc-test', baseUrl: 'https://fc.test', screenshots: true, timeoutMs: 1000 },
    llm: { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'auto', enabled: true, maxInputChars: 5000, language: 'English' },
    worker: { concurrency: 1, pollMs: 50, maxAttempts: 2 },
  };
}

function mockFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (String(url) === 'https://fc.test/v2/scrape') {
      return Response.json({
        success: true,
        data: {
          markdown: '# Rust ownership\n\nOwnership is how **Rust** manages memory without a garbage collector.',
          metadata: { title: 'Understanding Ownership', description: 'The Rust book chapter', ogImage: 'https://img.test/a.png', favicon: 'https://doc.test/favicon.ico', ogSiteName: 'The Rust Book' },
          screenshot: 'data:image/png;base64,iVBORw0KGgo=',
        },
      });
    }
    if (String(url) === 'https://llm.test/v1/chat/completions') {
      return Response.json({
        choices: [{ message: { content: '```json\n{"tags":["Rust","Memory Management","#programming"],"summary":"Explains Rust ownership."}\n```' } }],
      });
    }
    return new Response('nope', { status: 404 });
  };
}

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepcrawl-'));
  const config = baseConfig(dataDir);
  const calls = [];
  const fetchImpl = mockFetch(calls);
  const db = openDb(dataDir);
  const store = createStore(db);
  const crawler = createCrawler(config, fetchImpl);
  const tagger = createTagger(config, fetchImpl);
  const worker = createWorker({ db, store, crawler, tagger, config, log: quiet });
  return { dataDir, config, calls, db, store, crawler, tagger, worker };
}

test('normaliseUrl adds scheme and strips tracking params', () => {
  assert.equal(normaliseUrl('example.com/a?utm_source=x&id=2#frag'), 'https://example.com/a?id=2');
  assert.throws(() => normaliseUrl('javascript:alert(1)'));
});

test('link bookmark is crawled via Firecrawl, then AI-tagged', async () => {
  const { store, worker, calls, dataDir } = setup();
  const { bookmark } = store.create({ url: 'https://doc.test/ch04', tags: ['to-read'] });
  assert.equal(bookmark.crawl_status, 'pending');

  await worker.drain();
  const b = store.get(bookmark.id);

  assert.equal(b.crawl_status, 'done');
  assert.equal(b.ai_status, 'done');
  assert.equal(b.title, 'Understanding Ownership');
  assert.equal(b.site_name, 'The Rust Book');
  assert.match(b.content, /garbage collector/);
  assert.equal(b.summary, 'Explains Rust ownership.');
  assert.deepEqual(b.tags.map((t) => `${t.name}:${t.source}`).sort(), ['memory management:ai', 'programming:ai', 'rust:ai', 'to-read:human']);
  assert.ok(fs.existsSync(path.join(dataDir, 'assets', b.screenshot)));

  const fc = calls.find((c) => c.url.endsWith('/v2/scrape'));
  assert.equal(fc.body.url, 'https://doc.test/ch04');
  assert.deepEqual(fc.body.formats, ['markdown', 'screenshot']);
  assert.equal(fc.headers.authorization, 'Bearer fc-test');
  const llm = calls.find((c) => c.url.includes('chat/completions'));
  assert.equal(llm.body.model, 'auto');
  assert.match(llm.body.messages[1].content, /Ownership is how/);
});

test('duplicate urls return the existing bookmark', () => {
  const { store } = setup();
  const a = store.create({ url: 'https://x.test/p?utm_medium=y' });
  const b = store.create({ url: 'x.test/p' });
  assert.equal(b.duplicate, true);
  assert.equal(b.bookmark.id, a.bookmark.id);
});

test('full-text search finds crawled content and summaries', async () => {
  const { store, worker } = setup();
  store.create({ url: 'https://doc.test/ch04' });
  store.create({ type: 'note', note: 'Buy oat milk' });
  await worker.drain();
  assert.equal(store.search({ q: 'garbage' }).items.length, 1);
  assert.equal(store.search({ q: 'collect' }).items.length, 1, 'prefix match');
  assert.equal(store.search({ q: 'oat' }).items[0].type, 'note');
  assert.equal(store.search({ tag: 'rust' }).items.length, 2, 'mock LLM tags both');
  assert.equal(store.search({ type: 'note' }).items.length, 1);
  assert.equal(store.search({ q: 'zzzz' }).items.length, 0);
});

test('re-tag replaces AI tags but keeps human tags', async () => {
  const { store, worker } = setup();
  const { bookmark } = store.create({ type: 'note', note: 'rust notes', tags: ['mine'] });
  await worker.drain();
  store.saveAi(bookmark.id, { tags: ['other'], summary: '' });
  const names = store.get(bookmark.id).tags.map((t) => t.name).sort();
  assert.deepEqual(names, ['mine', 'other']);
  assert.ok(!store.tags().some((t) => t.name === 'rust'), 'orphan tags are pruned');
});

test('crawl failure is recorded and does not retry on 4xx', async () => {
  const { db, store, config } = setup();
  const failing = async () => Response.json({ success: false, error: 'blocked' }, { status: 403 });
  const worker = createWorker({ db, store, crawler: createCrawler(config, failing), tagger: { enabled: false }, config, log: quiet });
  const { bookmark } = store.create({ url: 'https://blocked.test' });
  await worker.drain();
  const b = store.get(bookmark.id);
  assert.equal(b.crawl_status, 'failed');
  assert.match(b.crawl_error, /blocked/);
  assert.equal(b.ai_status, 'skipped');
});

test('fallback crawler parses plain HTML when there is no Firecrawl key', async () => {
  const html = `<html><head><title>Hello &amp; welcome</title><meta property="og:image" content="/img.png"><meta name="description" content="Desc"></head>
    <body><nav>menu</nav><article><h1>Big</h1><p>First para.</p><script>bad()</script><ul><li>one</li></ul></article></body></html>`;
  const page = parseHtml(html, 'https://site.test/post');
  assert.equal(page.title, 'Hello & welcome');
  assert.equal(page.imageUrl, 'https://site.test/img.png');
  assert.equal(page.description, 'Desc');
  assert.match(page.content, /# Big/);
  assert.match(page.content, /- one/);
  assert.doesNotMatch(page.content, /bad\(\)|menu/);

  const crawler = createCrawler({ firecrawl: { apiKey: '' } }, async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
  assert.equal(crawler.usesFirecrawl, false);
  assert.equal((await crawler.scrape('https://site.test/post')).source, 'fetch');
});

test('parseAiResponse is tolerant of wrapping text and junk', () => {
  assert.deepEqual(parseAiResponse('Sure! {"tags":["A","a"," b "],"summary":" s "}'), { tags: ['a', 'b'], summary: 's' });
  assert.throws(() => parseAiResponse('no json here'));
});

test('markdown renderer escapes HTML and drops unsafe links', () => {
  const html = renderMarkdown('# T\n\n<script>x</script> [a](javascript:alert(1)) [b](https://ok.test) ![i](https://i.test/x.png)\n\n```\n<b>\n```');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<a href="https:\/\/ok.test"/);
  assert.match(html, /<img src="https:\/\/i.test\/x.png"/);
  assert.match(html, /<pre><code>&lt;b&gt;<\/code><\/pre>/);
});

test('import extracts urls from Netscape HTML and plain text', () => {
  assert.deepEqual(extractImportUrls('<DT><A HREF="https://a.test" ADD_DATE="1">A site</A>'), [{ url: 'https://a.test', title: 'A site' }]);
  assert.deepEqual(extractImportUrls('https://a.test\nnot a url\nhttps://b.test'), [{ url: 'https://a.test' }, { url: 'https://b.test' }]);
});

test('HTTP API: create, list, patch, lists, auth', async (t) => {
  const ctx = setup();
  ctx.config.apiKey = 'secret';
  const server = createServer({ ...ctx });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' };

  assert.equal((await fetch(`${base}/api/bookmarks`)).status, 401);

  let res = await fetch(`${base}/api/bookmarks`, { method: 'POST', headers: auth, body: JSON.stringify({ url: 'doc.test/ch04' }) });
  assert.equal(res.status, 201);
  const { bookmark } = await res.json();
  await ctx.worker.drain();

  res = await fetch(`${base}/api/bookmarks?q=ownership`, { headers: auth });
  const list = await res.json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].content, undefined, 'list view omits full content');

  res = await fetch(`${base}/api/bookmarks/${bookmark.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ favourited: true }) });
  assert.equal((await res.json()).favourited, true);

  res = await fetch(`${base}/api/lists`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Reading' }) });
  const l = await res.json();
  assert.equal((await fetch(`${base}/api/lists/${l.id}/bookmarks/${bookmark.id}`, { method: 'PUT', headers: auth })).status, 204);
  res = await fetch(`${base}/api/lists`, { headers: auth });
  assert.equal(res.status, 200, 'array responses are returned as JSON');
  assert.equal((await res.json())[0].count, 1);
  assert.ok(Array.isArray(await (await fetch(`${base}/api/tags`, { headers: auth })).json()));
  res = await fetch(`${base}/api/bookmarks?list=${l.id}`, { headers: auth });
  assert.equal((await res.json()).items.length, 1);

  res = await fetch(`${base}/api/bookmarks`, { method: 'POST', headers: auth, body: JSON.stringify({ url: 'ftp://x' }) });
  assert.equal(res.status, 400);

  res = await fetch(`${base}/`);
  assert.match(await res.text(), /KeepCrawl/);
  assert.equal((await fetch(`${base}/../src/config.js`)).status, 200, 'path traversal falls back to index');
  assert.doesNotMatch(await (await fetch(`${base}/..%2fsrc%2fconfig.js`)).text(), /FIRECRAWL_API_KEY/);
});

// ---------- v2: inbox, sections, triage helpers

const backdate = (db, id, days) =>
  db.prepare(`UPDATE bookmarks SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - days * 86400000).toISOString(), id);

test('section rules: domains, #tags and keywords', () => {
  const rules = parseRules('YouTube.com, https://www.github.com/x, #Ricette\nrecensione');
  assert.deepEqual(rules, [
    { kind: 'domain', value: 'youtube.com' },
    { kind: 'domain', value: 'github.com' },
    { kind: 'tag', value: 'ricette' },
    { kind: 'keyword', value: 'recensione' },
  ]);
  assert.ok(matchesRules(rules, { url: 'https://m.youtube.com/watch?v=1' }));
  assert.ok(!matchesRules(rules, { url: 'https://notyoutube.com/' }));
  assert.ok(matchesRules(rules, { url: 'https://x.test', tags: ['ricette'] }));
  assert.ok(matchesRules(rules, { url: 'https://x.test', title: 'La mia Recensione' }));
});

test('sections auto-file new links (by domain, and by AI tag after tagging)', async () => {
  const { store, worker } = setup();
  const video = store.createList({ name: 'Video', icon: '🎬', rules: 'youtube.com' });
  const rust = store.createList({ name: 'Rust', rules: '#rust' });
  const { bookmark: yt } = store.create({ url: 'https://www.youtube.com/watch?v=abc' });
  assert.deepEqual(store.get(yt.id).lists, [video.id], 'domain rule applies on save');

  const { bookmark: doc } = store.create({ url: 'https://doc.test/ch04' });
  assert.deepEqual(store.get(doc.id).lists, []);
  await worker.drain();
  assert.ok(store.get(doc.id).lists.includes(rust.id), 'tag rule applies once the AI tagged it');
});

test('adding rules to a section files existing links; rename keeps them', () => {
  const { store } = setup();
  store.create({ url: 'https://github.com/a/b' });
  store.create({ url: 'https://gitlab.com/c' });
  store.create({ url: 'https://other.test/' });
  const s = store.createList({ name: 'Codice' });
  assert.equal(s.added, 0);
  const updated = store.updateList(s.id, { rules: 'github.com, gitlab.com' });
  assert.equal(updated.added, 2);
  const renamed = store.updateList(s.id, { name: 'Programmazione', icon: '🧑‍💻' });
  assert.equal(renamed.name, 'Programmazione');
  assert.equal(renamed.rules, 'github.com, gitlab.com', 'renaming does not drop rules');
  const l = store.lists().find((x) => x.id === s.id);
  assert.equal(l.count, 2);
  assert.equal(l.unread, 2);
  assert.throws(() => store.updateList(s.id, { name: '  ' }));
});

test('inbox shows unread, unarchived, not snoozed links', () => {
  const { store } = setup();
  const a = store.create({ url: 'https://a.test' }).bookmark;
  const b = store.create({ url: 'https://b.test' }).bookmark;
  const c = store.create({ url: 'https://c.test' }).bookmark;
  const d = store.create({ url: 'https://d.test' }).bookmark;
  store.markRead(a.id);
  store.update(b.id, { archived: true });
  store.snooze(c.id, 7);
  const ids = store.search({ inbox: true }).items.map((x) => x.id);
  assert.deepEqual(ids, [d.id]);
  assert.equal(store.get(a.id).read, true);
  assert.equal(store.get(c.id).snoozed, true);
  store.snooze(c.id, 0);
  assert.equal(store.search({ inbox: true }).items.length, 2);
  store.markRead(a.id, false);
  assert.equal(store.search({ unread: true }).items.length, 4);
  assert.equal(store.markOpened(d.id).open_count, 1);
});

test('sorting: oldest, shortest and a stable daily random order', async () => {
  const { store, db } = setup();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(store.create({ url: `https://s${i}.test` }).bookmark.id);
  db.prepare(`UPDATE bookmarks SET reading_minutes = ? WHERE id = ?`).run(2, ids[3]);
  db.prepare(`UPDATE bookmarks SET reading_minutes = ? WHERE id = ?`).run(9, ids[1]);
  assert.equal(store.search({ sort: 'oldest' }).items[0].id, ids[0]);
  assert.deepEqual(store.search({ sort: 'shortest' }).items.slice(0, 2).map((x) => x.id), [ids[3], ids[1]]);
  assert.deepEqual(store.search({ maxMinutes: 5 }).items.map((x) => x.id), [ids[3]]);
  const r1 = store.search({ sort: 'random' }).items.map((x) => x.id);
  assert.deepEqual(store.search({ sort: 'random' }).items.map((x) => x.id), r1, 'same order within the day');
  const page1 = store.search({ sort: 'random', limit: 2 });
  const page2 = store.search({ sort: 'random', limit: 2, cursor: page1.nextCursor });
  assert.deepEqual([...page1.items, ...page2.items].map((x) => x.id), r1.slice(0, 4), 'paging does not repeat');
});

test('rediscover prefers old forgotten links; digest counts them', () => {
  const { store, db } = setup();
  const old = store.create({ url: 'https://old.test' }).bookmark;
  const fresh = store.create({ url: 'https://fresh.test' }).bookmark;
  const read = store.create({ url: 'https://read.test' }).bookmark;
  backdate(db, old.id, 45);
  backdate(db, read.id, 60);
  store.markRead(read.id);
  assert.deepEqual(store.rediscover({ n: 1 }).map((x) => x.id), [old.id]);
  assert.deepEqual(store.rediscover({ n: 5 }).map((x) => x.id).sort(), [old.id, fresh.id].sort());

  const d = store.digest();
  assert.equal(d.unread, 2);
  assert.equal(d.forgotten, 1);
  assert.equal(d.oldestUnreadDays, 45);
  assert.equal(d.readThisWeek, 1);

  assert.deepEqual(store.archiveForgotten(30), { archived: 1 });
  assert.equal(store.get(old.id).archived, true);
  assert.equal(store.get(read.id).archived, false, 'read links are left alone');
});

test('bulk actions', () => {
  const { store } = setup();
  const ids = ['https://1.test', 'https://2.test', 'https://3.test'].map((url) => store.create({ url }).bookmark.id);
  const s = store.createList({ name: 'Bulk' });
  assert.deepEqual(store.bulk(ids, 'read'), { changed: 3 });
  assert.deepEqual(store.bulk(ids.slice(0, 2), 'addToList', { listId: s.id }), { changed: 2 });
  assert.deepEqual(store.bulk([ids[2]], 'delete'), { changed: 1 });
  assert.equal(store.search({}).items.length, 2);
  assert.throws(() => store.bulk(ids, 'explode'));
  assert.throws(() => store.bulk(ids, 'addToList', { listId: 999 }));
});

test('opening a database from the first version adds the new columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepcrawl-old-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  const old = new DatabaseSync(path.join(dir, 'keepcrawl.db'));
  old.exec(`CREATE TABLE bookmarks (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, url TEXT, title TEXT, description TEXT, note TEXT,
    content TEXT, summary TEXT, image_url TEXT, favicon_url TEXT, site_name TEXT, screenshot TEXT, favourited INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, crawl_status TEXT NOT NULL DEFAULT 'pending', ai_status TEXT NOT NULL DEFAULT 'pending', crawl_error TEXT,
    created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x');
    CREATE TABLE lists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '📁');
    INSERT INTO bookmarks (type, url, created_at) VALUES ('link', 'https://kept.test/', '2026-01-01T00:00:00.000Z');
    INSERT INTO lists (name) VALUES ('Mia');`);
  old.close();
  const db = openDb(dir, { seed: true });
  const store = createStore(db);
  assert.equal(store.search({ inbox: true }).items.length, 1);
  assert.deepEqual(store.lists().map((l) => l.name), ['Mia'], 'no starter sections added to an existing install');
  store.markRead(1);
  assert.equal(store.get(1).read, true);
});

test('fresh install gets renamable starter sections', () => {
  const db = openDb(null, { seed: true });
  const store = createStore(db);
  assert.deepEqual(store.lists().map((l) => l.name), ['Video', 'Codice']);
});

test('HTTP: read/snooze/digest/rediscover endpoints and bookmarklet /save', async (t) => {
  const ctx = setup();
  const server = createServer({ ...ctx });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'content-type': 'application/json' };
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: json, body: JSON.stringify(body ?? {}) });

  const s = await (await post('/api/lists', { name: 'Ricette', icon: '🍳' })).json();
  const { token } = await (await fetch(`${base}/api/bookmarklet`)).json();
  assert.match(token, /^[0-9a-f]{32}$/);

  let res = await fetch(`${base}/save?url=${encodeURIComponent('https://pasta.test/carbonara')}&list=${s.id}`);
  assert.equal(res.status, 401, 'no token, no save');
  res = await fetch(`${base}/save?token=${token}&url=${encodeURIComponent('https://pasta.test/carbonara')}&title=Carbonara&list=${s.id}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Salvato/);
  res = await fetch(`${base}/save?token=${token}&url=${encodeURIComponent('https://pasta.test/carbonara')}`);
  assert.match(await res.text(), /già salvato/);

  const list = await (await fetch(`${base}/api/bookmarks?list=${s.id}`)).json();
  assert.equal(list.items.length, 1);
  const id = list.items[0].id;
  assert.equal(list.items[0].title, 'Carbonara');

  assert.equal((await (await fetch(`${base}/api/digest`)).json()).unread, 1);
  assert.equal((await (await fetch(`${base}/api/rediscover`)).json()).length, 1);
  assert.equal((await (await post(`/api/bookmarks/${id}/snooze`, { days: 3 })).json()).snoozed, true);
  assert.equal((await (await fetch(`${base}/api/bookmarks?inbox=true`)).json()).items.length, 0);
  assert.equal((await (await post(`/api/bookmarks/${id}/read`, {})).json()).read, true);
  assert.equal((await (await post(`/api/bookmarks/${id}/opened`)).json()).open_count, 1);
  assert.deepEqual(await (await post('/api/bookmarks/bulk', { ids: [id], action: 'unread' })).json(), { changed: 1 });

  res = await fetch(`${base}/api/import?list=${s.id}`, { method: 'POST', body: 'https://pasta.test/amatriciana\nhttps://pasta.test/carbonara' });
  assert.deepEqual(await res.json(), { found: 2, created: 1, duplicates: 1, invalid: 0 });
  assert.equal((await (await fetch(`${base}/api/lists`)).json())[0].count, 2);

  res = await fetch(`${base}/api/lists/${s.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ name: 'Primi piatti' }) });
  assert.equal((await res.json()).name, 'Primi piatti');
});
