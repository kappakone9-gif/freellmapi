import fs from 'node:fs';
import path from 'node:path';

// A small SQLite-backed job queue: crawl jobs fetch the page via Firecrawl,
// then enqueue a tag job that asks the LLM for tags + a summary.

export function createWorker({ db, store, crawler, tagger, config, log = console }) {
  const { concurrency, pollMs, maxAttempts } = config.worker;
  let running = 0;
  let timer = null;
  let stopped = true;

  const claim = db.prepare(
    `UPDATE jobs SET status='running', attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY id LIMIT 1)
     RETURNING *`,
  );
  const finish = db.prepare(`UPDATE jobs SET status='done', error=NULL WHERE id=?`);
  const retry = db.prepare(
    `UPDATE jobs SET status='queued', error=?, run_after=strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) WHERE id=?`,
  );
  const fail = db.prepare(`UPDATE jobs SET status='failed', error=? WHERE id=?`);
  const cleanup = db.prepare(`DELETE FROM jobs WHERE status='done' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')`);

  async function saveScreenshot(bookmarkId, screenshotUrl) {
    if (!screenshotUrl || !config.dataDir) return null;
    try {
      let buf;
      let ext = 'png';
      if (screenshotUrl.startsWith('data:')) {
        const m = /^data:image\/(\w+);base64,(.*)$/s.exec(screenshotUrl);
        if (!m) return null;
        ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        buf = Buffer.from(m[2], 'base64');
      } else {
        const res = await fetch(screenshotUrl, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) return null;
        const type = res.headers.get('content-type') || '';
        if (type.includes('jpeg')) ext = 'jpg';
        else if (type.includes('webp')) ext = 'webp';
        buf = Buffer.from(await res.arrayBuffer());
      }
      const file = `shot-${bookmarkId}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(config.dataDir, 'assets', file), buf);
      return file;
    } catch (err) {
      log.warn(`[worker] screenshot for #${bookmarkId} not saved: ${err.message}`);
      return null;
    }
  }

  async function runCrawl(job) {
    const b = store.raw(job.bookmark_id);
    if (!b) return;
    const page = await crawler.scrape(b.url);
    const shot = await saveScreenshot(b.id, page.screenshotUrl);
    store.saveCrawl(b.id, page, shot);
    log.info(`[worker] crawled #${b.id} via ${page.source}: ${page.title || b.url}`);
  }

  async function runTag(job) {
    const b = store.raw(job.bookmark_id);
    if (!b) return;
    if (!tagger.enabled) {
      store.setAiStatus(b.id, 'skipped');
      return;
    }
    const result = await tagger.analyse(b, store.tagNames());
    store.saveAi(b.id, result);
    log.info(`[worker] tagged #${b.id}: ${result.tags.join(', ')}`);
  }

  async function handle(job) {
    try {
      if (job.kind === 'crawl') await runCrawl(job);
      else if (job.kind === 'tag') await runTag(job);
      finish.run(job.id);
    } catch (err) {
      const retryable = err.retryable !== false;
      if (retryable && job.attempts < maxAttempts) {
        const backoff = `+${30 * 2 ** (job.attempts - 1)} seconds`;
        retry.run(err.message, backoff, job.id);
        log.warn(`[worker] ${job.kind} #${job.bookmark_id} failed (attempt ${job.attempts}), retrying: ${err.message}`);
      } else {
        fail.run(err.message, job.id);
        if (job.kind === 'crawl') store.failCrawl(job.bookmark_id, err.message);
        else store.setAiStatus(job.bookmark_id, 'failed');
        log.error(`[worker] ${job.kind} #${job.bookmark_id} failed: ${err.message}`);
      }
    }
  }

  function tick() {
    if (stopped) return;
    while (running < concurrency) {
      const job = claim.get();
      if (!job) break;
      running++;
      handle(job).finally(() => {
        running--;
        tick();
      });
    }
  }

  return {
    start() {
      stopped = false;
      timer = setInterval(() => {
        tick();
        cleanup.run();
      }, pollMs);
      timer.unref?.();
      tick();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    poke: tick,
    // For tests: process the queue until it is empty.
    async drain() {
      for (;;) {
        const job = claim.get();
        if (!job) {
          if (running === 0) return;
          await new Promise((r) => setTimeout(r, 5));
          continue;
        }
        await handle(job);
      }
    },
  };
}
