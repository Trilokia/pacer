#!/usr/bin/env node
'use strict';
/*
 * Runs before every shell command of a dashboard agent (a Claude Code
 * "PreToolUse" hook). Exit code 2 refuses the command and shows the message
 * to the agent. It stops git commit and git push however they are spelled,
 * for example "git -c user.name=x commit".
 */
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let command = '';
  try { command = String(JSON.parse(input).tool_input.command || ''); } catch { process.exit(0); }
  const value = String.raw`(?:[^\s"']|"[^"]*"|'[^']*')+`;
  const gitOptions = String.raw`(?:\s+(?:-[cC]\s+${value}|--?[\w-]+(?:=${value})?))*`;
  const banned = new RegExp(String.raw`(?:^|[\s;&|(` + '`' + String.raw`])git` + gitOptions + String.raw`\s+(commit|push)(?![\w-])`);
  const m = command.match(banned);
  if (!m) process.exit(0);
  console.error(`Refused: dashboard agents must not run "git ${m[1]}". Leave the changes uncommitted and describe them in your report; the user reviews and commits.`);
  process.exit(2);
});
