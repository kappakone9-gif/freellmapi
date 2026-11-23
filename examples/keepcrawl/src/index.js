import { config } from './config.js';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { createCrawler } from './crawler.js';
import { createTagger } from './ai.js';
import { createWorker } from './worker.js';
import { createServer } from './server.js';

const db = openDb(config.dataDir, { seed: true });
const store = createStore(db);
const crawler = createCrawler(config);
const tagger = createTagger(config);
const worker = createWorker({ db, store, crawler, tagger, config });
const server = createServer({ store, worker, config, crawler, tagger });

server.listen(config.port, config.host, () => {
  console.log(`KeepCrawl listening on http://${config.host}:${config.port}`);
  console.log(`  crawler: ${crawler.usesFirecrawl ? `Firecrawl (${config.firecrawl.baseUrl})` : 'plain fetch (set FIRECRAWL_API_KEY for Firecrawl)'}`);
  console.log(`  ai:      ${tagger.enabled ? `${config.llm.model} @ ${config.llm.baseUrl}` : 'disabled'}`);
  console.log(`  data:    ${config.dataDir}`);
  worker.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    worker.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
