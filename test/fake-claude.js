#!/usr/bin/env node
'use strict';
// A stand-in for the claude program, used only by the tests. It reads the
// prompt, says it started, and then either finishes at once or, when the
// prompt says KEEP RUNNING, keeps going (with a child process of its own)
// until Pacer stops it. It writes both process ids to $PACER_TEST_PIDS.
const { spawn } = require('node:child_process');
const fs = require('node:fs');

let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  say({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake' });
  if (prompt.includes('KEEP RUNNING')) {
    const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    if (process.env.PACER_TEST_PIDS) fs.writeFileSync(process.env.PACER_TEST_PIDS, `${process.pid} ${kid.pid}`);
    setTimeout(() => {}, 120000);
    return;
  }
  say({ type: 'result', subtype: 'success', is_error: false, result: 'Done. Nothing needed changing.', session_id: sessionId, total_cost_usd: 0, num_turns: 1 });
});
