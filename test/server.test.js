'use strict';
// Starts Pacer on a spare port with a throwaway data folder. No real agent is
// ever started: Settings point at a fake `claude` that only prints one line.
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
let tmp;
let server;

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
  const fake = path.join(tmp, 'claude');
  fs.writeFileSync(fake, '#!/bin/sh\necho \'{"type":"result","subtype":"success","result":"ok","total_cost_usd":0}\'\n', { mode: 0o755 });
  fs.mkdirSync(path.join(tmp, 'WeatherApp'));
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, DASH_PORT: String(PORT), DASH_DATA: path.join(tmp, 'data'), PATH: '/usr/bin:/bin' },
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
  const r = await request('PATCH', '/api/settings', { body: { claudePath: fake } });
  assert.equal(r.status, 200, r.text);
});

after(() => {
  if (server) server.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
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
