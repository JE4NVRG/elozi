import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Public repository: CI must run only on GitHub-hosted runners, with bounded jobs and no secrets.
const directory = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).map(name => [name, readFileSync(new URL(name, directory), 'utf8')]);
const workflow = readFileSync(new URL('ci.yml', directory), 'utf8');
const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)]
  .filter(([, , body]) => /    runs-on:/.test(body));

test('every workflow job runs on a GitHub-hosted runner, never on self-hosted labels', () => {
  assert.ok(workflows.length >= 1);
  for (const [name, text] of workflows) {
    assert.equal(/self-hosted/i.test(text.replace(/^\s*#.*$/gm, '')), false, `${name} must not target self-hosted runners`);
    for (const [, label] of text.matchAll(/^\s+runs-on:\s*(.+)$/gm)) assert.match(label.trim(), /^ubuntu-(?:latest|\d{2}\.\d{2})$/, `${name}: ${label}`);
  }
});

test('CI keeps finite deadlines, read-only token, no secrets and no privileged PR triggers', () => {
  assert.deepEqual(jobs.map(([, name]) => name), ['node']);
  for (const [, name, body] of jobs) {
    const deadline = body.match(/^    timeout-minutes: (\d+)$/m);
    assert.ok(deadline && Number(deadline[1]) > 0 && Number(deadline[1]) <= 60, `${name} needs a bounded deadline`);
  }
  for (const [name, text] of workflows) {
    assert.equal(/pull_request_target|workflow_run/.test(text.replace(/^\s*#.*$/gm, '')), false, name);
    assert.equal(/\$\{\{\s*secrets\./.test(text), false, name);
  }
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /persist-credentials: false/);
});

test('CI runs the install, syntax check and full test suite on Node 24', () => {
  assert.match(workflow, /node-version: '24'/);
  for (const command of ['npm ci', 'npm run check', 'npm test']) assert.ok(workflow.includes(`- run: ${command}`), command);
});
