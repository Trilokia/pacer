#!/usr/bin/env node
'use strict';
/*
 * Command-line helper for Claude sessions (and you) to use the dashboard's
 * task board from inside a project folder.
 *
 *   node dash.js list            open tasks for the project you are in
 *   node dash.js list --all      open tasks for every project
 *   node dash.js show T12        full task text, report and recent activity
 *   node dash.js claim T12       take a task (moves it to In progress)
 *   node dash.js note T12 "..."  post a progress note
 *   node dash.js done T12 "..."  finish with a short report (moves to Needs review)
 *   node dash.js fail T12 "..."  give up with a reason (moves to Needs review)
 *   node dash.js add "Title" [-d "details"] [--mode plan|edit] [--project Name]
 *
 * Options: --as "Name" sets who you are (default "VS Code session" or $DASH_NAME).
 */
const PORT = Number(process.env.DASH_PORT) || 4577;
const BASE = `http://127.0.0.1:${PORT}`;

async function call(method, url, body) {
  let res;
  try {
    res = await fetch(BASE + url, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  } catch {
    fail(`The dashboard is not running. Start it with: node "${__dirname}/server.js"`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error || `Request failed (${res.status})`);
  return data;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parse(argv) {
  const pos = [];
  const opt = {};
  const names = { '-d': 'desc', '--desc': 'desc', '--mode': 'mode', '--project': 'project', '--as': 'as' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opt.all = true;
    else if (names[a]) opt[names[a]] = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}

const taskId = (s) => {
  const m = String(s || '').match(/^[Tt]?(\d+)$/);
  if (!m) fail('Give a task id, for example T12.');
  return `T${m[1]}`;
};

function projectForCwd(projects) {
  const cwd = process.cwd();
  return projects
    .filter((p) => cwd === p.path || cwd.startsWith(p.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

const who = (opt) => opt.as || process.env.DASH_NAME || 'VS Code session';
const when = (ts) => new Date(ts).toLocaleString('en-IN', { hour12: false });

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(require('node:fs').readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(3).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    return;
  }

  if (cmd === 'list') {
    const state = await call('GET', '/api/state');
    const here = projectForCwd(state.projects);
    if (!opt.all && !here) fail('This folder is not a linked project. Use "list --all", or link the folder in the dashboard.');
    const names = Object.fromEntries(state.projects.map((p) => [p.id, p.name]));
    const tasks = state.tasks.filter((t) => t.status !== 'done' && (opt.all || t.projectId === here.id));
    console.log(opt.all ? 'Open tasks in all projects:' : `Open tasks for ${here.name}:`);
    if (!tasks.length) console.log('  (none)');
    for (const t of tasks) {
      const taken = t.assignee ? `  (${t.assignee.kind === 'agent' ? 'dashboard agent' : t.assignee.name})` : '';
      const proj = opt.all ? `  [${names[t.projectId]}]` : '';
      console.log(`  ${t.id.padEnd(5)} ${t.status.padEnd(8)} ${t.mode.padEnd(4)} ${t.priority === 'high' ? 'HIGH ' : ''}${t.title}${proj}${taken}`);
    }
    console.log('\nTake one with: claim <id>. Only "todo" and "review" tasks can be claimed.');
    return;
  }

  if (cmd === 'show') {
    const t = await call('GET', `/api/tasks/${taskId(pos[0])}`);
    console.log(`${t.id}  ${t.title}`);
    console.log(`Status: ${t.status}${t.outcome ? ` (${t.outcome})` : ''}   Mode: ${t.mode === 'edit' ? 'edit files' : 'plan only, do not change files'}   Priority: ${t.priority}`);
    if (t.assignee) console.log(`Assigned to: ${t.assignee.kind === 'agent' ? 'dashboard agent' : t.assignee.name}`);
    console.log(`\n${t.description || '(no description)'}`);
    if (t.report) console.log(`\n--- Last report ---\n${t.report}`);
    const recent = (t.log || []).slice(-12);
    if (recent.length) {
      console.log('\n--- Recent activity ---');
      for (const e of recent) console.log(`${when(e.t)}  [${e.kind}] ${e.text.split('\n')[0].slice(0, 200)}`);
    }
    return;
  }

  if (cmd === 'add') {
    const state = await call('GET', '/api/state');
    const project = opt.project
      ? state.projects.find((p) => p.name.toLowerCase() === opt.project.toLowerCase() || p.id === opt.project)
      : projectForCwd(state.projects);
    if (!project) fail('Could not tell which project this is for. Use --project "Name".');
    if (!pos[0]) fail('Give the task a title.');
    const t = await call('POST', '/api/tasks', { projectId: project.id, title: pos[0], description: opt.desc || '', mode: opt.mode || 'plan', by: who(opt) });
    console.log(`Added ${t.id} to ${project.name}: ${t.title}`);
    return;
  }

  if (cmd === 'claim') {
    const t = await call('POST', `/api/tasks/${taskId(pos[0])}/claim`, { name: who(opt) });
    console.log(`${t.id} is now yours: ${t.title}`);
    console.log(`Mode: ${t.mode === 'edit' ? 'edit files' : 'PLAN ONLY, do not change files'}`);
    console.log(`Read it with: show ${t.id}. Post progress with: note ${t.id} "...". Finish with: done ${t.id} "short report".`);
    return;
  }

  if (cmd === 'note' || cmd === 'done' || cmd === 'fail') {
    const id = taskId(pos[0]);
    const body = pos.slice(1).join(' ').trim();
    if (!body) fail(`Add the text, for example: ${cmd} ${id} "what happened"`);
    const t = await call('POST', `/api/tasks/${id}/${cmd}`, { text: body, name: who(opt) });
    console.log({ note: `Note added to ${t.id}.`, done: `${t.id} moved to Needs review.`, fail: `${t.id} moved to Needs review as not finished.` }[cmd]);
    return;
  }

  fail(`Unknown command "${cmd}". Try: help`);
}

main();
