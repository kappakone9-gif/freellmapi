import crypto from 'node:crypto';
import { tx } from './db.js';

export class NotFound extends Error {}
export class BadRequest extends Error {}

const now = () => new Date().toISOString();
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
const dayNumber = () => Math.floor(Date.now() / 86400000);

// Section rules: comma/newline separated. "#tag" matches a tag, anything with a
// dot is a domain (subdomains included), anything else is a keyword searched in
// the title, URL and description.
export function parseRules(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean)
    .map((r) => {
      if (r.startsWith('#')) return { kind: 'tag', value: r.slice(1).trim() };
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(r.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))) {
        return { kind: 'domain', value: r.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') };
      }
      return { kind: 'keyword', value: r };
    });
}

export function matchesRules(rules, { url, title, description, tags = [] }) {
  let host = '';
  try {
    host = url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {}
  const text = `${title || ''} ${url || ''} ${description || ''}`.toLowerCase();
  return rules.some((r) => {
    if (r.kind === 'tag') return tags.includes(r.value);
    if (r.kind === 'domain') return host === r.value || host.endsWith(`.${r.value}`);
    return text.includes(r.value);
  });
}

export function normaliseUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new BadRequest('serve un link');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new BadRequest('link non valido');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new BadRequest('sono supportati solo link http(s)');
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
      read: Boolean(row.read_at),
      snoozed: Boolean(row.snoozed_until && row.snoozed_until > now()),
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

  // Put a bookmark into every section whose rules match it. Only ever adds.
  function applyRules(bookmarkId, onlyListId) {
    const b = q.byId.get(bookmarkId);
    if (!b) return 0;
    const tags = q.tagsFor.all(bookmarkId).map((t) => t.name);
    const lists = db.prepare(`SELECT id, rules FROM lists WHERE rules != ''${onlyListId ? ' AND id = ?' : ''}`).all(...(onlyListId ? [onlyListId] : []));
    let added = 0;
    for (const l of lists) {
      if (matchesRules(parseRules(l.rules), { ...b, tags })) {
        added += Number(db.prepare(`INSERT OR IGNORE INTO list_items VALUES (?, ?)`).run(l.id, bookmarkId).changes);
      }
    }
    return added;
  }

  function enqueue(kind, bookmarkId) {
    db.prepare(`DELETE FROM jobs WHERE kind = ? AND bookmark_id = ? AND status IN ('queued','failed')`).run(kind, bookmarkId);
    q.enqueue.run(kind, bookmarkId);
  }

  const store = {
    get(id, opts = { full: true }) {
      const b = hydrate(q.byId.get(id), opts);
      if (!b) throw new NotFound(`segnalibro ${id} non trovato`);
      return b;
    },

    create({ type, url, title, note, tags = [], listId } = {}) {
      type = type || (url ? 'link' : 'note');
      if (type === 'link') {
        url = normaliseUrl(url);
        const dup = q.byUrl.get(url);
        if (dup) return { bookmark: store.get(dup.id), duplicate: true };
      } else if (type === 'note') {
        if (!String(note || '').trim()) throw new BadRequest('la nota è vuota');
        url = null;
      } else throw new BadRequest('type deve essere link o note');

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
        applyRules(id);
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
      const words = String(page.content || '').split(/\s+/).filter(Boolean).length;
      db.prepare(
        `UPDATE bookmarks SET
           title = COALESCE(title, :title), description = :description, content = :content,
           image_url = :image, favicon_url = :favicon, site_name = :site,
           screenshot = COALESCE(:shot, screenshot), reading_minutes = :minutes,
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
        minutes: words ? Math.max(1, Math.round(words / 220)) : null,
        now: now(),
      });
      applyRules(id);
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
        applyRules(id);
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

    search({ q: text, tag, listId, favourited, archived, type, unread, inbox, maxMinutes, sort = 'newest', limit = 30, cursor } = {}) {
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
      if (unread != null) where.push(unread ? 'b.read_at IS NULL' : 'b.read_at IS NOT NULL');
      if (inbox) {
        where.push(`b.read_at IS NULL AND b.archived = 0 AND (b.snoozed_until IS NULL OR b.snoozed_until <= :now)`);
        params.now = now();
      }
      if (maxMinutes) {
        where.push('b.reading_minutes <= :mm');
        params.mm = Number(maxMinutes);
      }
      if (!params.fts) {
        if (sort === 'oldest') order = 'b.created_at ASC, b.id ASC';
        else if (sort === 'shortest') order = 'COALESCE(b.reading_minutes, 999), b.id DESC';
        else if (sort === 'random') {
          // Stable for the whole day, so paging does not repeat items.
          order = '(b.id * 2654435761 + :seed) % 1000003';
          params.seed = dayNumber();
        }
      }
      // Keyset pagination for the default order; offset for everything else.
      const keyset = !params.fts && !['oldest', 'shortest', 'random'].includes(sort);
      const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
      let offset = 0;
      if (cursor) {
        if (!keyset) offset = Number(cursor) || 0;
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
      if (more) nextCursor = keyset ? String(items.at(-1).id) : String(offset + lim);
      return { items, nextCursor };
    },

    tags() {
      return q.allTags.all();
    },

    renameTag(id, name) {
      name = String(name || '').trim().toLowerCase();
      if (!name) throw new BadRequest('serve un nome');
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
        .prepare(
          `SELECT l.*, COUNT(b.id) AS count,
                  COALESCE(SUM(CASE WHEN b.read_at IS NULL AND b.archived = 0 THEN 1 ELSE 0 END), 0) AS unread
           FROM lists l LEFT JOIN list_items li ON li.list_id = l.id LEFT JOIN bookmarks b ON b.id = li.bookmark_id
           GROUP BY l.id ORDER BY l.position, l.id`,
        )
        .all();
    },
    // Apply a section's rules to every existing bookmark; returns how many were added.
    applyListRules(listId) {
      let added = 0;
      tx(db, () => {
        for (const { id } of db.prepare(`SELECT id FROM bookmarks`).all()) added += applyRules(id, listId);
      });
      return added;
    },
    createList({ name, icon, rules }) {
      if (!String(name || '').trim()) throw new BadRequest('serve un nome');
      const pos = db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM lists`).get().p;
      const row = db
        .prepare(`INSERT INTO lists (name, icon, rules, position) VALUES (?, ?, ?, ?) RETURNING *`)
        .get(String(name).trim(), icon || '📁', String(rules || '').trim(), pos);
      return { ...row, added: row.rules ? store.applyListRules(row.id) : 0 };
    },
    updateList(id, { name, icon, rules, position }) {
      if (name != null && !String(name).trim()) throw new BadRequest('serve un nome');
      const row = db
        .prepare(
          `UPDATE lists SET name = COALESCE(?, name), icon = COALESCE(?, icon), rules = COALESCE(?, rules), position = COALESCE(?, position)
           WHERE id = ? RETURNING *`,
        )
        .get(name == null ? null : String(name).trim(), icon || null, rules == null ? null : String(rules).trim(), position ?? null, id);
      if (!row) throw new NotFound('sezione non trovata');
      return { ...row, added: rules != null && row.rules ? store.applyListRules(row.id) : 0 };
    },
    deleteList(id) {
      db.prepare(`DELETE FROM lists WHERE id = ?`).run(id);
    },
    addToList(listId, bookmarkId) {
      store.get(bookmarkId);
      if (!db.prepare(`SELECT 1 FROM lists WHERE id = ?`).get(listId)) throw new NotFound('sezione non trovata');
      db.prepare(`INSERT OR IGNORE INTO list_items VALUES (?, ?)`).run(listId, bookmarkId);
    },
    removeFromList(listId, bookmarkId) {
      db.prepare(`DELETE FROM list_items WHERE list_id = ? AND bookmark_id = ?`).run(listId, bookmarkId);
    },

    markRead(id, read = true) {
      store.get(id);
      db.prepare(`UPDATE bookmarks SET read_at = ?, snoozed_until = NULL WHERE id = ?`).run(read ? now() : null, id);
      return store.get(id);
    },
    markOpened(id) {
      store.get(id);
      db.prepare(`UPDATE bookmarks SET last_opened_at = ?, open_count = open_count + 1 WHERE id = ?`).run(now(), id);
      return store.get(id);
    },
    snooze(id, days) {
      store.get(id);
      const until = days ? new Date(Date.now() + Number(days) * 86400000).toISOString() : null;
      db.prepare(`UPDATE bookmarks SET snoozed_until = ? WHERE id = ?`).run(until, id);
      return store.get(id);
    },

    // Forgotten links worth a second look: unread, older than two days first,
    // in an order that stays the same for the whole day ("shuffle" changes it).
    rediscover({ n = 3, shuffle = 0 } = {}) {
      const rows = db
        .prepare(
          `SELECT * FROM bookmarks
           WHERE read_at IS NULL AND archived = 0 AND (snoozed_until IS NULL OR snoozed_until <= :now)
           ORDER BY (created_at < :old) DESC, (id * 2654435761 + :seed) % 1000003
           LIMIT :n`,
        )
        .all({ now: now(), old: daysAgo(2), seed: dayNumber() * 7919 + Number(shuffle) * 104729, n: Math.min(Number(n) || 3, 12) });
      return rows.map((r) => hydrate(r));
    },

    digest() {
      const one = (sql, p = {}) => db.prepare(sql).get(p).n;
      const oldest = db.prepare(`SELECT MIN(created_at) AS d FROM bookmarks WHERE read_at IS NULL AND archived = 0`).get().d;
      return {
        unread: one(`SELECT COUNT(*) n FROM bookmarks WHERE read_at IS NULL AND archived = 0`),
        forgotten: one(`SELECT COUNT(*) n FROM bookmarks WHERE read_at IS NULL AND archived = 0 AND created_at < :d`, { d: daysAgo(30) }),
        neverOpened: one(`SELECT COUNT(*) n FROM bookmarks WHERE open_count = 0 AND archived = 0 AND type = 'link'`),
        readThisWeek: one(`SELECT COUNT(*) n FROM bookmarks WHERE read_at >= :d`, { d: daysAgo(7) }),
        savedThisWeek: one(`SELECT COUNT(*) n FROM bookmarks WHERE created_at >= :d`, { d: daysAgo(7) }),
        quickReads: one(`SELECT COUNT(*) n FROM bookmarks WHERE read_at IS NULL AND archived = 0 AND reading_minutes <= 5`),
        oldestUnreadDays: oldest ? Math.floor((Date.now() - Date.parse(oldest)) / 86400000) : 0,
      };
    },

    bulk(ids, action, { listId } = {}) {
      if (!Array.isArray(ids) || !ids.length) throw new BadRequest('nessun segnalibro selezionato');
      const actions = {
        read: (id) => db.prepare(`UPDATE bookmarks SET read_at = COALESCE(read_at, ?) WHERE id = ?`).run(now(), id),
        unread: (id) => db.prepare(`UPDATE bookmarks SET read_at = NULL WHERE id = ?`).run(id),
        archive: (id) => db.prepare(`UPDATE bookmarks SET archived = 1 WHERE id = ?`).run(id),
        unarchive: (id) => db.prepare(`UPDATE bookmarks SET archived = 0 WHERE id = ?`).run(id),
        delete: (id) => q.del.run(id),
        addToList: (id) => db.prepare(`INSERT OR IGNORE INTO list_items VALUES (?, ?)`).run(listId, id),
        removeFromList: (id) => db.prepare(`DELETE FROM list_items WHERE list_id = ? AND bookmark_id = ?`).run(listId, id),
      };
      const fn = actions[action];
      if (!fn) throw new BadRequest(`azione sconosciuta: ${action}`);
      if (action.endsWith('List') && !db.prepare(`SELECT 1 FROM lists WHERE id = ?`).get(listId)) throw new NotFound('sezione non trovata');
      let changed = 0;
      tx(db, () => {
        for (const id of ids) changed += Number(fn(Number(id)).changes);
        if (action === 'delete') q.pruneTags.run();
      });
      return { changed };
    },

    // "Declutter": archive unread links older than N days (they stay searchable).
    archiveForgotten(days = 30) {
      const d = Math.max(1, Number(days) || 30);
      const { changes } = db
        .prepare(`UPDATE bookmarks SET archived = 1 WHERE read_at IS NULL AND archived = 0 AND created_at < ?`)
        .run(daysAgo(d));
      return { archived: Number(changes) };
    },

    // Secret used by the bookmarklet so a random website cannot save links for you.
    saveToken() {
      let row = db.prepare(`SELECT value FROM meta WHERE key = 'save_token'`).get();
      if (!row) {
        const value = crypto.randomUUID().replace(/-/g, '');
        db.prepare(`INSERT INTO meta (key, value) VALUES ('save_token', ?)`).run(value);
        row = { value };
      }
      return row.value;
    },

    addHighlight(bookmarkId, { text, note }) {
      store.get(bookmarkId);
      if (!String(text || '').trim()) throw new BadRequest('testo vuoto');
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
