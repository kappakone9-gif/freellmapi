import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createStore, normaliseUrl } from '../src/store.js';
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
