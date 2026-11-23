'use strict';
// Starts Pacer on a spare port with a throwaway data folder. No real agent is
// ever started: Settings point at test/fake-claude.js, which only pretends.
// These tests run on macOS, Windows and Linux (see .github/workflows).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 45000 + Math.floor(Math.random() * 5000);
const HOST = `127.0.0.1:${PORT}`;
const WIN = process.platform === 'win32';
const FAKE = path.join(__dirname, 'fake-claude.js');
let tmp;
let server;
let pidFile;
let onPath; // where the server should find claude on PATH

function request(method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: pathname,
      headers: { Host: HOST, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-test-'));
  fs.mkdirSync(path.join(tmp, 'WeatherApp'));
  pidFile = path.join(tmp, 'pids.txt');
  // A claude for the server to find on PATH: on Windows the claude.cmd that
  // npm makes (Pacer runs the package's cli.js instead), elsewhere a plain file.
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  if (WIN) {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\n');
    const pkg = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    onPath = path.join(pkg, 'cli.js');
    fs.copyFileSync(FAKE, onPath);
  } else {
    onPath = path.join(bin, 'claude');
    fs.writeFileSync(onPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const PATH = [bin, WIN ? process.env.PATH : '/usr/bin:/bin'].join(path.delimiter);
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, DASH_PORT: String(PORT), DASH_DATA: path.join(tmp, 'data'), PATH, Path: PATH, PACER_TEST_PIDS: pidFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${out}`)), 10000);
    server.stdout.on('data', (c) => {
      out += c;
      if (out.includes('is running')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (c) => { out += c; });
    server.on('exit', (code) => reject(new Error(`Server exited (${code}):\n${out}`)));
  });
  const r = await request('PATCH', '/api/settings', { body: { claudePath: FAKE, notify: false } });
  assert.equal(r.status, 200, r.text);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, check, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(150);
  }
}
const getTask = async (id) => (await request('GET', `/api/tasks/${id}`)).json;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

after(() => {
  if (server) server.kill();
  if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may still hold a file */ }
});

test('finds claude on PATH when no path is set', async () => {
  await request('PATCH', '/api/settings', { body: { claudePath: '' } });
  const state = await request('GET', '/api/state');
  assert.equal(state.json.meta.claude, onPath);
  assert.equal(state.json.meta.platform, process.platform);
  await request('PATCH', '/api/settings', { body: { claudePath: FAKE } });
});

test('serves the page', async () => {
  const r = await request('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Pacer<\/title>/);
});

test('does not serve files outside public/', async () => {
  const r = await request('GET', '/..%2Fserver.js');
  assert.equal(r.status, 404);
});

test('refuses a request from another website', async () => {
  const r = await request('POST', '/api/projects', {
    body: { path: path.join(tmp, 'WeatherApp') },
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(r.status, 403);
});

test('refuses a cross-site request even without an Origin header', async () => {
  const r = await request('GET', '/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
});

test('refuses a wrong Host header (DNS rebinding)', async () => {
  const r = await request('GET', '/api/state', { headers: { Host: `evil.example:${PORT}` } });
  assert.equal(r.status, 403);
});

test('refuses a form post that is not JSON', async () => {
  const r = await request('POST', '/api/projects', { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 403);
});

test('links a project and stores a plan-only task', async () => {
  const dir = path.join(tmp, 'WeatherApp');
  const link = await request('POST', '/api/projects', { body: { path: dir } });
  assert.equal(link.status, 200, link.text);
  const project = link.json.added[0];
  assert.equal(project.name, 'WeatherApp');

  const made = await request('POST', '/api/tasks', { body: { projectId: project.id, title: 'Fix the settings crash' } });
  assert.equal(made.status, 200, made.text);
  assert.match(made.json.id, /^T\d+$/);

  const state = await request('GET', '/api/state');
  assert.equal(state.status, 200);
  const task = state.json.tasks.find((t) => t.id === made.json.id);
  assert.ok(task, 'the new task is in the state');
  assert.equal(task.mode, 'plan');
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'db.json')), 'data is saved to disk');
});

test('runs an agent and shows its result for review', async () => {
  const state = await request('GET', '/api/state');
  const project = state.json.projects.find((p) => p.name === 'WeatherApp');
  const made = await request('POST', '/api/tasks', { body: { projectId: project.id, title: 'Quick check' } });
  const run = await request('POST', `/api/tasks/${made.json.id}/run`, { body: {} });
  assert.equal(run.status, 200, run.text);
  const t = await waitFor('the task to finish', async () => {
    const x = await getTask(made.json.id);
    return x && x.status === 'review' && x;
  });
  assert.equal(t.outcome, 'ok', JSON.stringify(t.log || t));
});

test('Stop ends the agent and everything it started', async () => {
  const state = await request('GET', '/api/state');
  const project = state.json.projects.find((p) => p.name === 'WeatherApp');
  const made = await request('POST', '/api/tasks', { body: { projectId: project.id, title: 'KEEP RUNNING until stopped' } });
  await request('POST', `/api/tasks/${made.json.id}/run`, { body: {} });
  const pids = await waitFor('the agent to start', () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().split(' ').map(Number));
  assert.equal(pids.length, 2);
  assert.ok(pids.every(alive), 'the agent and its child are running');
  assert.equal((await getTask(made.json.id)).status, 'running');

  const stop = await request('POST', `/api/tasks/${made.json.id}/stop`, { body: {} });
  assert.equal(stop.status, 200, stop.text);
  const t = await waitFor('the task to stop', async () => {
    const x = await getTask(made.json.id);
    return x && x.status === 'review' && x;
  });
  assert.equal(t.outcome, 'stopped');
  await waitFor('both processes to end', () => !pids.some(alive), 10000);
});

test('a task needs a title and a project', async () => {
  const r = await request('POST', '/api/tasks', { body: { title: 'No project' } });
  assert.equal(r.status, 400);
});

// The guard that stops agents from committing or pushing.
function guard(command) {
  return spawnSync(process.execPath, [path.join(ROOT, 'guard', 'pre-tool.js')], {
    input: JSON.stringify({ tool_input: { command } }),
  }).status;
}

test('guard refuses git commit and push however they are spelled', () => {
  for (const c of [
    'git commit -m x',
    'git -c user.name=x commit -m y',
    'git -C /some/dir push origin main',
    'npm test && git commit -am "done"',
    'echo hi; git push',
  ]) assert.equal(guard(c), 2, c);
});

test('guard allows other git commands', () => {
  for (const c of ['git status', 'git diff', 'git log --oneline', 'echo "git commit later"']) {
    assert.equal(guard(c), 0, c);
  }
});
