import { tx } from './db.js';

export class NotFound extends Error {}
export class BadRequest extends Error {}

const now = () => new Date().toISOString();

export function normaliseUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new BadRequest('url is required');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new BadRequest('invalid url');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new BadRequest('only http(s) urls are supported');
  u.hash = '';
  for (const p of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_eid$|ref_src$)/i.test(p)) u.searchParams.delete(p);
  }
  return u.href;
}

// Turn free text into an FTS5 query: every word is a quoted prefix term.
function ftsQuery(q) {
  const terms = String(q)
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean);
  return terms.map((t) => `"${t}"*`).join(' ');
}

export function createStore(db) {
  const q = {
    insert: db.prepare(
      `INSERT INTO bookmarks (type, url, title, note, crawl_status, ai_status)
       VALUES (:type, :url, :title, :note, :crawl, :ai) RETURNING id`,
    ),
    byId: db.prepare(`SELECT * FROM bookmarks WHERE id = ?`),
    byUrl: db.prepare(`SELECT id FROM bookmarks WHERE url = ?`),
    del: db.prepare(`DELETE FROM bookmarks WHERE id = ?`),
    tagsFor: db.prepare(
      `SELECT t.name, bt.source FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
       WHERE bt.bookmark_id = ? ORDER BY t.name`,
    ),
    listsFor: db.prepare(`SELECT list_id FROM list_items WHERE bookmark_id = ?`),
    upsertTag: db.prepare(`INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = name RETURNING id`),
    attachTag: db.prepare(`INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source) VALUES (?, ?, ?)`),
    clearTags: db.prepare(`DELETE FROM bookmark_tags WHERE bookmark_id = ? AND source = ?`),
    clearAllTags: db.prepare(`DELETE FROM bookmark_tags WHERE bookmark_id = ?`),
    pruneTags: db.prepare(`DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM bookmark_tags)`),
    allTags: db.prepare(
      `SELECT t.id, t.name, COUNT(bt.bookmark_id) AS count FROM tags t
       LEFT JOIN bookmark_tags bt ON bt.tag_id = t.id GROUP BY t.id ORDER BY count DESC, t.name`,
    ),
    enqueue: db.prepare(`INSERT INTO jobs (kind, bookmark_id) VALUES (?, ?)`),
    highlights: db.prepare(`SELECT * FROM highlights WHERE bookmark_id = ? ORDER BY id`),
  };

  function hydrate(row, { full = false } = {}) {
    if (!row) return null;
    const out = {
      ...row,
      favourited: Boolean(row.favourited),
      archived: Boolean(row.archived),
      tags: q.tagsFor.all(row.id).map((t) => ({ name: t.name, source: t.source })),
      lists: q.listsFor.all(row.id).map((r) => r.list_id),
    };
    if (full) out.highlights = q.highlights.all(row.id);
    else {
      delete out.content;
      out.has_content = Boolean(row.content);
    }
    return out;
  }

  function setTags(bookmarkId, names, source) {
    for (const raw of names) {
      const name = String(raw).trim().toLowerCase();
      if (!name) continue;
      const { id } = q.upsertTag.get(name);
      q.attachTag.run(bookmarkId, id, source);
    }
  }

  function enqueue(kind, bookmarkId) {
    db.prepare(`DELETE FROM jobs WHERE kind = ? AND bookmark_id = ? AND status IN ('queued','failed')`).run(kind, bookmarkId);
    q.enqueue.run(kind, bookmarkId);
  }

  const store = {
    get(id, opts = { full: true }) {
      const b = hydrate(q.byId.get(id), opts);
      if (!b) throw new NotFound(`bookmark ${id} not found`);
      return b;
    },

    create({ type, url, title, note, tags = [], listId } = {}) {
      type = type || (url ? 'link' : 'note');
      if (type === 'link') {
        url = normaliseUrl(url);
        const dup = q.byUrl.get(url);
        if (dup) return { bookmark: store.get(dup.id), duplicate: true };
      } else if (type === 'note') {
        if (!String(note || '').trim()) throw new BadRequest('note text is required');
        url = null;
      } else throw new BadRequest('type must be link or note');

      const id = tx(db, () => {
        const { id } = q.insert.get({
          type,
          url,
          title: title || null,
          note: note || null,
          crawl: type === 'link' ? 'pending' : 'skipped',
          ai: 'pending',
        });
        setTags(id, tags, 'human');
        if (listId) db.prepare(`INSERT OR IGNORE INTO list_items VALUES (?, ?)`).run(listId, id);
        enqueue(type === 'link' ? 'crawl' : 'tag', id);
        return id;
      });
      return { bookmark: store.get(id), duplicate: false };
    },

    update(id, patch) {
      store.get(id);
      const fields = [];
      const params = { id };
      for (const key of ['title', 'note', 'summary']) {
        if (key in patch) {
          fields.push(`${key} = :${key}`);
          params[key] = patch[key] == null ? null : String(patch[key]);
        }
      }
      for (const key of ['favourited', 'archived']) {
        if (key in patch) {
          fields.push(`${key} = :${key}`);
          params[key] = patch[key] ? 1 : 0;
        }
      }
      tx(db, () => {
        if (fields.length) {
          params.now = now();
          db.prepare(`UPDATE bookmarks SET ${fields.join(', ')}, updated_at = :now WHERE id = :id`).run(params);
        }
        if (Array.isArray(patch.tags)) {
          q.clearAllTags.run(id);
          setTags(id, patch.tags, 'human');
          q.pruneTags.run();
        }
      });
      return store.get(id);
    },

    remove(id) {
      store.get(id);
      tx(db, () => {
        q.del.run(id);
        q.pruneTags.run();
      });
    },

    recrawl(id) {
      const b = store.get(id);
      const kind = b.type === 'link' ? 'crawl' : 'tag';
      db.prepare(
        `UPDATE bookmarks SET ${kind === 'crawl' ? "crawl_status='pending', crawl_error=NULL," : ''} ai_status='pending' WHERE id=?`,
      ).run(id);
      enqueue(kind, id);
      return store.get(id);
    },

    retag(id) {
      store.get(id);
      db.prepare(`UPDATE bookmarks SET ai_status='pending' WHERE id=?`).run(id);
      enqueue('tag', id);
      return store.get(id);
    },

    // Called by the crawl worker.
    saveCrawl(id, page, screenshotFile) {
      db.prepare(
        `UPDATE bookmarks SET
           title = COALESCE(title, :title), description = :description, content = :content,
           image_url = :image, favicon_url = :favicon, site_name = :site,
           screenshot = COALESCE(:shot, screenshot),
           crawl_status = 'done', crawl_error = NULL, updated_at = :now
         WHERE id = :id`,
      ).run({
        id,
        title: page.title || null,
        description: page.description || null,
        content: page.content || null,
        image: page.imageUrl || null,
        favicon: page.faviconUrl || null,
        site: page.siteName || null,
        shot: screenshotFile || null,
        now: now(),
      });
      enqueue('tag', id);
    },

    failCrawl(id, error) {
      db.prepare(`UPDATE bookmarks SET crawl_status='failed', crawl_error=?, updated_at=? WHERE id=?`).run(
        String(error).slice(0, 500),
        now(),
        id,
      );
      // Still try to tag from whatever we have (URL, user title/note).
      enqueue('tag', id);
    },

    saveAi(id, { tags, summary }) {
      tx(db, () => {
        q.clearTags.run(id, 'ai');
        setTags(id, tags, 'ai');
        db.prepare(`UPDATE bookmarks SET summary = COALESCE(NULLIF(:summary, ''), summary), ai_status='done', updated_at=:now WHERE id=:id`).run({
          id,
          summary: summary || '',
          now: now(),
        });
        q.pruneTags.run();
      });
    },

    setAiStatus(id, status) {
      db.prepare(`UPDATE bookmarks SET ai_status=? WHERE id=?`).run(status, id);
    },

    raw(id) {
      return q.byId.get(id);
    },

    tagNames() {
      return q.allTags.all().map((t) => t.name);
    },

    search({ q: text, tag, listId, favourited, archived, type, limit = 30, cursor } = {}) {
      const where = [];
      const params = {};
      let from = 'bookmarks b';
      let order = 'b.id DESC';
      if (text && ftsQuery(text)) {
        from = 'bookmarks_fts f JOIN bookmarks b ON b.id = f.rowid';
        where.push('bookmarks_fts MATCH :fts');
        params.fts = ftsQuery(text);
        order = 'bm25(bookmarks_fts, 10, 4, 4, 1, 3, 2), b.id DESC';
      }
      if (tag) {
        where.push(`b.id IN (SELECT bt.bookmark_id FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE t.name = :tag)`);
        params.tag = String(tag).toLowerCase();
      }
      if (listId) {
        where.push('b.id IN (SELECT bookmark_id FROM list_items WHERE list_id = :list)');
        params.list = Number(listId);
      }
      if (favourited != null) {
        where.push('b.favourited = :fav');
        params.fav = favourited ? 1 : 0;
      }
      if (archived != null) {
        where.push('b.archived = :arch');
        params.arch = archived ? 1 : 0;
      }
      if (type) {
        where.push('b.type = :type');
        params.type = type;
      }
      // Keyset pagination only for chronological order; relevance search uses offset.
      const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
      let offset = 0;
      if (cursor) {
        if (params.fts) offset = Number(cursor) || 0;
        else {
          where.push('b.id < :cursor');
          params.cursor = Number(cursor);
        }
      }
      const sql = `SELECT b.* FROM ${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY ${order} LIMIT ${lim + 1} OFFSET ${offset}`;
      const rows = db.prepare(sql).all(params);
      const more = rows.length > lim;
      const items = rows.slice(0, lim).map((r) => hydrate(r));
      let nextCursor = null;
      if (more) nextCursor = params.fts ? String(offset + lim) : String(items.at(-1).id);
      return { items, nextCursor };
    },

    tags() {
      return q.allTags.all();
    },

    renameTag(id, name) {
      name = String(name || '').trim().toLowerCase();
      if (!name) throw new BadRequest('name is required');
      const existing = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(name);
      tx(db, () => {
        if (existing && existing.id !== Number(id)) {
          // Merge into the existing tag.
          db.prepare(`INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source)
                      SELECT bookmark_id, ?, source FROM bookmark_tags WHERE tag_id = ?`).run(existing.id, id);
          db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
        } else {
          db.prepare(`UPDATE tags SET name = ? WHERE id = ?`).run(name, id);
        }
      });
    },

    deleteTag(id) {
      db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
    },

    lists() {
      return db
        .prepare(`SELECT l.*, COUNT(li.bookmark_id) AS count FROM lists l LEFT JOIN list_items li ON li.list_id = l.id GROUP BY l.id ORDER BY l.name`)
        .all();
    },
    createList({ name, icon }) {
      if (!String(name || '').trim()) throw new BadRequest('name is required');
      return db.prepare(`INSERT INTO lists (name, icon) VALUES (?, ?) RETURNING *`).get(String(name).trim(), icon || '📁');
    },
    updateList(id, { name, icon }) {
      const row = db.prepare(`UPDATE lists SET name = COALESCE(?, name), icon = COALESCE(?, icon) WHERE id = ? RETURNING *`).get(name ?? null, icon ?? null, id);
      if (!row) throw new NotFound('list not found');
      return row;
    },
    deleteList(id) {
      db.prepare(`DELETE FROM lists WHERE id = ?`).run(id);
    },
    addToList(listId, bookmarkId) {
      store.get(bookmarkId);
      if (!db.prepare(`SELECT 1 FROM lists WHERE id = ?`).get(listId)) throw new NotFound('list not found');
      db.prepare(`INSERT OR IGNORE INTO list_items VALUES (?, ?)`).run(listId, bookmarkId);
    },
    removeFromList(listId, bookmarkId) {
      db.prepare(`DELETE FROM list_items WHERE list_id = ? AND bookmark_id = ?`).run(listId, bookmarkId);
    },

    addHighlight(bookmarkId, { text, note }) {
      store.get(bookmarkId);
      if (!String(text || '').trim()) throw new BadRequest('text is required');
      return db.prepare(`INSERT INTO highlights (bookmark_id, text, note) VALUES (?, ?, ?) RETURNING *`).get(bookmarkId, String(text), note || null);
    },
    deleteHighlight(id) {
      db.prepare(`DELETE FROM highlights WHERE id = ?`).run(id);
    },

    stats() {
      return {
        bookmarks: db.prepare(`SELECT COUNT(*) n FROM bookmarks`).get().n,
        queued: db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running')`).get().n,
        failed: db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'failed'`).get().n,
      };
    },

    exportAll() {
      return db.prepare(`SELECT * FROM bookmarks ORDER BY id`).all().map((r) => hydrate(r, { full: true }));
    },
  };
  return store;
}
