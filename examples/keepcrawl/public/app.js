import { esc, renderMarkdown } from './markdown.js';

const $ = (sel, root = document) => root.querySelector(sel);
const state = { route: {}, items: [], cursor: null, lists: [], tags: [], current: null, pollTimer: null };

// ---------- API
function apiKey() {
  try {
    return localStorage.getItem('keepcrawl.key') || '';
  } catch {
    return '';
  }
}
async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  const key = apiKey();
  if (key) headers.authorization = `Bearer ${key}`;
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    const k = prompt('This KeepCrawl server needs an API key:');
    if (k) {
      try {
        localStorage.setItem('keepcrawl.key', k);
      } catch {}
      return api(path, { method, body, raw });
    }
    throw new Error('unauthorised');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const assetUrl = (file) => `/assets/${encodeURIComponent(file)}${apiKey() ? `?key=${encodeURIComponent(apiKey())}` : ''}`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- routing
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  return { page: page || 'home', arg: arg ? decodeURIComponent(arg) : null };
}

function routeQuery(r, q) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (r.page === 'home') p.set('archived', 'false');
  if (r.page === 'favourites') p.set('favourited', 'true');
  if (r.page === 'archive') p.set('archived', 'true');
  if (r.page === 'notes') p.set('type', 'note');
  if (r.page === 'tag') p.set('tag', r.arg);
  if (r.page === 'list') p.set('list', r.arg);
  return p;
}

function routeTitle(r, q) {
  if (q) return `Search: “${q}”`;
  if (r.page === 'favourites') return 'Favourites';
  if (r.page === 'archive') return 'Archive';
  if (r.page === 'notes') return 'Notes';
  if (r.page === 'tag') return `#${r.arg}`;
  if (r.page === 'list') {
    const l = state.lists.find((x) => String(x.id) === r.arg);
    return l ? `${l.icon} ${l.name}` : 'List';
  }
  return 'All bookmarks';
}

async function render() {
  state.route = parseRoute();
  const r = state.route;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.page));
  document.querySelectorAll('#lists a').forEach((a) => a.classList.toggle('active', r.page === 'list' && a.dataset.id === r.arg));
  $('#sidebar').classList.remove('open');
  $('#load-more').hidden = true;

  if (r.page === 'tags') return renderTags();
  if (r.page === 'import') return renderImport();

  const q = $('#search').value.trim();
  $('#view-title').textContent = routeTitle(r, q);
  const data = await api(`/api/bookmarks?${routeQuery(r, q)}`);
  state.items = data.items;
  state.cursor = data.nextCursor;
  renderGrid();
}

async function loadMore() {
  const p = routeQuery(state.route, $('#search').value.trim());
  p.set('cursor', state.cursor);
  const data = await api(`/api/bookmarks?${p}`);
  state.items.push(...data.items);
  state.cursor = data.nextCursor;
  renderGrid();
}

// ---------- views
function statusPill(b) {
  if (b.crawl_status === 'pending') return '<span class="pill"><span class="spin">⟳</span> crawling</span>';
  if (b.crawl_status === 'failed') return '<span class="pill failed">crawl failed</span>';
  if (b.ai_status === 'pending') return '<span class="pill"><span class="spin">✦</span> tagging</span>';
  return '';
}

function tagChips(b, { removable = false } = {}) {
  return b.tags
    .map((t) => `<a class="tag ${t.source === 'ai' ? 'ai' : ''}" href="#/tag/${encodeURIComponent(t.name)}" title="${t.source === 'ai' ? 'AI tag' : 'Your tag'}">#${esc(t.name)}${removable ? `<span class="x" data-remove-tag="${esc(t.name)}">×</span>` : ''}</a>`)
    .join('');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function card(b) {
  const img = b.image_url || (b.screenshot ? assetUrl(b.screenshot) : null);
  const thumb = img
    ? `<div class="thumb" style="background-image:url('${esc(img.replace(/['"()\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`))}')"></div>`
    : `<div class="thumb">${b.type === 'note' ? '📝' : '🔗'}</div>`;
  const plain = (t) => String(t || '').replace(/[*_`#>]+/g, '').trim();
  const title = b.title || (b.type === 'note' ? plain(b.note?.split('\n')[0]) : b.url) || 'Untitled';
  const snippetText = (s) => (b.type === 'note' && s === b.note ? plain(s) : s);
  const snippet = b.summary || b.description || (b.type === 'note' ? b.note : '') || '';
  return `<article class="card" data-id="${b.id}">
    ${thumb}
    <div class="body">
      <div class="title">${b.favourited ? '⭐ ' : ''}${esc(title)}</div>
      ${snippet ? `<div class="snippet">${esc(snippetText(snippet))}</div>` : ''}
      <div class="tags">${tagChips(b)}</div>
      <div class="meta">
        ${b.favicon_url ? `<img src="${esc(b.favicon_url)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        <span class="grow">${esc(b.site_name || hostOf(b.url) || 'note')}</span>
        ${statusPill(b)}
        <span>${new Date(b.created_at).toLocaleDateString()}</span>
      </div>
    </div>
  </article>`;
}

function renderGrid() {
  const view = $('#view');
  if (!state.items.length) {
    view.innerHTML = `<div class="empty">Nothing here yet. Paste a link above to save it — Firecrawl fetches the page and the AI tags it for you.</div>`;
  } else {
    view.innerHTML = `<div class="grid">${state.items.map(card).join('')}</div>`;
  }
  $('#load-more').hidden = !state.cursor;
  schedulePoll();
}

async function renderTags() {
  $('#view-title').textContent = 'Tags';
  state.tags = await api('/api/tags');
  $('#view').innerHTML = state.tags.length
    ? `<p class="status">Teal tags were added by the AI, purple ones by you. Click a tag to browse; use the ✎ to rename or merge.</p>
       <div class="tag-cloud">${state.tags
         .map((t) => `<span><a class="tag" href="#/tag/${encodeURIComponent(t.name)}">#${esc(t.name)} <small>${t.count}</small></a><button class="icon-btn" data-rename-tag="${t.id}" title="Rename / merge">✎</button><button class="icon-btn" data-delete-tag="${t.id}" title="Delete tag">🗑</button></span>`)
         .join('')}</div>`
    : '<div class="empty">No tags yet.</div>';
}

function renderImport() {
  $('#view-title').textContent = 'Import';
  $('#view').innerHTML = `<div class="box">
    <p>Upload a browser bookmarks export (Netscape HTML from Chrome, Firefox, Safari, Pocket…) or a text file with one URL per line. Each link is crawled and tagged in the background.</p>
    <input type="file" id="import-file" accept=".html,.htm,.txt">
    <p>…or paste URLs:</p>
    <textarea id="import-text" rows="6" placeholder="https://example.com/one\nhttps://example.com/two"></textarea>
    <p><button class="primary" id="import-go">Import</button></p>
    <div id="import-result"></div>
  </div>`;
}

// ---------- detail drawer
async function openBookmark(id) {
  const b = await api(`/api/bookmarks/${id}`);
  state.current = b;
  renderDrawer(b, 'reader');
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-backdrop').hidden = false;
  schedulePoll();
}

function closeDrawer() {
  state.current = null;
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-backdrop').hidden = true;
}

function applyHighlights(html, highlights) {
  let out = html;
  for (const h of highlights) {
    const needle = esc(h.text.trim());
    if (needle.length < 3) continue;
    const i = out.indexOf(needle);
    if (i >= 0) out = `${out.slice(0, i)}<mark>${needle}</mark>${out.slice(i + needle.length)}`;
  }
  return out;
}

function renderDrawer(b, tab = state.tab || 'reader') {
  state.tab = tab;
  const listOptions = state.lists
    .map((l) => `<label><input type="checkbox" data-list-toggle="${l.id}" ${b.lists.includes(l.id) ? 'checked' : ''}> ${esc(l.icon)} ${esc(l.name)}</label>`)
    .join(' ');
  let body = '';
  if (tab === 'reader') {
    if (b.type === 'note') body = `<div class="reader">${renderMarkdown(b.note)}</div>`;
    else if (b.content) body = `<div class="reader" id="reader">${applyHighlights(renderMarkdown(b.content), b.highlights)}</div>`;
    else body = `<div class="empty">${b.crawl_status === 'pending' ? 'Fetching the page with Firecrawl…' : 'No content was extracted for this page.'}</div>`;
  } else if (tab === 'screenshot') {
    body = b.screenshot ? `<img class="shot" src="${assetUrl(b.screenshot)}" alt="Screenshot of the page">` : '<div class="empty">No screenshot.</div>';
  } else if (tab === 'highlights') {
    body = b.highlights.length
      ? b.highlights.map((h) => `<div class="highlight-item"><span>${esc(h.text)}</span><button class="icon-btn" data-delete-hl="${h.id}">🗑</button></div>`).join('')
      : '<div class="empty">Select text in the reader view and press “Highlight” to save it.</div>';
  } else if (tab === 'note') {
    body = `<textarea id="note-edit" rows="10" placeholder="Your notes about this bookmark (markdown)">${esc(b.note || '')}</textarea><p><button id="note-save" class="primary">Save note</button></p>`;
  }

  $('#drawer').innerHTML = `
    <div class="row" style="justify-content:space-between">
      <span class="pill">${b.type === 'note' ? 'note' : esc(b.site_name || hostOf(b.url))}</span>
      <button class="icon-btn" id="drawer-close" aria-label="Close">✕</button>
    </div>
    <h2 contenteditable="true" id="title-edit" spellcheck="false">${esc(b.title || (b.type === 'note' ? 'Note' : b.url))}</h2>
    ${b.url ? `<a class="url" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.url)}</a>` : ''}
    <div class="actions">
      <button data-act="fav">${b.favourited ? '★ Unfavourite' : '☆ Favourite'}</button>
      <button data-act="archive">${b.archived ? '📤 Unarchive' : '🗄️ Archive'}</button>
      ${b.type === 'link' ? '<button data-act="recrawl">⟳ Re-crawl</button>' : ''}
      <button data-act="retag">✦ Re-tag with AI</button>
      <button data-act="delete" class="danger">🗑 Delete</button>
      ${statusPill(b)}
    </div>
    ${b.crawl_error ? `<div class="box"><b>Crawl error:</b> ${esc(b.crawl_error)}</div>` : ''}
    ${b.summary ? `<div class="box ai"><h3>✦ AI summary</h3>${esc(b.summary)}</div>` : ''}
    <div class="box">
      <h3>Tags</h3>
      <div class="tags">${tagChips(b, { removable: true })}</div>
      <form id="tag-form" class="row" style="margin-top:8px"><input id="tag-input" placeholder="Add tags, comma separated" style="flex:1"><button>Add</button></form>
    </div>
    ${state.lists.length ? `<div class="box"><h3>Lists</h3><div class="row">${listOptions}</div></div>` : ''}
    <div class="tabs">
      ${['reader', 'screenshot', 'highlights', 'note'].map((t) => `<button data-tab="${t}" class="${t === tab ? 'active' : ''}">${{ reader: '📖 Reader', screenshot: '🖼️ Screenshot', highlights: `🖍️ Highlights (${b.highlights.length})`, note: '✏️ Note' }[t]}</button>`).join('')}
    </div>
    <div style="padding-top:14px">${body}</div>`;
}

async function refreshCurrent() {
  if (!state.current) return;
  const b = await api(`/api/bookmarks/${state.current.id}`);
  state.current = b;
  renderDrawer(b);
  const i = state.items.findIndex((x) => x.id === b.id);
  if (i >= 0) {
    state.items[i] = b;
    renderGrid();
  }
}

// Poll while something is still being crawled or tagged.
function schedulePoll() {
  clearTimeout(state.pollTimer);
  const busy = (b) => b && (b.crawl_status === 'pending' || b.ai_status === 'pending');
  if (!state.items.some(busy) && !busy(state.current)) return;
  state.pollTimer = setTimeout(async () => {
    try {
      const ids = new Set(state.items.filter(busy).map((b) => b.id));
      for (const id of ids) {
        const b = await api(`/api/bookmarks/${id}`);
        const i = state.items.findIndex((x) => x.id === id);
        if (i >= 0) state.items[i] = b;
      }
      if (busy(state.current)) {
        state.current = await api(`/api/bookmarks/${state.current.id}`);
        renderDrawer(state.current);
      }
      renderGrid();
      loadStatus();
    } catch {}
  }, 2500);
}

// ---------- sidebar
async function loadLists() {
  state.lists = await api('/api/lists');
  $('#lists').innerHTML = state.lists
    .map((l) => `<a href="#/list/${l.id}" data-id="${l.id}">${esc(l.icon)} ${esc(l.name)} <span class="count">${l.count}</span></a>`)
    .join('') || '<div class="status">No lists yet</div>';
}
async function loadStatus() {
  try {
    const s = await api('/api/status');
    $('#status').innerHTML = `${s.bookmarks} bookmarks<br>crawler: ${esc(s.crawler)}<br>AI: ${s.ai ? esc(s.ai.model) : 'off'}${s.queued ? `<br>${s.queued} jobs queued` : ''}${s.failed ? `<br>${s.failed} failed jobs` : ''}`;
  } catch {}
}

// ---------- events
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#composer-input');
  const text = input.value.trim();
  if (!text) return;
  const isUrl = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+\S*$/i.test(text) && !/\s/.test(text);
  try {
    const out = await api('/api/bookmarks', { method: 'POST', body: isUrl ? { type: 'link', url: text } : { type: 'note', note: text } });
    input.value = '';
    toast(out.duplicate ? 'Already saved — opening it' : isUrl ? 'Saved! Crawling…' : 'Note saved');
    if (out.duplicate) openBookmark(out.bookmark.id);
    else await render();
    loadStatus();
  } catch (err) {
    toast(err.message);
  }
});
$('#composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (['tags', 'import'].includes(state.route.page)) location.hash = '#/';
    else render();
  }, 250);
});

$('#load-more').addEventListener('click', loadMore);
$('#menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
  if (e.key === '/' && document.activeElement === document.body) {
    e.preventDefault();
    $('#search').focus();
  }
});

$('#new-list').addEventListener('click', async () => {
  const name = prompt('List name');
  if (!name) return;
  const icon = prompt('Emoji icon', '📁') || '📁';
  await api('/api/lists', { method: 'POST', body: { name, icon } });
  loadLists();
});

$('#export-link').addEventListener('click', async (e) => {
  e.preventDefault();
  const data = await api('/api/export');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = 'keepcrawl-export.json';
  a.click();
});

$('#view').addEventListener('click', async (e) => {
  const c = e.target.closest('.card');
  if (c && !e.target.closest('a')) return openBookmark(Number(c.dataset.id));

  const rename = e.target.closest('[data-rename-tag]');
  if (rename) {
    const t = state.tags.find((x) => String(x.id) === rename.dataset.renameTag);
    const name = prompt('Rename tag (use an existing name to merge)', t?.name);
    if (name) {
      await api(`/api/tags/${rename.dataset.renameTag}`, { method: 'PATCH', body: { name } });
      renderTags();
    }
  }
  const del = e.target.closest('[data-delete-tag]');
  if (del && confirm('Delete this tag from every bookmark?')) {
    await api(`/api/tags/${del.dataset.deleteTag}`, { method: 'DELETE' });
    renderTags();
  }
  if (e.target.id === 'import-go') {
    const file = $('#import-file').files[0];
    const text = file ? await file.text() : $('#import-text').value;
    if (!text.trim()) return;
    const r = await api('/api/import', { method: 'POST', body: text, raw: true });
    $('#import-result').textContent = `Found ${r.found} links: ${r.created} added, ${r.duplicates} already saved, ${r.invalid} skipped.`;
    loadStatus();
  }
});

$('#drawer').addEventListener('click', async (e) => {
  const b = state.current;
  if (!b) return;
  if (e.target.id === 'drawer-close') return closeDrawer();
  const tab = e.target.closest('[data-tab]');
  if (tab) return renderDrawer(b, tab.dataset.tab);
  const removeTag = e.target.closest('[data-remove-tag]');
  if (removeTag) {
    e.preventDefault();
    const tags = b.tags.map((t) => t.name).filter((n) => n !== removeTag.dataset.removeTag);
    await api(`/api/bookmarks/${b.id}`, { method: 'PATCH', body: { tags } });
    return refreshCurrent();
  }
  const hl = e.target.closest('[data-delete-hl]');
  if (hl) {
    await api(`/api/highlights/${hl.dataset.deleteHl}`, { method: 'DELETE' });
    return refreshCurrent();
  }
  if (e.target.id === 'note-save') {
    await api(`/api/bookmarks/${b.id}`, { method: 'PATCH', body: { note: $('#note-edit').value } });
    toast('Note saved');
    return refreshCurrent();
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'fav') await api(`/api/bookmarks/${b.id}`, { method: 'PATCH', body: { favourited: !b.favourited } });
  if (act === 'archive') await api(`/api/bookmarks/${b.id}`, { method: 'PATCH', body: { archived: !b.archived } });
  if (act === 'recrawl') await api(`/api/bookmarks/${b.id}/recrawl`, { method: 'POST' });
  if (act === 'retag') await api(`/api/bookmarks/${b.id}/retag`, { method: 'POST' });
  if (act === 'delete') {
    if (!confirm('Delete this bookmark?')) return;
    await api(`/api/bookmarks/${b.id}`, { method: 'DELETE' });
    closeDrawer();
    return render();
  }
  await refreshCurrent();
  if (act === 'archive') render();
});

$('#drawer').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-list-toggle]');
  if (!t || !state.current) return;
  await api(`/api/lists/${t.dataset.listToggle}/bookmarks/${state.current.id}`, { method: t.checked ? 'PUT' : 'DELETE' });
  loadLists();
});

$('#drawer').addEventListener('submit', async (e) => {
  if (e.target.id !== 'tag-form') return;
  e.preventDefault();
  const add = $('#tag-input').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!add.length) return;
  const tags = [...new Set([...state.current.tags.map((t) => t.name), ...add])];
  await api(`/api/bookmarks/${state.current.id}`, { method: 'PATCH', body: { tags } });
  refreshCurrent();
});

$('#drawer').addEventListener('focusout', async (e) => {
  if (e.target.id !== 'title-edit' || !state.current) return;
  const title = e.target.textContent.trim();
  if (title && title !== state.current.title) {
    await api(`/api/bookmarks/${state.current.id}`, { method: 'PATCH', body: { title } });
    toast('Title updated');
  }
});

// Highlighting: select text in the reader, then click the floating button.
let hlButton;
document.addEventListener('mouseup', () => {
  hlButton?.remove();
  const sel = window.getSelection();
  const reader = $('#reader');
  if (!reader || !sel || sel.isCollapsed || !reader.contains(sel.anchorNode)) return;
  const text = sel.toString().trim();
  if (text.length < 3) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  hlButton = document.createElement('button');
  hlButton.className = 'hl-btn primary';
  hlButton.textContent = '🖍 Highlight';
  hlButton.style.top = `${rect.top + window.scrollY - 40}px`;
  hlButton.style.left = `${rect.left + window.scrollX}px`;
  hlButton.addEventListener('mousedown', async (ev) => {
    ev.preventDefault();
    await api(`/api/bookmarks/${state.current.id}/highlights`, { method: 'POST', body: { text } });
    hlButton.remove();
    toast('Highlighted');
    refreshCurrent();
  });
  document.body.appendChild(hlButton);
});

window.addEventListener('hashchange', () => render().catch((e) => toast(e.message)));

(async function init() {
  await Promise.all([loadLists(), loadStatus()]);
  await render();
})().catch((e) => toast(e.message));
