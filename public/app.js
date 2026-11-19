'use strict';

// ---------------------------------------------------------------- helpers

const $ = (sel, el = document) => el.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (value !== undefined) el.value = value; // after options exist, for <select>
  return el;
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

const clock = (ts) => new Date(ts).toLocaleTimeString('en-IN', { hour12: false });
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const money = (v) => `$${(Number(v) || 0).toFixed(2)}`;
const dayLabel = (ts) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

// A plan-limit bar. The fill colour and a word both carry how full it is.
function limitState(w) {
  if (!w) return null;
  if (w.resetsAt <= Date.now()) return { pct: 0, level: 'ok', word: '', reset: true };
  const pct = Math.round(w.utilization * 100);
  const level = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
  return { pct, level, word: { ok: '', warn: 'High', danger: 'Nearly full' }[level], reset: false };
}
function meter(label, st) {
  return h('div', { class: `meter ${st.level}`, role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': st.pct },
    h('div', { class: 'meter-fill', style: `width:${Math.min(100, st.pct)}%` }));
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

async function api(method, url, body, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  } catch (e) {
    if (!opts.quiet) toast('Cannot reach the dashboard server. Is it still running?');
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (!opts.quiet) toast(data.error || `Request failed (${res.status})`);
    throw new Error(data.error || String(res.status));
  }
  return data;
}

// Small, safe renderer for agent reports: builds DOM nodes, never raw HTML.
function inline(s) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    out.push(tok[0] === '`' ? h('code', null, tok.slice(1, -1)) : h('strong', null, tok.slice(2, -2)));
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function md(source) {
  const root = h('div', { class: 'md' });
  const lines = String(source || '').replace(/\r/g, '').split('\n');
  let para = [];
  let list = null;
  const flush = () => { if (para.length) { root.append(h('p', null, inline(para.join(' ')))); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush(); list = null;
      const buf = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) buf.push(lines[i]);
      root.append(h('pre', null, buf.join('\n')));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush(); list = null;
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        if (/^[\s|:-]+$/.test(lines[i])) continue;
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      }
      i--;
      root.append(h('div', { class: 'table' }, h('table', null,
        rows.map((cells, r) => h('tr', null, cells.map((c) => h(r === 0 ? 'th' : 'td', null, inline(c))))))));
      continue;
    }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) { flush(); list = null; root.append(h(head[1].length <= 2 ? 'h4' : 'h5', null, inline(head[2]))); continue; }
    const item = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      flush();
      const tag = /\d/.test(item[1]) ? 'OL' : 'UL';
      if (!list || list.tagName !== tag) { list = h(tag.toLowerCase()); root.append(list); }
      list.append(h('li', null, inline(item[2])));
      continue;
    }
    if (!line.trim()) { flush(); list = null; continue; }
    if (list && /^\s+\S/.test(line)) { list.lastChild.append(' ', ...inline(line.trim())); continue; }
    list = null;
    para.push(line.trim());
  }
  flush();
  return root;
}

// ---------------------------------------------------------------- state

let S = { settings: {}, projects: [], tasks: [], meta: {}, usage: null };
const ui = {
  filter: localStorage.getItem('dash.filter') || 'all',
  open: null,       // id of the task shown in the drawer
  task: null,       // full task (with activity log) for the drawer
  allDone: false,
  loaded: false,
};

const MODELS = [['', 'Default'], ['haiku', 'Haiku (cheapest)'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['fable', 'Fable']];
const MODES = [['plan', 'Plan only (no changes)'], ['edit', 'Edit files (no commits)']];
const PRIORITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']];

const projectOf = (t) => S.projects.find((p) => p.id === t.projectId);
const isAgent = (t) => t.assignee && t.assignee.kind === 'agent';
const locked = (t) => t.status === 'queued' || (t.status === 'running' && isAgent(t));

async function refresh(fresh) {
  S = await api('GET', `/api/state${fresh ? '?fresh=1' : ''}`, null, { quiet: ui.loaded });
  ui.loaded = true;
  if (ui.filter !== 'all' && !S.projects.some((p) => p.id === ui.filter)) setFilter('all', true);
  render();
  if (ui.open) loadOpen();
}

let refreshTimer;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), 120);
}

function setFilter(id, silent) {
  ui.filter = id;
  ui.allDone = false;
  localStorage.setItem('dash.filter', id);
  if (!silent) render();
}

// ---------------------------------------------------------------- render: page

function render() {
  const runningN = S.tasks.filter((t) => t.status === 'running').length;
  const reviewN = S.tasks.filter((t) => t.status === 'review').length;
  $('#stats').textContent = S.projects.length
    ? [plural(S.projects.length, 'project'), `${runningN} in progress`, `${reviewN} to review`].join(' · ')
    : 'No projects linked yet';
  document.title = reviewN ? `(${reviewN}) Project Dashboard` : 'Project Dashboard';

  const banner = $('#banner');
  if (!S.meta.claude) {
    banner.className = 'banner bad';
    banner.textContent = 'The claude program was not found, so agents cannot start. Set its path in Settings.';
    banner.hidden = false;
  } else if (!banner.dataset.offline) {
    banner.hidden = true;
  }

  renderUsageStrip();
  renderProjects();
  renderBoard();
}

function renderUsageStrip() {
  const el = $('#usage');
  const u = S.usage;
  if (!u) { el.hidden = true; return; }
  el.hidden = false;
  const bits = [h('span', { class: 'u-item' }, h('span', { class: 'u-label' }, 'Today'), h('strong', null, money(u.totals.today)))];
  for (const [key, label] of [['five_hour', '5-hour limit'], ['seven_day', 'Weekly limit']]) {
    const st = limitState(u.limits && u.limits.windows[key]);
    if (!st || st.reset) continue;
    bits.push(h('span', { class: 'u-item' }, h('span', { class: 'u-label' }, label), meter(label, st), h('strong', null, `${st.pct}%`)));
  }
  if (u.hold) bits.push(h('span', { class: 'chip high' }, 'Queue paused'));
  el.replaceChildren(...bits);
}

function renderProjects() {
  const nav = $('#projects');
  const open = (p) => S.tasks.filter((t) => t.status !== 'done' && (!p || t.projectId === p.id));
  const rows = [
    h('button', { class: `proj${ui.filter === 'all' ? ' on' : ''}`, onclick: () => setFilter('all') },
      h('span', { class: 'proj-name' }, 'All projects'),
      h('span', { class: 'proj-right' }, h('span', { class: 'count' }, open().length))),
  ];
  const order = { active: 0, paused: 1, shipped: 2 };
  const sorted = [...S.projects].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  for (const p of sorted) {
    const mine = open(p);
    const busy = mine.some((t) => t.status === 'running');
    const info = p.info || {};
    const sub = [];
    if (!info.exists) sub.push(h('span', { class: 'warn' }, 'Folder missing'));
    else {
      if (p.status !== 'active') sub.push(p.status === 'paused' ? 'Paused' : 'Shipped');
      sub.push(info.type);
      if (info.git) {
        sub.push(info.git.branch);
        if (info.git.changed) sub.push(h('span', { class: 'dirty' }, `${info.git.changed} changed`));
        if (info.git.last) sub.push(ago(info.git.last.at));
      } else sub.push('no git');
    }
    rows.push(h('div', {
      class: `proj${ui.filter === p.id ? ' on' : ''}${p.status !== 'active' ? ' dim' : ''}`,
      role: 'button', tabIndex: 0, title: p.path,
      onclick: () => setFilter(p.id),
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setFilter(p.id); },
    },
    h('span', { class: 'proj-name' }, p.name),
    h('span', { class: 'proj-right' },
      busy && h('span', { class: 'dot', title: 'Work in progress' }),
      h('span', { class: 'count' }, mine.length),
      h('button', { class: 'more', title: 'Project details', 'aria-label': `Details for ${p.name}`, onclick: (e) => { e.stopPropagation(); projectDialog(p.id); } }, '···')),
    h('span', { class: 'proj-sub' }, sub.flatMap((x, i) => (i ? [' · ', x] : [x])))));
  }
  rows.push(h('button', { class: 'btn small add', onclick: () => linkDialog() }, '+ Link project'));
  nav.replaceChildren(...rows);
}

const COLS = [
  { key: 'todo', title: 'To do', match: (t) => t.status === 'todo' || t.status === 'queued', empty: 'Nothing waiting.' },
  { key: 'running', title: 'In progress', match: (t) => t.status === 'running', empty: 'Nobody is working right now.' },
  { key: 'review', title: 'Needs review', match: (t) => t.status === 'review', empty: 'Nothing to review.' },
  { key: 'done', title: 'Done', match: (t) => t.status === 'done', empty: 'Finished tasks land here.' },
];
const RANK = { high: 0, normal: 1, low: 2 };
const SORT = {
  todo: (a, b) => (a.status === 'queued' ? 0 : 1) - (b.status === 'queued' ? 0 : 1) || RANK[a.priority] - RANK[b.priority] || a.createdAt - b.createdAt,
  running: (a, b) => (a.startedAt || 0) - (b.startedAt || 0),
  review: (a, b) => (b.finishedAt || 0) - (a.finishedAt || 0),
  done: (a, b) => (b.doneAt || b.updatedAt || 0) - (a.doneAt || a.updatedAt || 0),
};

function renderBoard() {
  const board = $('#board');
  const project = S.projects.find((p) => p.id === ui.filter);
  $('#board-title').textContent = project ? project.name : 'All projects';
  const sub = $('#board-sub');
  sub.replaceChildren();
  if (project) {
    const bits = [project.path];
    if (project.deadline) bits.push(`Deadline ${new Date(project.deadline + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`);
    if (project.info && project.info.git && project.info.git.last) bits.push(`Last commit: ${project.info.git.last.subject}`);
    sub.append(bits.join(' · '), ' · ', h('button', { class: 'link', onclick: () => conversationsDialog(project.id) }, 'Conversations'));
  }

  if (!S.projects.length) {
    board.replaceChildren(h('div', { class: 'welcome' },
      h('h3', null, 'Link your project folders to begin'),
      h('p', null, 'A project is just a folder on this Mac. Once it is linked you can add tasks for it, start agents on them, and watch their progress here. Linking never changes or moves the folder.'),
      h('div', { class: 'btns' },
        S.meta.suggestRoot && h('button', { class: 'btn primary', onclick: () => linkDialog(S.meta.suggestRoot, true) }, `Find projects in ${S.meta.suggestRoot.replace(S.meta.home, '~')}`),
        h('button', { class: 'btn', onclick: () => linkDialog() }, 'Link one folder'))));
    return;
  }

  const tasks = S.tasks.filter((t) => ui.filter === 'all' || t.projectId === ui.filter);
  board.replaceChildren(...COLS.map((col) => {
    let list = tasks.filter(col.match).sort(SORT[col.key]);
    const total = list.length;
    let more = null;
    if (col.key === 'done' && !ui.allDone && total > 15) {
      list = list.slice(0, 15);
      more = h('button', { class: 'link', onclick: () => { ui.allDone = true; renderBoard(); } }, `Show all ${total}`);
    }
    return h('section', { class: 'col' },
      h('div', { class: 'col-head' }, h('h3', null, col.title), h('span', { class: 'count' }, total)),
      h('div', { class: 'col-body' },
        list.length ? list.map(card) : h('div', { class: 'empty' }, col.empty),
        more));
  }));
}

function whoText(t) {
  if (!t.assignee) return null;
  if (t.assignee.kind === 'agent') return t.assignee.name ? `Agent (${t.assignee.name.replace(/^claude-/, '')})` : 'Agent';
  return t.assignee.name;
}

function card(t) {
  const p = projectOf(t);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  let line = null;
  let actions = null;
  if (t.status === 'todo') {
    actions = h('button', { class: 'btn small', onclick: stop(() => runTask(t.id)) }, 'Run agent');
  } else if (t.status === 'queued') {
    line = h('div', { class: 'card-line' }, h('span', { class: 'what', title: t.waitReason || '' }, t.waitReason || 'Queued'));
    actions = [
      h('button', { class: 'btn small', onclick: stop(() => act(t.id, 'stop')) }, 'Cancel'),
      /^Paused/.test(t.waitReason || '') && h('button', { class: 'btn small', onclick: stop(() => runTask(t.id, { force: true })) }, 'Run anyway'),
    ];
  } else if (t.status === 'running') {
    line = h('div', { class: 'card-line' },
      h('span', { class: 'dot' }),
      h('span', { class: 'what' }, t.last && t.last.kind !== 'status' ? firstLine(t.last.text) : (isAgent(t) ? 'Starting…' : 'Working…')),
      h('span', { class: 'timer', dataset: { since: t.startedAt } }, dur(Date.now() - t.startedAt)));
    if (isAgent(t)) actions = h('button', { class: 'btn small', onclick: stop(() => act(t.id, 'stop')) }, 'Stop');
  } else if (t.status === 'review') {
    const label = { ok: 'Finished', failed: 'Did not finish', stopped: 'Stopped' }[t.outcome] || 'Waiting for you';
    line = h('div', { class: `card-line ${t.outcome === 'failed' ? 'failed' : 'review'}` },
      h('span', { class: 'what' }, [label, ago(t.finishedAt), t.changes && t.changes.files ? plural(t.changes.files, 'file') + ' changed' : null].filter(Boolean).join(' · ')));
  } else {
    line = h('div', { class: 'card-line ok' }, h('span', { class: 'what' }, `Done · ${ago(t.doneAt || t.updatedAt)}`));
  }
  return h('article', {
    class: `card s-${t.status}${t.outcome ? ` o-${t.outcome}` : ''}`,
    tabIndex: 0,
    onclick: () => openTask(t.id),
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openTask(t.id); },
  },
  h('div', { class: 'card-top' },
    h('span', { class: 'tid' }, t.id),
    t.priority === 'high' && h('span', { class: 'chip high' }, 'High'),
    h('span', { class: `chip right ${t.mode}` }, t.mode === 'edit' ? 'Edit files' : 'Plan only')),
  h('h3', null, t.title),
  h('div', { class: 'card-meta' }, [ui.filter === 'all' && p ? p.name : null, whoText(t)].filter(Boolean).join(' · ')),
  line,
  actions && h('div', { class: 'card-actions' }, actions));
}

setInterval(() => {
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = dur(Date.now() - Number(el.dataset.since));
}, 1000);

// ---------------------------------------------------------------- task actions

async function act(id, action, body) {
  await api('POST', `/api/tasks/${id}/${action}`, body);
  refreshSoon();
}
const runTask = (id, body) => act(id, 'run', body);
async function patchTask(id, body) {
  await api('PATCH', `/api/tasks/${id}`, body);
  refreshSoon();
}

// ---------------------------------------------------------------- drawer

async function openTask(id) {
  ui.open = id;
  ui.task = null;
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  for (const sel of ['#d-head', '#d-fields', '#d-actions', '#d-follow', '#d-report', '#d-changes', '#d-convos', '#d-log', '#d-foot']) {
    const el = $(sel);
    el.replaceChildren();
    delete el.dataset.key;
  }
  $('#drawer').hidden = false;
  await loadOpen();
}

function closeDrawer() {
  ui.open = null;
  ui.task = null;
  $('#drawer').hidden = true;
  if (location.hash) history.replaceState(null, '', location.pathname);
}

// A link like http://localhost:4577/#T12 opens that task.
function openFromHash() {
  const id = location.hash.slice(1);
  if (/^T\d+$/.test(id) && id !== ui.open) openTask(id);
}
window.addEventListener('hashchange', openFromHash);

async function loadOpen() {
  const id = ui.open;
  if (!id) return;
  let t;
  try { t = await api('GET', `/api/tasks/${id}`, null, { quiet: true }); } catch { if (ui.open === id) closeDrawer(); return; }
  if (ui.open !== id) return;
  ui.task = t;
  renderDrawer();
}

// Re-draw one part of the drawer only when what it shows has changed, so
// live updates never wipe something you are typing.
function part(sel, key, build) {
  const el = $(sel);
  key = String(key);
  if (el.dataset.key === key) return;
  if (el.contains(document.activeElement) && el.dataset.key !== undefined && sel !== '#d-log') return;
  el.dataset.key = key;
  el.replaceChildren(...[build()].flat().filter(Boolean));
}

function select(options, value, onchange, disabled) {
  return h('select', { value, disabled, onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v }, label)));
}
const field = (label, control) => h('label', { class: 'field' }, h('span', null, label), control);

function statusPill(t) {
  if (t.status === 'running') return h('span', { class: 'pill running' }, h('span', { class: 'dot' }), 'In progress');
  if (t.status === 'queued') return h('span', { class: 'pill' }, 'Queued');
  if (t.status === 'review') {
    if (t.outcome === 'failed') return h('span', { class: 'pill failed' }, 'Did not finish');
    if (t.outcome === 'stopped') return h('span', { class: 'pill review' }, 'Stopped');
    return h('span', { class: 'pill review' }, 'Needs review');
  }
  if (t.status === 'done') return h('span', { class: 'pill done' }, 'Done');
  return h('span', { class: 'pill' }, 'To do');
}

function renderDrawer() {
  const t = ui.task;
  if (!t) return;
  const id = t.id;
  const lock = locked(t);
  const who = whoText(t);

  part('#d-head', [t.status, t.outcome, who, t.startedAt, t.waitReason].join('|'), () => [
    h('span', { class: 'tid' }, t.id),
    statusPill(t),
    h('span', { class: 'grow' },
      t.status === 'running'
        ? [who, ' · ', h('span', { dataset: { since: t.startedAt } }, dur(Date.now() - t.startedAt))]
        : t.status === 'queued' ? (t.waitReason || '') : (who || '')),
    h('button', { class: 'btn small ghost', onclick: closeDrawer, 'aria-label': 'Close' }, 'Close'),
  ]);

  part('#d-fields', [t.title, t.description, t.projectId, t.mode, t.model, t.priority, t.budget, S.settings.taskBudget, lock, S.projects.map((p) => p.id + p.name).join()].join('\u0001'), () =>
    h('div', { class: 'stack' },
      h('input', { type: 'text', class: 'd-title', value: t.title, 'aria-label': 'Title', onchange: (e) => patchTask(id, { title: e.target.value }) }),
      field('What should be done', h('textarea', { rows: 6, value: t.description, placeholder: 'Describe the task the way you would brief a developer: what to change, where, and how to tell it worked.', onchange: (e) => patchTask(id, { description: e.target.value }) })),
      h('div', { class: 'row' },
        field('Project', select(S.projects.map((p) => [p.id, p.name]), t.projectId, (v) => patchTask(id, { projectId: v }), lock)),
        field('Agent may', select(MODES, t.mode, (v) => patchTask(id, { mode: v }), lock)),
        field('Model', select(MODELS, t.model, (v) => patchTask(id, { model: v }), lock)),
        field('Priority', select(PRIORITIES, t.priority, (v) => patchTask(id, { priority: v }))),
        field('Spend limit for one run ($)', budgetInput(t.budget, (v) => patchTask(id, { budget: v }), lock)))));

  part('#d-actions', [t.status, t.outcome, t.mode, Boolean(t.sessionId), isAgent(t), /^Paused/.test(t.waitReason || '')].join('|'), () => {
    const b = [];
    const btn = (label, fn, cls = '') => h('button', { class: `btn ${cls}`, onclick: fn }, label);
    if (t.status === 'todo') {
      b.push(btn('Run agent', () => runTask(id), 'primary'), btn('Mark done', () => patchTask(id, { status: 'done' })));
    } else if (t.status === 'queued') {
      b.push(btn('Cancel', () => act(id, 'stop')));
      if (/^Paused/.test(t.waitReason || '')) b.push(btn('Run anyway', () => runTask(id, { force: true })));
    } else if (t.status === 'running') {
      if (isAgent(t)) b.push(btn('Stop agent', () => act(id, 'stop'), 'danger'));
      else b.push(btn('Mark done', () => patchTask(id, { status: 'done' })), btn('Take it back (To do)', () => patchTask(id, { status: 'todo' })));
    } else if (t.status === 'review') {
      b.push(btn('Mark done', () => patchTask(id, { status: 'done' }), 'primary'));
      if (t.mode === 'plan' && t.outcome === 'ok' && t.sessionId) {
        b.push(btn('Carry out this plan', () => runTask(id, { mode: 'edit', message: 'I have read your plan. Go ahead and carry it out now. You may edit files. Do not commit.' })));
      }
      b.push(btn('Run again from scratch', () => runTask(id)), btn('Back to To do', () => patchTask(id, { status: 'todo' })));
    } else {
      b.push(btn('Reopen', () => patchTask(id, { status: 'todo' })));
    }
    b.push(h('span', { class: 'spacer' }));
    let armed = false;
    const del = btn('Delete', () => {
      if (!armed) { armed = true; del.textContent = 'Really delete?'; setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 3000); return; }
      api('DELETE', `/api/tasks/${id}`).then(() => { closeDrawer(); refreshSoon(); });
    }, 'ghost danger');
    b.push(del);
    return b;
  });

  const canFollow = t.status === 'review' && Boolean(t.sessionId);
  part('#d-follow', canFollow, () => {
    if (!canFollow) return null;
    const box = h('textarea', { rows: 3, placeholder: 'Ask the same agent for a change or a fix. It remembers what it did.', 'aria-label': 'Follow-up for the agent' });
    return h('div', { class: 'follow' },
      h('div', { class: 'sect-title' }, 'Send a follow-up'),
      box,
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => { const v = box.value.trim(); if (!v) return toast('Write the follow-up first.'); box.blur(); runTask(id, { message: v }); } }, 'Send to agent'),
        h('span', { class: 'hint' }, t.mode === 'edit' ? 'The agent may edit files.' : 'Plan only: the agent will not change files.')));
  });

  part('#d-report', [t.report, t.outcome].join('\u0001'), () => t.report && [
    h('div', { class: 'sect-title' }, t.mode === 'plan' ? 'Plan and findings' : 'Report'),
    h('div', { class: `report${t.outcome === 'failed' ? ' failed' : ''}` }, md(t.report)),
  ]);

  part('#d-changes', [t.changes ? t.changes.at : 'none', t.mode, t.status, t.runs].join('|'), () => {
    if (!t.changes) {
      return t.mode === 'edit' && t.status === 'review'
        ? h('p', { class: 'hint' }, 'No list of changed files for this task. That happens when the project is not a git repository.')
        : null;
    }
    const c = t.changes;
    const box = h('div', { class: 'changes' }, c.files ? h('p', { class: 'hint' }, 'Loading…') : h('p', { class: 'hint' }, 'This task changed no files.'));
    if (c.files) loadChanges(id, box);
    return [
      h('div', { class: 'sect-title' }, c.files ? `Changes · ${plural(c.files, 'file')} · +${c.added} −${c.removed}` : 'Changes'),
      box,
      c.files ? h('p', { class: 'hint' }, `Compared with the project as it was when the task started. Recorded ${ago(c.at)}; nothing is committed.`) : null,
    ];
  });

  const convos = t.conversationInfo || [];
  part('#d-convos', JSON.stringify(convos.map((c) => [c.id, c.title, c.updatedAt, c.missing])), () => [
    h('div', { class: 'sect-title' }, 'Conversations'),
    convos.length ? h('ul', { class: 'found' }, convos.map((c) => h('li', { class: 'convo-row' },
      h('button', { class: 'convo-open', disabled: c.missing, onclick: () => conversationReader(c.id) },
        h('span', { class: 'n' }, c.title),
        h('span', { class: 'hint' }, [c.kind === 'agent' ? 'Dashboard agent' : 'Linked', c.missing ? null : ago(c.updatedAt), c.prompts ? plural(c.prompts, 'message') + ' from you' : null].filter(Boolean).join(' · '))),
      c.kind === 'linked' && h('button', { class: 'link', onclick: () => act(id, 'unlink', { sessionId: c.id }) }, 'Unlink')))) : null,
    h('button', { class: 'btn small', onclick: () => conversationsDialog(t.projectId, id) }, 'Link a conversation'),
  ]);

  const logEl = $('#d-log .log');
  const stick = !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  part('#d-log', t.logTotal, () => [
    h('div', { class: 'sect-title' }, `Activity${t.steps ? ` · ${plural(t.steps, 'step')}` : ''}`),
    h('ul', { class: 'log' }, (t.log || []).map((e) => h('li', { class: `k-${e.kind}` },
      h('time', null, clock(e.t)),
      h('span', { class: 'txt' },
        e.kind === 'you' && h('span', { class: 'tag' }, 'You'),
        e.kind === 'note' && h('span', { class: 'tag' }, 'Note'),
        e.kind === 'text' ? md(e.text) : e.text)))),
  ]);
  const fresh = $('#d-log .log');
  if (fresh && stick) fresh.scrollTop = fresh.scrollHeight;

  part('#d-foot', [t.sessionId, t.cost, t.runs, t.createdAt].join('|'), () => {
    const bits = [`Added ${ago(t.createdAt)}`];
    if (t.runs) bits.push(plural(t.runs, 'agent run'));
    if (t.cost) bits.push(`about $${t.cost.toFixed(2)} of usage`);
    return [
      h('div', null, bits.join(' · ')),
      t.sessionId && h('div', null, 'To continue this agent yourself, run in the project folder: ', h('code', null, `claude --resume ${t.sessionId}`)),
    ];
  });
}

// ---------------------------------------------------------------- dialogs

function showDialog(title, body, foot) {
  const dlg = $('#dlg');
  dlg.replaceChildren(
    h('div', { class: 'dlg-head' }, title),
    h('div', { class: 'dlg-body stack' }, body),
    h('div', { class: 'dlg-foot' }, foot));
  dlg.style.width = '';
  if (!dlg.open) dlg.showModal();
  return dlg;
}
const closeDialog = () => $('#dlg').close();
const cancelBtn = () => h('button', { class: 'btn ghost', onclick: closeDialog }, 'Cancel');

function newTaskDialog() {
  if (!S.projects.length) return linkDialog();
  const active = S.projects.filter((p) => p.status === 'active');
  const projects = active.length ? active : S.projects;
  const start = projects.some((p) => p.id === ui.filter) ? ui.filter : projects[0].id;
  const project = select(S.projects.map((p) => [p.id, p.name]), start, () => {});
  const title = h('input', { type: 'text', placeholder: 'Short name for the task' });
  const desc = h('textarea', { rows: 7, placeholder: 'Describe the task the way you would brief a developer: what to change, where, and how to tell it worked.' });
  const mode = select(MODES, 'plan', () => {});
  const model = select(MODELS, '', () => {});
  const priority = select(PRIORITIES, 'normal', () => {});
  const budget = budgetInput(0, () => {});
  const create = async (run) => {
    if (!title.value.trim()) { title.focus(); return toast('Give the task a title.'); }
    await api('POST', '/api/tasks', { projectId: project.value, title: title.value, description: desc.value, mode: mode.value, model: model.value, priority: priority.value, budget: Number(budget.value) || 0, run });
    closeDialog();
    refreshSoon();
  };
  showDialog('New task', [
    h('button', { class: 'link', onclick: () => bulkDialog() }, 'Add several tasks at once, across projects →'),
    field('Project', project),
    field('Title', title),
    field('What should be done', desc),
    h('div', { class: 'row' }, field('Agent may', mode), field('Model', model), field('Priority', priority), field('Spend limit for one run ($)', budget)),
    h('p', { class: 'hint' }, 'Plan only: the agent reads the code and writes a plan, and changes nothing. Edit files: it does the work but never commits or pushes. Cheaper models suit small, clearly described tasks.'),
  ], [
    cancelBtn(),
    h('button', { class: 'btn', onclick: () => create(false) }, 'Add to board'),
    h('button', { class: 'btn primary', onclick: () => create(true) }, 'Add and run agent'),
  ]);
  title.focus();
}

// Reads the "several tasks" box: one task per line, projects tagged with
// @Name, indented lines are details for the task above.
function parseBulk(source, fallbackId) {
  const norm = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const longestFirst = [...S.projects].sort((x, y) => y.name.length - x.name.length);
  const tasks = [];
  for (const raw of source.split('\n')) {
    if (!raw.trim()) continue;
    if (/^\s/.test(raw) && tasks.length) {
      const prev = tasks[tasks.length - 1];
      prev.description += (prev.description ? '\n' : '') + raw.trim();
      continue;
    }
    const line = raw.trim();
    const ids = [];
    const unknown = [];
    let title = '';
    for (let i = 0; i < line.length;) {
      if (line[i] !== '@' || (i > 0 && !/\s/.test(line[i - 1]))) { title += line[i++]; continue; }
      const rest = line.slice(i + 1);
      const full = longestFirst.find((p) => rest.toLowerCase().startsWith(p.name.toLowerCase())
        && (rest.length === p.name.length || /[\s,;:.]/.test(rest[p.name.length])));
      if (full) { ids.push(full.id); i += 1 + full.name.length; continue; }
      const word = (rest.match(/^[^\s,;:]+/) || [''])[0];
      const key = norm(word);
      const hits = key ? S.projects.filter((p) => norm(p.name).startsWith(key)) : [];
      const exact = hits.find((p) => norm(p.name) === key);
      if (exact || hits.length === 1) ids.push((exact || hits[0]).id);
      else unknown.push(hits.length > 1 ? `@${word} matches ${hits.length} projects` : `No project called @${word}`);
      i += 1 + word.length;
    }
    const projectIds = [...new Set(ids)];
    if (!projectIds.length && !unknown.length && fallbackId) projectIds.push(fallbackId);
    tasks.push({ title: title.replace(/\s+/g, ' ').replace(/^[-*•]\s+/, '').trim(), description: '', projectIds, unknown });
  }
  return tasks;
}

function bulkDialog() {
  if (!S.projects.length) return linkDialog();
  const order = { active: 0, paused: 1, shipped: 2 };
  const projects = [...S.projects].sort((x, y) => order[x.status] - order[y.status] || x.name.localeCompare(y.name));
  const eg = projects.map((p) => p.name);
  const box = h('textarea', { rows: 8, spellcheck: true, 'aria-label': 'Tasks, one per line',
    placeholder: `@${eg[0]} Fix the crash on the settings screen\n    Details go on indented lines under the task.\n@${eg[0]}${eg[1] ? ` @${eg[1]}` : ''} Update the dependencies` });
  const fallback = select([['', 'Nothing: every line needs a tag'], ...projects.map((p) => [p.id, p.name])],
    S.projects.some((p) => p.id === ui.filter) ? ui.filter : '', () => update());
  const mode = select(MODES, 'plan', () => {});
  const model = select(MODELS, '', () => {});
  const priority = select(PRIORITIES, 'normal', () => {});
  const preview = h('div', { class: 'bulk-preview' });
  const addBtn = h('button', { class: 'btn', onclick: () => create(false) });
  const runBtn = h('button', { class: 'btn primary', onclick: () => create(true) });
  let parsed = [];
  let total = 0;

  const problem = (t) => (!t.title ? 'Write what should be done' : t.unknown[0] || (!t.projectIds.length ? 'Tag a project with @Name' : null));
  function update() {
    parsed = parseBulk(box.value, fallback.value);
    const bad = parsed.some(problem);
    total = parsed.reduce((n, t) => n + t.projectIds.length, 0);
    const where = new Set(parsed.flatMap((t) => t.projectIds)).size;
    preview.replaceChildren(...(parsed.length ? [
      h('div', { class: 'sect-title' }, bad ? 'Fix the lines marked in red' : `${plural(total, 'task')} in ${plural(where, 'project')}`),
      h('ul', { class: 'found' }, parsed.map((t) => h('li', { class: `bulk-row${problem(t) ? ' bad' : ''}` },
        h('span', { class: 'n' }, t.title || '(no text)', t.description && h('span', { class: 'hint' }, '  + details')),
        problem(t)
          ? h('span', { class: 'bulk-err' }, problem(t))
          : t.projectIds.map((pid) => h('span', { class: 'chip edit' }, S.projects.find((p) => p.id === pid).name))))),
    ] : []));
    addBtn.textContent = total && !bad ? `Add ${total} to board` : 'Add to board';
    runBtn.textContent = total && !bad ? `Add and run ${plural(total, 'agent')}` : 'Add and run agents';
    addBtn.disabled = runBtn.disabled = bad || !total;
  }
  box.addEventListener('input', update);

  const insertTag = (name) => {
    const at = box.selectionStart;
    const before = box.value.slice(0, at);
    const tag = `${before && !/\s$/.test(before) ? ' ' : ''}@${name} `;
    box.setRangeText(tag, at, box.selectionEnd, 'end');
    box.focus();
    update();
  };

  async function create(run) {
    addBtn.disabled = runBtn.disabled = true;
    let made = 0;
    try {
      for (const t of parsed) {
        for (const projectId of t.projectIds) {
          await api('POST', '/api/tasks', { projectId, title: t.title, description: t.description, mode: mode.value, model: model.value, priority: priority.value, run });
          made++;
        }
      }
    } catch { /* the error is already shown */ }
    if (made < total) { toast(`Added ${made} of ${total}. The rest were not added.`); refreshSoon(); update(); return; }
    closeDialog();
    setFilter('all', true);
    toast(run ? `Started ${plural(made, 'task')}. Extra ones wait in the queue.` : `Added ${plural(made, 'task')}.`);
    refresh();
  }

  showDialog('Add several tasks', [
    h('p', { class: 'hint' }, 'One task per line. Tag the project with @Name. Tag more than one project to give the same task to each. Indent a line to add details to the task above it.'),
    h('div', { class: 'tagbar' }, h('span', { class: 'hint' }, 'Insert tag:'),
      projects.map((p) => h('button', { class: 'chip tag', title: p.path, onclick: () => insertTag(p.name) }, `@${p.name}`))),
    box,
    preview,
    field('Lines without a tag go to', fallback),
    h('div', { class: 'row' }, field('Agent may', mode), field('Model', model), field('Priority', priority)),
    h('p', { class: 'hint' }, `These three settings apply to every task here; you can change each task afterwards. Up to ${S.settings.maxAgents} agents run at once and the rest wait in the queue.`),
  ], [
    h('button', { class: 'link', onclick: () => newTaskDialog() }, '← One task'),
    h('span', { class: 'spacer' }),
    cancelBtn(), addBtn, runBtn,
  ]);
  $('#dlg').style.width = 'min(680px, calc(100vw - 32px))';
  update();
  box.focus();
}

function linkDialog(startPath, scanNow) {
  const input = h('input', { type: 'text', placeholder: '/Users/you/Projects/MyApp', value: startPath || '', spellcheck: false });
  const results = h('div');
  let found = [];

  const linkPaths = async (paths) => {
    const r = await api('POST', '/api/projects', { paths });
    closeDialog();
    toast(r.added.length ? `Linked ${plural(r.added.length, 'project')}.` : 'Already linked.');
    if (r.added.length === 1) setFilter(r.added[0].id, true);
    refresh(true);
  };

  const scan = async () => {
    const r = await api('POST', '/api/scan', { path: input.value });
    input.value = r.root;
    found = r.found;
    const boxes = [];
    const linkBtn = h('button', { class: 'btn primary', onclick: () => linkPaths(boxes.filter((b) => b.checked).map((b) => b.value)) });
    const count = () => { const n = boxes.filter((b) => b.checked).length; linkBtn.textContent = `Link selected (${n})`; linkBtn.disabled = !n; };
    const list = h('ul', { class: 'found' }, found.map((f) => {
      const box = h('input', { type: 'checkbox', value: f.path, checked: f.likely && !f.linked, disabled: f.linked, onchange: count });
      if (!f.linked) boxes.push(box);
      return h('li', null, h('label', { class: f.linked ? 'is-linked' : '' },
        box,
        h('span', { class: 'n' }, f.name),
        h('span', { class: 'chip' }, f.type),
        f.isGit && h('span', { class: 'chip' }, 'git'),
        f.linked && h('span', { class: 'hint' }, 'already linked')));
    }));
    count();
    results.replaceChildren(
      h('div', { class: 'sect-title' }, found.length ? `Folders inside (${found.length})` : 'No folders inside'),
      found.length ? list : null,
      found.length ? h('div', { style: 'margin-top:10px; display:flex; gap:8px; align-items:center; flex-wrap:wrap' },
        linkBtn,
        h('button', { class: 'link', onclick: () => { for (const b of boxes) b.checked = true; count(); } }, 'Select all'),
        h('button', { class: 'link', onclick: () => { for (const b of boxes) b.checked = false; count(); } }, 'Select none')) : null);
  };

  const browse = h('button', { class: 'btn', onclick: async () => {
    browse.disabled = true;
    browse.textContent = 'Choosing…';
    try {
      const r = await api('POST', '/api/pick-folder');
      if (r.path) { input.value = r.path; results.replaceChildren(); }
    } finally { browse.disabled = false; browse.textContent = 'Browse…'; }
  } }, 'Browse…');

  showDialog('Link a project folder', [
    field('Folder on this Mac', h('div', { class: 'path-row' }, input, browse)),
    h('div', { style: 'display:flex; gap:8px; flex-wrap:wrap' },
      h('button', { class: 'btn primary', onclick: () => linkPaths([input.value]) }, 'Link this folder'),
      h('button', { class: 'btn', onclick: scan }, 'Find projects inside it')),
    h('p', { class: 'hint' }, 'Linking only remembers where the folder is. Nothing is copied, moved or changed. Use "Find projects inside it" to import many at once from a parent folder.'),
    results,
  ], [h('button', { class: 'btn ghost', onclick: closeDialog }, 'Close')]);
  input.focus();
  if (scanNow) scan();
}

function projectDialog(pid) {
  const p = S.projects.find((x) => x.id === pid);
  if (!p) return;
  const info = p.info || {};
  const name = h('input', { type: 'text', value: p.name });
  const folder = h('input', { type: 'text', value: p.path, spellcheck: false });
  const status = select([['active', 'Active'], ['paused', 'Paused'], ['shipped', 'Shipped']], p.status, () => {});
  const deadline = h('input', { type: 'date', value: p.deadline || '' });
  const notes = h('textarea', { rows: 4, value: p.notes || '', placeholder: 'Anything you want to remember about this project.' });
  const taskCount = S.tasks.filter((t) => t.projectId === p.id).length;

  const facts = [['Kind', info.exists ? info.type : 'Folder missing']];
  if (info.git) {
    facts.push(['Branch', info.git.branch + (info.git.ahead ? ` (${info.git.ahead} not pushed)` : '')]);
    facts.push(['Uncommitted', info.git.changed ? plural(info.git.changed, 'file') : 'Nothing']);
    if (info.git.last) facts.push(['Last commit', `${info.git.last.subject} (${ago(info.git.last.at)})`]);
  } else if (info.exists) facts.push(['Git', 'Not a git repository']);
  if (info.exists) facts.push(['CLAUDE.md', info.hasClaudeMd ? 'Yes' : 'No']);

  let armed = false;
  const unlink = h('button', { class: 'btn ghost danger', onclick: async () => {
    if (!armed) { armed = true; unlink.textContent = taskCount ? `Unlink and delete its ${plural(taskCount, 'task')}?` : 'Really unlink?'; return; }
    await api('DELETE', `/api/projects/${p.id}`);
    closeDialog();
    refresh();
  } }, 'Unlink');

  showDialog(p.name, [
    h('dl', { class: 'kv' }, facts.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h('div', { style: 'display:flex; gap:8px; flex-wrap:wrap' },
      h('button', { class: 'btn small', onclick: () => conversationsDialog(p.id) }, 'Conversations'),
      h('button', { class: 'btn small', onclick: () => api('POST', `/api/projects/${p.id}/open`, { app: 'finder' }) }, 'Open in Finder'),
      h('button', { class: 'btn small', onclick: () => api('POST', `/api/projects/${p.id}/open`, { app: 'vscode' }) }, 'Open in VS Code')),
    field('Name', name),
    field('Folder', folder),
    h('div', { class: 'row' }, field('Status', status), field('Deadline', deadline)),
    field('Notes', notes),
    h('p', { class: 'hint' }, 'Unlinking removes the project and its tasks from this dashboard only. The folder itself is never touched.'),
  ], [
    unlink,
    h('span', { class: 'spacer' }),
    cancelBtn(),
    h('button', { class: 'btn primary', onclick: async () => {
      const body = { name: name.value, status: status.value, deadline: deadline.value, notes: notes.value };
      if (folder.value.trim() !== p.path) body.path = folder.value;
      await api('PATCH', `/api/projects/${p.id}`, body);
      closeDialog();
      refresh(true);
    } }, 'Save'),
  ]);
}

function settingsDialog() {
  const max = select([[1, '1'], [2, '2'], [3, '3'], [4, '4']].map(([v, l]) => [String(v), l]), String(S.settings.maxAgents), () => {});
  const model = select(MODELS, S.settings.defaultModel || '', () => {});
  const bin = h('input', { type: 'text', value: S.settings.claudePath || '', placeholder: S.meta.claude || 'Not found: paste the full path', spellcheck: false });
  showDialog('Settings', [
    field('Agents running at the same time', max),
    h('p', { class: 'hint' }, 'Extra tasks wait in the queue. Two agents never edit the same project at once. Each Gradle build needs 2 to 3 GB of memory, so 2 is a safe number on this Mac.'),
    field('Model for tasks set to "Default"', model),
    field('Path to the claude program (leave empty to find it automatically)', bin),
    h('p', { class: 'hint' }, S.meta.claude ? `Using now: ${S.meta.claude}` : 'The claude program was not found.'),
  ], [
    cancelBtn(),
    h('button', { class: 'btn primary', onclick: async () => {
      await api('PATCH', '/api/settings', { maxAgents: Number(max.value), defaultModel: model.value, claudePath: bin.value });
      closeDialog();
      refresh();
    } }, 'Save'),
  ]);
}

// ---------------------------------------------------------------- saved conversations

// Lists the Claude conversations saved for a project. With linkTo (a task id)
// each row also gets a Link button.
async function conversationsDialog(pid, linkTo) {
  const p = S.projects.find((x) => x.id === pid);
  if (!p) return;
  const body = h('div', null, h('p', { class: 'hint' }, 'Reading saved conversations…'));
  showDialog(linkTo ? `Link a conversation to ${linkTo}` : `Conversations in ${p.name}`, [
    body,
    h('p', { class: 'hint' }, 'These are the Claude Code conversations saved on this Mac for this folder. Claude removes them after about 30 days. Chats on claude.ai are not stored here.'),
  ], [h('button', { class: 'btn ghost', onclick: closeDialog }, 'Close')]);
  $('#dlg').style.width = 'min(680px, calc(100vw - 32px))';
  let r;
  try { r = await api('GET', `/api/projects/${pid}/conversations`); } catch { body.replaceChildren(h('p', { class: 'hint' }, 'Could not read the conversations.')); return; }
  if (!r.conversations.length) { body.replaceChildren(h('p', { class: 'hint' }, 'No saved conversations for this folder.')); return; }
  body.replaceChildren(h('ul', { class: 'found' }, r.conversations.map((c) => h('li', { class: 'convo-row' },
    h('button', { class: 'convo-open', disabled: c.tooBig, onclick: () => conversationReader(c.id, () => conversationsDialog(pid, linkTo)) },
      h('span', { class: 'n' }, c.title),
      h('span', { class: 'hint' }, [ago(c.updatedAt), c.tooBig ? 'too large to show' : plural(c.prompts, 'message') + ' from you', c.cost ? money(c.cost) : null].filter(Boolean).join(' · '))),
    c.agentTask && h('span', { class: 'chip' }, `Agent ${c.agentTask}`),
    c.tasks.filter((x) => x !== c.agentTask).map((x) => h('span', { class: 'chip edit' }, x)),
    linkTo && !c.tasks.includes(linkTo) && h('button', { class: 'btn small', onclick: async () => {
      await api('POST', `/api/tasks/${linkTo}/link`, { sessionId: c.id });
      closeDialog();
      refreshSoon();
    } }, 'Link')))));
}

async function conversationReader(sessionId, back) {
  const body = h('div', { class: 'convo' }, h('p', { class: 'hint' }, 'Opening…'));
  const foot = [back && h('button', { class: 'link', onclick: back }, '← All conversations'), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: closeDialog }, 'Close')];
  showDialog('Conversation', [body], foot);
  $('#dlg').style.width = 'min(820px, calc(100vw - 32px))';
  let c;
  try { c = await api('GET', `/api/conversations/${sessionId}`); } catch { body.replaceChildren(h('p', { class: 'hint' }, 'This conversation is no longer saved on this Mac.')); return; }
  $('#dlg .dlg-head').textContent = c.title;
  const nodes = [h('p', { class: 'hint' }, [
    c.startedAt ? `Started ${new Date(c.startedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}` : null,
    `last active ${ago(c.updatedAt)}`, c.cost ? money(c.cost) : null,
  ].filter(Boolean).join(' · '))];
  if (c.cut) nodes.push(h('p', { class: 'hint' }, `This is a long conversation. The first ${c.cut} entries are not shown.`));
  let steps = null;
  for (const it of c.items) {
    if (it.role === 'tool') {
      if (!steps) { steps = h('details', { class: 'steps' }, h('summary', null, '')); nodes.push(steps); }
      steps.append(h('div', null, it.text));
      steps.firstChild.textContent = plural(steps.childNodes.length - 1, 'step');
      continue;
    }
    steps = null;
    if (it.role === 'note') nodes.push(h('p', { class: 'hint' }, it.text));
    else if (it.role === 'user') nodes.push(h('div', { class: 'msg you' }, h('div', { class: 'who' }, 'You', it.t ? h('time', null, ` · ${clock(it.t)}`) : null), h('div', { class: 'body' }, it.text)));
    else nodes.push(h('div', { class: 'msg' }, md(it.text)));
  }
  nodes.push(h('p', { class: 'hint' }, 'To continue it, run in ', h('code', null, c.cwd || 'the project folder'), ': ', h('code', { style: 'user-select:all' }, `claude --resume ${c.id}`)));
  body.replaceChildren(...nodes);
  const scroller = $('#dlg .dlg-body');
  scroller.scrollTop = scroller.scrollHeight;
}

// ---------------------------------------------------------------- changes and usage

function budgetInput(value, onchange, disabled) {
  const fallback = S.settings.taskBudget > 0 ? `Default: ${money(S.settings.taskBudget)}` : 'No limit';
  return h('input', { type: 'number', min: 0, step: 0.5, placeholder: fallback, disabled, value: value > 0 ? String(value) : '', onchange: (e) => onchange(Math.max(0, Number(e.target.value) || 0)) });
}

function diffView(f) {
  if (f.binary) return h('p', { class: 'hint' }, 'Binary file: no text to show.');
  const lines = f.patch.split('\n');
  const from = lines.findIndex((l) => l.startsWith('@@'));
  if (from < 0) return h('p', { class: 'hint' }, f.kind === 'renamed' ? 'Renamed without other changes.' : 'No text changes.');
  const pre = h('pre', { class: 'diff' }, lines.slice(from).map((l) => h('span', { class: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l[0] === '@' ? 'hunk' : '' }, l || ' ')));
  return f.cut ? [pre, h('p', { class: 'hint' }, 'This file has long changes; only the first part is shown.')] : pre;
}

async function loadChanges(id, box) {
  let r;
  try { r = await api('GET', `/api/tasks/${id}/changes`, null, { quiet: true }); } catch { box.replaceChildren(h('p', { class: 'hint' }, 'Could not load the changes.')); return; }
  if (!r.files) { box.replaceChildren(h('p', { class: 'hint' }, r.reason)); return; }
  const openAll = r.files.length <= 3 && r.files.reduce((n, f) => n + f.added + f.removed, 0) <= 80;
  box.replaceChildren(...r.files.map((f) => {
    const body = h('div', { class: 'file-body' });
    const fill = () => { if (!body.childNodes.length) body.append(...[diffView(f)].flat()); };
    const d = h('details', { class: 'file', ontoggle: (e) => { if (e.target.open) fill(); } },
      h('summary', null,
        h('span', { class: 'fname' }, f.path),
        f.kind !== 'changed' && h('span', { class: 'chip' }, { new: 'New', deleted: 'Deleted', renamed: 'Renamed' }[f.kind]),
        h('span', { class: 'fstat' }, f.binary ? 'binary' : `+${f.added} −${f.removed}`)),
      body);
    if (openAll) { d.open = true; fill(); }
    return d;
  }));
}

function spendChart(days) {
  const max = Math.max(...days.map((d) => d.cost));
  if (!(max > 0)) return h('p', { class: 'hint' }, 'No agent runs in the last 14 days.');
  const today = days[days.length - 1].at;
  return h('div', { class: 'chart' },
    h('div', { class: 'chart-top' }, h('span', null, money(max)), h('span', { class: 'rule' })),
    h('div', { class: 'bars' }, days.map((d, i) => {
      const label = `${d.at === today ? 'Today' : dayLabel(d.at)}: ${money(d.cost)} in ${plural(d.runs, 'run')}`;
      return h('div', { class: `bar-col${i < 3 ? ' left' : i > days.length - 4 ? ' right' : ''}`, tabIndex: 0, 'aria-label': label },
        d.cost > 0 && h('div', { class: 'bar', style: `height:${Math.max(3, (d.cost / max) * 100)}%` }),
        h('div', { class: 'tip' }, label));
    })),
    h('div', { class: 'chart-x' }, h('span', null, dayLabel(days[0].at)), h('span', null, dayLabel(days[7].at)), h('span', null, 'Today')));
}

function usageDialog() {
  const u = S.usage;
  const s = S.settings;
  const tile = (label, value, note) => h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), note && h('div', { class: 'hint' }, note));
  const limits = [];
  for (const [key, label] of [['five_hour', '5-hour limit'], ['seven_day', 'Weekly limit']]) {
    const w = u.limits && u.limits.windows[key];
    const st = limitState(w);
    if (!st) continue;
    const resets = new Date(w.resetsAt).toLocaleString('en-IN', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    limits.push(h('div', { class: 'limit' },
      h('div', { class: 'limit-head' }, h('span', null, label), h('strong', null, st.reset ? 'Reset since the last agent run' : `${st.pct}% used${st.word ? ` · ${st.word}` : ''}`)),
      meter(label, st),
      !st.reset && h('div', { class: 'hint' }, `Resets ${resets}`)));
  }
  const rows = Object.entries(u.byProject).sort((a, b) => b[1].month - a[1].month || b[1].all - a[1].all);
  const name = (pid) => (S.projects.find((p) => p.id === pid) || { name: '(removed project)' }).name;
  const daily = h('input', { type: 'number', min: 0, step: 1, value: s.dailyBudget > 0 ? String(s.dailyBudget) : '', placeholder: 'No limit' });
  const perRun = h('input', { type: 'number', min: 0, step: 0.5, value: s.taskBudget > 0 ? String(s.taskBudget) : '', placeholder: 'No limit' });
  const hold = h('input', { type: 'number', min: 0, max: 100, step: 5, value: s.holdPercent > 0 ? String(s.holdPercent) : '', placeholder: 'Never' });

  showDialog('Usage and budgets', [
    u.hold && h('div', { class: 'banner bad', style: 'border-radius:8px; border:0' }, u.hold),
    h('div', { class: 'tiles' },
      tile('Today', money(u.totals.today), s.dailyBudget > 0 ? `of ${money(s.dailyBudget)} daily limit` : null),
      tile('This week', money(u.totals.week)),
      tile('This month', money(u.totals.month))),
    h('div', null,
      h('div', { class: 'sect-title' }, 'Your Claude plan limits'),
      limits.length
        ? [h('div', { class: 'limits' }, limits), h('p', { class: 'hint', style: 'margin-top:8px' }, `As of ${ago(u.limits.at)}. This updates each time a dashboard agent runs. Your own Claude sessions use the same limits, so the real number can be higher.`)]
        : h('p', { class: 'hint' }, 'Shown after the first agent run.')),
    h('div', null, h('div', { class: 'sect-title' }, 'Spend per day, last 14 days'), spendChart(u.days)),
    rows.length ? h('div', null,
      h('div', { class: 'sect-title' }, 'By project'),
      h('div', { class: 'md' }, h('div', { class: 'table' }, h('table', { class: 'usage-table' },
        h('tr', null, ['Project', 'Today', 'This week', 'This month', 'Runs'].map((c) => h('th', null, c))),
        rows.map(([pid, r]) => h('tr', null, h('td', null, name(pid)), h('td', null, money(r.today)), h('td', null, money(r.week)), h('td', null, money(r.month)), h('td', null, r.runs))))))) : null,
    h('div', { class: 'stack' },
      h('div', { class: 'sect-title' }, 'Budgets'),
      h('div', { class: 'row' },
        field('Daily spend limit ($)', daily),
        field('Spend limit for one agent run ($)', perRun)),
      field('Pause new agents when a plan limit is this full (%)', hold),
      h('p', { class: 'hint' }, 'Leave a box empty for no limit. When the daily limit or the plan-limit pause is hit, queued tasks wait and start again by themselves; running agents finish. A run that hits its own limit stops and lands in Needs review. Dollar amounts are what the runs would cost at API prices. On a Claude subscription you are not billed these amounts; there the plan limits are what matter.')),
  ], [
    cancelBtn(),
    h('button', { class: 'btn primary', onclick: async () => {
      await api('PATCH', '/api/settings', { dailyBudget: Number(daily.value) || 0, taskBudget: Number(perRun.value) || 0, holdPercent: Number(hold.value) || 0 });
      closeDialog();
      refresh();
    } }, 'Save'),
  ]);
}

// ---------------------------------------------------------------- wiring

$('#btn-new').addEventListener('click', newTaskDialog);
$('#btn-link').addEventListener('click', () => linkDialog());
$('#btn-settings').addEventListener('click', settingsDialog);
$('#usage').addEventListener('click', usageDialog);
$('#btn-refresh').addEventListener('click', () => refresh(true).then(() => toast('Project info refreshed.')).catch(() => {}));
$('#drawer').addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) closeDrawer(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.open && !$('#dlg').open) closeDrawer();
});

function connect() {
  const es = new EventSource('/api/events');
  const banner = $('#banner');
  es.onopen = () => {
    if (banner.dataset.offline) { delete banner.dataset.offline; banner.hidden = true; }
    refreshSoon();
  };
  es.onmessage = refreshSoon;
  es.onerror = () => {
    banner.dataset.offline = '1';
    banner.className = 'banner bad';
    banner.textContent = 'Lost contact with the dashboard server. Start it again and this page will reconnect.';
    banner.hidden = false;
  };
}

refresh().catch(() => {}).finally(() => { connect(); openFromHash(); });
setInterval(() => { if (!document.hidden) renderProjects(); }, 60000);
