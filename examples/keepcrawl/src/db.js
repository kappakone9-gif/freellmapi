import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bookmarks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL CHECK (type IN ('link','note')),
  url           TEXT,
  title         TEXT,
  description   TEXT,
  note          TEXT,
  content       TEXT,           -- markdown extracted by the crawler
  summary       TEXT,           -- AI summary
  image_url     TEXT,
  favicon_url   TEXT,
  site_name     TEXT,
  screenshot    TEXT,           -- file name under data/assets
  favourited    INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  crawl_status  TEXT NOT NULL DEFAULT 'pending',  -- pending|done|failed|skipped
  ai_status     TEXT NOT NULL DEFAULT 'pending',  -- pending|done|failed|skipped
  crawl_error   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_url ON bookmarks(url) WHERE url IS NOT NULL;

CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS bookmark_tags (
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'human',  -- human|ai
  PRIMARY KEY (bookmark_id, tag_id)
);

CREATE TABLE IF NOT EXISTS lists (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  icon   TEXT NOT NULL DEFAULT '📁'
);

CREATE TABLE IF NOT EXISTS list_items (
  list_id     INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, bookmark_id)
);

CREATE TABLE IF NOT EXISTS highlights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,          -- crawl|tag
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  run_after   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
  title, description, note, content, summary, url,
  content='bookmarks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS bookmarks_ai AFTER INSERT ON bookmarks BEGIN
  INSERT INTO bookmarks_fts(rowid, title, description, note, content, summary, url)
  VALUES (new.id, new.title, new.description, new.note, new.content, new.summary, new.url);
END;
CREATE TRIGGER IF NOT EXISTS bookmarks_ad AFTER DELETE ON bookmarks BEGIN
  INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, description, note, content, summary, url)
  VALUES ('delete', old.id, old.title, old.description, old.note, old.content, old.summary, old.url);
END;
DROP TRIGGER IF EXISTS bookmarks_au;
CREATE TRIGGER bookmarks_au AFTER UPDATE OF title, description, note, content, summary, url ON bookmarks BEGIN
  INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, description, note, content, summary, url)
  VALUES ('delete', old.id, old.title, old.description, old.note, old.content, old.summary, old.url);
  INSERT INTO bookmarks_fts(rowid, title, description, note, content, summary, url)
  VALUES (new.id, new.title, new.description, new.note, new.content, new.summary, new.url);
END;
`;

// Columns added after the first release; applied to old and new databases alike.
const COLUMNS = [
  ['bookmarks', 'read_at', 'TEXT'],
  ['bookmarks', 'last_opened_at', 'TEXT'],
  ['bookmarks', 'open_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['bookmarks', 'snoozed_until', 'TEXT'],
  ['bookmarks', 'reading_minutes', 'INTEGER'],
  ['lists', 'rules', "TEXT NOT NULL DEFAULT ''"],
  ['lists', 'position', 'INTEGER NOT NULL DEFAULT 0'],
];

// Example sections for a brand-new install. Rename or delete them freely.
const STARTER_SECTIONS = [
  { name: 'Video', icon: '🎬', rules: 'youtube.com, youtu.be, vimeo.com, twitch.tv, tiktok.com' },
  { name: 'Codice', icon: '💻', rules: 'github.com, gitlab.com, stackoverflow.com, #programming' },
];

export function openDb(dataDir, { seed = false } = {}) {
  let file = ':memory:';
  if (dataDir) {
    fs.mkdirSync(path.join(dataDir, 'assets'), { recursive: true });
    file = path.join(dataDir, 'keepcrawl.db');
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  for (const [table, col, def] of COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS bookmarks_inbox ON bookmarks(archived, read_at, created_at)`);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) {
    const empty = db.prepare(`SELECT (SELECT COUNT(*) FROM lists) + (SELECT COUNT(*) FROM bookmarks) AS n`).get().n === 0;
    if (seed && empty) {
      const ins = db.prepare(`INSERT INTO lists (name, icon, rules, position) VALUES (?, ?, ?, ?)`);
      STARTER_SECTIONS.forEach((s, i) => ins.run(s.name, s.icon, s.rules, i));
    }
    db.exec('PRAGMA user_version = 1');
  }
  // Jobs left "running" by a crash go back to the queue.
  db.prepare(`UPDATE jobs SET status='queued' WHERE status='running'`).run();
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
