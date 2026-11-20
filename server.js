#!/usr/bin/env node
'use strict';
/*
 * Project Dashboard: a local task board that can start Claude agents in your
 * project folders and show their progress. No dependencies.
 *
 *   node server.js        then open http://localhost:4577
 *
 * It listens on 127.0.0.1 only. Data lives in ./data/db.json.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

const PORT = Number(process.env.DASH_PORT) || 4577;
const HOST = '127.0.0.1';
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
const API_VERSION = 4;

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
  settings: { maxAgents: 2, defaultModel: '', claudePath: '', taskBudget: 0, dailyBudget: 0, holdPercent: 90, autoMax: 'max' },
  projects: [],
  tasks: [],
  spend: [],     // one entry per agent run: { at, taskId, projectId, cost, model }
  limits: null,  // last Claude plan limits an agent reported
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
    } else if (t.status === 'queued') {
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
    execFile(cmd, args, { timeout: 5000, maxBuffer: 4e6, ...opts }, (err, stdout, stderr) => {
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
  return { totals, byProject, days, limits: db.limits, hold: holdReason() };
}

function recordSpend(t, result) {
  const cost = Number(result.total_cost_usd) || 0;
  t.cost = (t.cost || 0) + cost;
  db.spend.push({ at: Date.now(), taskId: t.id, projectId: t.projectId, cost, model: (t.assignee && t.assignee.name) || '' });
}

function recordLimits(ev) {
  const windows = ev.rate_limit_info && ev.rate_limit_info.unifiedWindows;
  if (!windows) return;
  const out = {};
  for (const key of ['five_hour', 'seven_day']) {
    const w = windows[key];
    if (w && typeof w.utilization === 'number') out[key] = { utilization: w.utilization, resetsAt: Number(w.resetsAt) * 1000 };
  }
  if (Object.keys(out).length) db.limits = { at: Date.now(), windows: out };
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
    if (!file) return { id, kind, missing: true, title: 'Conversation no longer saved on this Mac' };
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
const VSCODE = ['-a', 'Visual Studio Code'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function vscodeHasFolder(dir) {
  let names = [];
  try { names = fs.readdirSync(IDE_LOCKS); } catch { return false; }
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(IDE_LOCKS, name), 'utf8'));
      if (lock.ideName && !/visual studio code/i.test(lock.ideName)) continue;
      if (!(lock.workspaceFolders || []).some((f) => fs.realpathSync(f) === dir)) continue;
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
  const first = await sh('open', [...VSCODE, dir]);
  if (!first.ok) throw new HttpError(500, 'Could not open VS Code. Is it installed in Applications?');
  const until = Date.now() + 25000;
  let up = vscodeHasFolder(dir);
  while (!up && Date.now() < until) {
    await sleep(500);
    up = vscodeHasFolder(dir);
  }
  await sh('open', [...VSCODE, dir]);
  await sleep(700);
  const link = `vscode://anthropic.claude-code/open?${new URLSearchParams(query)}`;
  const sent = await sh('open', [...VSCODE, link]);
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
      child = execFile(bin, args, { cwd: os.tmpdir(), env: agentEnv(), timeout: 40000, maxBuffer: 4e6 }, (err, stdout) => {
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
  const top = TIER_KEYS.indexOf(db.settings.autoMax);
  return TIERS[Math.min(i, top < 0 ? TIERS.length - 1 : top)];
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
  t.auto = { tier: tier.key, model: tier.model, why, at: Date.now() };
  addLog(t, 'status', `Auto picked ${tier.label} (${tier.model}): ${why}.${tier.key !== found.tier ? ` Settings limit Auto to ${tier.label}.` : ''}`);
  changed();
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
      child = execFile(bin, args, { cwd: os.tmpdir(), env: agentEnv(), timeout: 40000, maxBuffer: 4e6 }, (err, stdout) => {
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
    if (got) { changed(); pump(); }
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
  for (const d of (process.env.PATH || '').split(':')) if (d) cands.push(path.join(d, 'claude'));
  cands.push(
    path.join(home, '.claude/local/claude'),
    path.join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  );
  // The VS Code extension ships the same program. Newest version first.
  const ext = path.join(home, '.vscode/extensions');
  try {
    const dirs = fs.readdirSync(ext)
      .filter((n) => n.startsWith('anthropic.claude-code-'))
      .sort((a, b) => versionKey(b) - versionKey(a));
    for (const d of dirs) cands.push(path.join(ext, d, 'resources/native-binary/claude'));
  } catch { /* no VS Code */ }
  for (const c of cands) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch { /* keep looking */ }
  }
  return null;
}

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
  if (t.mode === 'plan') {
    lines.push('This is a PLAN-ONLY task: do not change, create or delete any files. Read the code, then give your findings and a step-by-step plan as your final message.');
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
  t.status = 'review';
  t.outcome = outcome;
  t.finishedAt = Date.now();
  t.waitReason = null;
  if (message) addLog(t, outcome === 'ok' ? 'status' : 'error', message);
  infoCache.delete(t.projectId);
  changed();
  pump();
}

function startAgent(t) {
  const p = findProject(t.projectId);
  const followUp = t.pendingFollowUp;
  delete t.pendingFollowUp;
  delete t.force;
  t.assignee = { kind: 'agent', name: t.model || db.settings.defaultModel || 'default model' };
  t.startedAt = Date.now();
  t.finishedAt = null;
  t.waitReason = null;
  t.outcome = null;
  if (!p || !fs.existsSync(p.path)) return finish(t, 'failed', 'The project folder was not found. Check the project link.');
  const bin = findClaude();
  if (!bin) return finish(t, 'failed', 'Could not find the claude program. Set its path in Settings.');

  const resume = Boolean(followUp && t.sessionId);
  const st = { child: null, stopped: false, result: null, plan: null, stderr: '', done: false };
  running.set(t.id, st);
  t.status = 'running';
  t.runs = (t.runs || 0) + 1;
  t.steps = 0;
  if (!resume) { t.sessionId = null; t.report = ''; }
  addLog(t, 'status', `${resume ? 'Agent resumed' : 'Agent started'} (${t.mode === 'edit' ? 'can edit files' : 'plan only'})`);
  changed();

  // Before an editing run, remember how the files look, so the task can show
  // exactly what changed. A follow-up keeps the first starting point.
  let ready = Promise.resolve();
  if (t.mode === 'edit' && !(resume && t.baseTree)) {
    t.changes = null;
    ready = snapshotTree(p.path).then((tree) => { t.baseTree = tree; }).catch(() => { t.baseTree = null; });
  }
  // "Auto" first finds out what kind of task this is. A follow-up stays on
  // the model the first run was given.
  if ((t.model || db.settings.defaultModel) !== 'auto') delete t.auto;
  else if (!(resume && t.auto)) ready = Promise.all([ready, chooseModel(t, p, bin)]);
  ready.then(() => {
    if (st.stopped) { st.done = true; return finish(t, 'stopped', 'Stopped by you.'); }
    launchAgent(t, p, st, bin, resume, followUp);
  });
}

function launchAgent(t, p, st, bin, resume, followUp) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', t.mode === 'edit' ? 'auto' : 'plan',
    '--append-system-prompt', systemPrompt(t),
  ];
  const wanted = t.model || db.settings.defaultModel;
  const model = wanted === 'auto' ? (t.auto && t.auto.model) : wanted;
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', t.sessionId);
  if (t.kind === 'scan') {
    // The answer has to come back as data the board can turn into tasks.
    args.push('--json-schema', JSON.stringify(SCAN_SCHEMA));
    const outside = t.scan && t.scan.notes === false ? [] : findNotes(p.path).outside;
    if (outside.length) args.push('--add-dir', ...outside);
  }
  const budget = Number(t.budget) > 0 ? Number(t.budget) : db.settings.taskBudget;
  if (budget > 0) args.push('--max-budget-usd', String(budget));
  // Three layers keep agents from committing or pushing: a check that runs
  // before every shell command, git hooks that refuse inside git itself, and
  // the plain deny rules.
  args.push('--settings', JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${process.execPath}" "${GUARD}"` }] }] },
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
    child = spawn(bin, args, { cwd: p.path, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
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
      onEvent(t, st, ev, p.path);
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
    if (t.mode === 'edit' && !spawnError) await saveChanges(t, p.path).catch(() => {});
    if (st.stopped) return finish(t, 'stopped', 'Stopped by you.');
    if (spawnError) return finish(t, 'failed', `Could not start the agent: ${spawnError.message}`);
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
      return finish(t, 'failed', `The agent stopped with an error (${r.subtype || 'unknown'}).`);
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
    finish(t, 'ok', 'Agent finished. Waiting for your review.');
  };
  child.on('error', (e) => end(null, e));
  child.on('close', (code) => end(code));
}

function onEvent(t, st, ev, cwd) {
  if (ev.type === 'rate_limit_event') {
    recordLimits(ev);
  } else if (ev.type === 'system' && ev.subtype === 'init') {
    t.sessionId = ev.session_id || t.sessionId;
    if (ev.model) t.assignee = { kind: 'agent', name: ev.model };
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
  const signal = (sig) => {
    try { process.kill(-pid, sig); } catch { try { st.child.kill(sig); } catch { /* gone */ } }
  };
  signal('SIGTERM');
  setTimeout(() => { if (!st.done) signal('SIGKILL'); }, 4000).unref();
}

function setWait(t, reason) {
  if (t.waitReason !== reason) { t.waitReason = reason; changed(); }
}

function pump() {
  const rank = (t) => PRIORITIES.indexOf(t.priority);
  const queued = db.tasks
    .filter((t) => t.status === 'queued')
    .sort((a, b) => rank(b) - rank(a) || a.queuedAt - b.queuedAt);
  const hold = queued.length ? holdReason() : null;
  // A plan limit can be reset before the time it gave. While tasks wait on
  // one, look again every few minutes.
  if (queued.length && planLimitHold() && Date.now() - limitCheckedAt > LIMIT_RECHECK_MS) refreshLimits();
  for (const t of queued) {
    if (hold && !t.force) { setWait(t, hold); continue; }
    if (running.size >= db.settings.maxAgents) { setWait(t, 'Waiting for a free agent slot'); continue; }
    const clash = t.mode === 'edit' && [...running.keys()].some((id) => {
      const other = findTask(id);
      return other && other.projectId === t.projectId && other.mode === 'edit';
    });
    if (clash) { setWait(t, 'Waiting: another agent is editing this project'); continue; }
    startAgent(t);
  }
}

// ---------------------------------------------------------------- api

function pick(value, allowed, what) {
  if (!allowed.includes(value)) throw new HttpError(400, `Unknown ${what}: ${value}`);
  return value;
}
const text = (v, max) => String(v == null ? '' : v).slice(0, max);
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

function queueTask(t) {
  delete t.ide;
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
      meta: { version: API_VERSION, claude: findClaude(), running: running.size, suggestRoot: path.dirname(__dirname), home: os.homedir(),
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
    if (!file) throw new HttpError(404, 'That conversation is no longer saved on this Mac.');
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
      if (to === 'todo') { t.assignee = null; t.outcome = null; delete t.force; }
      if (to === 'done') t.doneAt = Date.now();
      if (to === 'review') t.finishedAt = Date.now();
      // Work done by hand in VS Code ends here: record what it changed.
      if (t.ide) {
        delete t.ide;
        const proj = findProject(t.projectId);
        if (to !== 'todo' && proj) saveChanges(t, proj.path).then(changed).catch(() => {});
        if (to === 'review') t.outcome = 'ok';
      }
      t.waitReason = null;
      delete t.pendingFollowUp;
      addLog(t, 'status', { todo: 'Moved back to To do', review: 'Moved to Needs review', done: 'Marked done' }[to]);
      t.status = to;
    }
    t.updatedAt = Date.now();
    changed();
    pump();
    return briefTask(t);
  },

  deleteTask(req, res, m) {
    const t = findTask(m[1]);
    if (!t) throw new HttpError(404, 'That task no longer exists.');
    const st = running.get(t.id);
    if (st) killAgent(st);
    db.tasks = db.tasks.filter((x) => x !== t);
    fs.rm(changesFile(t.id), { force: true }, () => {});
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
        if (!findSessionFile(id)) throw new HttpError(404, 'That conversation is not saved on this Mac.');
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
      const message = text(body.message, 20000).trim();
      if (message) { t.pendingFollowUp = message; addLog(t, 'you', message); } else delete t.pendingFollowUp;
      if (body.force) t.force = true;
      queueTask(t);
      changed();
      pump();
    } else if (action === 'stop') {
      const st = running.get(t.id);
      if (st) killAgent(st);
      else if (t.status === 'queued') { t.status = 'todo'; t.assignee = null; t.waitReason = null; delete t.pendingFollowUp; delete t.force; changed(); }
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
        if ((t.mode === 'edit' || byHand) && proj) saveChanges(t, proj.path).then(changed).catch(() => {});
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

  patchProject(req, res, m, body) {
    const p = findProject(m[1]);
    if (!p) throw new HttpError(404, 'That project is no longer linked.');
    if ('name' in body) { const v = text(body.name, 80).trim(); if (v) p.name = v; }
    if ('notes' in body) p.notes = text(body.notes, 5000);
    if ('status' in body) p.status = pick(body.status, PROJECT_STATUSES, 'status');
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
    const args = body.app === 'vscode' ? ['-a', 'Visual Studio Code', p.path] : [p.path];
    const r = await sh('open', args);
    if (!r.ok) throw new HttpError(500, r.err.trim() || 'Could not open the folder.');
    return { ok: true };
  },

  async pickFolder() {
    const r = await sh('osascript', [
      '-e', 'tell me to activate',
      '-e', 'POSIX path of (choose folder with prompt "Choose a project folder")',
    ], { timeout: 180000 });
    if (!r.ok) return { cancelled: true };
    return { path: r.out.trim().replace(/\/$/, '') };
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
      const saved = (id) => fs.existsSync(path.join(sessionDir(p.path), `${id}.jsonl`));
      const sid = [t.sessionId, ...(t.conversations || []).slice().reverse()].find((id) => id && saved(id));
      if (!sid) throw new HttpError(409, 'This task has no conversation saved on this Mac any more. Use "Start in VS Code" instead.');
      const up = await openClaudeInVSCode(p.path, { session: sid });
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
        if (!t.baseTree) snapshotTree(p.path).then((tree) => { t.baseTree = tree; save(); }).catch(() => {});
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

  patchSettings(req, res, m, body) {
    if ('maxAgents' in body) db.settings.maxAgents = Math.min(16, Math.max(1, Math.round(Number(body.maxAgents)) || 1));
    if ('defaultModel' in body) db.settings.defaultModel = pick(body.defaultModel, MODELS, 'model');
    if ('autoMax' in body) db.settings.autoMax = pick(body.autoMax, TIER_KEYS, 'level');
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
  ['POST', /^\/api\/suggest$/, api.suggest],
  ['POST', /^\/api\/limits\/check$/, api.checkLimits],
  ['GET', /^\/api\/projects\/(P\d+)\/conversations$/, api.listConversations],
  ['GET', /^\/api\/conversations\/([0-9a-f-]{36})$/, api.getConversation],
  ['POST', /^\/api\/projects$/, api.linkProjects],
  ['PATCH', /^\/api\/projects\/(P\d+)$/, api.patchProject],
  ['DELETE', /^\/api\/projects\/(P\d+)$/, api.deleteProject],
  ['POST', /^\/api\/projects\/(P\d+)\/open$/, api.openProject],
  ['POST', /^\/api\/pick-folder$/, api.pickFolder],
  ['POST', /^\/api\/scan$/, api.scan],
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
    console.error(`Port ${PORT} is already in use. The dashboard is probably already running: http://localhost:${PORT}`);
    process.exit(0);
  }
  throw e;
});

load();
server.listen(PORT, HOST, () => {
  console.log(`Project Dashboard is running: http://localhost:${PORT}`);
  console.log(`Data: ${DB_FILE}`);
  console.log(findClaude() ? `Agents use: ${findClaude()}` : 'Warning: the claude program was not found. Set its path in Settings.');
});
