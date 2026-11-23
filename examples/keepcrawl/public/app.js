import { esc, renderMarkdown } from './markdown.js';

const $ = (sel, root = document) => root.querySelector(sel);
const state = {
  route: {},
  items: [],
  cursor: null,
  sections: [],
  tags: [],
  current: null,
  tab: 'reader',
  pollTimer: null,
  shuffle: 0,
  triage: null,
};

// ---------- preferences (per browser, best effort)
const prefs = (() => {
  let p = {};
  try {
    p = JSON.parse(localStorage.getItem('keepcrawl.prefs') || '{}');
  } catch {}
  return {
    get: (k, d) => (k in p ? p[k] : d),
    set: (k, v) => {
      p[k] = v;
      try {
        localStorage.setItem('keepcrawl.prefs', JSON.stringify(p));
      } catch {}
    },
  };
})();

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
    const k = prompt('Questo server KeepCrawl richiede una chiave API:');
    if (k) {
      try {
        localStorage.setItem('keepcrawl.key', k);
      } catch {}
      return api(path, { method, body, raw });
    }
    throw new Error('non autorizzato');
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
  toast.timer = setTimeout(() => (t.hidden = true), 2800);
}

// ---------- helpers
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
function ago(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days <= 0) return 'oggi';
  if (days === 1) return 'ieri';
  if (days < 14) return `${days} giorni fa`;
  if (days < 60) return `${Math.round(days / 7)} settimane fa`;
  if (days < 365) return `${Math.round(days / 30)} mesi fa`;
  const y = Math.round(days / 365);
  return y === 1 ? 'un anno fa' : `${y} anni fa`;
}
const ageDays = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);
const plain = (t) => String(t || '').replace(/[*_`#>]+/g, '').trim();
const sectionById = (id) => state.sections.find((s) => String(s.id) === String(id));

function extractUrls(text) {
  const urls = text.match(/https?:\/\/[^\s<>"]+/gi) || [];
  if (!urls.length && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text.trim())) urls.push(text.trim());
  return [...new Set(urls.map((u) => u.replace(/[),.;!?]+$/, '')))];
}

// ---------- routing
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  return { page: page || 'inbox', arg: arg ? decodeURIComponent(arg) : null };
}

const LIST_VIEWS = ['inbox', 'all', 'read', 'favourites', 'archive', 'notes', 'tag', 'section'];

function viewQuery(r, q) {
  const p = new URLSearchParams();
  if (q) {
    p.set('q', q);
    return p;
  }
  p.set('sort', prefs.get('sort', 'newest'));
  if (prefs.get('quick', false)) p.set('maxMinutes', '5');
  const hideRead = prefs.get('hideRead', false);
  if (r.page === 'inbox') p.set('inbox', 'true');
  if (r.page === 'all') {
    p.set('archived', 'false');
    if (hideRead) p.set('unread', 'true');
  }
  if (r.page === 'read') p.set('unread', 'false');
  if (r.page === 'favourites') p.set('favourited', 'true');
  if (r.page === 'archive') p.set('archived', 'true');
  if (r.page === 'notes') p.set('type', 'note');
  if (r.page === 'tag') p.set('tag', r.arg);
  if (r.page === 'section') p.set('list', r.arg);
  if (['favourites', 'tag', 'section', 'notes'].includes(r.page) && hideRead) p.set('unread', 'true');
  return p;
}

function viewTitle(r, q) {
  if (q) return `🔎 Risultati per “${esc(q)}”`;
  return (
    {
      inbox: '📥 Da leggere',
      all: '📚 Tutti i link',
      read: '✅ Letti',
      favourites: '⭐ Preferiti',
      archive: '🗄️ Archivio',
      notes: '📝 Note',
      tag: `🏷️ #${esc(r.arg)}`,
    }[r.page] ||
    (r.page === 'section' && sectionById(r.arg) ? `${esc(sectionById(r.arg).icon)} ${esc(sectionById(r.arg).name)}` : '')
  );
}

async function render() {
  state.route = parseRoute();
  const r = state.route;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.page));
  document.querySelectorAll('#sections a').forEach((a) => a.classList.toggle('active', r.page === 'section' && a.dataset.id === r.arg));
  $('#sidebar').classList.remove('open');
  $('#load-more').hidden = true;
  fillComposerSections();

  if (r.page === 'tags') return renderTags();
  if (r.page === 'import') return renderImport();
  if (r.page === 'bookmarklet') return renderBookmarklet();
  if (r.page === 'triage') return renderTriage();
  if (!LIST_VIEWS.includes(r.page)) return (location.hash = '#/');

  const q = $('#search').value.trim();
  let header = '';
  if (r.page === 'inbox' && !q) header += await digestHtml();
  header += `<div class="view-head"><h1>${viewTitle(r, q)}</h1>${r.page === 'section' && !q ? sectionHeadExtras(sectionById(r.arg)) : ''}</div>`;
  if (!q) header += toolbarHtml(r);
  $('#header').innerHTML = header;

  const data = await api(`/api/bookmarks?${viewQuery(r, q)}`);
  state.items = data.items;
  state.cursor = data.nextCursor;
  renderGrid();
}

async function loadMore() {
  const p = viewQuery(state.route, $('#search').value.trim());
  p.set('cursor', state.cursor);
  const data = await api(`/api/bookmarks?${p}`);
  state.items.push(...data.items);
  state.cursor = data.nextCursor;
  renderGrid();
}

// ---------- inbox extras: digest + rediscovery
async function digestHtml() {
  const [d, again] = await Promise.all([api('/api/digest'), api(`/api/rediscover?n=3&shuffle=${state.shuffle}`)]);
  if (!d.unread) {
    return `<div class="digest done">🎉 <b>Inbox vuota.</b> Non hai link arretrati: tutto letto, archiviato o smistato.</div>`;
  }
  const bits = [`<b>${d.unread}</b> link da leggere`];
  if (d.forgotten) bits.push(`<b>${d.forgotten}</b> dimenticati da oltre 30 giorni`);
  if (d.oldestUnreadDays > 1) bits.push(`il più vecchio aspetta da <b>${d.oldestUnreadDays} giorni</b>`);
  const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const week = `Questa settimana: ${pl(d.savedThisWeek, 'salvato', 'salvati')}, ${pl(d.readThisWeek, 'letto', 'letti')}.`;
  const out = `<div class="digest">
    <div>${bits.join(' · ')}<br><small>${week}</small></div>
    <div class="digest-actions">
      <a class="btn primary" href="#/triage">🔀 Smaltisci 5 minuti</a>
      ${d.quickReads ? `<button data-quick-on>⚡ Solo letture brevi (${d.quickReads})</button>` : ''}
      ${d.forgotten ? `<button data-archive-forgotten>🗄️ Archivia i ${d.forgotten} dimenticati</button>` : ''}
    </div>
  </div>`;
  const redisc = again.length
    ? `<section class="rediscover">
        <div class="view-head"><h2>✨ Riscoperti per te oggi</h2><button class="chip" data-reshuffle>🔄 Altri</button></div>
        <div class="grid">${again.map((b) => card(b, { big: true })).join('')}</div>
      </section>`
    : '';
  return out + redisc;
}

function toolbarHtml(r) {
  const sort = prefs.get('sort', 'newest');
  const quick = prefs.get('quick', false);
  const hideRead = prefs.get('hideRead', false);
  const canHideRead = ['all', 'favourites', 'tag', 'section', 'notes'].includes(r.page);
  return `<div class="toolbar">
    <label>Ordina
      <select data-sort>
        ${[['newest', 'Più recenti'], ['oldest', 'Più vecchi prima'], ['random', 'A caso'], ['shortest', 'Più brevi prima']]
          .map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`)
          .join('')}
      </select>
    </label>
    <button class="chip ${quick ? 'on' : ''}" data-toggle-pref="quick" title="Solo letture da 5 minuti o meno">⚡ ≤ 5 min</button>
    ${canHideRead ? `<button class="chip ${hideRead ? 'on' : ''}" data-toggle-pref="hideRead">🙈 Nascondi letti</button>` : ''}
  </div>`;
}

function sectionHeadExtras(s) {
  if (!s) return '';
  const rules = s.rules
    ? `<span class="rules" title="Smistamento automatico">⚙️ ${s.rules.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => `<span class="pill">${esc(x)}</span>`).join(' ')}</span>`
    : '';
  return `<button class="chip" data-edit-section="${s.id}">✏️ Rinomina / regole</button>${rules}`;
}

// ---------- cards
function statusPill(b) {
  if (b.crawl_status === 'pending') return '<span class="pill"><span class="spin">⟳</span> scarico…</span>';
  if (b.crawl_status === 'failed') return '<span class="pill failed">non scaricato</span>';
  if (b.ai_status === 'pending') return '<span class="pill"><span class="spin">✦</span> l’AI legge…</span>';
  return '';
}

function tagChips(b, { removable = false } = {}) {
  return b.tags
    .map((t) => `<a class="tag ${t.source === 'ai' ? 'ai' : ''}" href="#/tag/${encodeURIComponent(t.name)}" title="${t.source === 'ai' ? 'Tag dell’AI' : 'Tag tuo'}">#${esc(t.name)}${removable ? `<span class="x" data-remove-tag="${esc(t.name)}" aria-label="Rimuovi">×</span>` : ''}</a>`)
    .join('');
}

function sectionChips(b) {
  return b.lists
    .map((id) => sectionById(id))
    .filter(Boolean)
    .map((s) => `<a class="tag section" href="#/section/${s.id}">${esc(s.icon)} ${esc(s.name)}</a>`)
    .join('');
}

function card(b, { big = false } = {}) {
  const img = b.image_url || (b.screenshot ? assetUrl(b.screenshot) : null);
  const thumb = img
    ? `<div class="thumb" style="background-image:url('${esc(img.replace(/['"()\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`))}')"></div>`
    : `<div class="thumb">${b.type === 'note' ? '📝' : '🔗'}</div>`;
  const title = b.title || (b.type === 'note' ? plain(b.note?.split('\n')[0]) : b.url) || 'Senza titolo';
  const snippet = b.summary || b.description || (b.type === 'note' ? plain(b.note) : '') || '';
  const days = ageDays(b.created_at);
  const forgotten = !b.read && b.type === 'link' && days >= 30;
  return `<article class="card ${b.read ? 'is-read' : ''} ${big ? 'big' : ''}" data-id="${b.id}" draggable="true">
    ${thumb}
    <div class="quick" role="toolbar" aria-label="Azioni rapide">
      <button data-quick="read" title="${b.read ? 'Segna come da leggere' : 'Segna come letto'}">${b.read ? '↩️' : '✓'}</button>
      <button data-quick="archive" title="${b.archived ? 'Togli dall’archivio' : 'Archivia'}">${b.archived ? '📤' : '🗄️'}</button>
      <button data-quick="section" title="Metti in una sezione">📁</button>
    </div>
    <div class="body">
      <div class="title">${b.favourited ? '⭐ ' : ''}${esc(title)}</div>
      ${snippet ? `<div class="snippet">${b.summary ? '<b class="tldr">TL;DR</b> ' : ''}${esc(snippet)}</div>` : ''}
      <div class="tags">${sectionChips(b)}${tagChips(b)}</div>
      <div class="meta">
        ${b.favicon_url ? `<img src="${esc(b.favicon_url)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        <span class="grow">${esc(b.site_name || hostOf(b.url) || 'nota')}</span>
        ${statusPill(b)}
        ${b.reading_minutes ? `<span title="Tempo di lettura">⏱ ${b.reading_minutes} min</span>` : ''}
        ${forgotten ? `<span class="pill old" title="Salvato ${ago(b.created_at)} e mai letto">🕸️ ${ago(b.created_at)}</span>` : `<span>${ago(b.created_at)}</span>`}
        ${b.read ? '<span class="pill readpill">letto</span>' : ''}
      </div>
    </div>
  </article>`;
}

function renderGrid() {
  const view = $('#view');
  const r = state.route;
  if (!state.items.length) {
    const msg = {
      inbox: 'Niente da leggere qui. Copia un link e premi Ctrl+V per salvarlo.',
      section: 'Questa sezione è vuota. Trascina qui un link dalla lista, usa il pulsante 📁 su una scheda, oppure aggiungi una regola di smistamento automatico.',
      read: 'Non hai ancora segnato niente come letto.',
    }[r.page] || 'Nessun link qui.';
    view.innerHTML = `<div class="empty">${msg}</div>`;
  } else {
    view.innerHTML = `<div class="grid">${state.items.map((b) => card(b)).join('')}</div>`;
  }
  $('#load-more').hidden = !state.cursor;
  schedulePoll();
}

function replaceItem(b) {
  const i = state.items.findIndex((x) => x.id === b.id);
  if (i >= 0) state.items[i] = b;
}

// Does the item still belong in the current view after a change?
function stillVisible(b) {
  const p = state.route.page;
  if ($('#search').value.trim()) return true;
  if (p === 'inbox') return !b.read && !b.archived && !b.snoozed;
  if (p === 'archive') return b.archived;
  if (p === 'all') return !b.archived && !(prefs.get('hideRead', false) && b.read);
  if (p === 'read') return b.read;
  if (p === 'section') return b.lists.includes(Number(state.route.arg));
  return true;
}

async function afterChange(b, message) {
  if (state.route.page === 'inbox' && !$('#search').value.trim()) {
    // The digest and the "rediscovered" row depend on read state: redraw all.
    if (message) toast(message);
    await render();
    return refreshSidebar();
  }
  if (stillVisible(b)) replaceItem(b);
  else state.items = state.items.filter((x) => x.id !== b.id);
  renderGrid();
  if (message) toast(message);
  refreshSidebar();
}

// ---------- tags / import / bookmarklet
async function renderTags() {
  $('#header').innerHTML = '<div class="view-head"><h1>🏷️ Tag</h1></div>';
  state.tags = await api('/api/tags');
  $('#view').innerHTML = state.tags.length
    ? `<p class="hint">I tag verdi li ha messi l’AI, quelli viola tu. Clicca un tag per vederne i link; ✎ per rinominarlo (usa un nome esistente per unirli).</p>
       <div class="tag-cloud">${state.tags
         .map((t) => `<span><a class="tag" href="#/tag/${encodeURIComponent(t.name)}">#${esc(t.name)} <small>${t.count}</small></a><button class="icon-btn" data-rename-tag="${t.id}" title="Rinomina / unisci">✎</button><button class="icon-btn" data-delete-tag="${t.id}" title="Elimina tag">🗑</button></span>`)
         .join('')}</div>`
    : '<div class="empty">Ancora nessun tag.</div>';
}

function renderImport() {
  $('#header').innerHTML = '<div class="view-head"><h1>⬆️ Importa</h1></div>';
  $('#view').innerHTML = `<div class="box">
    <p>Carica l’esportazione dei preferiti del browser (HTML da Chrome, Firefox, Safari, Pocket…) oppure un file di testo con un link per riga. Ogni link viene scaricato e taggato in background.</p>
    <input type="file" id="import-file" accept=".html,.htm,.txt">
    <p>…oppure incolla i link:</p>
    <textarea id="import-text" rows="6" placeholder="https://esempio.it/uno&#10;https://esempio.it/due"></textarea>
    <p class="row">Metti in <select id="import-section"><option value="">nessuna sezione</option>${state.sections.map((s) => `<option value="${s.id}">${esc(s.icon)} ${esc(s.name)}</option>`).join('')}</select>
    <button class="primary" id="import-go">Importa</button></p>
    <div id="import-result"></div>
  </div>`;
}

async function renderBookmarklet() {
  $('#header').innerHTML = '<div class="view-head"><h1>🔖 Salva dal browser con un clic</h1></div>';
  const { token } = await api('/api/bookmarklet');
  const js = (listId) =>
    `javascript:(()=>{window.open(${JSON.stringify(`${location.origin}/save?token=${token}${listId ? `&list=${listId}` : ''}&url=`)}+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'keepcrawl','width=420,height=260')})()`;
  const link = (label, listId) => `<a class="bookmarklet" href="${esc(js(listId))}" draggable="true" onclick="event.preventDefault();alert('Trascinami nella barra dei preferiti!')">${label}</a>`;
  $('#view').innerHTML = `<div class="box">
    <p>Trascina questo pulsante nella <b>barra dei preferiti</b> del browser. Quando sei su una pagina che vuoi tenere, cliccalo: viene salvata senza aprire KeepCrawl.</p>
    <p>${link('➕ Salva in KeepCrawl')}</p>
    ${state.sections.length ? `<p>Oppure un pulsante per ogni sezione, per salvare direttamente lì:</p><p class="row">${state.sections.map((s) => link(`${esc(s.icon)} ${esc(s.name)}`, s.id)).join(' ')}</p>` : ''}
    <p class="hint">Il pulsante contiene un codice segreto: non condividerlo. Se rinomini una sezione il pulsante continua a funzionare.</p>
  </div>`;
}

// ---------- triage ("smaltisci"): one link at a time
async function renderTriage() {
  $('#header').innerHTML = `<div class="view-head"><h1>🔀 Smaltisci</h1></div>
    <p class="hint">Un link alla volta, dal più vecchio. Decidi in pochi secondi: lo leggi, lo archivi, lo metti in una sezione o lo rimandi. Scorciatoie da tastiera tra parentesi.</p>`;
  if (!state.triage || state.triage.done) {
    const data = await api('/api/bookmarks?inbox=true&sort=oldest&limit=100');
    state.triage = { queue: data.items, i: 0, done: false, stats: { read: 0, archived: 0, filed: 0, deleted: 0, later: 0 } };
  }
  drawTriage();
}

function drawTriage() {
  const t = state.triage;
  const b = t.queue[t.i];
  if (!b) {
    t.done = true;
    const s = t.stats;
    $('#view').innerHTML = `<div class="triage-card done">
      <div style="font-size:48px">🎉</div>
      <h2>${t.queue.length ? 'Fatto!' : 'Inbox già vuota'}</h2>
      ${t.queue.length ? `<p>${s.read} letti · ${s.archived} archiviati · ${s.filed} smistati · ${s.later} rimandati · ${s.deleted} eliminati</p>` : '<p>Non c’è niente da smaltire.</p>'}
      <a class="btn primary" href="#/">Torna a “Da leggere”</a>
    </div>`;
    refreshSidebar();
    return;
  }
  const img = b.image_url || (b.screenshot ? assetUrl(b.screenshot) : null);
  $('#view').innerHTML = `<div class="triage-card" data-id="${b.id}">
    <div class="progress"><div style="width:${Math.round((t.i / t.queue.length) * 100)}%"></div></div>
    <div class="triage-meta">${t.i + 1} di ${t.queue.length} · salvato ${ago(b.created_at)}${b.reading_minutes ? ` · ⏱ ${b.reading_minutes} min` : ''} · ${esc(b.site_name || hostOf(b.url) || 'nota')}</div>
    ${img ? `<img class="triage-img" src="${esc(img)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <h2>${esc(b.title || plain(b.note) || b.url)}</h2>
    ${b.summary ? `<p class="triage-summary"><b class="tldr">TL;DR</b> ${esc(b.summary)}</p>` : b.description ? `<p class="triage-summary">${esc(b.description)}</p>` : ''}
    <div class="tags">${sectionChips(b)}${tagChips(b)}</div>
    <div class="triage-actions">
      <button data-triage="open" class="primary">📖 Leggi ora <kbd>L</kbd></button>
      <button data-triage="read">✓ Già letto / non serve leggerlo <kbd>F</kbd></button>
      <button data-triage="archive">🗄️ Archivia <kbd>A</kbd></button>
      <button data-triage="later">⏰ Fra una settimana <kbd>P</kbd></button>
      <button data-triage="skip">⏭ Salta <kbd>S</kbd></button>
      <button data-triage="delete" class="danger">🗑 Elimina <kbd>D</kbd></button>
    </div>
    ${state.sections.length ? `<div class="triage-sections"><span>📁 Metti in:</span> ${state.sections.slice(0, 9).map((s, i) => `<button data-triage-section="${s.id}">${esc(s.icon)} ${esc(s.name)} <kbd>${i + 1}</kbd></button>`).join('')} <button data-triage="new-section">＋ Nuova</button></div>` : ''}
  </div>`;
}

async function triageAction(action, sectionId) {
  const t = state.triage;
  const b = t?.queue[t.i];
  if (!b) return;
  if (action === 'open') {
    await openBookmark(b.id);
    return;
  }
  if (action === 'read') {
    await api(`/api/bookmarks/${b.id}/read`, { method: 'POST', body: { read: true } });
    t.stats.read++;
  } else if (action === 'archive') {
    await api(`/api/bookmarks/${b.id}`, { method: 'PATCH', body: { archived: true } });
    t.stats.archived++;
  } else if (action === 'later') {
    await api(`/api/bookmarks/${b.id}/snooze`, { method: 'POST', body: { days: 7 } });
    t.stats.later++;
  } else if (action === 'delete') {
    await api(`/api/bookmarks/${b.id}`, { method: 'DELETE' });
    t.stats.deleted++;
  } else if (action === 'section') {
    await api(`/api/lists/${sectionId}/bookmarks/${b.id}`, { method: 'PUT' });
    t.stats.filed++;
    toast(`Messo in ${sectionById(sectionId)?.name || 'sezione'}`);
  } else if (action === 'new-section') {
    const s = await openSectionDialog(null);
    if (s) await triageAction('section', s.id);
    return;
  }
  t.i++;
  drawTriage();
}

// ---------- detail drawer
async function openBookmark(id) {
  const b = await api(`/api/bookmarks/${id}/opened`, { method: 'POST' });
  state.current = b;
  renderDrawer(b, 'reader');
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-backdrop').hidden = false;
  schedulePoll();
}

function closeDrawer({ navigating = false } = {}) {
  if (!state.current) return;
  state.current = null;
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-backdrop').hidden = true;
  if (!navigating && state.route.page === 'triage' && state.triage && !state.triage.done) {
    // Came from triage: move on if the link was dealt with in the drawer.
    api(`/api/bookmarks/${state.triage.queue[state.triage.i].id}`)
      .then((b) => {
        if (b.read || b.archived || b.snoozed) {
          state.triage.stats.read += b.read ? 1 : 0;
          state.triage.i++;
        }
        drawTriage();
      })
      .catch(() => drawTriage());
  }
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
  const sectionOptions = state.sections
    .map((s) => `<label class="check"><input type="checkbox" data-section-toggle="${s.id}" ${b.lists.includes(s.id) ? 'checked' : ''}> ${esc(s.icon)} ${esc(s.name)}</label>`)
    .join('');
  let body = '';
  if (tab === 'reader') {
    if (b.type === 'note') body = `<div class="reader">${renderMarkdown(b.note)}</div>`;
    else if (b.content) body = `<div class="reader" id="reader">${applyHighlights(renderMarkdown(b.content), b.highlights)}</div>`;
    else body = `<div class="empty">${b.crawl_status === 'pending' ? 'Sto scaricando la pagina con Firecrawl…' : 'Non è stato possibile estrarre il testo di questa pagina.'}</div>`;
  } else if (tab === 'screenshot') {
    body = b.screenshot ? `<img class="shot" src="${assetUrl(b.screenshot)}" alt="Screenshot della pagina">` : '<div class="empty">Nessuno screenshot.</div>';
  } else if (tab === 'highlights') {
    body = b.highlights.length
      ? b.highlights.map((h) => `<div class="highlight-item"><span>${esc(h.text)}</span><button class="icon-btn" data-delete-hl="${h.id}" aria-label="Elimina">🗑</button></div>`).join('')
      : '<div class="empty">Seleziona del testo nella vista lettura e premi “Evidenzia”.</div>';
  } else if (tab === 'note') {
    body = `<textarea id="note-edit" rows="10" placeholder="I tuoi appunti su questo link (markdown)">${esc(b.note || '')}</textarea><p><button id="note-save" class="primary">Salva nota</button></p>`;
  }

  $('#drawer').innerHTML = `
    <div class="row" style="justify-content:space-between">
      <span class="pill">${b.type === 'note' ? 'nota' : esc(b.site_name || hostOf(b.url))} · salvato ${ago(b.created_at)}${b.reading_minutes ? ` · ⏱ ${b.reading_minutes} min` : ''}</span>
      <button class="icon-btn" id="drawer-close" aria-label="Chiudi">✕</button>
    </div>
    <h2 contenteditable="true" id="title-edit" spellcheck="false" title="Clicca per rinominare">${esc(b.title || (b.type === 'note' ? 'Nota' : b.url))}</h2>
    ${b.url ? `<a class="url" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" data-open-original>${esc(b.url)} ↗</a>` : ''}
    <div class="actions">
      <button data-act="read" class="${b.read ? '' : 'primary'}">${b.read ? '↩️ Segna come da leggere' : '✓ Segna come letto'}</button>
      ${b.url ? `<a class="btn" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" data-open-original>↗ Apri originale</a>` : ''}
      <button data-act="fav">${b.favourited ? '★ Togli dai preferiti' : '☆ Preferito'}</button>
      <button data-act="archive">${b.archived ? '📤 Togli dall’archivio' : '🗄️ Archivia'}</button>
      ${b.read ? '' : `<button data-act="snooze">${b.snoozed ? '⏰ Rimandato (annulla)' : '⏰ Ricordamelo fra 7 giorni'}</button>`}
      ${b.type === 'link' ? '<button data-act="recrawl">⟳ Riscarica</button>' : ''}
      <button data-act="retag">✦ Rifai tag AI</button>
      <button data-act="delete" class="danger">🗑 Elimina</button>
      ${statusPill(b)}
    </div>
    ${b.crawl_error ? `<div class="box"><b>Errore di scaricamento:</b> ${esc(b.crawl_error)}</div>` : ''}
    ${b.summary ? `<div class="box ai"><h3>✦ TL;DR dell’AI</h3>${esc(b.summary)}</div>` : ''}
    <div class="box">
      <h3>Sezioni</h3>
      <div class="row">${sectionOptions || '<span class="hint">Nessuna sezione.</span>'} <button class="chip" data-new-section-for="${b.id}">＋ Nuova sezione</button></div>
    </div>
    <div class="box">
      <h3>Tag</h3>
      <div class="tags">${tagChips(b, { removable: true })}</div>
      <form id="tag-form" class="row" style="margin-top:8px"><input id="tag-input" placeholder="Aggiungi tag, separati da virgola" style="flex:1"><button>Aggiungi</button></form>
    </div>
    <div class="tabs">
      ${['reader', 'screenshot', 'highlights', 'note'].map((t) => `<button data-tab="${t}" class="${t === tab ? 'active' : ''}">${{ reader: '📖 Lettura', screenshot: '🖼️ Screenshot', highlights: `🖍️ Evidenziati (${b.highlights.length})`, note: '✏️ Nota' }[t]}</button>`).join('')}
    </div>
    <div style="padding-top:14px">${body}</div>
    ${tab === 'reader' && b.content && !b.read ? '<div class="finish"><button data-act="read" class="primary">✓ Finito, segna come letto</button></div>' : ''}`;
}

async function refreshCurrent() {
  if (!state.current) return;
  const b = await api(`/api/bookmarks/${state.current.id}`);
  state.current = b;
  renderDrawer(b);
  if (state.items.some((x) => x.id === b.id)) await afterChange(b);
  else refreshSidebar();
}

// Poll while something is still being crawled or tagged.
function schedulePoll() {
  clearTimeout(state.pollTimer);
  const busy = (b) => b && (b.crawl_status === 'pending' || b.ai_status === 'pending');
  if (!state.items.some(busy) && !busy(state.current)) return;
  state.pollTimer = setTimeout(async () => {
    try {
      for (const b of state.items.filter(busy)) replaceItem(await api(`/api/bookmarks/${b.id}`));
      if (busy(state.current)) {
        state.current = await api(`/api/bookmarks/${state.current.id}`);
        renderDrawer(state.current);
      }
      renderGrid();
      refreshSidebar();
    } catch {}
  }, 2500);
}

// ---------- sidebar & sections
async function refreshSidebar() {
  await Promise.all([loadSections(), loadStatus()]);
}

async function loadSections() {
  state.sections = await api('/api/lists');
  const r = parseRoute();
  $('#sections').innerHTML =
    state.sections
      .map(
        (s) => `<a href="#/section/${s.id}" data-id="${s.id}" class="${r.page === 'section' && r.arg === String(s.id) ? 'active' : ''}" title="Doppio clic per rinominare · trascina qui i link">
          ${esc(s.icon)} ${esc(s.name)}
          <span class="count">${s.unread ? `<b>${s.unread}</b>` : s.count || ''}</span>
          <button class="icon-btn edit" data-edit-section="${s.id}" aria-label="Modifica sezione ${esc(s.name)}">✎</button>
        </a>`,
      )
      .join('') || '<div class="status">Crea una sezione per raccogliere link specifici.</div>';
  fillComposerSections();
}

function fillComposerSections() {
  const sel = $('#composer-section');
  const r = parseRoute();
  // Default to the section being viewed; elsewhere, no section (avoids filing by accident).
  const want = r.page === 'section' ? r.arg : state.route.page === r.page && sel.dataset.page === r.page ? sel.value : '';
  sel.dataset.page = r.page;
  sel.innerHTML = `<option value="">📥 Nessuna sezione</option>${state.sections.map((s) => `<option value="${s.id}">${esc(s.icon)} ${esc(s.name)}</option>`).join('')}`;
  sel.value = sectionById(want) ? want : '';
}

async function loadStatus() {
  try {
    const [s, d] = await Promise.all([api('/api/status'), api('/api/digest')]);
    $('#count-inbox').innerHTML = d.unread ? `<b>${d.unread}</b>` : '';
    $('#status').innerHTML = `${s.bookmarks} link salvati<br>scaricamento: ${esc(s.crawler)}<br>AI: ${s.ai ? esc(s.ai.model) : 'spenta'}${s.queued ? `<br>${s.queued} in lavorazione` : ''}${s.failed ? `<br>${s.failed} falliti` : ''}`;
  } catch {}
}

const EMOJIS = ['📁', '📚', '🎬', '💻', '🍳', '🛒', '✈️', '💼', '🎵', '🧠', '💡', '🏠', '💰', '🎮', '📰', '❤️', '🧪', '🎨'];

// Create (section = null) or edit a section. Resolves with the saved section, or null.
function openSectionDialog(section) {
  const dlg = $('#section-dialog');
  const form = $('#section-form');
  form.name.value = section?.name || '';
  form.icon.value = section?.icon || '📁';
  form.rules.value = section?.rules || '';
  $('#section-dialog-title').textContent = section ? 'Modifica sezione' : 'Nuova sezione';
  $('#section-delete').hidden = !section;
  $('#emoji-picks').innerHTML = EMOJIS.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
  dlg.showModal();
  form.name.focus();
  return new Promise((resolve) => {
    const cleanup = () => {
      form.onsubmit = null;
      $('#section-cancel').onclick = null;
      $('#section-delete').onclick = null;
      dlg.onclose = null;
    };
    dlg.onclose = () => {
      cleanup();
      resolve(null);
    };
    $('#section-cancel').onclick = () => dlg.close();
    $('#section-delete').onclick = async () => {
      if (!confirm(`Eliminare la sezione “${section.name}”? I link restano salvati.`)) return;
      await api(`/api/lists/${section.id}`, { method: 'DELETE' });
      cleanup();
      dlg.close();
      toast('Sezione eliminata');
      await loadSections();
      if (parseRoute().arg === String(section.id)) location.hash = '#/';
      resolve(null);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: form.name.value.trim(), icon: form.icon.value.trim() || '📁', rules: form.rules.value.trim() };
      try {
        const saved = section
          ? await api(`/api/lists/${section.id}`, { method: 'PATCH', body })
          : await api('/api/lists', { method: 'POST', body });
        cleanup();
        dlg.close();
        toast(`Sezione salvata${saved.added ? ` · ${saved.added} link smistati qui` : ''}`);
        await loadSections();
        if (state.route.page === 'section' || saved.added) render();
        resolve(saved);
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

$('#emoji-picks').addEventListener('click', (e) => {
  const b = e.target.closest('[data-emoji]');
  if (b) $('#section-form').icon.value = b.dataset.emoji;
});

// Small popover to put a card into sections.
function openSectionMenu(anchor, b) {
  document.querySelector('.menu-pop')?.remove();
  const pop = document.createElement('div');
  pop.className = 'menu-pop';
  pop.innerHTML = `${state.sections
    .map((s) => `<label class="check"><input type="checkbox" data-pop-section="${s.id}" ${b.lists.includes(s.id) ? 'checked' : ''}> ${esc(s.icon)} ${esc(s.name)}</label>`)
    .join('')}<button data-pop-new>＋ Nuova sezione…</button>`;
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + window.scrollY + 4}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left + window.scrollX - 120, document.documentElement.clientWidth - 230))}px`;
  pop.dataset.id = b.id;
  document.body.appendChild(pop);
}

document.addEventListener('click', async (e) => {
  const pop = document.querySelector('.menu-pop');
  if (!pop) return;
  if (!pop.contains(e.target) && !e.target.closest('[data-quick="section"]')) return pop.remove();
  const id = Number(pop.dataset.id);
  if (e.target.closest('[data-pop-new]')) {
    pop.remove();
    const s = await openSectionDialog(null);
    if (s) {
      await api(`/api/lists/${s.id}/bookmarks/${id}`, { method: 'PUT' });
      await afterChange(await api(`/api/bookmarks/${id}`), `Messo in ${s.name}`);
    }
  }
});
document.addEventListener('change', async (e) => {
  const t = e.target.closest('[data-pop-section]');
  if (!t) return;
  const id = Number(t.closest('.menu-pop').dataset.id);
  await api(`/api/lists/${t.dataset.popSection}/bookmarks/${id}`, { method: t.checked ? 'PUT' : 'DELETE' });
  await afterChange(await api(`/api/bookmarks/${id}`));
});

// ---------- saving links
async function saveText(text, { fromPaste = false } = {}) {
  text = String(text || '').trim();
  if (!text) return false;
  const listId = Number($('#composer-section').value) || undefined;
  const urls = extractUrls(text);
  let rest = text;
  for (const u of urls) rest = rest.replace(u, '');
  rest = rest.trim();
  if (fromPaste && !urls.length) return false;
  try {
    if (urls.length === 1) {
      const out = await api('/api/bookmarks', { method: 'POST', body: { type: 'link', url: urls[0], note: rest.length > 2 ? rest : undefined, listId } });
      if (out.duplicate) {
        if (listId) await api(`/api/lists/${listId}/bookmarks/${out.bookmark.id}`, { method: 'PUT' });
        toast(`Già salvato ${ago(out.bookmark.created_at)}${out.bookmark.read ? '' : ' (e mai letto 😉)'}`);
        openBookmark(out.bookmark.id);
        return true;
      }
      toast(`Salvato${listId ? ` in ${sectionById(listId).name}` : ''}! Lo scarico e lo riassumo…`);
    } else if (urls.length > 1) {
      const r = await api(`/api/import${listId ? `?list=${listId}` : ''}`, { method: 'POST', body: urls.join('\n'), raw: true });
      toast(`${r.created} link salvati${r.duplicates ? `, ${r.duplicates} già presenti` : ''}`);
    } else {
      await api('/api/bookmarks', { method: 'POST', body: { type: 'note', note: text, listId } });
      toast('Nota salvata');
    }
    if (['tags', 'import', 'bookmarklet', 'triage'].includes(state.route.page)) location.hash = '#/';
    else await render();
    refreshSidebar();
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await saveText($('#composer-input').value)) $('#composer-input').value = '';
});
$('#composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#paste-btn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!(await saveText(text, { fromPaste: true }))) toast('Negli appunti non c’è un link');
  } catch {
    toast('Il browser non permette di leggere gli appunti: usa Ctrl+V');
  }
});
// Paste anywhere on the page (outside text fields) saves the link straight away.
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (t.closest?.('input, textarea, [contenteditable="true"], dialog')) return;
  const text = e.clipboardData?.getData('text') || '';
  if (extractUrls(text).length) {
    e.preventDefault();
    saveText(text, { fromPaste: true });
  }
});

// ---------- other events
let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!LIST_VIEWS.includes(state.route.page)) location.hash = '#/all';
    else render();
  }, 250);
});

$('#load-more').addEventListener('click', loadMore);
$('#menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#drawer-backdrop').addEventListener('click', closeDrawer);
$('#new-section').addEventListener('click', () => openSectionDialog(null));

document.addEventListener('keydown', (e) => {
  if ($('#section-dialog').open) return;
  if (e.key === 'Escape') {
    document.querySelector('.menu-pop')?.remove();
    return closeDrawer();
  }
  const typing = document.activeElement?.closest?.('input, textarea, select, [contenteditable="true"]');
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    $('#search').focus();
    return;
  }
  if (state.route.page === 'triage' && !state.current && state.triage && !state.triage.done) {
    const k = e.key.toLowerCase();
    const map = { l: 'open', f: 'read', a: 'archive', p: 'later', s: 'skip', d: 'delete' };
    if (map[k]) {
      e.preventDefault();
      if (k === 'd' && !confirm('Eliminare questo link?')) return;
      triageAction(map[k]);
    } else if (/^[1-9]$/.test(k) && state.sections[Number(k) - 1]) {
      triageAction('section', state.sections[Number(k) - 1].id);
    }
  }
});

$('#export-link').addEventListener('click', async (e) => {
  e.preventDefault();
  const data = await api('/api/export');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = 'keepcrawl-export.json';
  a.click();
});

// Sidebar: edit sections (✎ or double-click) and drop cards onto them.
$('#sections').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit-section]');
  if (edit) {
    e.preventDefault();
    openSectionDialog(sectionById(edit.dataset.editSection));
  }
});
$('#sections').addEventListener('dblclick', (e) => {
  const a = e.target.closest('a[data-id]');
  if (a) {
    e.preventDefault();
    openSectionDialog(sectionById(a.dataset.id));
  }
});
$('#sections').addEventListener('dragover', (e) => {
  const a = e.target.closest('a[data-id]');
  if (!a || !e.dataTransfer.types.includes('text/keepcrawl-id')) return;
  e.preventDefault();
  a.classList.add('drop');
});
$('#sections').addEventListener('dragleave', (e) => e.target.closest('a[data-id]')?.classList.remove('drop'));
$('#sections').addEventListener('drop', async (e) => {
  const a = e.target.closest('a[data-id]');
  const id = Number(e.dataTransfer.getData('text/keepcrawl-id'));
  if (!a || !id) return;
  e.preventDefault();
  a.classList.remove('drop');
  await api(`/api/lists/${a.dataset.id}/bookmarks/${id}`, { method: 'PUT' });
  await afterChange(await api(`/api/bookmarks/${id}`), `Messo in ${sectionById(a.dataset.id).name}`);
});
document.addEventListener('dragstart', (e) => {
  const c = e.target.closest?.('.card');
  if (c) {
    e.dataTransfer.setData('text/keepcrawl-id', c.dataset.id);
    e.dataTransfer.effectAllowed = 'copy';
    document.body.classList.add('dragging');
  }
});
document.addEventListener('dragend', () => document.body.classList.remove('dragging'));

// Header (digest, toolbar, section header) actions.
$('#header').addEventListener('click', async (e) => {
  const tog = e.target.closest('[data-toggle-pref]');
  if (tog) {
    prefs.set(tog.dataset.togglePref, !prefs.get(tog.dataset.togglePref, false));
    return render();
  }
  if (e.target.closest('[data-quick-on]')) {
    prefs.set('quick', true);
    return render();
  }
  if (e.target.closest('[data-reshuffle]')) {
    state.shuffle++;
    return render();
  }
  const edit = e.target.closest('[data-edit-section]');
  if (edit) return openSectionDialog(sectionById(edit.dataset.editSection));
  if (e.target.closest('[data-archive-forgotten]')) {
    if (!confirm('Archiviare tutti i link non letti salvati più di 30 giorni fa? Restano cercabili nell’Archivio.')) return;
    const r = await api('/api/archive-forgotten', { method: 'POST', body: { days: 30 } });
    toast(`${r.archived} link archiviati. Inbox più leggera!`);
    render();
    refreshSidebar();
    return;
  }
  const c = e.target.closest('.card');
  if (c) return handleCardClick(e, c);
});
$('#header').addEventListener('change', (e) => {
  if (e.target.matches('[data-sort]')) {
    prefs.set('sort', e.target.value);
    render();
  }
});

async function handleCardClick(e, c) {
  const id = Number(c.dataset.id);
  const quick = e.target.closest('[data-quick]')?.dataset.quick;
  if (!quick) {
    if (!e.target.closest('a')) openBookmark(id);
    return;
  }
  e.stopPropagation();
  const b = state.items.find((x) => x.id === id) || (await api(`/api/bookmarks/${id}`));
  if (quick === 'section') return openSectionMenu(e.target.closest('button'), b);
  if (quick === 'read') {
    const nb = await api(`/api/bookmarks/${id}/read`, { method: 'POST', body: { read: !b.read } });
    return afterChange(nb, nb.read ? '✓ Letto' : 'Di nuovo da leggere');
  }
  if (quick === 'archive') {
    const nb = await api(`/api/bookmarks/${id}`, { method: 'PATCH', body: { archived: !b.archived } });
    return afterChange(nb, nb.archived ? '🗄️ Archiviato' : 'Tolto dall’archivio');
  }
}

$('#view').addEventListener('click', async (e) => {
  const c = e.target.closest('.card');
  if (c) return handleCardClick(e, c);

  const tr = e.target.closest('[data-triage]');
  if (tr) {
    if (tr.dataset.triage === 'delete' && !confirm('Eliminare questo link?')) return;
    return triageAction(tr.dataset.triage);
  }
  const trs = e.target.closest('[data-triage-section]');
  if (trs) return triageAction('section', Number(trs.dataset.triageSection));

  const rename = e.target.closest('[data-rename-tag]');
  if (rename) {
    const t = state.tags.find((x) => String(x.id) === rename.dataset.renameTag);
    const name = prompt('Rinomina il tag (usa un nome esistente per unirli)', t?.name);
    if (name) {
      await api(`/api/tags/${rename.dataset.renameTag}`, { method: 'PATCH', body: { name } });
      renderTags();
    }
  }
  const del = e.target.closest('[data-delete-tag]');
  if (del && confirm('Togliere questo tag da tutti i link?')) {
    await api(`/api/tags/${del.dataset.deleteTag}`, { method: 'DELETE' });
    renderTags();
  }
  if (e.target.id === 'import-go') {
    const file = $('#import-file').files[0];
    const text = file ? await file.text() : $('#import-text').value;
    if (!text.trim()) return;
    const list = $('#import-section').value;
    const r = await api(`/api/import${list ? `?list=${list}` : ''}`, { method: 'POST', body: text, raw: true });
    $('#import-result').textContent = `Trovati ${r.found} link: ${r.created} aggiunti, ${r.duplicates} già salvati, ${r.invalid} scartati.`;
    refreshSidebar();
  }
});

$('#drawer').addEventListener('click', async (e) => {
  const b = state.current;
  if (!b) return;
  if (e.target.id === 'drawer-close') return closeDrawer();
  if (e.target.closest('[data-open-original]')) {
    // Opening the original counts as reading it.
    if (!b.read) api(`/api/bookmarks/${b.id}/read`, { method: 'POST', body: { read: true } }).then(refreshCurrent);
    return;
  }
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
  if (e.target.closest('[data-new-section-for]')) {
    const s = await openSectionDialog(null);
    if (s) await api(`/api/lists/${s.id}/bookmarks/${b.id}`, { method: 'PUT' });
    return refreshCurrent();
  }
  if (e.target.id === 'note-save') {
    await api(`/api/bookmarks/${b.id}`, { method: 'PATCH', body: { note: $('#note-edit').value } });
    toast('Nota salvata');
    return refreshCurrent();
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'read') {
    await api(`/api/bookmarks/${b.id}/read`, { method: 'POST', body: { read: !b.read } });
    toast(b.read ? 'Di nuovo da leggere' : '✓ Segnato come letto');
  }
  if (act === 'fav') await api(`/api/bookmarks/${b.id}`, { method: 'PATCH', body: { favourited: !b.favourited } });
  if (act === 'archive') await api(`/api/bookmarks/${b.id}`, { method: 'PATCH', body: { archived: !b.archived } });
  if (act === 'snooze') {
    await api(`/api/bookmarks/${b.id}/snooze`, { method: 'POST', body: { days: b.snoozed ? 0 : 7 } });
    toast(b.snoozed ? 'Rinvio annullato' : 'Te lo ripropongo fra 7 giorni');
  }
  if (act === 'recrawl') await api(`/api/bookmarks/${b.id}/recrawl`, { method: 'POST' });
  if (act === 'retag') await api(`/api/bookmarks/${b.id}/retag`, { method: 'POST' });
  if (act === 'delete') {
    if (!confirm('Eliminare questo link?')) return;
    await api(`/api/bookmarks/${b.id}`, { method: 'DELETE' });
    state.items = state.items.filter((x) => x.id !== b.id);
    if (state.triage && state.route.page === 'triage') state.triage.queue = state.triage.queue.filter((x) => x.id !== b.id);
    closeDrawer();
    renderGrid();
    refreshSidebar();
    return;
  }
  await refreshCurrent();
});

$('#drawer').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-section-toggle]');
  if (!t || !state.current) return;
  await api(`/api/lists/${t.dataset.sectionToggle}/bookmarks/${state.current.id}`, { method: t.checked ? 'PUT' : 'DELETE' });
  refreshCurrent();
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
    toast('Titolo aggiornato');
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
  hlButton.textContent = '🖍 Evidenzia';
  hlButton.style.top = `${rect.top + window.scrollY - 40}px`;
  hlButton.style.left = `${rect.left + window.scrollX}px`;
  hlButton.addEventListener('mousedown', async (ev) => {
    ev.preventDefault();
    await api(`/api/bookmarks/${state.current.id}/highlights`, { method: 'POST', body: { text } });
    hlButton.remove();
    toast('Evidenziato');
    refreshCurrent();
  });
  document.body.appendChild(hlButton);
});

window.addEventListener('hashchange', () => {
  closeDrawer({ navigating: true });
  if (parseRoute().page === 'triage') state.triage = null;
  render().catch((e) => toast(e.message));
});

(async function init() {
  await refreshSidebar();
  await render();
})().catch((e) => toast(e.message));
