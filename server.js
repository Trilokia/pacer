#!/usr/bin/env node
'use strict';
/*
 * Pacer: a local task board that can start Claude agents in your
 * project folders and show their progress. No dependencies.
 *
 *   node server.js        then open http://localhost:4577
 *
 * It listens on 127.0.0.1 only. Data lives in ./data/db.json.
 * Runs on macOS, Windows and Linux; a few extras (notifications, the folder
 * picker, open in VS Code) use each system's own tools.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const PORT = Number(process.env.DASH_PORT) || 4577;
const HOST = '127.0.0.1';
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DASH_DATA || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const CHANGES_DIR = path.join(DATA_DIR, 'changes');
const GUARD = path.join(__dirname, 'guard', 'pre-tool.js');
const GIT_HOOKS = path.join(__dirname, 'guard', 'githooks');
const LOG_CAP = 400;
const INFO_TTL_MS = 15000;

const MODES = ['plan', 'edit'];
const PRIORITIES = ['low', 'normal', 'high'];
const PROJECT_STATUSES = ['active', 'paused', 'shipped'];
const MODELS = ['', 'auto', 'haiku', 'sonnet', 'opus', 'fable'];
// The levels the automatic model choice picks from, cheapest first.
const TIERS = [
  { key: 'eco', label: 'Eco', model: 'haiku' },
  { key: 'efficient', label: 'Efficient', model: 'sonnet' },
  { key: 'optimized', label: 'Optimized', model: 'opus' },
  { key: 'max', label: 'Max', model: 'fable' },
];
const TIER_KEYS = TIERS.map((x) => x.key);
// The page checks this number, so a page that is newer than the running
// server can hide what the server cannot do yet.
const API_VERSION = 10;
const REPEATS = { daily: 864e5, weekly: 7 * 864e5 };
// Files a separate copy of a project needs but git does not track. They are
// copied only when git ignores them, so they can never end up in a commit.
const COPY_EXTRA = ['local.properties', '.env', '.env.local'];
// How careful agents are with the Claude plan limit: see "usage modes" below.
const USAGE_MODES = ['saver', 'balanced', 'full'];
// Most agents at once in a mode (never above the number in Settings). Full power goes by Settings alone.
const MODE_AGENTS = { saver: 1, balanced: 2 };
const SAVER_RUN_BUDGET = 3; // dollars for one run in Saver, when you set no limit yourself
// The order waiting tasks start in: 'project' finishes one project's tasks
// before the next project begins, 'mixed' goes by priority and time alone.
const QUEUE_ORDERS = ['project', 'mixed'];
const MAX_LIMIT_RETRIES = 3; // times in a row a task may be cut off by a limit and continue by itself

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- store

let db = {
  version: 1,
  seq: 1,
  pseq: 1,
  // taskBudget and dailyBudget are in US dollars, 0 = no limit. holdPercent
  // pauses the queue when a Claude plan limit is that full, 0 = never.
  // autoMax is the strongest level the automatic model choice may pick.
  settings: { maxAgents: 2, defaultModel: '', claudePath: '', taskBudget: 0, dailyBudget: 0, holdPercent: 90, autoMax: 'max', usageMode: 'full', autoSaver: 70, notify: true, ntfyTopic: '', queueOrder: 'project' },
  projects: [],
  tasks: [],
  spend: [],     // one entry per agent run: { at, taskId, projectId, cost, model }
  limits: null,  // last Claude plan limits an agent reported
  windows: {},   // per 5-hour window: how far agents pushed the limit, and what they spent
  defaultFamily: '', // the model Claude Code picks when a task names none
  runOrder: [],  // project ids in the order you last chose in "Plan a run"
};

function load() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(CHANGES_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      console.error(`Could not read ${DB_FILE}: ${e.message}\nFix or remove that file, then start again.`);
      process.exit(1);
    }
    db = { ...db, ...saved, settings: { ...db.settings, ...(saved.settings || {}) } };
  }
  // Agents do not survive a restart of the dashboard.
  for (const t of db.tasks) {
    if (t.status === 'running' && t.assignee && t.assignee.kind === 'agent') {
      t.status = 'review';
      t.outcome = 'failed';
      t.finishedAt = Date.now();
      addLog(t, 'error', 'The dashboard was restarted while this agent was running.');
    } else if (t.status === 'queued' && !t.limitCut) {
      t.status = 'todo';
      t.assignee = null;
      t.waitReason = null;
      delete t.pendingFollowUp;
    }
  }
  flush();
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 150);
}
function flush() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

const clients = new Set();
let notifyTimer = null;
function changed() {
  save();
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const res of clients) res.write('data: change\n\n');
  }, 200);
}

const findTask = (id) => db.tasks.find((t) => t.id === id);
const findProject = (id) => db.projects.find((p) => p.id === id);

function addLog(t, kind, text) {
  t.log = t.log || [];
  t.log.push({ t: Date.now(), kind, text: String(text).slice(0, 4000) });
  t.logTotal = (t.logTotal || 0) + 1;
  if (t.log.length > LOG_CAP) t.log.splice(0, t.log.length - LOG_CAP);
  t.updatedAt = Date.now();
}

function briefTask(t) {
  const { log, pendingFollowUp, baseTree, ...rest } = t;
  return { ...rest, last: log && log.length ? log[log.length - 1] : null };
}

// ---------------------------------------------------------------- projects

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 4e6, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || ''), code: err ? err.code : 0 });
    });
  });
}

function detectType(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('settings.gradle.kts') || has('settings.gradle') || has('build.gradle.kts') || has('build.gradle')) {
    return has('app/src/main/AndroidManifest.xml') || has('app/build.gradle.kts') || has('app/build.gradle')
      ? 'Android' : 'Gradle';
  }
  if (has('pubspec.yaml')) return 'Flutter';
  if (has('package.json')) return 'Node';
  if (has('Cargo.toml')) return 'Rust';
  if (has('pyproject.toml') || has('requirements.txt')) return 'Python';
  if (has('composer.json') || has('index.php')) return 'PHP';
  if (has('index.html')) return 'Web';
  return 'Folder';
}

const infoCache = new Map(); // project id -> { at, info }

async function computeInfo(dir) {
  const info = { exists: false, type: 'Folder', git: null, hasClaudeMd: false, notes: 0 };
  try { info.exists = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
  if (!info.exists) return info;
  info.type = detectType(dir);
  info.hasClaudeMd = fs.existsSync(path.join(dir, 'CLAUDE.md'));
  info.notes = findNotes(dir).files.length;
  if (!fs.existsSync(path.join(dir, '.git'))) return info;
  const st = await sh('git', ['-C', dir, 'status', '--porcelain=v1', '-b']);
  if (!st.ok) return info;
  const lines = st.out.split('\n').filter(Boolean);
  const head = (lines.shift() || '').replace(/^## /, '');
  let branch = head.split('...')[0].split(' ')[0];
  const fresh = head.match(/^No commits yet on (.+)$/);
  if (fresh) branch = fresh[1];
  if (head.startsWith('HEAD (no branch)')) branch = 'detached';
  const ahead = head.match(/ahead (\d+)/);
  info.git = { branch, changed: lines.length, ahead: ahead ? Number(ahead[1]) : 0, last: null };
  const lg = await sh('git', ['-C', dir, 'log', '-1', '--format=%ct%x1f%s']);
  if (lg.ok && lg.out.trim()) {
    const [ct, subject] = lg.out.trim().split('\x1f');
    info.git.last = { at: Number(ct) * 1000, subject: subject || '' };
  }
  return info;
}

async function projectInfo(p, fresh) {
  const hit = infoCache.get(p.id);
  if (!fresh && hit && Date.now() - hit.at < INFO_TTL_MS) return hit.info;
  const info = await computeInfo(p.path);
  infoCache.set(p.id, { at: Date.now(), info });
  return info;
}

function normalizeDir(input) {
  let s = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!s) throw new HttpError(400, 'Type or choose a folder path first.');
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  let real;
  try { real = fs.realpathSync(path.resolve(s)); } catch { throw new HttpError(400, `Folder not found: ${s}`); }
  if (!fs.statSync(real).isDirectory()) throw new HttpError(400, `Not a folder: ${s}`);
  return real;
}

// ---------------------------------------------------------------- usage and budgets

function periodStarts() {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(day);
  week.setDate(day.getDate() - ((day.getDay() + 6) % 7)); // Monday
  return { day: day.getTime(), week: week.getTime(), month: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };
}

function usage() {
  const start = periodStarts();
  const totals = { today: 0, week: 0, month: 0, all: 0 };
  const byProject = {};
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(start.day);
    d.setDate(d.getDate() - i);
    days.push({ at: d.getTime(), cost: 0, runs: 0 });
  }
  for (const e of db.spend) {
    const row = byProject[e.projectId] || (byProject[e.projectId] = { today: 0, week: 0, month: 0, all: 0, runs: 0 });
    for (const bucket of [totals, row]) {
      bucket.all += e.cost;
      if (e.at >= start.month) bucket.month += e.cost;
      if (e.at >= start.week) bucket.week += e.cost;
      if (e.at >= start.day) bucket.today += e.cost;
    }
    const run = e.check ? 0 : 1; // the quick model check is spend, but not an agent run
    row.runs += run;
    for (let i = days.length - 1; i >= 0; i--) {
      if (e.at >= days[i].at) { days[i].cost += e.cost; days[i].runs += run; break; }
    }
  }
  const rate = pointsPerDollar();
  const typical = FAMILIES.map((fam) => {
    const run = typicalRun(fam, 'edit');
    return { family: fam, cost: run.cost, points: run.cost * rate, runs: run.runs || 0 };
  });
  return { totals, byProject, days, limits: db.limits, hold: holdReason(), mode: usageMode(), chosen: chosenMode(), stepped: steppedDown(), autoSaver: autoSaverAt(), agentCap: agentCap(), saverBudget: SAVER_RUN_BUDGET, rate, typical };
}

function recordSpend(t, result) {
  const cost = Number(result.total_cost_usd) || 0;
  t.cost = (t.cost || 0) + cost;
  db.spend.push({ at: Date.now(), taskId: t.id, projectId: t.projectId, cost, model: (t.assignee && t.assignee.name) || '',
    mode: editing(t) ? 'edit' : 'plan', ms: Date.now() - (t.startedAt || Date.now()) });
  const w = db.limits && db.limits.windows.five_hour;
  const win = w && db.windows[String(w.resetsAt)];
  if (win) win.cost += cost;
}

// fromAgent: the reading came from a running dashboard agent.
function recordLimits(ev, fromAgent) {
  const windows = ev.rate_limit_info && ev.rate_limit_info.unifiedWindows;
  if (!windows) return;
  const out = {};
  for (const key of ['five_hour', 'seven_day']) {
    const w = windows[key];
    if (w && typeof w.utilization === 'number') out[key] = { utilization: w.utilization, resetsAt: Number(w.resetsAt) * 1000 };
  }
  if (!Object.keys(out).length) return;
  const now = Date.now();
  db.limits = { at: now, windows: out };
  // Learn what agent work costs in limit terms. Only the rise between two
  // readings that agents sent close together is counted: that rise is their
  // own work (plus whatever you did in other Claude sessions meanwhile).
  const w = out.five_hour;
  if (!w) return;
  const key = String(w.resetsAt);
  const win = db.windows[key] || (db.windows[key] = { gain: 0, cost: 0, lastU: w.utilization, agentAt: 0 });
  if (fromAgent) {
    if (now - win.agentAt < 10 * 60000 && w.utilization > win.lastU) {
      win.gain += w.utilization - win.lastU;
      // Your own Claude sessions push the same limit. A window where they
      // were busy too says less about what agent work costs.
      if (ownSessionsActiveSince(win.agentAt)) win.mixed = true;
    }
    win.agentAt = now;
  }
  win.lastU = w.utilization;
  win.lastAt = now;
  const keys = Object.keys(db.windows);
  if (keys.length > 8) for (const k of keys.sort((a, b) => Number(a) - Number(b)).slice(0, keys.length - 8)) delete db.windows[k];
}

// Why new agents should wait right now, or null when they may start.
function holdReason() {
  const s = db.settings;
  if (s.dailyBudget > 0) {
    const start = periodStarts().day;
    const spent = db.spend.reduce((sum, e) => sum + (e.at >= start ? e.cost : 0), 0);
    if (spent >= s.dailyBudget) return `Paused: today's spend limit is reached ($${spent.toFixed(2)} of $${s.dailyBudget.toFixed(2)})`;
  }
  return planLimitHold();
}

// The pause for a full Claude plan limit, going by the last reading.
function planLimitHold() {
  const s = db.settings;
  if (s.holdPercent > 0 && db.limits) {
    for (const [key, label] of [['five_hour', '5-hour'], ['seven_day', 'weekly']]) {
      const w = db.limits.windows[key];
      if (!w || w.resetsAt <= Date.now() || w.utilization * 100 < s.holdPercent) continue;
      const when = new Date(w.resetsAt).toLocaleString('en-IN', key === 'five_hour'
        ? { hour: '2-digit', minute: '2-digit', hour12: false }
        : { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
      return `Paused: your Claude ${label} limit is ${Math.round(w.utilization * 100)}% used (resets ${when})`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- what a task changed

// Records the project's files as a git tree, without touching the real git
// index, the working files or the history. Returns the tree id, or null when
// the folder is not a git repository.
async function snapshotTree(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const where = await sh('git', ['-C', dir, 'rev-parse', '--git-path', 'index']);
  if (!where.ok) return null;
  const realIndex = path.resolve(dir, where.out.trim());
  const tmp = path.join(os.tmpdir(), `dash-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmp);
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    const add = await sh('git', ['-C', dir, 'add', '-A'], { env, timeout: 90000 });
    if (!add.ok) return null;
    const tree = await sh('git', ['-C', dir, 'write-tree'], { env });
    return tree.ok ? tree.out.trim() : null;
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

const changesFile = (id) => path.join(CHANGES_DIR, `${id}.patch`);

function parsePatch(patch) {
  const files = [];
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const lines = chunk.split('\n');
    const plus = lines.find((l) => l.startsWith('+++ '));
    const minus = lines.find((l) => l.startsWith('--- '));
    const renameTo = lines.find((l) => l.startsWith('rename to '));
    const head = lines[0].match(/^diff --git a\/(.*) b\/(.*)$/);
    let name = head ? head[2] : '(unknown file)';
    if (renameTo) name = renameTo.slice(10);
    else if (plus && plus !== '+++ /dev/null') name = plus.slice(4).replace(/^b\//, '');
    else if (minus && minus !== '--- /dev/null') name = minus.slice(4).replace(/^a\//, '');
    let added = 0;
    let removed = 0;
    let inHunk = false;
    for (const l of lines) {
      if (l.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (l[0] === '+') added++;
      else if (l[0] === '-') removed++;
    }
    const kind = lines.some((l) => l.startsWith('new file mode')) ? 'new'
      : lines.some((l) => l.startsWith('deleted file mode')) ? 'deleted'
        : renameTo ? 'renamed' : 'changed';
    files.push({ path: name, kind, added, removed, binary: /^Binary files |^GIT binary patch/m.test(chunk), patch: chunk });
  }
  return files;
}

// Compares the project now with how it was when the task started, and keeps
// the result as a patch file so it stays readable later.
async function saveChanges(t, dir) {
  if (!t.baseTree) return;
  const end = await snapshotTree(dir);
  if (!end) return;
  const diff = await sh('git', ['-C', dir, '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', t.baseTree, end],
    { timeout: 60000, maxBuffer: 64e6 });
  if (!diff.ok) return;
  const files = parsePatch(diff.out);
  fs.writeFileSync(changesFile(t.id), diff.out.slice(0, 4e6));
  t.changes = {
    at: Date.now(),
    files: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };
}

// ---------------------------------------------------------------- saved Claude conversations

// Claude Code keeps every conversation as a file under
// ~/.claude/projects/<folder path with every odd character turned into "-">/.
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sessionDir = (dir) => path.join(CLAUDE_PROJECTS, dir.replace(/[^a-zA-Z0-9]/g, '-'));
const sessionCache = new Map(); // file -> { key, data }

function cleanPrompt(raw) {
  let s = String(raw || '');
  const cmd = s.match(/<command-name>([^<]*)<\/command-name>/);
  const cmdArgs = s.match(/<command-args>([^<]*)<\/command-args>/);
  s = s.replace(/<(system-reminder|ide_selection|ide_opened_file|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|task-notification)>[\s\S]*?<\/\1>/g, '').trim();
  if (cmd && !s) s = `${cmd[1]} ${cmdArgs ? cmdArgs[1] : ''}`.trim();
  return s;
}

function parseSession(file) {
  const stat = fs.statSync(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = sessionCache.get(file);
  if (hit && hit.key === key) return hit.data;
  const data = { id: path.basename(file, '.jsonl'), title: '', first: '', lastPrompt: '', lastReply: '', prompts: 0, cost: 0, startedAt: 0, updatedAt: stat.mtimeMs, cwd: '', items: [], tooBig: stat.size > 150e6 };
  if (!data.tooBig) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line || line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'ai-title' && e.aiTitle) data.title = e.aiTitle;
      else if (e.type === 'custom-title' && e.customTitle) data.title = e.customTitle;
      else if (e.type === 'cost-state') data.cost = Number(e.totalCostUSD) || data.cost;
      if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta || !e.message) continue;
      const t = Date.parse(e.timestamp) || 0;
      if (t && !data.startedAt) data.startedAt = t;
      if (e.cwd && !data.cwd) data.cwd = e.cwd;
      const content = e.message.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b.type === 'text' && e.type === 'user') {
          const s = cleanPrompt(b.text);
          if (!s) continue;
          if (e.isCompactSummary) { data.items.push({ role: 'note', t, text: 'Claude summarised the earlier part of this conversation here.' }); continue; }
          data.prompts += 1;
          if (!data.first) data.first = s.split('\n')[0].slice(0, 120);
          data.lastPrompt = s.slice(0, 500);
          data.items.push({ role: 'user', t, text: s.slice(0, 8000) });
        } else if (b.type === 'text' && b.text && b.text.trim()) {
          data.lastReply = b.text.trim().slice(0, 900);
          data.items.push({ role: 'assistant', t, text: b.text.trim().slice(0, 8000) });
        } else if (b.type === 'tool_use') {
          data.items.push({ role: 'tool', t, text: toolLine(b.name, b.input, e.cwd || data.cwd || '/') });
        }
      }
    }
  }
  sessionCache.set(file, { key, data });
  return data;
}

function findSessionFile(id, preferDir) {
  if (!SESSION_ID.test(id)) return null;
  const dirs = [];
  if (preferDir) dirs.push(sessionDir(preferDir));
  try { for (const d of fs.readdirSync(CLAUDE_PROJECTS)) dirs.push(path.join(CLAUDE_PROJECTS, d)); } catch { /* none saved */ }
  for (const d of dirs) {
    const f = path.join(d, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function sessionSummary(file) {
  const { items, ...s } = parseSession(file);
  const tasks = db.tasks.filter((t) => t.sessionId === s.id || (t.conversations || []).includes(s.id));
  return {
    ...s,
    title: s.title || s.first || 'Untitled conversation',
    steps: items.length,
    agentTask: (tasks.find((t) => t.sessionId === s.id) || {}).id || null,
    tasks: tasks.map((t) => t.id),
  };
}

// The dashboard agent's own conversation plus any the user or a session linked.
function taskConversations(t) {
  const p = findProject(t.projectId);
  const ids = [...new Set([t.sessionId, ...(t.conversations || [])].filter(Boolean))];
  return ids.map((id) => {
    const kind = id === t.sessionId ? 'agent' : 'linked';
    const file = findSessionFile(id, p && p.path);
    if (!file) return { id, kind, missing: true, title: 'Conversation no longer saved on this computer' };
    try { return { ...sessionSummary(file), kind }; } catch { return { id, kind, missing: true, title: 'Conversation could not be read' }; }
  });
}

function linkConversation(t, id) {
  if (!SESSION_ID.test(String(id || '')) || id === t.sessionId) return false;
  t.conversations = t.conversations || [];
  if (t.conversations.includes(id)) return false;
  t.conversations.push(id);
  return true;
}

// ---------------------------------------------------------------- hand a task over to VS Code

// The Claude extension keeps one small file here per open VS Code window,
// naming the folder that window has open.
const IDE_LOCKS = path.join(os.homedir(), '.claude', 'ide');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Windows paths compare without regard to case (C:\ and c:\ are one folder).
const samePath = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

// Opens a link (such as vscode://…) with whatever program handles it.
function openLink(url) {
  if (MAC) return sh('open', [url]);
  if (WIN) return sh('rundll32', ['url.dll,FileProtocolHandler', url]);
  return sh('xdg-open', [url]);
}

// Opens a folder in Finder, File Explorer or the Linux file manager.
async function openFolder(dir) {
  if (MAC) return sh('open', [dir]);
  // Explorer exits with code 1 even when it worked, so its result says nothing.
  if (WIN) { await sh('explorer.exe', [dir]); return { ok: true, out: '', err: '' }; }
  return sh('xdg-open', [dir]);
}

// Opens a folder, or a vscode:// link, in VS Code.
function openInVSCode(target) {
  if (MAC) return sh('open', ['-a', 'Visual Studio Code', target]);
  if (/^vscode:/.test(target)) return openLink(target);
  if (WIN) {
    const exe = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
    ].find((f) => fs.existsSync(f));
    if (!exe) return openLink(`vscode://file/${target.replace(/\\/g, '/')}`);
    try {
      spawn(exe, [target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return Promise.resolve({ ok: true, out: '', err: '' });
    } catch (e) { return Promise.resolve({ ok: false, out: '', err: e.message }); }
  }
  return sh('code', [target]);
}

function vscodeHasFolder(dir) {
  let names = [];
  try { names = fs.readdirSync(IDE_LOCKS); } catch { return false; }
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(IDE_LOCKS, name), 'utf8'));
      if (lock.ideName && !/visual studio code/i.test(lock.ideName)) continue;
      if (!(lock.workspaceFolders || []).some((f) => samePath(fs.realpathSync(f), dir))) continue;
      if (lock.pid) process.kill(lock.pid, 0); // throws when that VS Code is gone
      return true;
    } catch { /* a leftover or unreadable file */ }
  }
  return false;
}

// Opens the project in VS Code, then opens the Claude panel there through
// the extension's own link. The link lands in whichever VS Code window is in
// front, and only a window on this very folder can find the project's
// conversations. So: open the folder, wait until its window is up, bring it
// to the front once more, and only then send the link. Gives false when the
// window never showed up in time (the link is still sent, as a best effort).
async function openClaudeInVSCode(dir, query) {
  const first = await openInVSCode(dir);
  if (!first.ok) throw new HttpError(500, 'Could not open VS Code. Is it installed?');
  const until = Date.now() + 25000;
  let up = vscodeHasFolder(dir);
  while (!up && Date.now() < until) {
    await sleep(500);
    up = vscodeHasFolder(dir);
  }
  await openInVSCode(dir);
  await sleep(700);
  const link = `vscode://anthropic.claude-code/open?${new URLSearchParams(query)}`;
  const sent = await openInVSCode(link);
  if (!sent.ok) throw new HttpError(500, 'VS Code opened, but its Claude panel did not. Is the Claude Code extension installed?');
  return up;
}

// What a task started by hand in VS Code begins with. It is put in the
// message box there; you press Enter to send it.
// The task's own text stays out of the link: Claude reads it from the board
// by id. Link text passes through two rounds of decoding on its way into the
// extension, and characters like & or % in a task could get mangled there.
function handoverPrompt(t) {
  const dash = `node "${path.join(__dirname, 'dash.js')}"`;
  const title = t.title.replace(/[^\p{L}\p{N} .,:;!?'()/_-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return [
    `Pick up task ${t.id} from my project dashboard: ${title}`,
    '',
    `1. Read it: ${dash} show ${t.id}`,
    `2. Take it: ${dash} claim ${t.id}`,
    t.mode === 'plan'
      ? '3. Do what it says. It is a plan-only task: do not change any files. Give me your findings and a step-by-step plan.'
      : '3. Do what it says. You may edit files. Do not commit or push.',
    `4. Finish with: ${dash} done ${t.id} "a short report in plain English: what you did, how you checked it, what is left"`,
  ].join('\n');
}

// ---------------------------------------------------------------- notes and plan files

const NOTE_DIRS = ['docs', 'doc', 'plans', 'plan', 'notes'];
const NOTE_FILE = /\.(md|markdown)$|^todo(\.txt)?$/i;
const NOT_NOTES = /^(licen[sc]e|code_of_conduct|contributing|security)\b/i;

// The notes a "what is next" scan should read: markdown files at the top of
// the project and in its docs / plans folders. A project inside a workspace
// that has a shared CLAUDE.md also gets that workspace's plans and docs.
// `outside` lists the folders outside the project the agent needs to read.
function findNotes(dir) {
  const files = [];
  const outside = [];
  const take = (d) => {
    let names = [];
    try { names = fs.readdirSync(d).sort(); } catch { return 0; }
    let n = 0;
    for (const name of names) {
      if (n >= 12) break;
      if (!NOTE_FILE.test(name) || NOT_NOTES.test(name)) continue;
      const f = path.join(d, name);
      try { const st = fs.statSync(f); if (!st.isFile() || !st.size) continue; } catch { continue; }
      files.push(f);
      n++;
    }
    return n;
  };
  take(dir);
  for (const sub of NOTE_DIRS) take(path.join(dir, sub));
  const parent = path.dirname(dir);
  if (parent !== dir && parent !== os.homedir() && fs.existsSync(path.join(parent, 'CLAUDE.md'))) {
    for (const sub of NOTE_DIRS) {
      const d = path.join(parent, sub);
      if (take(d)) outside.push(d);
    }
  }
  return { files, outside };
}

// ---------------------------------------------------------------- automatic model choice

const TIER_GUIDE = [
  'eco: fixed commands or collecting information, with no judgment needed (run the tests and report, take screenshots, list or read files, read a log).',
  'efficient: a small, clearly described change in a few files (rename something, add a string or resource, fix a typo, write a test for behaviour that is already described, summarise).',
  'optimized: a feature that touches several files, a bug where the cause is partly known, planning a feature, reviewing code.',
  'max: the hardest work (design or architecture decisions, a bug with an unknown cause, security or privacy, anything about a store release or store policy, a large rewrite).',
];
const CLASSIFY_PROMPT = [
  'You sort software tasks by how capable an AI model they need, so that simple tasks do not use an expensive model.',
  'The task text may have typing mistakes. Read it for what the person means.',
  'Pick the lowest level that can do the task well:',
  ...TIER_GUIDE,
  'A vague or open-ended task needs more judgment, so it is at least "optimized".',
  'Give the level and a reason of at most 12 plain words.',
].join('\n');
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: { tier: { type: 'string', enum: TIER_KEYS }, why: { type: 'string' } },
  required: ['tier', 'why'],
  additionalProperties: false,
};

// The environment for a claude program started by the dashboard. The server
// may itself have been started from inside a Claude session.
function agentEnv() {
  const env = { ...process.env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  return env;
}

// Asks the cheapest model what kind of task this is. It takes a few seconds
// and costs a fraction of a cent. Gives null when there is no usable answer.
function classifyTask(t, p, bin) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', 'haiku', '--safe-mode', '--tools', '', '--system-prompt', CLASSIFY_PROMPT,
      '--output-format', 'json', '--json-schema', JSON.stringify(CLASSIFY_SCHEMA), '--no-session-persistence'];
    const info = (infoCache.get(p.id) || {}).info;
    const ask = [
      `Kind of project: ${info ? info.type : 'unknown'}`,
      `The agent may: ${t.mode === 'edit' ? 'edit files' : 'only read and write a plan'}`,
      `Title: ${t.title}`,
      t.description ? `Details: ${t.description.slice(0, 3000)}` : '',
    ].filter(Boolean).join('\n');
    let child;
    try {
      child = execFile(...claudeCommand(bin, args), { cwd: os.tmpdir(), env: agentEnv(), timeout: 40000, maxBuffer: 4e6, windowsHide: true }, (err, stdout) => {
        let r = null;
        try { r = JSON.parse(String(stdout)); } catch { /* no answer */ }
        if (Array.isArray(r)) r = r[r.length - 1];
        if (!r || typeof r !== 'object') return resolve(null);
        const cost = Number(r.total_cost_usd) || 0;
        if (cost) {
          t.cost = (t.cost || 0) + cost;
          db.spend.push({ at: Date.now(), taskId: t.id, projectId: t.projectId, cost, model: 'haiku', check: true });
        }
        const out = r.structured_output;
        resolve(out && TIER_KEYS.includes(out.tier) ? { tier: out.tier, why: String(out.why || '').slice(0, 160).trim() } : null);
      });
    } catch { return resolve(null); }
    child.stdin.on('error', () => {});
    child.stdin.end(ask);
  });
}

// Word rules, used only when the quick check gives no answer.
function guessTier(t) {
  const s = `${t.title}\n${t.description || ''}`.toLowerCase();
  if (/architect|redesign|security|privacy|policy|release|publish|play store|migrat|rewrite|root cause|not sure why|unknown/.test(s)) return 'max';
  if (s.length < 400 && /\b(rename|typo|spelling|string|label|wording|colou?r|icon|bump|version|comment)\b/.test(s)) return 'efficient';
  if (t.mode === 'plan' && s.length < 300 && /\b(list|count|find where|which files?|screenshot|logcat|run the tests?)\b/.test(s)) return 'eco';
  return 'optimized';
}

// The level to really use: never above the limit set in Settings.
function capTier(key) {
  const i = Math.max(0, TIER_KEYS.indexOf(key));
  let top = TIER_KEYS.indexOf(db.settings.autoMax);
  if (top < 0) top = TIERS.length - 1;
  if (usageMode() === 'saver') top = Math.min(top, TIER_KEYS.indexOf('optimized'));
  return TIERS[Math.min(i, top)];
}

// What an Auto pick was made for. When the task text changes, it is sized again.
const autoKey = (t) => crypto.createHash('md5')
  .update([t.mode, t.title, t.description || '', t.kind || '', JSON.stringify(t.scan || '')].join('\n')).digest('hex');

// True when the task has an Auto pick that still fits it. A follow-up keeps
// the model its first run had; otherwise the pick follows today's cap.
function sized(t) {
  if (!t.auto) return false;
  if (t.pendingFollowUp && t.sessionId) return true;
  if (t.auto.key !== autoKey(t)) return false;
  const tier = capTier(t.auto.asked);
  t.auto.tier = tier.key;
  t.auto.model = tier.model;
  return true;
}

// Sets t.auto: the level and model the automatic choice gives this run.
async function chooseModel(t, p, bin) {
  let found = null;
  if (t.kind === 'scan') {
    // No check needed: reading notes is light work, judging code is not.
    found = t.scan && t.scan.code
      ? { tier: 'optimized', why: 'judging the code needs a stronger model' }
      : { tier: 'efficient', why: 'reading notes and plans is light work' };
  } else {
    try { found = await classifyTask(t, p, bin); } catch { /* fall back to the word rules */ }
    if (!found) found = { tier: guessTier(t), why: 'chosen by simple word rules, because the quick check gave no answer' };
  }
  const tier = capTier(found.tier);
  const why = found.why.replace(/[.\s]+$/, '');
  // asked = what the task needs; tier and model = what it gets under today's cap.
  t.auto = { tier: tier.key, model: tier.model, asked: found.tier, why, key: autoKey(t), at: Date.now() };
  const capped = tier.key === found.tier ? '' : usageMode() === 'saver' ? ` Usage saver keeps Auto at ${tier.label} or below.` : ` Settings limit Auto to ${tier.label}.`;
  addLog(t, 'status', `Auto picked ${tier.label} (${tier.model}): ${why}.${capped}`);
  changed();
}

// ---------------------------------------------------------------- usage modes
//
// One switch for how careful agents are with the Claude plan limit:
//   saver     "Default" means Auto, nothing runs above Opus, small models
//             think less, every run has a spend limit, and a task Auto sizes
//             as "max" first only plans.
//   balanced  "Default" means Auto.
//   full      Nothing is held back: "Default" is Claude Code's own model.
// Saver and Balanced also start agents by how much of the limit they are
// likely to take, not just by how many are running. Saver runs one agent at
// a time and Balanced two.
// Whatever mode you chose, the dashboard acts as Saver while the 5-hour
// limit is at or above settings.autoSaver percent (0 = never), and goes back
// to your mode by itself when the limit resets.

const chosenMode = () => (USAGE_MODES.includes(db.settings.usageMode) ? db.settings.usageMode : 'full');
const autoSaverAt = () => (db.settings.autoSaver == null ? 70 : Math.min(100, Math.max(0, Number(db.settings.autoSaver) || 0)));
function steppedDown() {
  const at = autoSaverAt();
  const w = db.limits && db.limits.windows.five_hour;
  return chosenMode() !== 'saver' && at > 0 && Boolean(w) && w.resetsAt > Date.now() && w.utilization * 100 >= at;
}
const usageMode = () => (steppedDown() ? 'saver' : chosenMode());
const agentCap = () => Math.min(db.settings.maxAgents, MODE_AGENTS[usageMode()] || Infinity);

// The model choice a task runs with: its own, else the default.
function wantedModel(t) {
  const m = t.model || db.settings.defaultModel || (usageMode() === 'full' ? '' : 'auto');
  return usageMode() === 'saver' && m === 'fable' ? 'opus' : m;
}

// The model the task will run on, as far as it is known. '' means Claude
// Code's own default, or an Auto pick that has not been made yet.
function runModel(t) {
  const m = wantedModel(t);
  return m === 'auto' ? ((t.auto && t.auto.model) || '') : m;
}

function runBudget(t) {
  if (Number(t.budget) > 0) return Number(t.budget);
  if (db.settings.taskBudget > 0) return db.settings.taskBudget;
  return usageMode() === 'saver' ? SAVER_RUN_BUDGET : 0;
}

// Saver: the small models think less. The big ones keep their normal effort.
const runEffort = (t) => (usageMode() === 'saver' ? { haiku: 'low', sonnet: 'medium' }[runModel(t)] || '' : '');

// False for a plan-only task, and for an edit task that is still in its
// "plan first" phase.
const editing = (t) => t.mode === 'edit' && t.phase !== 'plan';

// Saver: a task Auto sizes as "max" plans first and edits only after your OK.
const plansFirst = (t) => usageMode() === 'saver' && t.mode === 'edit' && !t.kind && !t.planOk
  && wantedModel(t) === 'auto' && Boolean(t.auto) && t.auto.asked === 'max';

// ---------------------------------------------------------------- how much of the limit a run takes

const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'];
const family = (name) => (String(name || '').match(/haiku|sonnet|opus|fable/) || [''])[0];
// Used until there are three runs of your own on a model: dollars at API
// prices, and how long a run takes.
const TYPICAL = {
  haiku: { cost: 0.05, ms: 90e3 }, sonnet: { cost: 0.3, ms: 180e3 },
  opus: { cost: 1.5, ms: 400e3 }, fable: { cost: 6, ms: 900e3 },
};

// From your own last runs on a model: the cost three runs in four stay
// under, and the usual length.
function typicalRun(fam, runMode) {
  const base = TYPICAL[fam] || TYPICAL.opus;
  const all = db.spend.filter((e) => !e.check && e.cost > 0 && family(e.model) === fam);
  const modeOf = (e) => e.mode || (findTask(e.taskId) || {}).mode;
  let runs = all.filter((e) => modeOf(e) === runMode).slice(-12);
  if (runs.length < 3) runs = all.slice(-12);
  if (runs.length < 3) return base;
  const costs = runs.map((e) => e.cost).sort((a, b) => a - b);
  const timed = runs.filter((e) => e.ms > 0);
  return {
    cost: costs[Math.min(costs.length - 1, Math.floor(costs.length * 0.75))],
    ms: timed.length >= 3 ? timed.reduce((sum, e) => sum + e.ms, 0) / timed.length : base.ms,
    runs: runs.length,
  };
}

// How many points (percent) of the 5-hour limit one dollar of agent work
// takes on your plan. Learned from the readings; 2 until there is enough.
function pointsPerDollar() {
  const usable = Object.values(db.windows).filter((w) => w.cost >= 2 && w.gain > 0);
  // Windows where only agents were working are the cleaner measure.
  const clean = usable.filter((w) => !w.mixed);
  let gain = 0;
  let cost = 0;
  for (const w of clean.length ? clean : usable) {
    gain += w.gain * 100;
    cost += w.cost;
  }
  return cost ? Math.min(30, Math.max(0.2, gain / cost)) : 2;
}

// True when a Claude conversation that is not a dashboard agent's was
// written to since the given time. Looked up at most every 20 seconds.
let ownSeen = { at: 0, latest: 0 };
function ownSessionsActiveSince(ts) {
  if (Date.now() - ownSeen.at > 20000) {
    const mine = new Set(db.tasks.filter((t) => t.sessionId && !t.ide).map((t) => `${t.sessionId}.jsonl`));
    let latest = 0;
    try {
      for (const d of fs.readdirSync(CLAUDE_PROJECTS)) {
        let names = [];
        try { names = fs.readdirSync(path.join(CLAUDE_PROJECTS, d)); } catch { continue; }
        for (const n of names) {
          if (!n.endsWith('.jsonl') || mine.has(n)) continue;
          try { latest = Math.max(latest, fs.statSync(path.join(CLAUDE_PROJECTS, d, n)).mtimeMs); } catch { /* gone */ }
        }
      }
    } catch { /* nothing saved */ }
    ownSeen = { at: Date.now(), latest };
  }
  return ownSeen.latest > ts;
}

// The model a task will most likely run on. An Auto task that has not been
// sized yet goes by the word rules, which cost nothing.
function likelyFamily(t) {
  const known = family(runModel(t));
  if (known) return known;
  if (wantedModel(t) === 'auto') {
    return capTier(t.kind === 'scan' ? (t.scan && t.scan.code ? 'optimized' : 'efficient') : guessTier(t)).model;
  }
  return db.defaultFamily || 'fable';
}

// What one run of this task is likely to take. memo (optional) saves looking
// up the same model twice when many tasks are estimated together.
function estimate(t, memo) {
  const fam = likelyFamily(t);
  const key = `${fam}/${editing(t) ? 'edit' : 'plan'}`;
  const run = (memo && memo[key]) || typicalRun(fam, editing(t) ? 'edit' : 'plan');
  if (memo) memo[key] = run;
  const cap = runBudget(t);
  const cost = cap > 0 ? Math.min(run.cost, cap) : run.cost;
  return { cost, ms: run.ms, points: cost * pointsPerDollar(), family: fam };
}

// How much of the 5-hour limit is free for new agents, in points (percent):
// the pause level, minus what is used, minus what the running agents will
// still take. The part they already used is in the reading, so their share
// shrinks as they get older.
function limitRoom() {
  const now = Date.now();
  const w = db.limits && db.limits.windows.five_hour;
  const live = Boolean(w) && w.resetsAt > now;
  const used = live ? w.utilization * 100 : 0;
  const ceiling = db.settings.holdPercent > 0 ? db.settings.holdPercent : 100;
  let reserved = 0;
  for (const [id, st] of running) {
    const other = findTask(id);
    if (!other || !st.est) continue;
    reserved += st.est.points * Math.max(0.2, 1 - (now - other.startedAt) / st.est.ms);
  }
  return { used, ceiling, reserved, free: ceiling - used - reserved, resetsAt: live ? w.resetsAt : 0, readAt: db.limits ? db.limits.at : 0 };
}

// Is there room in the 5-hour limit to start this task next to the agents
// already running? Gives null when it may start, else why it waits. A task
// with nothing else running is never held here: the plain pause covers that.
function roomFor(t) {
  if (usageMode() === 'full' || !running.size) return null;
  const need = estimate(t).points;
  const free = limitRoom().free;
  if (need <= free) return null;
  return `Waiting for room in your 5-hour limit: needs about ${Math.max(1, Math.round(need))}%, ${Math.max(0, Math.floor(free))}% is free`;
}

// ---------------------------------------------------------------- project by project
//
// With settings.queueOrder 'project', waiting tasks start one project after
// another, so a limit that runs out leaves finished projects and untouched
// ones, not a little done everywhere. The order: a project that agents are
// already working on, then the order you chose in "Plan a run", then the
// project that needs the least of the limit (so the most projects get done).
// A second project starts next to the first only when both fit in what is
// free of the 5-hour limit.

let focusProject = null; // the project the last agent was started for

// True for a waiting task that cannot start until you do something: the
// task it runs after is not queued, running or finished well.
function waitsOnYou(t) {
  const first = t.after && !t.force ? findTask(t.after) : null;
  if (!first || first.status === 'done' || first.status === 'queued' || first.status === 'running') return false;
  return !(first.status === 'review' && first.outcome === 'ok' && first.phase !== 'plan');
}

// Gives each project with waiting tasks its place in line and what its
// waiting tasks need, as a Map of project id to { rank, need, upTo, left }.
function projectLine(queued) {
  const memo = {};
  const rows = new Map();
  for (const t of queued) {
    if (waitsOnYou(t) || (stillCut(t) && !t.force)) continue;
    const r = rows.get(t.projectId) || { id: t.projectId, need: 0, left: 0, first: Infinity };
    r.need += estimate(t, memo).points;
    r.left += 1;
    r.first = Math.min(r.first, t.queuedAt || 0);
    rows.set(t.projectId, r);
  }
  if (focusProject && !rows.has(focusProject)) focusProject = null; // that project has nothing waiting any more
  const busy = new Set([...running.keys()].map((id) => (findTask(id) || {}).projectId));
  const chosen = Array.isArray(db.runOrder) ? db.runOrder : [];
  const place = (id) => { const i = chosen.indexOf(id); return i < 0 ? chosen.length : i; };
  const list = [...rows.values()].sort((a, b) => busy.has(b.id) - busy.has(a.id)
    || (b.id === focusProject) - (a.id === focusProject)
    || place(a.id) - place(b.id) || a.need - b.need || a.first - b.first);
  let sum = 0;
  list.forEach((r, i) => { r.rank = i; sum += r.need; r.upTo = sum; });
  return rows;
}

// What the open tasks (To do and waiting) of every project are likely to
// take, and how much of the 5-hour limit is free: the numbers behind
// "Plan a run".
function forecast() {
  const memo = {};
  const rows = new Map();
  for (const t of db.tasks) {
    if (t.status !== 'todo' && t.status !== 'queued') continue;
    const r = rows.get(t.projectId) || { id: t.projectId, tasks: 0, todo: 0, queued: 0, points: 0, cost: 0, ms: 0, guessed: 0, models: {} };
    const e = estimate(t, memo);
    r.tasks += 1;
    r[t.status] += 1;
    r.points += e.points;
    r.cost += e.cost;
    r.ms += e.ms;
    r.models[e.family] = (r.models[e.family] || 0) + 1;
    // The model is not known yet: Auto has not looked at the task.
    if (!family(runModel(t))) r.guessed += 1;
    rows.set(t.projectId, r);
  }
  return { ...limitRoom(), rate: pointsPerDollar(), runOrder: Array.isArray(db.runOrder) ? db.runOrder : [], projects: [...rows.values()] };
}

const LIMIT_NAME = { five_hour: '5-hour', seven_day: 'weekly' };
const clockTime = (ms, withDay) => new Date(ms).toLocaleString('en-IN', withDay
  ? { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
  : { hour: '2-digit', minute: '2-digit', hour12: false });

// True while the limit that cut a task off is still full.
function stillCut(t) {
  if (!t.limitCut) return false;
  const w = db.limits && db.limits.windows[t.limitCut.type];
  if (w && w.resetsAt === t.limitCut.resetsAt) return w.resetsAt > Date.now() && w.utilization >= 0.95;
  return !w && t.limitCut.resetsAt > Date.now();
}

// A run that a Claude plan limit cut off goes back in the queue, and
// continues the same conversation by itself once the limit has reset.
function parkForLimit(t, st) {
  const w5 = db.limits && db.limits.windows.five_hour;
  const lim = st.limit || { type: 'five_hour', resetsAt: (w5 && w5.resetsAt) || Date.now() + 3600e3 };
  const count = ((t.limitCut && t.limitCut.count) || 0) + 1;
  const name = LIMIT_NAME[lim.type] || 'plan';
  if (count > MAX_LIMIT_RETRIES) {
    return finish(t, 'failed', `Cut off by your Claude ${name} limit ${count} times in a row. Send a follow-up to continue when there is room.`);
  }
  running.delete(t.id);
  t.limitCut = { type: lim.type, resetsAt: lim.resetsAt, count };
  t.status = 'queued';
  t.queuedAt = Date.now();
  t.outcome = null;
  t.finishedAt = null;
  t.assignee = { kind: 'agent', name: '' };
  t.pendingFollowUp = 'You were cut off by a usage limit, which has now reset. Continue the task from where you stopped.';
  addLog(t, 'status', `Cut off by your Claude ${name} limit. It continues by itself after the reset (${clockTime(lim.resetsAt, lim.type !== 'five_hour')}).`);
  notify(`Your Claude ${name} limit is used up. Agents continue by themselves after ${clockTime(lim.resetsAt, lim.type !== 'five_hour')}.`);
  infoCache.delete(t.projectId);
  changed();
  pump();
}

// Reads the Claude plan limits right now with one tiny Haiku call (about a
// hundredth of a cent; nothing when the limit is full). Agents report the
// limits as they run, but a queue that is paused for a full limit runs no
// agents, so by itself it would never notice a limit that was reset early.
const LIMIT_RECHECK_MS = 5 * 60000;
let limitCheck = null; // the check in progress, if any
let limitCheckedAt = 0;
function refreshLimits() {
  if (limitCheck) return limitCheck;
  const bin = findClaude();
  if (!bin) return Promise.resolve(false);
  limitCheckedAt = Date.now();
  limitCheck = new Promise((resolve) => {
    const args = ['-p', '--model', 'haiku', '--safe-mode', '--tools', '', '--system-prompt', 'Reply with the single word OK.',
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
    let child;
    try {
      child = execFile(...claudeCommand(bin, args), { cwd: os.tmpdir(), env: agentEnv(), timeout: 40000, maxBuffer: 4e6, windowsHide: true }, (err, stdout) => {
        let got = false;
        for (const line of String(stdout).split('\n')) {
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type !== 'rate_limit_event') continue;
          const before = db.limits;
          recordLimits(ev);
          if (db.limits !== before) got = true;
        }
        resolve(got);
      });
    } catch { return resolve(false); }
    child.stdin.on('error', () => {});
    child.stdin.end('OK');
  }).then((got) => {
    limitCheck = null;
    if (got) changed();
    pump();
    return got;
  });
  return limitCheck;
}

// ---------------------------------------------------------------- "what is next" scans

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          details: { type: 'string' },
          source: { type: 'string', enum: ['notes', 'idea'] },
          from: { type: 'string' },
          mode: { type: 'string', enum: MODES },
          size: { type: 'string', enum: TIER_KEYS },
          priority: { type: 'string', enum: PRIORITIES },
        },
        required: ['title', 'details', 'source', 'from', 'mode', 'size', 'priority'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'suggestions'],
  additionalProperties: false,
};

function scanPrompt(t, p) {
  const want = t.scan || { notes: true, code: false };
  const notes = want.notes ? findNotes(p.path).files : [];
  const rel = (f) => { const r = path.relative(p.path, f); return r.startsWith('..') ? f : r; };
  const info = (infoCache.get(p.id) || {}).info;
  const board = db.tasks.filter((x) => x.projectId === p.id && x.kind !== 'scan');
  const state = { todo: 'to do', queued: 'to do', running: 'in progress', review: 'worked on, waiting for review', done: 'done' };
  const lines = [
    `The user builds several projects alone and wants to know where the project "${p.name}" stands and what to work on next.`,
    'Your suggestions become tasks on their task board. The user, or another AI agent that has not seen this conversation, picks the tasks up later, so each one has to make sense by itself.',
    'Look at the project and change nothing.',
    '',
  ];
  if (notes.length) {
    lines.push(
      'Start from the notes and plan files, because they say what the user means to build. These exist:',
      ...notes.map((f) => `- ${rel(f)}`),
      'Read the ones about this project. Files outside the project folder may also cover sibling projects: use only the parts about this one. If CLAUDE.md names a plan file for this project, that is the one to read.',
      'Compare what the notes say should exist with what the code really has, and list what is still left to do. Notes go out of date, so check the code before you call something missing.',
      '');
  } else if (want.notes) {
    lines.push('This project has no notes or plan files, so work out what it is for from the code and the git history.', '');
  }
  if (want.code) {
    lines.push(
      `${notes.length ? 'Then look' : 'Look'} at the code with fresh eyes and add your own ideas${notes.length ? ' that the notes do not mention' : ''}: likely bugs, missing tests, things that would block a release, rough edges a user would notice.`,
      'Useful places: the folder layout, the build files, TODO and FIXME comments, and the recent git history. Suggest only what you have a concrete reason for in this code.',
      '');
  } else {
    lines.push('Keep this quick: read the notes, the folder layout and the recent git history. Open code files only to check whether something is already done.', '');
  }
  const facts = [`Today is ${new Date().toISOString().slice(0, 10)}.`];
  if (info && info.exists) facts.push(`Kind of project: ${info.type}.`);
  if (p.deadline) facts.push(`The user's deadline for it: ${p.deadline}.`);
  if (p.notes && p.notes.trim()) facts.push(`The user's own note about it: ${p.notes.trim().slice(0, 1500)}`);
  lines.push(...facts, '');
  if (t.description && t.description.trim()) lines.push(`The user asks you to focus on: ${t.description.trim()}`, '');
  if (board.length) {
    lines.push(
      'These tasks are already on the board for this project. Do not suggest them again:',
      ...board.slice(-40).map((x) => `- ${x.id} (${state[x.status] || x.status}): ${x.title}`),
      '');
  }
  lines.push(
    'Give back:',
    '- summary: where the project stands, in 3 to 6 short sentences of plain, simple English.',
    '- suggestions: at most 10, the most useful first. A few good ones are better than many vague ones. For each:',
    '  - title: starts with a verb, under 80 characters.',
    '  - details: the whole brief for whoever does the task. What to change, where (file or screen names), and how to tell it worked. 2 to 5 sentences.',
    '  - source: "notes" when it is left over from the notes or plan, "idea" when it is your own suggestion.',
    '  - from: the file and section it comes from, or the code that made you suggest it. A few words.',
    '  - mode: "edit" when the work is clear enough to simply do, "plan" when it needs a decision or a design first.',
    '  - size: how capable a model the task needs. Pick the lowest that can do it well:',
    ...TIER_GUIDE.map((g) => `    - ${g}`),
    '  - priority: "high" only when it blocks a release or breaks the app, "low" for nice-to-haves, otherwise "normal".',
  );
  return lines.join('\n');
}

// Finds a JSON object in an answer that was meant to be only JSON.
function looseJson(s) {
  s = String(s || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const part of [fence && fence[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)]) {
    if (!part) continue;
    try { return JSON.parse(part); } catch { /* try the next form */ }
  }
  return null;
}

// Checks and tidies what a scan gave back. `run` keeps suggestion ids from
// different runs of the same scan apart.
function readSuggestions(obj, run) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.suggestions)) return null;
  const clip = (v, max) => String(v == null ? '' : v).slice(0, max).trim();
  const suggestions = [];
  for (const s of obj.suggestions.slice(0, 20)) {
    const title = clip(s && s.title, 200);
    if (!title) continue;
    suggestions.push({
      id: `r${run}s${suggestions.length + 1}`,
      title,
      details: clip(s.details, 4000),
      source: s.source === 'notes' ? 'notes' : 'idea',
      from: clip(s.from, 200),
      mode: MODES.includes(s.mode) ? s.mode : 'plan',
      size: TIER_KEYS.includes(s.size) ? s.size : 'optimized',
      priority: PRIORITIES.includes(s.priority) ? s.priority : 'normal',
      taskId: null,
    });
  }
  return { summary: clip(obj.summary, 4000), suggestions };
}

// ---------------------------------------------------------------- notifications

// A desktop notification (and a phone one through ntfy.sh, if you set a topic)
// when something needs you. Several at once are folded into one.
const notes = [];
let noteTimer = null;
function notify(textLine) {
  if (!db.settings.notify) return;
  notes.push(textLine);
  if (!noteTimer) noteTimer = setTimeout(sendNotes, 2500);
}
function desktopNote(line) {
  const quiet = () => {};
  if (MAC) return execFile('osascript', ['-e', `display notification ${JSON.stringify(line)} with title "Pacer"`], quiet);
  if (WIN) {
    // A tray balloon, which Windows 10 and 11 show as a normal notification.
    // The text goes in through the environment, so no quoting can break it.
    return execFile('powershell.exe', ['-NoProfile', '-Command', [
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.Visible = $true',
      "$n.ShowBalloonTip(8000, 'Pacer', $env:PACER_NOTE, 'None')",
      'Start-Sleep -Seconds 8',
      '$n.Dispose()',
    ].join('; ')], { windowsHide: true, timeout: 20000, env: { ...process.env, PACER_NOTE: line } }, quiet);
  }
  return execFile('notify-send', ['Pacer', line], quiet);
}

function sendNotes() {
  noteTimer = null;
  const list = notes.splice(0);
  if (!list.length) return;
  const body = list.length === 1 ? list[0] : `${list.length} updates. ${list.slice(0, 3).join(' · ')}${list.length > 3 ? ' · …' : ''}`;
  desktopNote(body.slice(0, 300));
  const topic = db.settings.ntfyTopic;
  if (topic) fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', body, headers: { Title: 'Pacer' } }).catch(() => {});
}

// ---------------------------------------------------------------- a separate copy of the project for one task

// With "separate copy" on, an editing task works in its own git worktree on
// its own branch, next to the project. Several agents can then edit one
// project at the same time, and the result can go back as uncommitted
// changes ("Apply to project") or as a pull request.
const workDir = (t, p) => (t.work && fs.existsSync(t.work.dir) ? t.work.dir : p.path);
const git = (dir, args, opts) => sh('git', ['-C', dir, ...args], { timeout: 60000, maxBuffer: 64e6, ...opts });

async function makeCopy(t, p) {
  const head = await git(p.path, ['rev-parse', 'HEAD']);
  if (!head.ok) throw new Error('A separate copy needs a git repository with at least one commit. Turn "separate copy" off for this task, or commit once in the project.');
  const slug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
  const branch = `dashboard/${t.id.toLowerCase()}-${slug}`;
  const dir = path.join(path.dirname(p.path), '.dashboard-copies', `${path.basename(p.path)}-${t.id}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const made = await git(p.path, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  if (!made.ok) throw new Error(`Could not make the separate copy: ${made.err.trim().split('\n').pop()}`);
  for (const name of COPY_EXTRA) {
    const from = path.join(p.path, name);
    if (!fs.existsSync(from)) continue;
    const ignored = await git(p.path, ['check-ignore', '-q', name]);
    if (ignored.ok) try { fs.copyFileSync(from, path.join(dir, name)); } catch { /* not needed enough to fail */ }
  }
  t.work = { dir: fs.realpathSync(dir), branch, base: head.out.trim() };
  addLog(t, 'status', `Working in a separate copy on branch ${branch}`);
}

async function removeCopy(t, p) {
  const w = t.work;
  if (!w) return;
  if (p && fs.existsSync(p.path)) {
    await git(p.path, ['worktree', 'remove', '--force', w.dir]);
    await git(p.path, ['worktree', 'prune']);
    if (!w.pr) await git(p.path, ['branch', '-D', w.branch]); // a branch with a pull request stays
  }
  fs.rm(w.dir, { recursive: true, force: true }, () => {});
  delete t.work;
  delete t.baseTree;
}

// ---------------------------------------------------------------- agents

const running = new Map(); // task id -> { child, stopped }

function versionKey(name) {
  const m = name.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 1e12 + Number(m[2]) * 1e6 + Number(m[3]) : 0;
}

function findClaude() {
  const home = os.homedir();
  const cands = [];
  if (db.settings.claudePath) cands.push(db.settings.claudePath);
  // On Windows the program is claude.exe, or claude.cmd when npm installed it.
  const names = WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) for (const n of names) cands.push(path.join(d, n));
  for (const n of names) cands.push(path.join(home, '.local', 'bin', n), path.join(home, '.claude', 'local', n));
  if (WIN && process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'claude.cmd'));
  if (!WIN) cands.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  // The VS Code extension ships the same program. Newest version first.
  const ext = path.join(home, '.vscode', 'extensions');
  try {
    const dirs = fs.readdirSync(ext)
      .filter((n) => n.startsWith('anthropic.claude-code-'))
      .sort((a, b) => versionKey(b) - versionKey(a));
    for (const d of dirs) cands.push(path.join(ext, d, 'resources', 'native-binary', WIN ? 'claude.exe' : 'claude'));
  } catch { /* no VS Code */ }
  for (const c of cands) {
    const found = runnableClaude(c);
    if (found) return found;
  }
  return null;
}

// A file Pacer can start directly. A Windows .cmd/.bat cannot be started
// without a shell (and quoting long prompts through cmd.exe is fragile), so
// for npm's claude.cmd the real program inside the npm package is used.
function runnableClaude(c) {
  try {
    if (!fs.statSync(c).isFile()) return null;
    if (/\.(cmd|bat)$/i.test(c)) {
      const pkg = path.join(path.dirname(c), 'node_modules', '@anthropic-ai', 'claude-code');
      for (const f of [path.join(pkg, 'bin', 'claude.exe'), path.join(pkg, 'cli.js')]) if (fs.existsSync(f)) return f;
      return null;
    }
    if (!WIN && !/\.[cm]?js$/i.test(c)) fs.accessSync(c, fs.constants.X_OK); // a .js file runs through Node
    return c;
  } catch { return null; }
}

// The command and arguments that start claude. A .js file runs through Node.
const claudeCommand = (bin, args) => (/\.[cm]?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args]);

function systemPrompt(t) {
  if (t.kind === 'scan') {
    return [
      "You are a background agent started from the user's project dashboard to look at one project and suggest what to do next.",
      'Nobody can answer questions while you run. Do not ask questions: make a sensible choice.',
      "This is a read-only job: do not change, create or delete any files, and never run git commit or git push. Follow the project's CLAUDE.md.",
      'Write for the user in plain, simple English.',
    ].join('\n');
  }
  const lines = [
    "You are a background agent started from the user's project dashboard to do one task.",
    'Nobody can answer questions while you run. Do not ask questions: make a sensible choice and say what you chose in your report.',
    "Work only inside the current project folder, and follow the project's CLAUDE.md.",
    'Never run git commit or git push. Leave changes uncommitted for the user to review.',
  ];
  if (!editing(t)) {
    lines.push('This is a PLAN-ONLY task: do not change, create or delete any files. Read the code, then give your findings and a step-by-step plan as your final message.');
    if (t.phase === 'plan') lines.push('The user reads your plan first and then decides whether you carry it out, so make the plan complete enough to act on.');
  }
  lines.push('Finish with a short report in plain, simple English: what you did or found, which files changed, how you checked it, and anything left over or needing the user\'s decision.');
  return lines.join('\n');
}

function firstPrompt(t, p) {
  if (t.kind === 'scan') return scanPrompt(t, p);
  return [
    `Task ${t.id} for the project "${p.name}": ${t.title}`,
    t.description ? `\n${t.description}` : '',
  ].join('\n').trim();
}

function toolLine(name, input, cwd) {
  const rel = (f) => {
    if (!f) return '';
    const r = path.relative(cwd, f);
    return r && !r.startsWith('..') ? r : f;
  };
  const cut = (s, n = 140) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  input = input || {};
  switch (name) {
    case 'Read': return `Read ${rel(input.file_path)}`;
    case 'Edit': case 'NotebookEdit': return `Edit ${rel(input.file_path || input.notebook_path)}`;
    case 'Write': return `Write ${rel(input.file_path)}`;
    case 'Bash': return `Run: ${cut(input.description || input.command)}`;
    case 'Grep': return `Search for "${cut(input.pattern, 80)}"`;
    case 'Glob': return `Find files ${cut(input.pattern, 80)}`;
    case 'Task': case 'Agent': return `Helper agent: ${cut(input.description || input.prompt, 100)}`;
    case 'WebFetch': return `Fetch ${cut(input.url, 100)}`;
    case 'WebSearch': return `Web search: ${cut(input.query, 100)}`;
    case 'ExitPlanMode': return 'Plan ready';
    case 'StructuredOutput': return 'Writing up the suggestions';
    default: return name;
  }
}

function finish(t, outcome, message) {
  running.delete(t.id);
  delete t.limitCut;
  t.status = 'review';
  t.outcome = outcome;
  t.finishedAt = Date.now();
  t.waitReason = null;
  if (message) addLog(t, outcome === 'ok' ? 'status' : 'error', message);
  if (outcome !== 'stopped') {
    const name = (findProject(t.projectId) || {}).name || 'a project';
    notify(outcome !== 'ok' ? `${t.id} did not finish (${name}): ${t.title}`
      : t.phase === 'plan' ? `${t.id} has a plan ready for your OK (${name}): ${t.title}`
        : t.kind === 'scan' ? `${t.id}: suggestions are ready for ${name}`
          : `${t.id} finished (${name}): ${t.title}`);
  }
  infoCache.delete(t.projectId);
  changed();
  pump();
}

function startAgent(t) {
  const p = findProject(t.projectId);
  const followUp = t.pendingFollowUp;
  delete t.pendingFollowUp;
  delete t.force;
  t.assignee = { kind: 'agent', name: runModel(t) || (wantedModel(t) === 'auto' ? 'auto' : 'default model') };
  t.startedAt = Date.now();
  t.finishedAt = null;
  t.waitReason = null;
  t.outcome = null;
  if (!p || !fs.existsSync(p.path)) return finish(t, 'failed', 'The project folder was not found. Check the project link.');
  const bin = findClaude();
  if (!bin) return finish(t, 'failed', 'Could not find the claude program. Set its path in Settings.');

  const resume = Boolean(followUp && t.sessionId);
  // Usage saver: a big task only plans on its first run. A follow-up keeps
  // the phase it is in, until you press "Carry out this plan".
  if (!resume) { if (plansFirst(t)) t.phase = 'plan'; else delete t.phase; }
  const st = { child: null, stopped: false, result: null, plan: null, stderr: '', done: false, limit: null, model: '', est: estimate(t) };
  running.set(t.id, st);
  t.status = 'running';
  t.runs = (t.runs || 0) + 1;
  t.steps = 0;
  if (!resume) { t.sessionId = null; t.report = ''; }
  if (usageMode() === 'saver' && (t.model || db.settings.defaultModel) === 'fable') addLog(t, 'status', 'Usage saver: this run uses Optimized (opus) in place of Max (fable).');
  addLog(t, 'status', `${resume ? 'Agent resumed' : 'Agent started'} (${editing(t) ? 'can edit files' : t.phase === 'plan' ? 'plans first: Usage saver asks for your OK before a task this big edits files' : 'plan only'})`);
  changed();

  // Before an editing run, remember how the files look, so the task can show
  // exactly what changed. A follow-up keeps the first starting point.
  let ready = Promise.resolve();
  if (t.copy && editing(t) && !(t.work && fs.existsSync(t.work.dir))) {
    delete t.work;
    delete t.baseTree;
    ready = makeCopy(t, p).catch((e) => { st.copyError = e.message; });
  }
  ready = ready.then(() => {
    if (st.copyError || !editing(t) || (resume && t.baseTree)) return null;
    t.changes = null;
    return snapshotTree(workDir(t, p)).then((tree) => { t.baseTree = tree; }).catch(() => { t.baseTree = null; });
  });
  // "Auto" first finds out what kind of task this is. A follow-up stays on
  // the model the first run was given.
  // (The queue normally has sized the task already; this is the safety net.)
  if (wantedModel(t) !== 'auto') delete t.auto;
  else if (!(resume && t.auto) && !sized(t)) ready = Promise.all([ready, chooseModel(t, p, bin)]);
  ready.then(() => {
    if (st.stopped) { st.done = true; return finish(t, 'stopped', 'Stopped by you.'); }
    if (st.copyError) { st.done = true; return finish(t, 'failed', st.copyError); }
    launchAgent(t, p, st, bin, resume, followUp);
  });
}

function launchAgent(t, p, st, bin, resume, followUp) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', editing(t) ? 'auto' : 'plan',
    '--append-system-prompt', systemPrompt(t),
  ];
  const model = runModel(t);
  st.model = model;
  if (model) args.push('--model', model);
  const effort = runEffort(t);
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--resume', t.sessionId);
  if (t.kind === 'scan') {
    // The answer has to come back as data the board can turn into tasks.
    args.push('--json-schema', JSON.stringify(SCAN_SCHEMA));
    const outside = t.scan && t.scan.notes === false ? [] : findNotes(p.path).outside;
    if (outside.length) args.push('--add-dir', ...outside);
  }
  const budget = runBudget(t);
  if (budget > 0) args.push('--max-budget-usd', String(budget));
  // Three layers keep agents from committing or pushing: a check that runs
  // before every shell command, git hooks that refuse inside git itself, and
  // the plain deny rules.
  args.push('--settings', JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${process.execPath.replace(/\\/g, '/')}" "${GUARD.replace(/\\/g, '/')}"` }] }] },
  }));
  args.push('--disallowedTools', 'Bash(git commit *)', 'Bash(git push *)');

  let prompt = resume ? followUp : firstPrompt(t, p);
  if (followUp && !resume) prompt += `\n\n${followUp}`;
  if (resume && t.kind === 'scan') prompt += '\n\nThen give the complete, updated summary and list of suggestions again.';

  const env = agentEnv();
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  env.GIT_CONFIG_COUNT = String(n + 1);
  env[`GIT_CONFIG_KEY_${n}`] = 'core.hooksPath';
  env[`GIT_CONFIG_VALUE_${n}`] = GIT_HOOKS;

  let child;
  try {
    // Its own process group (not on Windows), so Stop can end everything it started.
    child = spawn(...claudeCommand(bin, args), { cwd: workDir(t, p), env, stdio: ['pipe', 'pipe', 'pipe'], detached: !WIN, windowsHide: true });
  } catch (e) {
    st.done = true;
    return finish(t, 'failed', `Could not start the agent: ${e.message}`);
  }
  st.child = child;

  const raw = fs.createWriteStream(path.join(RUNS_DIR, `${t.id}.jsonl`), { flags: 'a' });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      raw.write(line + '\n');
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      onEvent(t, st, ev, workDir(t, p));
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { st.stderr = (st.stderr + c).slice(-2000); });

  const end = async (code, spawnError) => {
    if (st.done) return;
    st.done = true;
    raw.end();
    const r = st.result;
    if (r) recordSpend(t, r);
    if (editing(t) && !spawnError) await saveChanges(t, workDir(t, p)).catch(() => {});
    if (st.stopped) return finish(t, 'stopped', 'Stopped by you.');
    if (spawnError) return finish(t, 'failed', `Could not start the agent: ${spawnError.message}`);
    // Cut off by a Claude plan limit: wait for the reset, then carry on.
    if (r ? r.is_error && (r.api_error_status === 429 || st.limit) : st.limit) return parkForLimit(t, st);
    if (!r) {
      const tail = st.stderr.trim().split('\n').slice(-3).join(' ');
      return finish(t, 'failed', `The agent ended without a result (exit code ${code}). ${tail}`.trim());
    }
    let answer = typeof r.result === 'string' ? r.result.trim() : '';
    if (st.plan && answer.length < st.plan.length) answer = st.plan;
    if (r.is_error) {
      t.report = answer || t.report || '';
      if (/budget/i.test(r.subtype || '')) {
        return finish(t, 'failed', `Stopped: this run reached its spend limit ($${Number(r.total_cost_usd || 0).toFixed(2)}). Raise the limit or send a follow-up to continue.`);
      }
      const said = answer.split('\n')[0].slice(0, 200);
      return finish(t, 'failed', said ? `The agent stopped with an error: ${said}` : `The agent stopped with an error (${r.subtype || 'unknown'}).`);
    }
    if (t.kind === 'scan') {
      const got = readSuggestions(r.structured_output, t.runs) || readSuggestions(looseJson(answer), t.runs);
      if (!got) {
        t.report = answer;
        return finish(t, 'failed', 'The agent did not give its suggestions in a form the board can read. Its answer is shown as the report.');
      }
      t.summary = got.summary;
      t.suggestions = got.suggestions;
      t.report = got.summary;
      const count = got.suggestions.length;
      return finish(t, 'ok', count ? `${count} suggestion${count === 1 ? '' : 's'} ready. Tick the ones you want as tasks.` : 'Finished: nothing to suggest right now.');
    }
    t.report = answer || '(The agent finished without writing a report.)';
    if (t.phase === 'plan') return finish(t, 'ok', 'Plan ready. Read it, then press "Carry out this plan" to let the agent edit files.');
    finish(t, 'ok', 'Agent finished. Waiting for your review.');
  };
  child.on('error', (e) => end(null, e));
  child.on('close', (code) => end(code));
}

function onEvent(t, st, ev, cwd) {
  if (ev.type === 'rate_limit_event') {
    const info = ev.rate_limit_info || {};
    if (info.status === 'rejected') st.limit = { type: info.rateLimitType || 'five_hour', resetsAt: Number(info.resetsAt) * 1000 || Date.now() + 3600e3 };
    recordLimits(ev, true);
    pumpSoon(); // a fresh reading can make room for a waiting task
  } else if (ev.type === 'system' && ev.subtype === 'init') {
    t.sessionId = ev.session_id || t.sessionId;
    if (ev.model) {
      t.assignee = { kind: 'agent', name: ev.model };
      if (!st.model) db.defaultFamily = family(ev.model) || db.defaultFamily;
    }
  } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
    for (const block of (ev.message && ev.message.content) || []) {
      if (block.type === 'text' && block.text && block.text.trim()) {
        addLog(t, 'text', block.text.trim());
      } else if (block.type === 'tool_use') {
        if (block.name === 'ExitPlanMode' && block.input && block.input.plan) st.plan = String(block.input.plan);
        t.steps = (t.steps || 0) + 1;
        addLog(t, 'tool', toolLine(block.name, block.input, cwd));
      }
    }
  } else if (ev.type === 'result') {
    st.result = ev;
    t.sessionId = ev.session_id || t.sessionId;
  } else {
    return;
  }
  changed();
}

function killAgent(st) {
  st.stopped = true;
  if (!st.child) return; // still preparing: it stops before it launches
  const pid = st.child.pid;
  if (WIN) {
    // No process groups or signals on Windows: end the whole process tree.
    if (pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  const signal = (sig) => {
    try { process.kill(-pid, sig); } catch { try { st.child.kill(sig); } catch { /* gone */ } }
  };
  signal('SIGTERM');
  setTimeout(() => { if (!st.done) signal('SIGKILL'); }, 4000).unref();
}

function setWait(t, reason) {
  if (t.waitReason !== reason) { t.waitReason = reason; changed(); }
}

const sizing = new Set(); // ids of tasks whose Auto pick is being made
// Each check is a Claude process of about 200 MB. With many tasks queued at
// once, all of them at the same moment would use up this computer's memory.
const SIZING_MAX = 3;
let pumpTimer = null;
function pumpSoon() {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, 1500);
}

function pump() {
  const rank = (t) => PRIORITIES.indexOf(t.priority);
  const queued = db.tasks
    .filter((t) => t.status === 'queued')
    .sort((a, b) => rank(b) - rank(a) || a.queuedAt - b.queuedAt);
  if (!queued.length) return;
  const now = Date.now();
  const hold = holdReason();
  // A plan limit can be reset before the time it gave. While tasks wait on
  // one, look again every few minutes.
  if ((planLimitHold() || queued.some(stillCut)) && now - limitCheckedAt > LIMIT_RECHECK_MS) refreshLimits();
  const bin = findClaude();
  // How many agents fit depends on how full the limit is, so starting one
  // next to another takes a recent reading. The first may always go.
  const stale = usageMode() !== 'full' && Boolean(bin) && (!db.limits || now - db.limits.at > 3 * 60000);
  // Project by project: put the projects in line, then go down the line.
  const line = db.settings.queueOrder !== 'mixed' ? projectLine(queued) : null;
  const free = line ? limitRoom().free : 0;
  if (line) {
    const place = (t) => (line.get(t.projectId) || { rank: Infinity }).rank;
    queued.sort((a, b) => (place(a) === place(b) ? 0 : place(a) < place(b) ? -1 : 1) || rank(b) - rank(a) || a.queuedAt - b.queuedAt);
  }
  for (const t of queued) {
    if (stillCut(t) && !t.force) {
      const c = t.limitCut;
      setWait(t, `Waiting for your Claude ${LIMIT_NAME[c.type] || 'plan'} limit to reset (${clockTime(c.resetsAt, c.type !== 'five_hour')}). Then it continues by itself`);
      continue;
    }
    if (hold && !t.force) { setWait(t, hold); continue; }
    // "Run after": wait until the task it follows has really finished.
    const first = t.after && !t.force ? findTask(t.after) : null;
    if (first && first.status !== 'done' && !(first.status === 'review' && first.outcome === 'ok' && first.phase !== 'plan')) {
      setWait(t, first.status !== 'review' ? `Waiting for ${first.id} to finish first`
        : first.phase === 'plan' ? `Waiting for ${first.id}: its plan needs your OK` : `Waiting: ${first.id} did not finish`);
      continue;
    }
    // Auto: find out what kind of task this is before deciding when it may start.
    const p = findProject(t.projectId);
    if (bin && p && wantedModel(t) === 'auto' && !sized(t)) {
      if (!sizing.has(t.id) && sizing.size < SIZING_MAX) {
        sizing.add(t.id);
        chooseModel(t, p, bin).catch(() => {}).then(() => { sizing.delete(t.id); pump(); });
      }
      setWait(t, sizing.has(t.id) ? 'Checking what kind of task this is' : 'Waiting to check what kind of task this is');
      continue;
    }
    if (running.size >= db.settings.maxAgents) { setWait(t, 'Waiting for a free agent slot'); continue; }
    if (running.size >= agentCap() && !t.force) {
      setWait(t, usageMode() === 'saver' ? 'Waiting for room: Saver runs one agent at a time' : 'Waiting for room: Balanced runs two agents at a time');
      continue;
    }
    const clash = t.mode === 'edit' && !t.copy && [...running.keys()].some((id) => {
      const other = findTask(id);
      return other && other.projectId === t.projectId && editing(other) && !other.copy;
    });
    if (clash) { setWait(t, 'Waiting: another agent is editing this project'); continue; }
    // Project by project: a project further down the line starts next to
    // the ones before it only when all of them fit in the free limit.
    const row = line && !t.force ? line.get(t.projectId) : null;
    if (row && row.upTo > free) {
      const before = [...line.values()].find((r) => r.rank < row.rank && r.left > 0);
      const other = before ? before.id : [...running.keys()].map((id) => (findTask(id) || {}).projectId).find((pid) => pid && pid !== t.projectId);
      if (other) {
        setWait(t, `Waiting for room: ${(findProject(other) || { name: 'another project' }).name} is finished first, both do not fit in your 5-hour limit together`);
        continue;
      }
    }
    if (stale && running.size && !t.force) {
      if (!limitCheck && now - limitCheckedAt > 60000) refreshLimits();
      // (If the check cannot run right now, go by the reading there is.)
      if (limitCheck) { setWait(t, 'Checking how full your Claude limit is'); continue; }
    }
    const room = t.force ? null : roomFor(t);
    if (room) { setWait(t, room); continue; }
    if (row) row.left -= 1;
    focusProject = t.projectId;
    startAgent(t);
  }
}

// ---------------------------------------------------------------- api

function pick(value, allowed, what) {
  if (!allowed.includes(value)) throw new HttpError(400, `Unknown ${what}: ${value}`);
  return value;
}
const text = (v, max) => String(v == null ? '' : v).slice(0, max);

// Tags are short labels you give a project to group similar ones ("Android",
// "Client work"). Takes a list or comma-separated text. A tag another project
// already uses keeps that project's spelling, so "android" joins "Android".
function cleanTags(v, others = []) {
  const known = new Map(others.flatMap((p) => p.tags || []).map((x) => [x.toLowerCase(), x]));
  const out = [];
  for (const raw of Array.isArray(v) ? v : String(v || '').split(',')) {
    const typed = text(String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim(), 24).trim();
    const tag = known.get(typed.toLowerCase()) || typed;
    if (tag && !out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length === 8) break;
  }
  return out;
}
const agentBusy = (t) => t.status === 'queued' || (t.status === 'running' && t.assignee && t.assignee.kind === 'agent');

function newTask(f) {
  const now = Date.now();
  return {
    id: `T${db.seq++}`,
    projectId: f.projectId,
    title: f.title,
    description: f.description || '',
    status: 'todo',
    outcome: null,
    mode: f.mode || 'plan',
    model: f.model || '',
    priority: f.priority || 'normal',
    budget: f.budget || 0,
    assignee: null,
    report: '',
    sessionId: null,
    cost: 0,
    runs: 0,
    steps: 0,
    log: [],
    logTotal: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// Moves a task that no agent is running to To do, Needs review or Done.
function moveTask(t, to) {
  if (to === 'todo') { t.assignee = null; t.outcome = null; delete t.force; }
  if (to === 'done') {
    t.doneAt = Date.now();
    if (t.work && (t.work.applied || t.work.pr)) removeCopy(t, findProject(t.projectId)).then(changed).catch(() => {});
  }
  if (to === 'review') t.finishedAt = Date.now();
  // Work done by hand in VS Code ends here: record what it changed.
  if (t.ide) {
    delete t.ide;
    const proj = findProject(t.projectId);
    if (to !== 'todo' && proj) saveChanges(t, workDir(t, proj)).then(changed).catch(() => {});
    if (to === 'review') t.outcome = 'ok';
  }
  t.waitReason = null;
  delete t.pendingFollowUp;
  delete t.limitCut;
  addLog(t, 'status', { todo: 'Moved back to To do', review: 'Moved to Needs review', done: 'Marked done' }[to]);
  t.status = to;
}

function queueTask(t) {
  delete t.ide;
  delete t.limitCut;
  t.status = 'queued';
  t.queuedAt = Date.now();
  t.outcome = null;
  t.assignee = { kind: 'agent', name: '' };
}

const api = {
  async getState(req, res, m, body, url) {
    const fresh = url.searchParams.get('fresh') === '1';
    const projects = await Promise.all(db.projects.map(async (p) => ({ ...p, info: await projectInfo(p, fresh) })));
    return {
      settings: db.settings,
      projects,
      tasks: db.tasks.map(briefTask),
      usage: usage(),
      forecast: forecast(),
      meta: { version: API_VERSION, platform: process.platform, claude: findClaude(), running: running.size, suggestRoot: path.dirname(__dirname), home: os.homedir(),
        system: { memGb: Math.round(os.totalmem() / 2 ** 30), cores: os.cpus().length } },
    };
  },

  getTask(req, res, m) {
    const t = findTask(m[1]);
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    const { pendingFollowUp, baseTree, ...rest } = t;
    return { ...rest, conversationInfo: taskConversations(t) };
  },

  listConversations(req, res, m) {
    const p = findProject(m[1]);
    if (!p) throw new HttpError(404, 'That project is no longer linked.');
    const dir = sessionDir(p.path);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && SESSION_ID.test(f.slice(0, -6))); } catch { /* none saved */ }
    const list = [];
    for (const f of files) {
      try { list.push(sessionSummary(path.join(dir, f))); } catch { /* unreadable file */ }
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return { conversations: list.filter((c) => c.steps > 0 || c.tooBig) };
  },

  getConversation(req, res, m) {
    const file = findSessionFile(m[1]);
    if (!file) throw new HttpError(404, 'That conversation is no longer saved on this computer.');
    const s = parseSession(file);
    const max = 3000;
    return { ...sessionSummary(file), items: s.items.slice(-max), cut: Math.max(0, s.items.length - max) };
  },

  getChanges(req, res, m) {
    const t = findTask(m[1]);
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    if (!t.changes || !fs.existsSync(changesFile(t.id))) {
      const p = findProject(t.projectId);
      const isGit = p && fs.existsSync(path.join(p.path, '.git'));
      return { files: null, reason: !isGit ? 'This project is not a git repository, so changes cannot be shown.' : 'No changes were recorded for this task.' };
    }
    const files = parsePatch(fs.readFileSync(changesFile(t.id), 'utf8')).map((f) => (
      f.patch.length > 200000 ? { ...f, patch: f.patch.slice(0, 200000), cut: true } : f));
    return { files, at: t.changes.at };
  },

  createTask(req, res, m, body) {
    const title = text(body.title, 200).trim();
    if (!title) throw new HttpError(400, 'Give the task a title.');
    if (!findProject(body.projectId)) throw new HttpError(400, 'Choose a project for this task.');
    const fields = {
      projectId: body.projectId,
      title,
      description: text(body.description, 20000),
      mode: pick(body.mode || 'plan', MODES, 'mode'),
      model: pick(body.model || '', MODELS, 'model'),
      priority: pick(body.priority || 'normal', PRIORITIES, 'priority'),
      budget: Math.max(0, Number(body.budget) || 0),
    };
    const t = newTask(fields);
    if (body.copy) t.copy = true;
    if (body.after && findTask(body.after)) t.after = body.after;
    if (REPEATS[body.repeat]) t.repeat = body.repeat;
    addLog(t, 'status', body.by ? `Task added by ${text(body.by, 60)}` : 'Task added');
    db.tasks.push(t);
    if (body.run) queueTask(t);
    changed();
    pump();
    return briefTask(t);
  },

  // Starts a read-only "what is next" scan in each chosen project. A project
  // keeps one open scan; asking again runs that same one again.
  suggest(req, res, m, body) {
    const notes = body.notes !== false;
    const code = Boolean(body.code);
    if (!notes && !code) throw new HttpError(400, 'Choose what to look at: the notes, the code, or both.');
    const model = pick(body.model == null ? 'auto' : body.model, MODELS, 'model');
    const focus = text(body.focus, 2000).trim();
    const out = [];
    for (const pid of Array.isArray(body.projectIds) ? body.projectIds : []) {
      if (!findProject(pid)) continue;
      let t = db.tasks.find((x) => x.kind === 'scan' && x.projectId === pid && x.status !== 'done');
      if (t && (t.status === 'running' || t.status === 'queued')) { out.push(t); continue; }
      if (!t) {
        t = newTask({ projectId: pid, title: 'Suggest what to do next', mode: 'plan' });
        t.kind = 'scan';
        addLog(t, 'status', 'Suggestions asked for');
        db.tasks.push(t);
      }
      t.scan = { notes, code };
      t.model = model;
      t.description = focus;
      delete t.pendingFollowUp;
      queueTask(t);
      out.push(t);
    }
    if (!out.length) throw new HttpError(400, 'Choose at least one project.');
    changed();
    pump();
    return { tasks: out.map(briefTask) };
  },

  // Turns the chosen suggestions of a scan into tasks on the board.
  adopt(req, res, m, body) {
    const t = findTask(m[1]);
    if (!t || t.kind !== 'scan') throw new HttpError(404, 'Those suggestions no longer exist.');
    const made = [];
    for (const item of Array.isArray(body.items) ? body.items : []) {
      const s = (t.suggestions || []).find((x) => x.id === (item && item.id));
      if (!s || (s.taskId && findTask(s.taskId))) continue;
      const n = newTask({
        projectId: t.projectId,
        title: s.title,
        description: [s.details, s.from ? `Where this comes from: ${s.from}` : ''].filter(Boolean).join('\n\n'),
        mode: pick(item.mode || s.mode, MODES, 'mode'),
        model: capTier(s.size).model, // the scan already sized the task
        priority: s.priority,
      });
      addLog(n, 'status', `Task added from the suggestions in ${t.id}`);
      db.tasks.push(n);
      s.taskId = n.id;
      if (body.run) queueTask(n);
      made.push(n);
    }
    t.updatedAt = Date.now();
    changed();
    pump();
    return { tasks: made.map(briefTask) };
  },

  patchTask(req, res, m, body) {
    const t = findTask(m[1]);
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    const locked = agentBusy(t);
    if ('title' in body) { const v = text(body.title, 200).trim(); if (v) t.title = v; }
    if ('description' in body) t.description = text(body.description, 20000);
    if ('priority' in body) t.priority = pick(body.priority, PRIORITIES, 'priority');
    if ('budget' in body) t.budget = Math.max(0, Number(body.budget) || 0);
    if ('repeat' in body) t.repeat = REPEATS[body.repeat] ? body.repeat : '';
    if ('after' in body) {
      const first = body.after ? findTask(body.after) : null;
      // Not itself, and not a task that (directly or further on) waits for this one.
      for (let x = first, n = 0; x && n < 100; x = x.after ? findTask(x.after) : null, n++) {
        if (x === t) throw new HttpError(400, 'That would make the two tasks wait for each other.');
      }
      t.after = first ? first.id : '';
    }
    if ('copy' in body && Boolean(body.copy) !== Boolean(t.copy)) {
      if (locked) throw new HttpError(409, 'Stop the agent before changing this.');
      if (t.work) throw new HttpError(409, 'This task already has a separate copy. Remove the copy first.');
      t.copy = Boolean(body.copy);
    }
    for (const k of ['mode', 'model', 'projectId']) {
      if (!(k in body) || body[k] === t[k]) continue;
      if (locked) throw new HttpError(409, 'Stop the agent before changing this.');
      if (t.kind === 'scan' && k !== 'model') throw new HttpError(409, 'A suggestions scan stays read-only and in its own project.');
      if (k === 'mode') t.mode = pick(body.mode, MODES, 'mode');
      if (k === 'model') { t.model = pick(body.model, MODELS, 'model'); delete t.auto; }
      if (k === 'projectId') {
        if (!findProject(body.projectId)) throw new HttpError(400, 'Unknown project.');
        t.projectId = body.projectId;
        t.sessionId = null; // a session belongs to the folder it ran in
      }
    }
    if ('status' in body && body.status !== t.status) {
      const to = pick(body.status, ['todo', 'review', 'done'], 'status');
      if (t.status === 'running' && t.assignee && t.assignee.kind === 'agent') {
        throw new HttpError(409, 'Stop the agent first.');
      }
      moveTask(t, to);
    }
    t.updatedAt = Date.now();
    changed();
    pump();
    return briefTask(t);
  },

  // "Mark all done" on the Needs review column: only tasks that are still
  // waiting for review when the request arrives are touched.
  markDone(req, res, m, body) {
    let done = 0;
    for (const id of Array.isArray(body.ids) ? body.ids : []) {
      const t = findTask(id);
      if (!t || t.status !== 'review') continue;
      moveTask(t, 'done');
      t.updatedAt = Date.now();
      done++;
    }
    changed();
    return { done };
  },

  deleteTask(req, res, m) {
    const t = findTask(m[1]);
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    const st = running.get(t.id);
    if (st) killAgent(st);
    db.tasks = db.tasks.filter((x) => x !== t);
    fs.rm(changesFile(t.id), { force: true }, () => {});
    if (t.work) removeCopy(t, findProject(t.projectId)).catch(() => {});
    changed();
    return { ok: true };
  },

  taskAction(req, res, m, body) {
    const t = findTask(m[1]);
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    const action = m[2];
    const who = text(body.name, 60).trim() || 'A Claude session';

    if (action === 'link' || action === 'unlink') {
      const id = String(body.sessionId || '');
      if (!SESSION_ID.test(id)) throw new HttpError(400, 'That is not a conversation id.');
      if (action === 'link') {
        if (!findSessionFile(id)) throw new HttpError(404, 'That conversation is not saved on this computer.');
        if (linkConversation(t, id)) addLog(t, 'status', 'Conversation linked');
      } else {
        t.conversations = (t.conversations || []).filter((x) => x !== id);
      }
      changed();
      return briefTask(t);
    }
    // A VS Code session that works on a task links its own conversation to it.
    if (['claim', 'note', 'done', 'fail'].includes(action) && body.sessionId) linkConversation(t, String(body.sessionId));

    if (action === 'run') {
      if (t.status === 'queued' && body.force) { t.force = true; changed(); pump(); return briefTask(t); }
      if (t.status === 'running' || t.status === 'queued') throw new HttpError(409, 'This task is already running or queued.');
      if (body.mode && t.kind !== 'scan') t.mode = pick(body.mode, MODES, 'mode');
      // "Carry out this plan" on a task that planned first: your OK to edit.
      if (body.mode === 'edit' && t.phase === 'plan') { delete t.phase; t.planOk = true; }
      const message = text(body.message, 20000).trim();
      if (message) { t.pendingFollowUp = message; addLog(t, 'you', message); } else delete t.pendingFollowUp;
      if (body.force) t.force = true;
      queueTask(t);
      changed();
      pump();
    } else if (action === 'stop') {
      const st = running.get(t.id);
      if (st) killAgent(st);
      else if (t.status === 'queued') {
        // A task that was waiting for a limit reset keeps what it did so far.
        const parked = Boolean(t.limitCut);
        t.status = parked ? 'review' : 'todo';
        if (parked) { t.outcome = 'stopped'; t.finishedAt = Date.now(); addLog(t, 'status', 'You stopped it from continuing after the limit reset.'); } else t.assignee = null;
        t.waitReason = null;
        delete t.pendingFollowUp;
        delete t.force;
        delete t.limitCut;
        changed();
      }
      else throw new HttpError(409, 'No agent is running on this task.');
    } else if (action === 'claim') {
      if (t.status === 'running' || t.status === 'queued') {
        throw new HttpError(409, `${t.id} is already taken by ${t.assignee && t.assignee.kind === 'agent' ? 'a dashboard agent' : (t.assignee && t.assignee.name) || 'someone'}.`);
      }
      if (t.status === 'done') throw new HttpError(409, `${t.id} is already done.`);
      if (t.kind === 'scan') throw new HttpError(409, `${t.id} is a suggestions scan run by the dashboard, not a task to pick up.`);
      t.status = 'running';
      t.outcome = null;
      t.assignee = { kind: 'session', name: who };
      t.startedAt = Date.now();
      t.finishedAt = null;
      addLog(t, 'status', `Picked up by ${who}`);
      changed();
      const proj = findProject(t.projectId);
      if (t.mode === 'edit' && proj) {
        t.changes = null;
        snapshotTree(proj.path).then((tree) => { t.baseTree = tree; save(); }).catch(() => {});
      }
    } else {
      // note / done / fail come from a Claude session working on the task
      const msg = text(body.text, 20000).trim();
      if (!msg) throw new HttpError(400, 'Add some text.');
      if (agentBusy(t)) throw new HttpError(409, `${t.id} is being worked on by a dashboard agent.`);
      if (action === 'note') {
        addLog(t, 'note', msg);
      } else {
        if (!t.assignee) t.assignee = { kind: 'session', name: who };
        const byHand = Boolean(t.ide); // continued in VS Code: record changes whatever the mode
        delete t.ide;
        t.status = 'review';
        t.outcome = action === 'done' ? 'ok' : 'failed';
        t.finishedAt = Date.now();
        t.report = msg;
        addLog(t, action === 'done' ? 'status' : 'error', action === 'done' ? 'Reported as finished. Waiting for your review.' : 'Reported as not finished.');
        infoCache.delete(t.projectId);
        const proj = findProject(t.projectId);
        if ((t.mode === 'edit' || byHand) && proj) saveChanges(t, workDir(t, proj)).then(changed).catch(() => {});
      }
      changed();
    }
    return briefTask(t);
  },

  linkProjects(req, res, m, body) {
    const inputs = Array.isArray(body.paths) ? body.paths : [body.path];
    const added = [];
    const skipped = [];
    for (const input of inputs) {
      const dir = normalizeDir(input);
      if (db.projects.some((p) => p.path === dir)) { skipped.push(dir); continue; }
      const p = { id: `P${db.pseq++}`, name: path.basename(dir), path: dir, status: 'active', notes: '', deadline: '', createdAt: Date.now() };
      db.projects.push(p);
      added.push(p);
    }
    changed();
    return { added, skipped };
  },

  // Makes a new, empty project folder and links it, so a task can start a
  // project from nothing.
  async newProject(req, res, m, body) {
    const name = text(body.name, 80).trim();
    if (!name) throw new HttpError(400, 'Give the new project a name.');
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name) || name.endsWith('.')) {
      throw new HttpError(400, 'Use letters, numbers, spaces, dashes, dots and underscores for the name, and start with a letter or number.');
    }
    const parent = normalizeDir(body.parent || path.dirname(__dirname));
    const dir = path.join(parent, name);
    if (fs.existsSync(dir)) throw new HttpError(409, `"${name}" already exists in that folder. Use "Link project" to add it.`);
    try { fs.mkdirSync(dir); } catch (e) { throw new HttpError(500, `Could not make the folder: ${e.message}`); }
    // A git repository lets the board show what each task changed.
    if (body.git !== false) await sh('git', ['-C', dir, 'init', '-q']);
    const p = { id: `P${db.pseq++}`, name, path: fs.realpathSync(dir), status: 'active', notes: '', deadline: '', createdAt: Date.now() };
    db.projects.push(p);
    changed();
    return p;
  },

  patchProject(req, res, m, body) {
    const p = findProject(m[1]);
    if (!p) throw new HttpError(404, 'That project is no longer linked.');
    if ('name' in body) { const v = text(body.name, 80).trim(); if (v) p.name = v; }
    if ('notes' in body) p.notes = text(body.notes, 5000);
    if ('status' in body) p.status = pick(body.status, PROJECT_STATUSES, 'status');
    if ('tags' in body) p.tags = cleanTags(body.tags, db.projects.filter((x) => x !== p));
    if ('deadline' in body) p.deadline = /^\d{4}-\d{2}-\d{2}$/.test(body.deadline) ? body.deadline : '';
    if ('path' in body) {
      const dir = normalizeDir(body.path);
      if (db.projects.some((x) => x !== p && x.path === dir)) throw new HttpError(409, 'Another project already links to that folder.');
      p.path = dir;
      infoCache.delete(p.id);
    }
    changed();
    return p;
  },

  deleteProject(req, res, m) {
    const p = findProject(m[1]);
    if (!p) throw new HttpError(404, 'That project is no longer linked.');
    for (const t of db.tasks) {
      if (t.projectId !== p.id) continue;
      const st = running.get(t.id);
      if (st) killAgent(st);
    }
    db.tasks = db.tasks.filter((t) => t.projectId !== p.id);
    db.projects = db.projects.filter((x) => x !== p);
    infoCache.delete(p.id);
    changed();
    return { ok: true };
  },

  async openProject(req, res, m, body) {
    const p = findProject(m[1]);
    if (!p) throw new HttpError(404, 'That project is no longer linked.');
    const r = body.app === 'vscode' ? await openInVSCode(p.path) : await openFolder(p.path);
    if (!r.ok) throw new HttpError(500, r.err.trim() || 'Could not open the folder.');
    return { ok: true };
  },

  async pickFolder() {
    let r;
    if (MAC) {
      r = await sh('osascript', [
        '-e', 'tell me to activate',
        '-e', 'POSIX path of (choose folder with prompt "Choose a project folder")',
      ], { timeout: 180000 });
    } else if (WIN) {
      // A hidden always-on-top window owns the dialog, so it opens in front of the browser.
      r = await sh('powershell.exe', ['-NoProfile', '-STA', '-Command', [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = 'Choose a project folder'",
        "if ($d.ShowDialog($o) -eq 'OK') { $d.SelectedPath }",
      ].join('; ')], { timeout: 180000 });
    } else {
      r = await sh('zenity', ['--file-selection', '--directory', '--title=Choose a project folder'], { timeout: 180000 });
    }
    const dir = r.ok ? r.out.trim() : '';
    if (!dir) return { cancelled: true };
    return { path: dir.length > 1 ? dir.replace(/[\\/]$/, '') : dir };
  },

  scan(req, res, m, body) {
    const root = normalizeDir(body.path);
    const linked = new Set(db.projects.map((p) => p.path));
    const found = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const dir = path.join(root, entry.name);
      if (dir === __dirname) continue;
      const type = detectType(dir);
      const isGit = fs.existsSync(path.join(dir, '.git'));
      found.push({ name: entry.name, path: dir, type, isGit, linked: linked.has(dir), likely: type !== 'Folder' || isGit });
    }
    found.sort((a, b) => Number(b.likely) - Number(a.likely) || a.name.localeCompare(b.name));
    return { root, found };
  },

  // A finished task that worked in a separate copy: bring its changes into
  // the project, open a pull request for them, or throw the copy away.
  async copyAction(req, res, m, body) {
    const t = findTask(m[1]);
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    const p = findProject(t.projectId);
    if (!t.work || !p) throw new HttpError(409, 'This task has no separate copy.');
    if (agentBusy(t)) throw new HttpError(409, 'Stop the agent first.');
    const w = t.work;
    const line = (r) => (r.err.trim() || r.out.trim()).split('\n').slice(-2).join(' ');

    if (body.do === 'remove') {
      await removeCopy(t, p);
      addLog(t, 'status', 'Separate copy removed');
      changed();
      return briefTask(t);
    }

    if (body.do === 'apply') {
      const end = await snapshotTree(w.dir);
      if (!t.baseTree || !end) throw new HttpError(500, 'Could not read the changes in the copy.');
      const diff = await git(w.dir, ['diff', '--binary', t.baseTree, end]);
      if (!diff.ok) throw new HttpError(500, `Could not read the changes: ${line(diff)}`);
      if (!diff.out.trim()) throw new HttpError(409, 'The copy has no changes to apply.');
      const file = path.join(os.tmpdir(), `dash-apply-${t.id}-${Date.now()}.patch`);
      fs.writeFileSync(file, diff.out);
      try {
        const check = await git(p.path, ['apply', '--check', file]);
        if (!check.ok) throw new HttpError(409, 'These changes do not fit the project as it is now: the same lines were changed there since the copy was made. Open a pull request instead, or ask the agent to redo it.');
        const done = await git(p.path, ['apply', file]);
        if (!done.ok) throw new HttpError(500, `Could not apply the changes: ${line(done)}`);
      } finally { fs.rm(file, { force: true }, () => {}); }
      w.applied = Date.now();
      addLog(t, 'status', 'Changes applied to the project folder (not committed)');
      infoCache.delete(p.id);
      changed();
      return briefTask(t);
    }

    if (body.do === 'pr') {
      const title = text(body.title, 200).trim() || t.title;
      const remote = await git(w.dir, ['remote', 'get-url', 'origin']);
      if (!remote.ok) throw new HttpError(409, 'This project has no "origin" remote on GitHub, so there is nowhere to open a pull request.');
      await git(w.dir, ['add', '-A']);
      const staged = await git(w.dir, ['diff', '--cached', '--quiet']);
      const ahead = await git(w.dir, ['rev-list', '--count', `${w.base}..HEAD`]);
      if (staged.ok && !(Number(ahead.out) > 0)) throw new HttpError(409, 'The copy has no changes to put in a pull request.');
      if (!staged.ok) {
        // The dashboard commits here, as you, because you pressed the button.
        const commit = await git(w.dir, ['commit', '-m', title]);
        if (!commit.ok) throw new HttpError(500, `Could not commit: ${line(commit)}`);
      }
      const push = await git(w.dir, ['push', '-u', 'origin', w.branch], { timeout: 120000 });
      if (!push.ok) throw new HttpError(500, `Could not push the branch: ${line(push)}`);
      const pr = await sh('gh', ['pr', 'create', '--head', w.branch, '--title', title, '--body', text(body.body, 20000)], { cwd: w.dir, timeout: 60000 });
      if (!pr.ok) throw new HttpError(500, `The branch is pushed, but the pull request was not opened: ${line(pr)}`);
      w.pr = (pr.out.match(/https?:\/\/\S+/) || [''])[0] || 'opened';
      addLog(t, 'status', `Pull request opened: ${w.pr}`);
      changed();
      return briefTask(t);
    }
    throw new HttpError(400, 'Unknown action.');
  },

  // "Continue in VS Code" and "Start in VS Code" on a task.
  async openInVSCode(req, res, m, body) {
    const t = findTask(m[1]);
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    const p = findProject(t.projectId);
    if (!p || !fs.existsSync(p.path)) throw new HttpError(409, 'The project folder was not found. Check the project link.');
    if (t.kind === 'scan') throw new HttpError(409, 'A suggestions scan is run by the dashboard, not in VS Code.');
    if (agentBusy(t)) throw new HttpError(409, 'Stop the agent first.');
    const mine = t.status === 'running' && t.ide;

    if (body.how === 'continue') {
      // The agent's own conversation, else the newest one linked to the task.
      const saved = (id) => fs.existsSync(path.join(sessionDir(workDir(t, p)), `${id}.jsonl`));
      const sid = [t.sessionId, ...(t.conversations || []).slice().reverse()].find((id) => id && saved(id));
      if (!sid) throw new HttpError(409, 'This task has no conversation saved on this computer any more. Use "Start in VS Code" instead.');
      const up = await openClaudeInVSCode(workDir(t, p), { session: sid });
      if (!mine && !agentBusy(t)) {
        // While you work on it by hand, the dashboard must not run its own
        // agent on the same conversation. Showing it as yours sees to that.
        t.status = 'running';
        t.outcome = null;
        t.assignee = { kind: 'session', name: 'You, in VS Code' };
        t.ide = { at: Date.now(), sessionId: sid };
        t.startedAt = Date.now();
        t.finishedAt = null;
        t.waitReason = null;
        addLog(t, 'status', 'Continued by you in VS Code');
        // Remember how the files look now, so the task can show what changed.
        if (!t.baseTree) snapshotTree(workDir(t, p)).then((tree) => { t.baseTree = tree; save(); }).catch(() => {});
        changed();
      }
      return { ok: true, sure: up, message: up
        ? 'Opened this conversation in VS Code. If VS Code asks whether to open the link, press Open. The task stays In progress until you press "Finished in VS Code".'
        : 'VS Code is slow to open this folder. If no Claude chat showed up, answer any question VS Code asks about trusting the folder, then press the button again.' };
    }

    const up = await openClaudeInVSCode(p.path, { prompt: handoverPrompt(t) });
    addLog(t, 'status', 'Opened in VS Code to start by hand');
    changed();
    return { ok: true, sure: up, message: up
      ? 'VS Code is open with the task in the Claude message box: press Enter there to start it. If VS Code asks whether to open the link, press Open.'
      : 'VS Code is slow to open this folder. If no Claude chat showed up, answer any question VS Code asks about trusting the folder, then press the button again.' };
  },

  // "Check now" in the Usage dialog.
  async checkLimits() {
    const got = await refreshLimits();
    if (!got) throw new HttpError(502, 'Could not read your plan limits just now. Try again in a minute.');
    return usage();
  },

  // "Plan a run": queues every To do task of the chosen projects, to run
  // one project after another in the order given.
  runProjects(req, res, m, body) {
    const ids = [...new Set(Array.isArray(body.projectIds) ? body.projectIds.map(String) : [])].filter(findProject);
    if (!ids.length) throw new HttpError(400, 'Choose at least one project.');
    db.runOrder = ids;
    focusProject = null; // your order counts from here on
    db.settings.queueOrder = 'project';
    let queued = 0;
    for (const t of db.tasks) {
      if (t.status !== 'todo' || !ids.includes(t.projectId)) continue;
      delete t.pendingFollowUp;
      queueTask(t);
      queued += 1;
    }
    changed();
    pump();
    return { queued };
  },

  patchSettings(req, res, m, body) {
    if ('maxAgents' in body) db.settings.maxAgents = Math.min(16, Math.max(1, Math.round(Number(body.maxAgents)) || 1));
    if ('defaultModel' in body) db.settings.defaultModel = pick(body.defaultModel, MODELS, 'model');
    if ('autoMax' in body) db.settings.autoMax = pick(body.autoMax, TIER_KEYS, 'level');
    if ('usageMode' in body) db.settings.usageMode = pick(body.usageMode, USAGE_MODES, 'usage mode');
    if ('queueOrder' in body) db.settings.queueOrder = pick(body.queueOrder, QUEUE_ORDERS, 'queue order');
    if ('autoSaver' in body) db.settings.autoSaver = Math.min(100, Math.max(0, Math.round(Number(body.autoSaver) || 0)));
    if ('notify' in body) db.settings.notify = Boolean(body.notify);
    if ('ntfyTopic' in body) db.settings.ntfyTopic = text(body.ntfyTopic, 80).trim().replace(/[^A-Za-z0-9_-]/g, '');
    if ('claudePath' in body) db.settings.claudePath = text(body.claudePath, 500).trim();
    const money = (v) => Math.min(100000, Math.max(0, Math.round((Number(v) || 0) * 100) / 100));
    if ('taskBudget' in body) db.settings.taskBudget = money(body.taskBudget);
    if ('dailyBudget' in body) db.settings.dailyBudget = money(body.dailyBudget);
    if ('holdPercent' in body) db.settings.holdPercent = Math.min(100, Math.max(0, Math.round(Number(body.holdPercent) || 0)));
    changed();
    pump();
    return db.settings;
  },
};

const routes = [
  ['GET', /^\/api\/state$/, api.getState],
  ['GET', /^\/api\/tasks\/(T\d+)$/, api.getTask],
  ['GET', /^\/api\/tasks\/(T\d+)\/changes$/, api.getChanges],
  ['POST', /^\/api\/tasks$/, api.createTask],
  ['PATCH', /^\/api\/tasks\/(T\d+)$/, api.patchTask],
  ['DELETE', /^\/api\/tasks\/(T\d+)$/, api.deleteTask],
  ['POST', /^\/api\/tasks\/(T\d+)\/(run|stop|claim|note|done|fail|link|unlink)$/, api.taskAction],
  ['POST', /^\/api\/tasks\/(T\d+)\/adopt$/, api.adopt],
  ['POST', /^\/api\/tasks\/(T\d+)\/vscode$/, api.openInVSCode],
  ['POST', /^\/api\/tasks\/(T\d+)\/copy$/, api.copyAction],
  ['POST', /^\/api\/suggest$/, api.suggest],
  ['POST', /^\/api\/limits\/check$/, api.checkLimits],
  ['GET', /^\/api\/projects\/(P\d+)\/conversations$/, api.listConversations],
  ['GET', /^\/api\/conversations\/([0-9a-f-]{36})$/, api.getConversation],
  ['POST', /^\/api\/projects$/, api.linkProjects],
  ['POST', /^\/api\/projects\/new$/, api.newProject],
  ['POST', /^\/api\/tasks\/mark-done$/, api.markDone],
  ['PATCH', /^\/api\/projects\/(P\d+)$/, api.patchProject],
  ['DELETE', /^\/api\/projects\/(P\d+)$/, api.deleteProject],
  ['POST', /^\/api\/projects\/(P\d+)\/open$/, api.openProject],
  ['POST', /^\/api\/pick-folder$/, api.pickFolder],
  ['POST', /^\/api\/scan$/, api.scan],
  ['POST', /^\/api\/run-projects$/, api.runProjects],
  ['PATCH', /^\/api\/settings$/, api.patchSettings],
];

// ---------------------------------------------------------------- http

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// This server can start agents that edit files, so only this machine's own
// dashboard page (or a local command-line tool) may talk to it.
function trusted(req) {
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (req.method !== 'GET' && !/^application\/json/i.test(req.headers['content-type'] || '')) return false;
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new HttpError(413, 'Too much data.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new HttpError(400, 'Bad JSON.')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (!trusted(req)) return send(res, 403, { error: 'Request refused.' });
  try {
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      for (const [method, re, fn] of routes) {
        const m = req.method === method && url.pathname.match(re);
        if (!m) continue;
        const body = method === 'GET' ? {} : await readBody(req);
        return send(res, 200, await fn(req, res, m, body, url));
      }
      throw new HttpError(404, 'Unknown request.');
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Not allowed.');
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'Something went wrong.' });
  }
});

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();
// Paused tasks start by themselves once a limit resets or a new day begins.
setInterval(pump, 60000).unref();

// A repeating task runs again a day or a week after it last finished: a scan
// simply looks again, any other task gets a fresh copy of itself.
function runRepeats() {
  const now = Date.now();
  let any = false;
  for (const t of [...db.tasks]) {
    const every = REPEATS[t.repeat];
    const last = t.finishedAt || t.doneAt;
    if (!every || !last || (t.status !== 'review' && t.status !== 'done') || now < last + every) continue;
    any = true;
    if (t.kind === 'scan') {
      addLog(t, 'status', 'Looking again (repeats)');
      queueTask(t);
      continue;
    }
    const n = newTask({ projectId: t.projectId, title: t.title, description: t.description, mode: t.mode, model: t.model, priority: t.priority, budget: t.budget });
    n.repeat = t.repeat;
    n.copy = t.copy;
    addLog(n, 'status', `Repeat of ${t.id}`);
    db.tasks.push(n);
    queueTask(n);
    t.repeat = '';
    addLog(t, 'status', `Repeated as ${n.id}`);
  }
  if (any) { changed(); pump(); }
}
setInterval(runRepeats, 60000).unref();

function shutdown() {
  for (const st of running.values()) killAgent(st);
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Pacer is probably already running: http://localhost:${PORT}`);
    if (process.argv.includes('--open')) openLink(`http://localhost:${PORT}`).then(() => process.exit(0));
    else process.exit(0);
    return;
  }
  throw e;
});

load();
server.listen(PORT, HOST, () => {
  console.log(`Pacer is running: http://localhost:${PORT}`);
  if (process.argv.includes('--open')) openLink(`http://localhost:${PORT}`);
  console.log(`Data: ${DB_FILE}`);
  console.log(findClaude() ? `Agents use: ${findClaude()}` : 'Warning: the claude program was not found. Set its path in Settings.');
});
