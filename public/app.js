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

// ---------------------------------------------------------------- theme

// The page follows this Mac's light or dark setting until you choose one.
const ICON_SUN = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="3.6"/><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7z"/></svg>';
const themeChoice = () => { try { return localStorage.getItem('dash.theme') || ''; } catch { return ''; } };
const themeNow = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function setTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  try { if (choice) localStorage.setItem('dash.theme', choice); else localStorage.removeItem('dash.theme'); } catch { /* private window */ }
  paintTheme();
}
function paintTheme() {
  const b = $('#btn-theme');
  const dark = themeNow() === 'dark';
  b.innerHTML = dark ? ICON_SUN : ICON_MOON; // fixed markup, nothing from outside
  b.title = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
  b.setAttribute('aria-label', b.title);
}

// ---------------------------------------------------------------- state

let S = { settings: {}, projects: [], tasks: [], meta: {}, usage: null, forecast: null };
const ui = {
  filter: localStorage.getItem('dash.filter') || 'all',
  tag: localStorage.getItem('dash.tag') || '', // show only projects with this tag ('' = all)
  open: null,       // id of the task shown in the drawer
  task: null,       // full task (with activity log) for the drawer
  allDone: false,
  armDone: 0,       // until when "Mark all done" waits for its second click
  armRun: 0,        // the same for "Run all anyway"
  loaded: false,
  sel: new Map(),   // "T12/r1s3" -> { on, mode }: suggestions you ticked, and the mode chosen for each
  onState: null,    // lets an open dialog follow live updates
};

// Model levels, cheapest first: [level, name, model].
const TIERS = [['eco', 'Eco', 'haiku'], ['efficient', 'Efficient', 'sonnet'], ['optimized', 'Optimized', 'opus'], ['max', 'Max', 'fable']];
const MODEL_NAME = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };
// False while the page is newer than the running server (it was updated but
// not restarted yet): the new features stay hidden until the restart.
const PAGE_VERSION = 10;
const serverHas = (n) => (S.meta.version || 1) >= n;
const v2 = () => serverHas(2);

// How careful agents are with your Claude limit.
const USAGE_MODES = [
  ['saver', 'Saver', 'Uses the least: one agent at a time, Auto picks the model for every task set to Default, nothing runs above Optimized (Opus), small models think less, a run stops at its spend limit, and the biggest tasks plan first and edit only after your OK.'],
  ['balanced', 'Balanced', 'Two agents at a time, and Auto picks the model for every task set to Default. Nothing else is held back.'],
  ['full', 'Full power', 'Tasks set to Default use Claude Code\'s own model, and as many agents run at once as Settings allows.'],
];
// The mode you picked, and the mode in force: the dashboard acts as Saver
// while your 5-hour limit is nearly full, whatever you picked.
const chosenMode = () => (serverHas(5) && S.settings.usageMode) || 'full';
const steppedDown = () => Boolean(serverHas(8) && S.usage && S.usage.stepped);
const usageMode = () => (steppedDown() ? 'saver' : chosenMode());
const steppedNote = () => `Acting as Saver for now: your 5-hour limit is ${S.usage.autoSaver}% full or more. Your own mode comes back by itself when the limit resets.`;
// What "Default" means for a task right now.
const defaultModel = () => S.settings.defaultModel || (usageMode() === 'full' ? '' : 'auto');
// A waiting task that "Run anyway" can push through.
const canForce = (t) => /^(Paused|Waiting for room|Waiting for your Claude|Waiting for T\d|Waiting: T\d)/.test(t.waitReason || '');
const REPEATS = [['', 'Never'], ['daily', 'Every day'], ['weekly', 'Every week']];
const plansFirst = (t) => t.phase === 'plan';

function modelLabel(v) {
  if (v === 'auto') return 'Auto';
  const tier = TIERS.find((x) => x[2] === v);
  return tier ? `${tier[1]} · ${MODEL_NAME[v]}` : 'Default';
}
// The choices for a model box.
function modelOptions(forSettings) {
  const def = defaultModel();
  const first = forSettings ? (usageMode() === 'full' ? "Claude Code's own default" : 'Auto (set by the usage mode)') : def ? `Default (${modelLabel(def)})` : 'Default';
  return [['', first], v2() && ['auto', 'Auto (by task type)'], ...TIERS.map((x) => [x[2], modelLabel(x[2])])].filter(Boolean);
}
// The level a suggestion will really run at: never above the limit in Settings.
function cappedTier(size) {
  const keys = TIERS.map((x) => x[0]);
  const top = keys.indexOf(S.settings.autoMax);
  return TIERS[Math.min(Math.max(0, keys.indexOf(size)), top < 0 ? TIERS.length - 1 : top)];
}

const MODES = [['plan', 'Plan only (no changes)'], ['edit', 'Edit files (no commits)']];
const PRIORITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']];

const projectOf = (t) => S.projects.find((p) => p.id === t.projectId);
const isAgent = (t) => t.assignee && t.assignee.kind === 'agent';
const locked = (t) => t.status === 'queued' || (t.status === 'running' && isAgent(t));

async function refresh(fresh) {
  S = await api('GET', `/api/state${fresh ? '?fresh=1' : ''}`, null, { quiet: ui.loaded });
  ui.loaded = true;
  if (ui.filter !== 'all' && !S.projects.some((p) => p.id === ui.filter)) setFilter('all', true);
  if (ui.tag && !S.projects.some((p) => hasTag(p, ui.tag))) setTag('', true);
  render();
  if (ui.open) loadOpen();
}

let refreshTimer;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), 120);
}

function setFilter(id, silent) {
  if (!silent && id !== 'all' && id !== ui.filter) noteOpened(id);
  ui.filter = id;
  ui.allDone = false;
  localStorage.setItem('dash.filter', id);
  if (!silent) render();
}

// ---------------------------------------------------------------- project tags

// Tags group similar projects ("Android", "Client work"). Picking one in the
// side list shows only those projects and their tasks.
const tagsOf = (p) => (p && p.tags) || [];
const hasTag = (p, tag) => tagsOf(p).some((x) => x.toLowerCase() === tag.toLowerCase());
const inTag = (p) => !ui.tag || hasTag(p, ui.tag);
function allTags() {
  const seen = new Map(); // lower-case tag -> [tag, number of projects]
  for (const p of S.projects) for (const x of tagsOf(p)) {
    const row = seen.get(x.toLowerCase()) || [x, 0];
    row[1]++;
    seen.set(x.toLowerCase(), row);
  }
  return [...seen.values()].sort((a, b) => a[0].localeCompare(b[0]));
}
function setTag(tag, silent) {
  ui.tag = tag;
  ui.allDone = false;
  localStorage.setItem('dash.tag', tag);
  // A project outside the chosen tag would be open but missing from the list.
  if (ui.filter !== 'all' && !inTag(S.projects.find((p) => p.id === ui.filter))) setFilter('all', true);
  if (!silent) render();
}

// ---------------------------------------------------------------- project order

// How the project list is sorted. The choice, your own drag order and when you
// last opened each project are kept in this browser only.
const PROJECT_SORTS = [
  ['priority', 'Priority (auto)'],
  ['recent', 'Recently opened'],
  ['least', 'Least recently opened'],
  ['most', 'Most opened'],
  ['name', 'A to Z'],
  ['custom', 'Custom (drag to arrange)'],
];
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function writeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full or blocked */ }
}
function projSort() {
  const v = localStorage.getItem('dash.sort');
  return PROJECT_SORTS.some(([k]) => k === v) ? v : 'priority';
}
function setProjSort(v) {
  // Starting Custom with no saved order keeps the order you see now.
  if (v === 'custom' && !readJSON('dash.order', []).length && ui.shownOrder) writeJSON('dash.order', ui.shownOrder);
  localStorage.setItem('dash.sort', v);
  $('#proj-sort').value = v;
  renderProjects();
}
// "Opened" = picked in the side list, or opened in Finder / VS Code.
function noteOpened(pid) {
  const all = readJSON('dash.opened', {});
  all[pid] = { at: Date.now(), n: ((all[pid] && all[pid].n) || 0) + 1 };
  writeJSON('dash.opened', all);
}

// What makes a project need you now, for the Priority sort.
function urgency(p) {
  const mine = S.tasks.filter((t) => t.projectId === p.id && t.status !== 'done' && t.kind !== 'scan');
  const days = p.deadline ? Math.ceil((new Date(p.deadline + 'T00:00') - Date.now()) / 86400000) : null;
  return {
    days,
    // A deadline in the next two weeks counts. One missed by more than two
    // weeks is probably stale, so it no longer pins the project to the top.
    soon: days !== null && days >= -14 && days <= 14 ? days : Infinity,
    high: mine.filter((t) => t.priority === 'high').length,
    review: mine.filter((t) => t.status === 'review').length,
    open: mine.length,
  };
}

function sortedProjects(mode = projSort()) {
  const status = { active: 0, paused: 1, shipped: 2 };
  const opened = readJSON('dash.opened', {});
  const at = (p) => (opened[p.id] && opened[p.id].at) || 0;
  const n = (p) => (opened[p.id] && opened[p.id].n) || 0;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const list = [...S.projects];
  if (mode === 'custom') {
    const order = readJSON('dash.order', []);
    const pos = (p) => { const i = order.indexOf(p.id); return i < 0 ? Infinity : i; };
    // Projects linked after you arranged the list go at the end.
    return list.sort((a, b) => pos(a) - pos(b) || status[a.status] - status[b.status] || byName(a, b));
  }
  let cmp = byName;
  if (mode === 'recent') cmp = (a, b) => at(b) - at(a) || byName(a, b);
  if (mode === 'least') cmp = (a, b) => at(a) - at(b) || byName(a, b);
  if (mode === 'most') cmp = (a, b) => n(b) - n(a) || at(b) - at(a) || byName(a, b);
  if (mode === 'priority') {
    const u = new Map(list.map((p) => [p.id, urgency(p)]));
    cmp = (a, b) => {
      const x = u.get(a.id), y = u.get(b.id);
      return (x.soon - y.soon || 0) || y.high - x.high || y.review - x.review || y.open - x.open || at(b) - at(a) || byName(a, b);
    };
  }
  // Paused and shipped projects stay below the active ones.
  return list.sort((a, b) => status[a.status] - status[b.status] || cmp(a, b));
}

function clearDropMarks() {
  for (const el of document.querySelectorAll('.proj.drop-before, .proj.drop-after')) el.classList.remove('drop-before', 'drop-after');
}

// Moves a project in the custom order (and switches to Custom).
function moveProject(pid, beforeId) {
  const order = (ui.shownOrder || S.projects.map((p) => p.id)).filter((id) => id !== pid);
  const i = beforeId ? order.indexOf(beforeId) : -1;
  order.splice(i < 0 ? order.length : i, 0, pid);
  writeJSON('dash.order', order);
  if (projSort() !== 'custom') toast('Switched to Custom order. Pick another sort any time.');
  ui.holdOrder = false;
  setProjSort('custom');
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
  } else if (banner.dataset.offline) {
    // keep the "lost contact" message
  } else if (ui.loaded && !serverHas(PAGE_VERSION)) {
    banner.className = 'banner';
    banner.textContent = 'The dashboard was updated. Restart it (close its Terminal window, then open start.command again) to get the newest features. A restart stops running agents and moves waiting tasks back to To do, so let them finish first.';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  $('#btn-suggest').hidden = !v2() || !S.projects.length;
  $('#btn-plan').hidden = !serverHas(10) || !S.forecast || !S.forecast.projects.length;
  $('#usage-refresh').hidden = !serverHas(3) || !S.usage;
  const pick = $('#usage-mode');
  pick.hidden = !serverHas(5);
  if (document.activeElement !== pick) pick.value = chosenMode();

  renderUsageStrip();
  renderProjects();
  renderBoard();
  if (ui.onState) ui.onState();
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
  else if (steppedDown()) bits.push(h('span', { class: 'chip', title: steppedNote() }, 'Saver until reset'));
  el.replaceChildren(...bits);
}

function renderProjects() {
  const nav = $('#projects');
  const open = (p) => S.tasks.filter((t) => t.status !== 'done' && (p ? t.projectId === p.id : inTag(projectOf(t))));
  const tags = allTags();
  $('#proj-tags').hidden = !tags.length;
  $('#proj-tags').replaceChildren(...tags.map(([tag, n]) => h('button', {
    class: `chip tag${hasTag({ tags: [tag] }, ui.tag) ? ' on' : ''}`, 'aria-pressed': String(hasTag({ tags: [tag] }, ui.tag)),
    title: ui.tag && hasTag({ tags: [tag] }, ui.tag) ? 'Show all projects again' : `Show only the ${plural(n, 'project')} tagged ${tag}`,
    onclick: () => setTag(hasTag({ tags: [tag] }, ui.tag) ? '' : tag),
  }, `${tag} ${n}`)));
  const rows = [
    h('button', { class: `proj${ui.filter === 'all' ? ' on' : ''}`, onclick: () => setFilter('all') },
      h('span', { class: 'proj-name' }, ui.tag ? `All tagged ${ui.tag}` : 'All projects'),
      h('span', { class: 'proj-right' }, h('span', { class: 'count' }, open().length))),
  ];
  const mode = projSort();
  let sorted = sortedProjects(mode);
  // While the pointer is on the list, keep rows where they are so the one you
  // just clicked does not jump away. The new order shows when you leave.
  if (ui.holdOrder && ui.shownOrder) {
    const pos = (p) => { const i = ui.shownOrder.indexOf(p.id); return i < 0 ? Infinity : i; };
    sorted = [...S.projects].sort((a, b) => pos(a) - pos(b));
  }
  ui.shownOrder = sorted.map((p) => p.id);
  if ($('#proj-sort').value !== mode) $('#proj-sort').value = mode;
  $('#proj-tip').hidden = mode !== 'custom';
  for (const p of sorted) {
    if (!inTag(p)) continue;
    const mine = open(p);
    const busy = mine.some((t) => t.status === 'running');
    const info = p.info || {};
    const urg = urgency(p);
    const sub = [];
    if (!info.exists) sub.push(h('span', { class: 'warn' }, 'Folder missing'));
    else {
      if (p.status !== 'active') sub.push(p.status === 'paused' ? 'Paused' : 'Shipped');
      if (p.status === 'active' && urg.soon !== Infinity) {
        sub.push(h('span', { class: urg.days < 0 ? 'warn' : 'dirty' },
          urg.days < 0 ? `Deadline passed ${plural(-urg.days, 'day')} ago` : urg.days === 0 ? 'Due today' : `Due in ${plural(urg.days, 'day')}`));
      }
      if (urg.high) sub.push(h('span', { class: 'dirty' }, `${urg.high} high`));
      sub.push(info.type);
      if (info.git) {
        sub.push(info.git.branch);
        if (info.git.changed) sub.push(h('span', { class: 'dirty' }, `${info.git.changed} changed`));
        if (info.git.last) sub.push(ago(info.git.last.at));
      } else sub.push('no git');
    }
    rows.push(h('div', {
      class: `proj${ui.filter === p.id ? ' on' : ''}${p.status !== 'active' ? ' dim' : ''}`,
      role: 'button', tabIndex: 0, title: `${p.path}\nDrag to arrange, or Alt+Up / Alt+Down`,
      draggable: true, dataset: { pid: p.id },
      onclick: () => setFilter(p.id),
      onkeydown: (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') setFilter(p.id);
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          const ids = ui.shownOrder;
          const i = ids.indexOf(p.id);
          const j = e.key === 'ArrowUp' ? i - 1 : i + 2;
          if (j < 0 || i + (e.key === 'ArrowUp' ? -1 : 1) >= ids.length) return;
          moveProject(p.id, ids[j]);
          const el = $(`.proj[data-pid="${p.id}"]`);
          if (el) el.focus();
        }
      },
      ondragstart: (e) => { ui.drag = p.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.name); e.currentTarget.classList.add('dragging'); },
      ondragend: (e) => { ui.drag = null; e.currentTarget.classList.remove('dragging'); clearDropMarks(); },
      ondragover: (e) => {
        if (!ui.drag || ui.drag === p.id) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        clearDropMarks();
        e.currentTarget.classList.add(after ? 'drop-after' : 'drop-before');
      },
      ondrop: (e) => {
        if (!ui.drag || ui.drag === p.id) return;
        e.preventDefault();
        const after = e.currentTarget.classList.contains('drop-after');
        const ids = ui.shownOrder.filter((id) => id !== ui.drag);
        const before = after ? ids[ids.indexOf(p.id) + 1] : p.id;
        const id = ui.drag;
        ui.drag = null;
        moveProject(id, before);
      },
    },
    h('span', { class: 'proj-name' }, p.name),
    h('span', { class: 'proj-right' },
      busy && h('span', { class: 'dot', title: 'Work in progress' }),
      h('span', { class: 'count' }, mine.length),
      h('button', { class: 'more', title: 'Project details', 'aria-label': `Details for ${p.name}`, onclick: (e) => { e.stopPropagation(); projectDialog(p.id); } }, '···')),
    h('span', { class: 'proj-sub' }, sub.flatMap((x, i) => (i ? [' · ', x] : [x]))),
    tagsOf(p).length ? h('span', { class: 'proj-tags' }, tagsOf(p).map((x) => h('span', { class: 'chip' }, x))) : null));
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
  $('#board-title').textContent = project ? project.name : ui.tag ? `Projects tagged ${ui.tag}` : 'All projects';
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

  const tasks = S.tasks.filter((t) => (ui.filter === 'all' ? inTag(projectOf(t)) : t.projectId === ui.filter));
  board.replaceChildren(...COLS.map((col) => {
    let list = tasks.filter(col.match).sort(SORT[col.key]);
    const total = list.length;
    let more = null;
    if (col.key === 'done' && !ui.allDone && total > 15) {
      list = list.slice(0, 15);
      more = h('button', { class: 'link', onclick: () => { ui.allDone = true; renderBoard(); } }, `Show all ${total}`);
    }
    return h('section', { class: `col col-${col.key}` },
      h('div', { class: 'col-head' }, h('h3', null, col.title), h('span', { class: 'count' }, total),
        col.key === 'review' && markAllDone(list),
        col.key === 'todo' && runAllAnyway(list)),
      h('div', { class: 'col-body' },
        list.length ? list.map(card) : h('div', { class: 'empty' }, col.empty),
        more));
  }));
}

// "Mark all done" for the Needs review column. Suggestion scans are left
// alone, so their suggestions stay available. It asks once before it acts.
function markAllDone(list) {
  const ids = list.filter((t) => t.kind !== 'scan').map((t) => t.id);
  if (!serverHas(6) || !ids.length) return null;
  const armed = ui.armDone > Date.now();
  return h('button', {
    class: `link col-action${armed ? ' armed' : ''}`,
    title: 'Moves every task in this column to Done. Suggestion scans stay here.',
    onclick: async () => {
      if (!armed) {
        ui.armDone = Date.now() + 5000;
        renderBoard();
        setTimeout(() => { if (ui.armDone && ui.armDone <= Date.now()) { ui.armDone = 0; renderBoard(); } }, 5100);
        return;
      }
      ui.armDone = 0;
      try {
        const r = await api('POST', '/api/tasks/mark-done', { ids });
        toast(`Marked ${plural(r.done, 'task')} done.`);
      } catch { /* the error is already shown */ }
      refresh().catch(() => {});
    },
  }, armed ? `Mark ${ids.length} done?` : 'Mark all done');
}

// "Run all anyway" for the To do column: starts every waiting task that
// "Run anyway" could push through, in the tasks shown now (the chosen project
// or tag). Many agents at once can use up your Claude limit fast, so it asks
// once before it acts.
function runAllAnyway(list) {
  const ids = list.filter(canForce).map((t) => t.id);
  if (ids.length < 2) return null;
  const armed = ui.armRun > Date.now();
  return h('button', {
    class: `link col-action${armed ? ' armed' : ''}`,
    title: 'Starts every waiting task now, without waiting for room, the limit, the agents-at-once cap or the task before it.',
    onclick: async () => {
      if (!armed) {
        ui.armRun = Date.now() + 5000;
        renderBoard();
        setTimeout(() => { if (ui.armRun && ui.armRun <= Date.now()) { ui.armRun = 0; renderBoard(); } }, 5100);
        return;
      }
      ui.armRun = 0;
      let n = 0;
      for (const id of ids) {
        try { await api('POST', `/api/tasks/${id}/run`, { force: true }, { quiet: true }); n++; } catch { /* finished or stopped meanwhile */ }
      }
      toast(`Started ${plural(n, 'task')} anyway.`);
      refresh().catch(() => {});
    },
  }, armed ? `Run ${ids.length} now?` : 'Run all anyway');
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
      canForce(t) && h('button', { class: 'btn small', onclick: stop(() => runTask(t.id, { force: true })) }, 'Run anyway'),
    ];
  } else if (t.status === 'running') {
    line = h('div', { class: 'card-line' },
      h('span', { class: 'dot' }),
      h('span', { class: 'what' }, t.last && t.last.kind !== 'status' ? firstLine(t.last.text) : (isAgent(t) ? 'Starting…' : 'Working…')),
      h('span', { class: 'timer', dataset: { since: t.startedAt } }, dur(Date.now() - t.startedAt)));
    if (isAgent(t)) actions = h('button', { class: 'btn small', onclick: stop(() => act(t.id, 'stop')) }, 'Stop');
  } else if (t.status === 'review') {
    const label = (plansFirst(t) && t.outcome === 'ok' ? 'Plan ready: needs your OK' : { ok: 'Finished', failed: 'Did not finish', stopped: 'Stopped' }[t.outcome]) || 'Waiting for you';
    const found = t.kind === 'scan' && t.outcome === 'ok' && t.suggestions ? plural(t.suggestions.length, 'suggestion') : null;
    line = h('div', { class: `card-line ${t.outcome === 'failed' ? 'failed' : 'review'}` },
      h('span', { class: 'what' }, [found || label, ago(t.finishedAt), t.changes && t.changes.files ? plural(t.changes.files, 'file') + ' changed' : null].filter(Boolean).join(' · ')));
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
    t.kind === 'scan'
      ? h('span', { class: 'chip right scan' }, 'Suggestions')
      : h('span', { class: `chip right ${plansFirst(t) ? 'plan' : t.mode}` }, plansFirst(t) ? 'Plan first' : t.mode === 'edit' ? 'Edit files' : 'Plan only')),
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
// Hands a task to the Claude panel in VS Code: the same conversation
// ("continue"), or a new one with the task ready to send ("start").
async function openInVSCode(id, how, button) {
  if (document.activeElement) document.activeElement.blur(); // lets the buttons redraw
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Opening VS Code…';
  try {
    const r = await api('POST', `/api/tasks/${id}/vscode`, { how });
    toast(r.message);
  } catch { /* the error is already shown */ }
  button.disabled = false;
  button.textContent = label;
  refreshSoon();
}
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
  if (/^C[0-9a-f-]{36}$/.test(id)) conversationReader(id.slice(1));
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

  const scan = t.kind === 'scan';
  const usesAuto = (t.model || defaultModel()) === 'auto';
  part('#d-fields', [t.title, t.description, t.projectId, t.mode, t.model, t.priority, t.budget, S.settings.taskBudget, defaultModel(), usageMode(), S.meta.version, t.auto && t.auto.at, t.phase, t.status, t.after, t.repeat, t.copy, JSON.stringify(t.work || 0), S.tasks.length, lock, S.projects.map((p) => p.id + p.name).join()].join('\u0001'), () =>
    h('div', { class: 'stack' },
      h('input', { type: 'text', class: 'd-title', value: t.title, 'aria-label': 'Title', onchange: (e) => patchTask(id, { title: e.target.value }) }),
      scan
        ? field('Anything to focus on (optional)', h('textarea', { rows: 2, value: t.description, placeholder: 'For example: what blocks the Play Store release.', onchange: (e) => patchTask(id, { description: e.target.value }) }))
        : field('What should be done', h('textarea', { rows: 6, value: t.description, placeholder: 'Describe the task the way you would brief a developer: what to change, where, and how to tell it worked.', onchange: (e) => patchTask(id, { description: e.target.value }) })),
      h('div', { class: 'row' },
        !scan && field('Project', select(S.projects.map((p) => [p.id, p.name]), t.projectId, (v) => patchTask(id, { projectId: v }), lock)),
        !scan && field('Agent may', select(MODES, t.mode, (v) => patchTask(id, { mode: v }), lock)),
        field('Model', select(modelOptions(), t.model, (v) => patchTask(id, { model: v }), lock)),
        field('Priority', select(PRIORITIES, t.priority, (v) => patchTask(id, { priority: v }))),
        field('Spend limit for one run ($)', budgetInput(t.budget, (v) => patchTask(id, { budget: v }), lock)),
        serverHas(7) && !scan && field('Run after', select(
          [['', 'Nothing: run when started'], ...S.tasks.filter((x) => x.id !== id && !x.kind && (x.status !== 'done' || x.id === t.after)).map((x) => [x.id, `${x.id} · ${x.title.slice(0, 40)}`])],
          t.after || '', (v) => patchTask(id, { after: v }))),
        serverHas(7) && field('Repeat', select(REPEATS, t.repeat || '', (v) => patchTask(id, { repeat: v })))),
      serverHas(7) && !scan && t.mode === 'edit' && h('label', { class: 'cp-link' },
        h('input', { type: 'checkbox', checked: Boolean(t.copy), disabled: lock || Boolean(t.work), onchange: (e) => patchTask(id, { copy: e.target.checked }) }),
        'Work in a separate copy of the project, so other agents can edit it at the same time'),
      t.work && h('p', { class: 'hint' }, [
        `Separate copy on branch ${t.work.branch}.`,
        t.work.pr ? `Pull request: ${t.work.pr}.` : null,
        t.work.applied ? 'Its changes were applied to the project folder.' : null,
        !t.work.pr && !t.work.applied && t.status === 'review' ? 'The changes are only in the copy until you apply them or open a pull request.' : null,
      ].filter(Boolean).join(' ')),
      t.repeat && h('p', { class: 'hint' }, scan ? 'Repeats: it looks again by itself after that time.' : 'Repeats: after that time a fresh copy of this task is added and started.'),
      scan && h('p', { class: 'hint' }, `${projectOf(t) ? projectOf(t).name : 'Project'}: Claude looks at ${t.scan && t.scan.code ? (t.scan.notes ? 'the notes, the plans and the code' : 'the code') : 'the notes and plan files'} and changes nothing.`),
      usesAuto && h('p', { class: 'hint' }, t.auto
        ? `Auto picked ${modelLabel(t.auto.model)}: ${t.auto.why}.`
        : 'Auto: when the agent starts, a quick check of the task type picks the model (Eco, Efficient, Optimized or Max).'),
      plansFirst(t) && h('p', { class: 'hint' }, t.status === 'review'
        ? 'Usage saver: this is a big task, so the agent only planned. Read the plan, then press "Carry out this plan" to let it edit files.'
        : 'Usage saver: this is a big task, so the agent plans first and edits files only after your OK.')));

  // A task with a saved conversation can be continued in VS Code; one without can be started there.
  const hasConvo = (t.conversationInfo || []).some((c) => !c.missing);
  part('#d-actions', [t.status, t.outcome, t.mode, t.phase, Boolean(t.sessionId), isAgent(t), canForce(t), hasConvo, Boolean(t.ide), S.meta.version, JSON.stringify(t.work || 0)].join('|'), () => {
    const b = [];
    const btn = (label, fn, cls = '') => h('button', { class: `btn ${cls}`, onclick: fn }, label);
    const vscode = (label) => {
      if (!serverHas(4) || scan) return null;
      const el = btn(label || (hasConvo ? 'Continue in VS Code' : 'Start in VS Code'), () => openInVSCode(id, hasConvo ? 'continue' : 'start', el));
      el.title = hasConvo
        ? 'Opens this task\'s conversation in the Claude panel of VS Code, with everything said so far.'
        : 'Opens VS Code with this task ready in the Claude message box, so you can run it by hand.';
      return el;
    };
    if (t.status === 'todo') {
      b.push(btn('Run agent', () => runTask(id), 'primary'), vscode(), btn('Mark done', () => patchTask(id, { status: 'done' })));
    } else if (t.status === 'queued') {
      b.push(btn('Cancel', () => act(id, 'stop')));
      if (canForce(t)) b.push(btn('Run anyway', () => runTask(id, { force: true })));
    } else if (t.status === 'running') {
      if (isAgent(t)) b.push(btn('Stop agent', () => act(id, 'stop'), 'danger'));
      else if (t.ide) b.push(btn('Finished in VS Code', () => patchTask(id, { status: 'review' }), 'primary'), hasConvo && vscode('Open it in VS Code again'), btn('Mark done', () => patchTask(id, { status: 'done' })), btn('Take it back (To do)', () => patchTask(id, { status: 'todo' })));
      else b.push(btn('Mark done', () => patchTask(id, { status: 'done' })), btn('Take it back (To do)', () => patchTask(id, { status: 'todo' })));
    } else if (t.status === 'review') {
      const planned = (t.mode === 'plan' || plansFirst(t)) && t.outcome === 'ok' && t.sessionId && !scan;
      // A task that planned first is waiting for your OK, so that is the main button.
      b.push(btn('Mark done', () => patchTask(id, { status: 'done' }), planned && plansFirst(t) ? '' : 'primary'));
      if (planned) {
        b.push(btn('Carry out this plan', () => runTask(id, { mode: 'edit', message: 'I have read your plan. Go ahead and carry it out now. You may edit files. Do not commit.' }), plansFirst(t) ? 'primary' : ''));
      }
      if (t.work) {
        const copyDo = async (what, body, el) => {
          if (document.activeElement) document.activeElement.blur();
          el.disabled = true;
          try { await api('POST', `/api/tasks/${id}/copy`, { do: what, ...body }); } catch { /* the error is already shown */ }
          el.disabled = false;
          refreshSoon();
        };
        if (!t.work.applied) { const el = btn('Apply to project', () => copyDo('apply', {}, el)); el.title = 'Puts the changes into the project folder, uncommitted, like a normal task.'; b.push(el); }
        if (!t.work.pr) b.push(btn('Open pull request', () => pullRequestDialog(t)));
        const rm = btn('Remove the copy', () => {
          if (rm.dataset.armed || t.work.applied || t.work.pr) return copyDo('remove', {}, rm);
          rm.dataset.armed = '1'; rm.textContent = 'Throw its changes away?';
        }, 'ghost');
        b.push(rm);
      }
      b.push(vscode(), btn(scan ? 'Look again' : 'Run again from scratch', () => runTask(id)), btn('Back to To do', () => patchTask(id, { status: 'todo' })));
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
  part('#d-follow', [canFollow, t.mode, t.phase].join('|'), () => {
    if (!canFollow) return null;
    const box = h('textarea', { rows: 3, placeholder: 'Ask the same agent for a change or a fix. It remembers what it did.', 'aria-label': 'Follow-up for the agent' });
    return h('div', { class: 'follow' },
      h('div', { class: 'sect-title' }, 'Send a follow-up'),
      box,
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => { const v = box.value.trim(); if (!v) return toast('Write the follow-up first.'); box.blur(); runTask(id, { message: v }); } }, 'Send to agent'),
        h('span', { class: 'hint' }, t.mode === 'edit' && !plansFirst(t) ? 'The agent may edit files.' : 'Plan only: the agent will not change files.')));
  });

  if (scan && Array.isArray(t.suggestions)) {
    part('#d-report', JSON.stringify([t.suggestions.map((s) => [s.id, addedAs(s)]), t.summary, t.report, t.outcome]), () => {
      const btns = adoptButtons(() => (ui.task && ui.task.id === id ? [ui.task] : []));
      return [
        t.outcome === 'failed' && t.report && t.report !== t.summary && h('div', { style: 'margin-bottom:14px' },
          h('div', { class: 'sect-title' }, 'The last look did not finish'),
          h('div', { class: 'report failed' }, md(t.report))),
        h('div', { class: 'sect-title' }, 'Where the project stands'),
        h('div', { class: 'report' }, md(t.summary || 'No summary.')),
        h('div', { class: 'sect-title', style: 'margin-top:14px' }, `Suggestions · ${t.suggestions.length}`),
        t.suggestions.length ? suggestionRows(t, btns.update) : h('p', { class: 'hint' }, 'Nothing to suggest right now.'),
        openSuggestions(t).length ? h('div', { class: 'sug-actions' }, h('span', { class: 'hint' }, 'Tick the ones you want as tasks.'), h('span', { class: 'spacer' }), btns.add, btns.run) : null,
      ];
    });
  } else {
    part('#d-report', [t.report, t.outcome, t.phase].join('\u0001'), () => t.report && [
      h('div', { class: 'sect-title' }, scan ? 'Report' : t.mode === 'plan' || plansFirst(t) ? 'Plan and findings' : 'Report'),
      h('div', { class: `report${t.outcome === 'failed' ? ' failed' : ''}` }, md(t.report)),
    ]);
  }

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
  ui.onState = null; // the dialog being replaced no longer follows updates
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

const MODES_SHORT = [['plan', 'Plan only'], ['edit', 'Edit files']];
const HEAVY = ['Android', 'Gradle', 'Flutter'];

// ---------------------------------------------------------------- AI suggestions

const selKey = (t, s) => `${t.id}/${s.id}`;
// The id of the task a suggestion became, while that task still exists.
const addedAs = (s) => (s.taskId && S.tasks.some((x) => x.id === s.taskId) ? s.taskId : null);
const openSuggestions = (t) => (t.suggestions || []).filter((s) => !addedAs(s));
const tickedIn = (t) => openSuggestions(t).filter((s) => (ui.sel.get(selKey(t, s)) || {}).on);

// Which folds in the suggestion lists are open, so a redraw keeps them as you left them.
const sugOpen = new Map();

// The suggestions of one scan, each with a tick box and its own Plan / Edit switch.
// The ones already on the board are folded away under "N already added".
function suggestionRows(t, onchange) {
  const fresh = t.suggestions.filter((s) => !addedAs(s));
  const added = t.suggestions.filter((s) => addedAs(s));
  const addedKey = `added:${t.id}`;
  return h('div', { class: 'sug-rows' },
    fresh.length ? h('ul', { class: 'found sug-list' }, fresh.map((s) => suggestionRow(t, s, onchange))) : h('p', { class: 'hint' }, 'Every suggestion here is already on the board.'),
    added.length && h('details', { class: 'sug-added', open: sugOpen.get(addedKey), ontoggle: (e) => sugOpen.set(addedKey, e.target.open) },
      h('summary', null, `${plural(added.length, 'suggestion')} already added`),
      h('ul', { class: 'found sug-list' }, added.map((s) => suggestionRow(t, s, onchange)))));
}

function suggestionRow(t, s, onchange) {
  const key = selKey(t, s);
  const st = ui.sel.get(key) || { on: false, mode: s.mode };
  const taskId = addedAs(s);
  const set = (patch) => { Object.assign(st, patch); ui.sel.set(key, st); onchange(); };
  const modeBtn = h('button', { class: 'chip mode', title: 'What the agent may do for this task. Click to switch.', onclick: () => { set({ mode: st.mode === 'edit' ? 'plan' : 'edit' }); paint(); } });
  const paint = () => { modeBtn.className = `chip mode ${st.mode}`; modeBtn.textContent = st.mode === 'edit' ? 'Edit files' : 'Plan only'; };
  paint();
  return h('li', { class: `sug${taskId ? ' is-added' : ''}` },
    h('div', { class: 'sug-top' },
      h('label', { class: 'sug-pick' },
        taskId ? h('span', { class: 'sug-tick' }, '✓') : h('input', { type: 'checkbox', checked: st.on, onchange: (e) => set({ on: e.target.checked }) }),
        h('span', { class: 'sug-title' }, s.title)),
      s.priority === 'high' && h('span', { class: 'chip high' }, 'High'),
      h('span', { class: 'chip' }, s.source === 'notes' ? 'Left in your notes' : 'AI idea'),
      taskId
        ? h('button', { class: 'link', onclick: () => { if ($('#dlg').open) closeDialog(); openTask(taskId); } }, `Added as ${taskId}`)
        : modeBtn),
    h('p', { class: 'sug-details' }, s.details),
    h('p', { class: 'hint' }, [s.from && `From: ${s.from}`, `Model: ${modelLabel(cappedTier(s.size)[2])}`, s.priority === 'low' && 'Low priority'].filter(Boolean).join(' · ')));
}

// "Add to board" and "Add and run" for the ticked suggestions of some scans.
function adoptButtons(getScans) {
  const add = h('button', { class: 'btn', onclick: () => go(false) });
  const run = h('button', { class: 'btn primary', onclick: () => go(true) });
  const update = () => {
    const n = getScans().reduce((sum, t) => sum + tickedIn(t).length, 0);
    add.textContent = n ? `Add ${n} to board` : 'Add to board';
    run.textContent = n ? `Add and run ${plural(n, 'agent')}` : 'Add and run agents';
    add.disabled = run.disabled = !n;
  };
  async function go(runNow) {
    add.disabled = run.disabled = true;
    if (document.activeElement) document.activeElement.blur(); // lets the list redraw
    let made = 0;
    try {
      for (const t of getScans()) {
        const items = tickedIn(t).map((s) => ({ id: s.id, mode: ui.sel.get(selKey(t, s)).mode }));
        if (!items.length) continue;
        const r = await api('POST', `/api/tasks/${t.id}/adopt`, { items, run: runNow });
        made += r.tasks.length;
        for (const it of items) ui.sel.delete(`${t.id}/${it.id}`);
      }
    } catch { /* the error is already shown */ }
    if (made) toast(runNow ? `Started ${plural(made, 'task')}. Extra ones wait in the queue.` : `Added ${plural(made, 'task')} to the board.`);
    await refresh().catch(() => {});
    update();
  }
  update();
  return { add, run, update };
}

function suggestDialog() {
  if (!S.projects.length) return linkDialog();
  const projects = sortedProjects();
  // A project keeps one open scan; a scan you marked done no longer shows here.
  const scanOf = (pid) => S.tasks.filter((t) => t.kind === 'scan' && t.projectId === pid && t.status !== 'done').sort((a, b) => b.createdAt - a.createdAt)[0];
  const busy = (t) => Boolean(t) && (t.status === 'running' || t.status === 'queued');
  const chosen = new Set(projects.some((p) => p.id === ui.filter) ? [ui.filter] : []);
  // Only the ticked projects show their suggestions, and only those can be added.
  const scans = () => projects.filter((p) => chosen.has(p.id)).map((p) => scanOf(p.id)).filter(Boolean);

  const look = select([['notes', 'Notes and plan files (quick)'], ['both', 'Notes, plans and the code (thorough)'], ['code', 'The code only']], 'notes', () => {});
  const model = select(modelOptions().slice(1), 'auto', () => {});
  const focus = h('input', { type: 'text', placeholder: 'Optional, for example: what blocks the release' });
  const goBtn = h('button', { class: 'btn primary', onclick: start });
  const results = h('div', { class: 'sug-results' });
  const none = h('p', { class: 'hint' });
  const btns = adoptButtons(scans);

  const stateOf = (p) => {
    const t = scanOf(p.id);
    if (!t || t.status === 'todo') return ['Not looked at yet', ''];
    if (t.status === 'queued') return [t.waitReason || 'Waiting to start', 'busy'];
    if (t.status === 'running') return [`Looking… ${t.last && t.last.kind !== 'status' ? firstLine(t.last.text) : ''}`, 'busy'];
    if (t.outcome === 'failed') return ['Did not finish', 'bad'];
    if (t.outcome === 'stopped') return ['Stopped', ''];
    const total = (t.suggestions || []).length;
    const left = openSuggestions(t).length;
    const count = total && !left ? `all ${total} added` : `${plural(total, 'suggestion')}${total && left < total ? `, ${left} not added yet` : ''}`;
    return [`${count} · ${ago(t.finishedAt)}`, ''];
  };
  const rows = projects.map((p) => {
    const box = h('input', { type: 'checkbox', checked: chosen.has(p.id), onchange: () => { if (box.checked) chosen.add(p.id); else chosen.delete(p.id); paint(); } });
    const state = h('span', { class: 'state' });
    const notes = (p.info && p.info.notes) || 0;
    const el = h('li', null, h('label', { title: p.path }, box,
      h('span', { class: 'n' }, p.name),
      h('span', { class: 'chip' }, notes ? plural(notes, 'notes file') : 'no notes files'),
      state));
    return { p, box, state, el, notes };
  });
  const choose = (test) => { chosen.clear(); for (const r of rows) { r.box.checked = test(r); if (r.box.checked) chosen.add(r.p.id); } paint(); };

  async function start() {
    goBtn.disabled = true;
    const v = look.value;
    try {
      const r = await api('POST', '/api/suggest', { projectIds: [...chosen], notes: v !== 'code', code: v !== 'notes', model: model.value, focus: focus.value });
      toast(`Looking at ${plural(r.tasks.length, 'project')}. Extra ones wait in the queue.`);
    } catch { /* the error is already shown */ }
    await refresh().catch(() => {});
  }

  const sections = new Map(); // project id -> { key, el }
  // Ticks (or unticks) every suggestion not yet on the board.
  const tickAll = (list, on) => {
    for (const t of list) for (const s of openSuggestions(t)) {
      const key = selKey(t, s);
      ui.sel.set(key, { ...(ui.sel.get(key) || { mode: s.mode }), on });
    }
    sections.clear();
    paint();
  };
  // One project's result, folded open or shut. It starts open while it has
  // suggestions you have not added yet, and keeps whatever you set after that.
  function section(p, t) {
    const failed = t.status === 'review' && t.outcome === 'failed';
    const total = (t.suggestions || []).length;
    const left = openSuggestions(t).length;
    const count = !t.suggestions ? null
      : !total ? 'nothing to suggest'
      : !left ? `all ${total} added`
      : `${left} to pick${left < total ? ` · ${total - left} added` : ''}`;
    // Buttons sit in the fold's header; this stops their click from folding it too.
    const act = (fn) => (e) => { e.preventDefault(); fn(); };
    return h('details', { class: 'sug-proj', open: sugOpen.has(p.id) ? sugOpen.get(p.id) : left > 0 || failed, ontoggle: (e) => sugOpen.set(p.id, e.target.open) },
      h('summary', { class: 'sug-head' },
        h('h4', null, p.name),
        count && h('span', { class: `chip${left ? ' fits' : ''}` }, count),
        h('span', { class: 'hint' }, [busy(t) ? 'Looking again…' : ago(t.finishedAt), t.cost ? money(t.cost) : null].filter(Boolean).join(' · ')),
        h('span', { class: 'spacer' }),
        left > 1 && h('button', { class: 'link', onclick: act(() => tickAll([t], true)) }, 'Tick all'),
        h('button', { class: 'link', onclick: act(() => { closeDialog(); openTask(t.id); }) }, `Open ${t.id}`)),
      failed && h('p', { class: 'bulk-err' }, `The last look did not finish. Open ${t.id} to see why.`),
      t.summary && h('p', { class: 'sug-summary' }, t.summary),
      t.suggestions && (t.suggestions.length ? suggestionRows(t, btns.update) : h('p', { class: 'hint' }, 'Nothing to suggest right now.')));
  }

  function paint() {
    for (const r of rows) {
      const [label, cls] = stateOf(r.p);
      r.state.textContent = label;
      r.state.className = `state ${cls}`;
    }
    const n = chosen.size;
    goBtn.textContent = n ? `Look at ${plural(n, 'project')}` : 'Look at projects';
    goBtn.disabled = !n;
    const want = [];
    for (const p of projects) {
      if (!chosen.has(p.id)) continue;
      const t = scanOf(p.id);
      if (!t || !(t.suggestions || (t.status === 'review' && t.outcome === 'failed'))) continue;
      const key = JSON.stringify([t.id, t.status, t.outcome, t.summary, t.cost, (t.suggestions || []).map((s) => [s.id, addedAs(s)])]);
      let sec = sections.get(p.id);
      if (!sec || sec.key !== key) { sec = { key, el: section(p, t) }; sections.set(p.id, sec); }
      want.push(sec.el);
    }
    none.hidden = want.length > 0;
    const elsewhere = projects.filter((p) => !chosen.has(p.id) && (scanOf(p.id) || {}).suggestions).length;
    none.textContent = !n
      ? `Tick a project above to see its suggestions here.${elsewhere ? ` ${plural(elsewhere, 'project')} already ${elsewhere === 1 ? 'has' : 'have'} some.` : ''}`
      : 'Nothing yet for the ticked projects. Press the button above; suggestions show up here as each project finishes.';
    if (want.length !== results.children.length || want.some((el, i) => results.children[i] !== el)) results.replaceChildren(...want);
    btns.update();
  }

  showDialog('AI suggestions', [
    h('p', { class: 'hint' }, 'Claude looks at each project you tick and lists what is left to do and what could be done next. It changes nothing. You choose which suggestions become tasks.'),
    h('div', { class: 'row three' }, field('Look at', look), field('Model', model), field('Focus on', focus)),
    h('div', null,
      h('div', { class: 'sug-pickers' },
        h('span', { class: 'sect-title' }, 'Projects'),
        h('button', { class: 'link', onclick: () => choose(() => true) }, 'All'),
        h('button', { class: 'link', onclick: () => choose(() => false) }, 'None'),
        h('button', { class: 'link', onclick: () => choose((r) => r.notes > 0) }, 'With notes files'),
        h('button', { class: 'link', onclick: () => choose((r) => !scanOf(r.p.id)) }, 'Not looked at yet')),
      h('ul', { class: 'found sug-projects' }, rows.map((r) => r.el))),
    h('div', { class: 'sug-actions' }, goBtn,
      h('span', { class: 'hint' }, 'One agent per project. Quick takes about a minute each. Thorough reads the code too, so it takes several minutes and uses much more of your Claude limit.')),
    h('div', null,
      h('div', { class: 'sug-pickers' },
        h('span', { class: 'sect-title' }, 'Suggestions'),
        h('button', { class: 'link', onclick: () => tickAll(scans(), true) }, 'Tick all'),
        h('button', { class: 'link', onclick: () => tickAll(scans(), false) }, 'Untick all')),
      none, results),
  ], [
    h('button', { class: 'btn ghost', onclick: closeDialog }, 'Close'),
    h('span', { class: 'spacer' }),
    btns.add, btns.run,
  ]);
  $('#dlg').style.width = 'min(960px, calc(100vw - 32px))';
  ui.onState = paint;
  paint();
}

// A compact list of a project's saved Claude conversations, shown beside the
// add-task forms so you can see where each project stands while you write.
function convoPanel(opts = {}) {
  const list = h('div', { class: 'cp-list' });
  const picker = opts.picker ? select(S.projects.map((p) => [p.id, p.name]), '', (v) => panel.show(v, true)) : null;
  const el = h('aside', { class: 'cp' }, h('div', { class: 'cp-head' }, h('span', { class: 'sect-title' }, 'Recent conversations'), picker), list);
  const panel = { el, pid: null, pinned: false, linked: new Set(), show };
  let ticket = 0;
  async function show(pid, byHand) {
    if (byHand) panel.pinned = true;
    if (!pid || pid === panel.pid) return;
    panel.pid = pid;
    panel.linked.clear();
    if (picker) picker.value = pid;
    const mine = ++ticket;
    list.replaceChildren(h('p', { class: 'hint' }, 'Reading…'));
    let r;
    try { r = await api('GET', `/api/projects/${pid}/conversations`, null, { quiet: true }); } catch { r = { conversations: [] }; }
    if (mine !== ticket) return;
    if (!r.conversations.length) { list.replaceChildren(h('p', { class: 'hint' }, 'No saved conversations for this project.')); return; }
    list.replaceChildren(...r.conversations.slice(0, 12).map((c) => {
      const peek = h('div', { class: 'cp-peek' });
      return h('details', { class: 'cp-item', ontoggle: (e) => {
        if (!e.target.open || peek.childNodes.length) return;
        peek.append(
          c.lastPrompt && h('div', null, h('span', { class: 'cp-tag' }, 'You last asked'), h('p', null, c.lastPrompt)),
          c.lastReply && h('div', null, h('span', { class: 'cp-tag' }, 'Claude ended with'), h('div', { class: 'cp-reply' }, md(c.lastReply))),
          h('div', { class: 'cp-actions' },
            h('a', { class: 'link', href: `/#C${c.id}`, target: '_blank', rel: 'noopener' }, 'Open full conversation'),
            opts.linkable && h('label', { class: 'cp-link' }, h('input', { type: 'checkbox', onchange: (ev) => { if (ev.target.checked) panel.linked.add(c.id); else panel.linked.delete(c.id); } }), 'Link to this task')));
      } },
      h('summary', null, h('span', { class: 'cp-title' }, c.title), h('span', { class: 'cp-when' }, [ago(c.updatedAt), c.agentTask ? `agent ${c.agentTask}` : null].filter(Boolean).join(' · '))),
      peek);
    }));
  }
  return panel;
}

// How many agents may run at once, with plain advice about this Mac. The user
// decides; the advice only says what to expect.
function agentLimit(onchange) {
  const sys = S.meta.system || { memGb: 8, cores: 4 };
  const active = S.projects.filter((p) => p.status === 'active');
  const weights = active.map((p) => (HEAVY.includes(p.info && p.info.type) ? 3 : 1)).sort((a, b) => b - a);
  const reserve = 6; // macOS, VS Code, browser, an emulator
  const heavyMax = Math.max(1, Math.floor((sys.memGb - reserve) / 3));
  const lightMax = Math.max(1, Math.min(sys.cores, sys.memGb - reserve));
  const top = Math.max(4, Math.min(16, S.projects.length));
  const pick = select(Array.from({ length: top }, (_, k) => [String(k + 1), String(k + 1)]), String(Math.min(top, S.settings.maxAgents)), () => { verdict(); if (onchange) onchange(Number(pick.value)); });
  const note = h('p', { class: 'hint' });
  function verdict() {
    const n = Number(pick.value);
    let need = reserve;
    for (let k = 0; k < n; k++) need += weights[k] || 0.5;
    const heavyN = weights.slice(0, n).filter((w) => w === 3).length;
    const base = `This Mac has ${sys.memGb} GB of memory and ${sys.cores} cores. An agent building an Android app needs about 3 GB; a web or plan-only agent about 1 GB or less. Comfortable here: up to ${heavyMax} with Android builds, up to ${lightMax} for light work.`;
    const worst = `${n} at once on your heaviest projects${heavyN ? ` (${heavyN} Android)` : ''} could need about ${Math.round(need)} GB with your other apps.`;
    note.className = `hint${need > sys.memGb ? ' warn-text' : ''}`;
    note.textContent = `${base} ${worst} ${need > sys.memGb ? 'That is more than this Mac has, so expect slow or failed builds. It is your call.' : 'That should fit.'}`;
  }
  verdict();
  return { pick, note, get value() { return Number(pick.value); } };
}

function newTaskDialog() {
  const NEW = '+new';
  const canMake = serverHas(6);
  if (!S.projects.length && !canMake) return linkDialog();
  const active = sortedProjects().filter((p) => p.status === 'active');
  const projects = active.length ? active : S.projects;
  const start = !projects.length ? NEW : projects.some((p) => p.id === ui.filter) ? ui.filter : projects[0].id;
  const panel = convoPanel({ linkable: true });
  const project = select([...sortedProjects().map((p) => [p.id, p.name]), canMake && [NEW, '+ New empty project…']].filter(Boolean), start, (v) => pickProject(v));
  const title = h('input', { type: 'text', placeholder: 'Short name for the task' });
  const desc = h('textarea', { rows: 5, placeholder: 'What to change, where, and how to tell it worked.' });
  const mode = select(MODES_SHORT, 'plan', () => {});
  // A project that does not exist yet: the dashboard makes an empty folder for it.
  const newName = h('input', { type: 'text', placeholder: 'For example: Invoice Maker', spellcheck: false });
  const newParent = h('input', { type: 'text', value: S.meta.suggestRoot || S.meta.home || '', spellcheck: false });
  const newGit = h('input', { type: 'checkbox', checked: true });
  const browse = h('button', { class: 'btn', onclick: async () => {
    browse.disabled = true;
    try { const r = await api('POST', '/api/pick-folder'); if (r.path) newParent.value = r.path; } finally { browse.disabled = false; }
  } }, 'Browse…');
  const copy = h('input', { type: 'checkbox' });
  const newBox = h('div', { class: 'new-project stack tight', hidden: true },
    h('div', { class: 'row two' }, field('Name of the new project', newName), field('Make its folder inside', h('div', { class: 'path-row' }, newParent, browse))),
    h('label', { class: 'cp-link' }, newGit, 'Start a git repository in it, so the board can show what each task changed'),
    h('p', { class: 'hint' }, 'This makes one empty folder with that name. Choose "Edit files" below if the agent should build something in it.'));
  function pickProject(v) {
    newBox.hidden = v !== NEW;
    if (v === NEW) { mode.value = 'edit'; newName.focus(); } else panel.show(v);
  }
  const model = select(modelOptions(), '', () => {});
  const priority = select(PRIORITIES, 'normal', () => {});
  const budget = budgetInput(0, () => {});
  const create = async (run) => {
    if (!title.value.trim()) { title.focus(); return toast('Give the task a title.'); }
    const fresh = project.value === NEW;
    if (fresh) {
      if (!newName.value.trim()) { newName.focus(); return toast('Give the new project a name.'); }
      const p = await api('POST', '/api/projects/new', { name: newName.value, parent: newParent.value, git: newGit.checked });
      // It exists now: choose it, so another try does not make it twice.
      project.append(h('option', { value: p.id }, p.name));
      project.value = p.id;
      newBox.hidden = true;
    }
    const t = await api('POST', '/api/tasks', { projectId: project.value, title: title.value, description: desc.value, mode: mode.value, model: model.value, priority: priority.value, budget: Number(budget.value) || 0, copy: copy.checked && mode.value === 'edit', run });
    for (const sessionId of panel.linked) await api('POST', `/api/tasks/${t.id}/link`, { sessionId }).catch(() => {});
    closeDialog();
    if (fresh) { toast(`Made the project "${newName.value.trim()}" and added the task.`); setFilter(t.projectId, true); await refresh(true).catch(() => {}); return; }
    refreshSoon();
  };
  showDialog('New task', [
    h('div', { class: 'split' },
      h('div', { class: 'stack tight' },
        h('div', { class: 'row two' }, field('Project', project), field('Title', title)),
        newBox,
        field('What should be done', desc),
        h('div', { class: 'row four' }, field('Agent may', mode), field('Model', model), field('Priority', priority), field('Limit ($)', budget)),
        serverHas(7) && h('label', { class: 'cp-link' }, copy, 'Work in a separate copy of the project (for Edit files), so other agents can edit it at the same time'),
        h('p', { class: 'hint' }, 'Plan only changes nothing. Edit files does the work but never commits.')),
      panel.el),
  ], [
    h('button', { class: 'link', onclick: () => bulkDialog() }, 'Several tasks →'),
    h('span', { class: 'spacer' }),
    cancelBtn(),
    h('button', { class: 'btn', onclick: () => create(false).catch(() => {}) }, 'Add to board'),
    h('button', { class: 'btn primary', onclick: () => create(true).catch(() => {}) }, 'Add and run agent'),
  ]);
  $('#dlg').style.width = 'min(920px, calc(100vw - 32px))';
  if (start === NEW) pickProject(NEW); else { panel.show(start); title.focus(); }
}

// Reads the "several tasks" box: one task per line, projects tagged with
// @Name, indented lines are details for the task above.
function parseBulk(source, fallbackId) {
  const norm = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const longestFirst = [...S.projects].sort((x, y) => y.name.length - x.name.length);
  const tasks = [];
  const rows = source.split('\n');
  for (let n = 0; n < rows.length; n++) {
    const raw = rows[n];
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
    let mode = ''; // "!plan" or "!edit" on the line sets it for this task alone
    for (let i = 0; i < line.length;) {
      const wordStart = i === 0 || /\s/.test(line[i - 1]);
      const bang = line[i] === '!' && wordStart && line.slice(i + 1).match(BANG_MODE);
      if (bang) { mode = bang[1].toLowerCase(); i += 1 + bang[1].length; continue; }
      if (line[i] !== '@' || !wordStart) { title += line[i++]; continue; }
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
    tasks.push({ title: title.replace(/\s+/g, ' ').replace(/^[-*•]\s+/, '').trim(), description: '', projectIds, unknown, mode, line: n });
  }
  return tasks;
}
const BANG_MODE = /^(plan|edit)(?=$|[\s,;:.])/i;

function bulkDialog() {
  if (!S.projects.length) return linkDialog();
  const projects = sortedProjects();
  const eg = projects.map((p) => p.name);
  const panel = convoPanel({ picker: true });
  const limit = agentLimit((n) => api('PATCH', '/api/settings', { maxAgents: n }).then(() => { S.settings.maxAgents = n; }));
  const box = h('textarea', { rows: 6, spellcheck: true, 'aria-label': 'Tasks, one per line',
    placeholder: `@${eg[0]} Fix the crash on the settings screen\n    Details go on indented lines under the task.\n@${eg[0]}${eg[1] ? ` @${eg[1]}` : ''} Update the dependencies` });
  const fallback = select([['', 'Nothing (tag needed)'], ...projects.map((p) => [p.id, p.name])],
    S.projects.some((p) => p.id === ui.filter) ? ui.filter : '', () => update());
  const mode = select(MODES_SHORT, 'plan', () => update());
  const model = select(modelOptions(), '', () => {});
  const priority = select(PRIORITIES, 'normal', () => {});
  const preview = h('div', { class: 'bulk-preview' });
  // Each task can have its own mode: "!edit" or "!plan" on its line. Clicking
  // the label in the list below writes that word into the line for you.
  const modeOf = (t) => t.mode || mode.value;
  const switchMode = (t) => {
    const lines = box.value.split('\n');
    const indented = /^\s/.test(lines[t.line]);
    let line = lines[t.line].replace(/(^|\s)!(plan|edit)(?=$|[\s,;:.])/gi, '$1').replace(/\s+$/, '');
    if (!indented) line = line.trimStart();
    lines[t.line] = `${line} !${modeOf(t) === 'edit' ? 'plan' : 'edit'}`;
    box.value = lines.join('\n');
    update();
  };
  // The side list follows the project tagged on the line you are typing.
  const follow = () => {
    if (panel.pinned) return;
    const upto = box.value.slice(0, box.selectionStart);
    const line = box.value.split('\n')[upto.split('\n').length - 1] || '';
    const hit = parseBulk(line, fallback.value)[0];
    const pid = (hit && hit.projectIds[hit.projectIds.length - 1]) || (parsed[0] && parsed[0].projectIds[0]) || fallback.value;
    if (pid) panel.show(pid);
  };
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
          : [
            t.projectIds.map((pid) => h('span', { class: 'chip' }, S.projects.find((p) => p.id === pid).name)),
            h('button', { class: `chip mode ${modeOf(t)}`, title: 'What the agent may do for this task. Click to switch.', onclick: () => switchMode(t) }, modeOf(t) === 'edit' ? 'Edit files' : 'Plan only'),
          ]))),
    ] : []));
    addBtn.textContent = total && !bad ? `Add ${total} to board` : 'Add to board';
    runBtn.textContent = total && !bad ? `Add and run ${plural(total, 'agent')}` : 'Add and run agents';
    addBtn.disabled = runBtn.disabled = bad || !total;
  }
  box.addEventListener('input', () => { panel.pinned = false; update(); follow(); });
  box.addEventListener('keyup', follow);
  box.addEventListener('click', follow);

  const insertTag = (name) => {
    const at = box.selectionStart;
    const before = box.value.slice(0, at);
    const tag = `${before && !/\s$/.test(before) ? ' ' : ''}@${name} `;
    box.setRangeText(tag, at, box.selectionEnd, 'end');
    box.focus();
    panel.pinned = false;
    update();
    follow();
  };

  const inOrder = h('input', { type: 'checkbox' });
  const copies = h('input', { type: 'checkbox' });
  async function create(run) {
    addBtn.disabled = runBtn.disabled = true;
    let made = 0;
    const last = {}; // project id -> the task added before, for "one after another"
    try {
      for (const t of parsed) {
        for (const projectId of t.projectIds) {
          const added = await api('POST', '/api/tasks', { projectId, title: t.title, description: t.description, mode: modeOf(t), model: model.value, priority: priority.value, run,
            copy: copies.checked && modeOf(t) === 'edit', after: inOrder.checked ? last[projectId] || '' : '' });
          last[projectId] = added.id;
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
    h('div', { class: 'split' },
      h('div', { class: 'stack tight' },
        h('div', { class: 'tagbar' }, projects.map((p) => h('button', { class: 'chip tag', title: p.path, onclick: () => insertTag(p.name) }, `@${p.name}`))),
        box,
        h('p', { class: 'hint' }, 'One task per line. Tag with @Name (several tags give the task to each project). Indent a line for details. To let one task edit files and another only plan, add !edit or !plan to its line, or click its label in the list below.'),
        preview,
        h('div', { class: 'row four' }, field('Untagged lines go to', fallback), field('Agent may (default)', mode), field('Model', model), field('Priority', priority)),
        serverHas(7) && h('div', { class: 'sug-pickers' },
          h('label', { class: 'cp-link' }, inOrder, 'In each project, run them one after another'),
          h('label', { class: 'cp-link' }, copies, 'Separate copy for each editing task')),
        h('div', { class: 'row agents' }, field('Agents at once', limit.pick), limit.note)),
      panel.el),
  ], [
    h('button', { class: 'link', onclick: () => newTaskDialog() }, '← One task'),
    h('span', { class: 'spacer' }),
    cancelBtn(), addBtn, runBtn,
  ]);
  $('#dlg').style.width = 'min(980px, calc(100vw - 32px))';
  update();
  follow();
  if (!panel.pid) panel.show(projects[0].id);
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

  // Tags: typed with commas between them. The chips below add a tag another
  // project already has, or this project's kind, with one click.
  const tags = h('input', { type: 'text', value: tagsOf(p).join(', '), placeholder: 'For example: Android, Client work', spellcheck: false });
  const typedTags = () => tags.value.split(',').map((x) => x.trim()).filter(Boolean);
  const tagIdeas = h('div', { class: 'tagbar' });
  const showTagIdeas = () => {
    const have = { tags: typedTags() };
    const ideas = [...allTags().map(([x]) => x), info.exists && info.type !== 'Folder' ? info.type : null]
      .filter((x, i, all) => x && !hasTag(have, x) && all.findIndex((y) => y && y.toLowerCase() === x.toLowerCase()) === i);
    tagIdeas.hidden = !ideas.length;
    tagIdeas.replaceChildren(h('span', { class: 'hint' }, 'Add:'), ...ideas.map((x) => h('button', {
      class: 'chip tag', type: 'button', onclick: () => { tags.value = [...typedTags(), x].join(', '); showTagIdeas(); },
    }, x)));
  };
  tags.addEventListener('input', showTagIdeas);
  showTagIdeas();

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
      h('button', { class: 'btn small', onclick: () => { noteOpened(p.id); api('POST', `/api/projects/${p.id}/open`, { app: 'finder' }); } }, 'Open in Finder'),
      h('button', { class: 'btn small', onclick: () => { noteOpened(p.id); api('POST', `/api/projects/${p.id}/open`, { app: 'vscode' }); } }, 'Open in VS Code')),
    field('Name', name),
    field('Folder', folder),
    h('div', { class: 'row' }, field('Status', status), field('Deadline', deadline)),
    serverHas(9) && field('Tags (commas between them): group similar projects, then filter by tag in the side list', tags),
    serverHas(9) && tagIdeas,
    field('Notes', notes),
    h('p', { class: 'hint' }, 'Unlinking removes the project and its tasks from this dashboard only. The folder itself is never touched.'),
  ], [
    unlink,
    h('span', { class: 'spacer' }),
    cancelBtn(),
    h('button', { class: 'btn primary', onclick: async () => {
      const body = { name: name.value, status: status.value, deadline: deadline.value, notes: notes.value };
      if (folder.value.trim() !== p.path) body.path = folder.value;
      if (serverHas(9)) body.tags = typedTags();
      await api('PATCH', `/api/projects/${p.id}`, body);
      closeDialog();
      refresh(true);
    } }, 'Save'),
  ]);
}

function settingsDialog() {
  const limit = agentLimit();
  const max = limit.pick;
  const model = select(modelOptions(true), S.settings.defaultModel || '', () => {});
  const autoMax = select(TIERS.map((x) => [x[0], modelLabel(x[2])]), S.settings.autoMax || 'max', () => {});
  const bin = h('input', { type: 'text', value: S.settings.claudePath || '', placeholder: S.meta.claude || 'Not found: paste the full path', spellcheck: false });
  const theme = select([['', 'Same as this Mac'], ['light', 'Light'], ['dark', 'Dark']], themeChoice(), (v) => setTheme(v));
  const notifyBox = h('input', { type: 'checkbox', checked: S.settings.notify !== false });
  const ntfy = h('input', { type: 'text', value: S.settings.ntfyTopic || '', placeholder: 'Empty: no phone notifications', spellcheck: false });
  showDialog('Settings', [
    field('Theme', theme),
    serverHas(7) && h('label', { class: 'cp-link' }, notifyBox, 'Show a Mac notification when a task finishes, needs your OK, or the limit runs out'),
    serverHas(7) && field('Phone notifications: your topic name on ntfy.sh', ntfy),
    serverHas(7) && h('p', { class: 'hint' }, 'For the phone, install the free ntfy app, subscribe to a topic name only you know, and type it here. The task id, project name and title are then sent to ntfy.sh, an outside service.'),
    field('Agents running at the same time', max),
    limit.note,
    h('p', { class: 'hint' }, 'Extra tasks wait in the queue. Two agents never edit the same project at once, so there is no gain in going above your number of projects.'),
    h('div', { class: 'row' }, field('Model for tasks set to "Default"', model), v2() && field('Strongest model Auto may pick', autoMax)),
    v2() && h('p', { class: 'hint' }, 'Auto first asks the cheapest model what kind of task it is (a few seconds, far less than a cent), then uses: Eco (Haiku) for chores like running commands and collecting information, Efficient (Sonnet) for small, clear changes, Optimized (Opus) for features, bugs and plans, and Max (Fable) for design decisions, release work and the hardest problems. You can also pick a level yourself on any task.'),
    field('Path to the claude program (leave empty to find it automatically)', bin),
    h('p', { class: 'hint' }, S.meta.claude ? `Using now: ${S.meta.claude}` : 'The claude program was not found.'),
  ], [
    cancelBtn(),
    h('button', { class: 'btn primary', onclick: async () => {
      await api('PATCH', '/api/settings', { maxAgents: Number(max.value), defaultModel: model.value, claudePath: bin.value, ...(v2() ? { autoMax: autoMax.value } : {}), ...(serverHas(7) ? { notify: notifyBox.checked, ntfyTopic: ntfy.value } : {}) });
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
  const fallback = S.settings.taskBudget > 0 ? `Default: ${money(S.settings.taskBudget)}`
    : usageMode() === 'saver' && S.usage ? `Saver: ${money(S.usage.saverBudget)}` : 'No limit';
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

// Asks before anything leaves this Mac: the dashboard commits the copy's
// changes as you, pushes the branch and opens the pull request.
function pullRequestDialog(t) {
  const title = h('input', { type: 'text', value: t.title });
  const body = h('textarea', { rows: 8, value: [t.description, t.report ? `What was done:\n${t.report.slice(0, 3000)}` : ''].filter(Boolean).join('\n\n') });
  const go = h('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true;
    go.textContent = 'Working…';
    try {
      const r = await api('POST', `/api/tasks/${t.id}/copy`, { do: 'pr', title: title.value, body: body.value });
      closeDialog();
      toast(`Pull request opened: ${r.work.pr}`);
    } catch { go.disabled = false; go.textContent = 'Commit, push and open'; }
    refreshSoon();
  } }, 'Commit, push and open');
  showDialog(`Pull request for ${t.id}`, [
    field('Title (also the commit message)', title),
    field('Description', body),
    h('p', { class: 'hint' }, `This commits the changes in the copy under your name, pushes the branch ${t.work.branch} to GitHub and opens a pull request. Nothing is merged. Read the Changes first.`),
  ], [cancelBtn(), go]);
  $('#dlg').style.width = 'min(640px, calc(100vw - 32px))';
}

async function setUsageMode(mode) {
  try { await api('PATCH', '/api/settings', { usageMode: mode }); } catch { /* the error is already shown */ }
  await refresh().catch(() => {});
  const m = USAGE_MODES.find((x) => x[0] === chosenMode());
  toast(steppedDown() ? `Usage mode: ${m[1]}. ${steppedNote()}` : `Usage mode: ${m[1]}. It applies to agents that start from now on.`);
}

// Reads your Claude limits afresh (one tiny Haiku call) and reloads the
// numbers. Gives true when it worked.
let usageBusy = false;
async function refreshUsage(button) {
  if (usageBusy) return false;
  usageBusy = true;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = button.dataset.busy || 'Refreshing…';
  let ok = false;
  try {
    await api('POST', '/api/limits/check');
    await refresh();
    ok = true;
    const w = (S.usage.limits && S.usage.limits.windows) || {};
    const pct = (key) => (w[key] && w[key].resetsAt > Date.now() ? `${Math.round(w[key].utilization * 100)}%` : null);
    const bits = [pct('five_hour') && `5-hour limit ${pct('five_hour')}`, pct('seven_day') && `weekly ${pct('seven_day')}`].filter(Boolean);
    toast(`Usage refreshed${bits.length ? `: ${bits.join(', ')}` : ''}.${S.usage.hold ? ' The queue is still paused.' : ''}`);
  } catch { /* the error is already shown */ }
  usageBusy = false;
  button.disabled = false;
  button.textContent = label;
  return ok;
}

// draft: what was typed in the budget boxes, kept when the dialog redraws.
function usageDialog(draft = {}) {
  const u = S.usage;
  const s = S.settings;
  const typed = (key, saved) => (key in draft ? draft[key] : saved > 0 ? String(saved) : '');
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
  const daily = h('input', { type: 'number', min: 0, step: 1, value: typed('daily', s.dailyBudget), placeholder: 'No limit' });
  const perRun = h('input', { type: 'number', min: 0, step: 0.5, value: typed('perRun', s.taskBudget), placeholder: usageMode() === 'saver' ? `Saver: ${money(u.saverBudget)}` : 'No limit' });
  const hold = h('input', { type: 'number', min: 0, max: 100, step: 5, value: typed('hold', s.holdPercent), placeholder: 'Never' });
  const saverAt = h('input', { type: 'number', min: 0, max: 100, step: 5, value: typed('saverAt', u.autoSaver), placeholder: 'Never' });
  const redraw = () => usageDialog({ daily: daily.value, perRun: perRun.value, hold: hold.value, saverAt: saverAt.value });
  // For when you know the limits changed (a reset, or heavy use in VS Code).
  const refreshBtn = serverHas(3) && h('button', { class: 'btn small', title: 'Read your Claude limits again now', onclick: async () => {
    if (await refreshUsage(refreshBtn) && $('#dlg').open && $('#dlg').contains(refreshBtn)) redraw();
  } }, 'Refresh');

  const modeBox = serverHas(5) && h('div', null,
    h('div', { class: 'sect-title' }, 'Usage mode'),
    h('div', { class: 'modes' }, USAGE_MODES.map(([key, label, about]) => h('label', { class: `mode-row${chosenMode() === key ? ' on' : ''}` },
      h('input', { type: 'radio', name: 'usage-mode', checked: chosenMode() === key, onchange: async () => { await setUsageMode(key); redraw(); } }),
      h('strong', null, label),
      h('span', { class: 'hint' }, about)))),
    steppedDown() && h('p', { class: 'hint', style: 'margin-top:8px' }, h('strong', null, steppedNote())),
    h('p', { class: 'hint', style: 'margin-top:8px' }, 'In Saver and Balanced, agents also start by how much of your 5-hour limit they are likely to take, not just by how many are running: a new one starts only if it fits under the pause level below, next to those already running. In every mode, an agent that a limit cuts off waits for the reset and then continues by itself.'));
  const typical = serverHas(5) && u.typical && h('div', null,
    h('div', { class: 'sect-title' }, 'What one agent run usually takes'),
    h('div', { class: 'md' }, h('div', { class: 'table' }, h('table', { class: 'usage-table' },
      h('tr', null, ['Model', 'Usage of a run', 'About this much of the 5-hour limit', 'Based on'].map((c) => h('th', null, c))),
      u.typical.map((r) => h('tr', null,
        h('td', null, modelLabel(r.family)),
        h('td', null, money(r.cost)),
        h('td', null, r.points < 1 ? 'under 1%' : `${Math.round(r.points)}%`),
        h('td', null, r.runs ? `your last ${plural(r.runs, 'run')}` : 'a starting guess')))))),
    h('p', { class: 'hint', style: 'margin-top:8px' }, `The dashboard uses these to decide how many agents fit at once. They are learned from your own runs: the usage figure is one that three runs in four stay under, and one dollar of agent work is counted as about ${u.rate.toFixed(1)}% of your 5-hour limit.`));

  showDialog('Usage and budgets', [
    u.hold && h('div', { class: 'banner bad', style: 'border-radius:8px; border:0' }, u.hold),
    modeBox,
    h('div', { class: 'tiles' },
      tile('Today', money(u.totals.today), s.dailyBudget > 0 ? `of ${money(s.dailyBudget)} daily limit` : null),
      tile('This week', money(u.totals.week)),
      tile('This month', money(u.totals.month))),
    h('div', null,
      h('div', { class: 'sect-head' }, h('div', { class: 'sect-title' }, 'Your Claude plan limits'), refreshBtn),
      limits.length
        ? [h('div', { class: 'limits' }, limits), h('p', { class: 'hint', style: 'margin-top:8px' }, `As of ${ago(u.limits.at)}. This updates each time a dashboard agent runs, and every few minutes while tasks are paused by a limit. Your own Claude sessions use the same limits, so press Refresh when you want the number as it is right now.`)]
        : h('p', { class: 'hint' }, 'Not read yet. Press Refresh, or wait for the first agent run.')),
    typical,
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
      serverHas(8) && field('Switch to Saver by itself when the 5-hour limit is this full (%)', saverAt),
      h('p', { class: 'hint' }, 'Leave a box empty for no limit. When the daily limit or the plan-limit pause is hit, queued tasks wait and start again by themselves; running agents finish. A run that hits its own limit stops and lands in Needs review. Dollar amounts are what the runs would cost at API prices. On a Claude subscription you are not billed these amounts; there the plan limits are what matter.')),
  ], [
    cancelBtn(),
    h('button', { class: 'btn primary', onclick: async () => {
      await api('PATCH', '/api/settings', { dailyBudget: Number(daily.value) || 0, taskBudget: Number(perRun.value) || 0, holdPercent: Number(hold.value) || 0, ...(serverHas(8) ? { autoSaver: Number(saverAt.value) || 0 } : {}) });
      closeDialog();
      refresh();
    } }, 'Save'),
  ]);
}

// ---------------------------------------------------------------- plan a run

const share = (v) => (v > 0 && v < 1 ? 'under 1%' : `${Math.round(v)}%`);
function roughTime(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

// Shows what the open tasks of each project are likely to take of the
// 5-hour limit, how many projects fit in what is free, and queues the ticked
// ones to run one project after another.
// plan: { order: [project ids], on: Set of ticked ids }, kept across redraws.
function planDialog(plan) {
  const f = S.forecast;
  const rows = new Map(f.projects.filter((r) => S.projects.some((p) => p.id === r.id)).map((r) => [r.id, r]));
  const free = Math.max(0, f.free);
  // Smallest first: that way the most projects get finished.
  const smallestFirst = () => [...rows.values()].sort((a, b) => a.points - b.points).map((r) => r.id);
  const mostThatFit = () => {
    const order = smallestFirst();
    const on = new Set();
    let sum = 0;
    for (const id of order) {
      if (sum + rows.get(id).points > free) break;
      sum += rows.get(id).points;
      on.add(id);
    }
    if (!on.size && order.length) on.add(order[0]);
    return { order, on };
  };
  if (!plan) plan = mostThatFit();
  plan.order = [...plan.order.filter((id) => rows.has(id)), ...smallestFirst().filter((id) => !plan.order.includes(id))];
  const redraw = () => planDialog(plan);
  const name = (id) => S.projects.find((p) => p.id === id).name;

  const picked = plan.order.filter((id) => plan.on.has(id));
  const sum = (key) => picked.reduce((n, id) => n + rows.get(id)[key], 0);
  const need = sum('points');
  let run = 0;
  let fitCount = 0;
  const fits = new Map(); // ticked project -> does it still fit, counting those before it
  for (const id of picked) {
    run += rows.get(id).points;
    fits.set(id, run <= free);
    if (run <= free) fitCount += 1;
  }

  const move = (id, by) => {
    const i = plan.order.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= plan.order.length) return;
    [plan.order[i], plan.order[j]] = [plan.order[j], plan.order[i]];
    redraw();
  };
  const table = h('div', { class: 'md' }, h('div', { class: 'table' }, h('table', { class: 'usage-table plan-table' },
    h('tr', null, ['Project', 'Open tasks', 'Of the 5-hour limit', 'Usage', 'Agent time', '', 'Order'].map((c) => h('th', null, c))),
    plan.order.map((id, i) => {
      const r = rows.get(id);
      const on = plan.on.has(id);
      const models = TIERS.filter((x) => r.models[x[2]]).map((x) => `${r.models[x[2]]} ${MODEL_NAME[x[2]]}`).join(', ');
      return h('tr', { class: on ? '' : 'off' },
        h('td', null, h('label', { class: 'cp-link' },
          h('input', { type: 'checkbox', checked: on, onchange: (e) => { if (e.target.checked) plan.on.add(id); else plan.on.delete(id); redraw(); } }), name(id))),
        h('td', null, String(r.tasks), h('div', { class: 'hint' }, models)),
        h('td', null, `about ${share(r.points)}`),
        h('td', null, money(r.cost)),
        h('td', null, roughTime(r.ms)),
        h('td', null, on && h('span', { class: `chip ${fits.get(id) ? 'fits' : 'high'}` }, fits.get(id) ? 'Fits' : 'Does not fit')),
        h('td', { class: 'plan-move' },
          h('button', { class: 'btn small ghost', disabled: i === 0, title: 'Run earlier', 'aria-label': `Run ${name(id)} earlier`, onclick: () => move(id, -1) }, '↑'),
          h('button', { class: 'btn small ghost', disabled: i === plan.order.length - 1, title: 'Run later', 'aria-label': `Run ${name(id)} later`, onclick: () => move(id, 1) }, '↓')));
    }))));

  // The limit as one bar: used, kept for running agents, this plan, and the pause level.
  const fitPart = Math.min(need, free);
  const overPart = Math.max(0, Math.min(need - fitPart, 100 - f.used - f.reserved - fitPart));
  const seg = (cls, v) => v > 0.2 && h('span', { class: cls, style: `width:${Math.min(100, v)}%` });
  const key = (cls, label) => h('span', null, h('i', { class: cls, style: `background:${{ used: 'var(--muted)', held: 'color-mix(in srgb, var(--muted) 50%, transparent)', fits: 'var(--ok)', over: 'var(--bad)' }[cls]}` }), label);
  const bar = h('div', null,
    h('div', { class: 'plan-bar', role: 'img', 'aria-label': `5-hour limit: ${Math.round(f.used)}% used, this plan needs about ${share(need)}, ${share(free)} is free` },
      seg('used', f.used), seg('held', f.reserved), seg('fits', fitPart), seg('over', overPart),
      f.ceiling < 100 && h('span', { class: 'stop', style: `left:${f.ceiling}%; height:100%` })),
    h('div', { class: 'plan-key' },
      key('used', `Used ${Math.round(f.used)}%`),
      f.reserved > 0.5 && key('held', `Agents running now, about ${share(f.reserved)}`),
      key('fits', `This plan, about ${share(need)}`),
      need > free && key('over', 'More than is free'),
      f.ceiling < 100 && h('span', null, `Line: new agents pause at ${f.ceiling}%`)));

  const refreshBtn = h('button', { class: 'btn small', title: 'Read your Claude limits again now', onclick: async () => {
    if (await refreshUsage(refreshBtn) && $('#dlg').open && $('#dlg').contains(refreshBtn)) redraw();
  } }, 'Refresh');
  const resets = f.resetsAt && new Date(f.resetsAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const now = f.resetsAt
    ? `${share(free)} of your 5-hour limit is free for agents (${Math.round(f.used)}% used, resets ${resets}). Read ${ago(f.readAt)}.`
    : f.readAt ? 'Your 5-hour limit has reset since it was last read, so it is counted as empty.'
      : 'Your Claude limit has not been read yet, so it is counted as empty. Press Refresh for the real number.';

  const tasks = sum('tasks');
  let verdict = 'Tick the projects you want to run.';
  if (picked.length) {
    verdict = `${plural(picked.length, 'project')}, ${plural(tasks, 'task')}: about ${share(need)} of your 5-hour limit, ${money(sum('cost'))} of usage, about ${roughTime(sum('ms'))} of agent time. `;
    if (need <= free) verdict += 'All of it should fit.';
    else if (fitCount) verdict += `Only the first ${fitCount === 1 ? 'project fits' : `${fitCount} projects fit`}. The rest starts while there is room, waits for the reset, and then continues by itself.`;
    else verdict += `That is more than is free. It starts anyway, waits for the reset${resets ? ` (${resets})` : ''} when the limit is full, and then continues by itself.`;
  }
  const guessed = [...rows.values()].reduce((n, r) => n + r.guessed, 0);
  const week = limitState(S.usage && S.usage.limits && S.usage.limits.windows.seven_day);
  const order = select([['project', 'One project after another'], ['mixed', 'Mixed: by priority and time only']], S.settings.queueOrder || 'project', async (v) => {
    await api('PATCH', '/api/settings', { queueOrder: v });
    await refresh();
    redraw();
  });
  const todo = picked.reduce((n, id) => n + rows.get(id).todo, 0);

  showDialog('Plan a run', [
    h('div', { class: 'sect-head' }, h('p', { class: 'hint', style: 'margin:0' }, now), refreshBtn),
    bar,
    table,
    h('div', { class: 'plan-sum' }, verdict),
    h('div', { class: 'plan-btns' },
      h('button', { class: 'btn small', onclick: () => planDialog(mostThatFit()) }, 'Pick the most that fit'),
      h('button', { class: 'btn small', onclick: () => { plan.on = new Set(plan.order); redraw(); } }, 'Tick all'),
      h('button', { class: 'btn small', onclick: () => { plan.on = new Set(); redraw(); } }, 'Untick all')),
    field('How waiting tasks start', order),
    h('p', { class: 'hint' }, 'With "One project after another", agents finish all waiting tasks of one project before they begin the next, so a limit that runs out does not leave every project half done. A second project starts next to the first only when both fit in what is free. Without an order from you, the smallest project goes first.'),
    h('p', { class: 'hint' }, `These are rough estimates from your own past runs on each model (see Usage and budgets). They count the 5-hour limit only, and your own Claude sessions use the same limit.${guessed ? ` Auto has not looked at ${plural(guessed, 'task')} yet, so the model is a guess from the wording.` : ''}${week && !week.reset && week.pct >= 70 ? ` Your weekly limit is ${week.pct}% used, which can stop agents earlier.` : ''}`),
  ], [
    cancelBtn(),
    h('button', { class: 'btn primary', disabled: !picked.length, onclick: async () => {
      const r = await api('POST', '/api/run-projects', { projectIds: picked });
      closeDialog();
      toast(r.queued ? `${plural(r.queued, 'task')} queued, one project after another.` : 'Order saved for the waiting tasks.');
      refresh().catch(() => {});
    } }, todo ? `Run ${plural(todo, 'task')} in this order` : 'Use this order'),
  ]);
  $('#dlg').style.width = 'min(820px, calc(100vw - 32px))';
}

// ---------------------------------------------------------------- wiring

$('#btn-new').addEventListener('click', newTaskDialog);
$('#btn-link').addEventListener('click', () => linkDialog());
$('#btn-settings').addEventListener('click', settingsDialog);
$('#btn-suggest').addEventListener('click', suggestDialog);
$('#btn-plan').addEventListener('click', () => planDialog());
$('#btn-theme').addEventListener('click', () => setTheme(themeNow() === 'dark' ? 'light' : 'dark'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintTheme);
paintTheme();
$('#usage-mode').addEventListener('change', (e) => setUsageMode(e.target.value));
$('#dlg').addEventListener('close', () => { ui.onState = null; });
$('#usage').addEventListener('click', () => usageDialog());
$('#usage-refresh').addEventListener('click', (e) => refreshUsage(e.currentTarget));
$('#btn-refresh').addEventListener('click', () => refresh(true).then(() => toast('Project info refreshed.')).catch(() => {}));
$('#proj-sort').replaceChildren(...PROJECT_SORTS.map(([v, label]) => h('option', { value: v }, label)));
$('#proj-sort').value = projSort();
$('#proj-sort').addEventListener('change', (e) => setProjSort(e.target.value));
{
  const nav = $('#projects');
  const hold = (on) => { if (ui.holdOrder === on) return; ui.holdOrder = on; if (!on) renderProjects(); };
  nav.addEventListener('mouseenter', () => hold(true));
  nav.addEventListener('mouseleave', () => { if (!nav.contains(document.activeElement)) hold(false); });
  nav.addEventListener('focusin', () => hold(true));
  nav.addEventListener('focusout', (e) => { if (!nav.contains(e.relatedTarget) && !nav.matches(':hover')) hold(false); });
}
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
