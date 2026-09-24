import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a pull request from a fork can do in this repository's CI (security review sc-3,
 * 2026-09-23).
 *
 * Both workflows run on every pull request, forks included, and the screenshots job runs
 * the fork's own code and uploads what it wrote. That is safe for as long as a fork's run
 * can only read, holds no secret and feeds nothing that publishes, and each of those is one
 * careless line away from being false: `pull_request_target`, `contents: write`, a
 * `workflow_run` follow-up, a release action. So they are asserted here, on the files, and
 * a change that loosens one has to change this test and say why.
 *
 * Read as text, not parsed: the project has no YAML dependency and wants none, and these
 * files are small and regular. Comments are dropped first, so explaining a rule in a
 * comment does not trip it.
 */

const DIR = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));
const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

/** The file without comment lines or trailing comments. */
const code = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#\s.*$/, ''))
    .join('\n');

// A Windows runner checks the files out with CRLF line endings.
const workflows = FILES.map((name) => ({ name, text: code(readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n')) }));

/** Each job's lines, by id: the two-space keys under `jobs:`. */
function jobsOf(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  assert.ok(start >= 0, 'a jobs: block');
  const jobs = {};
  let id = null;
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) {
      id = m[1];
      jobs[id] = [];
    } else if (/^\S/.test(line)) {
      break;
    } else if (id) {
      jobs[id].push(line);
    }
  }
  return jobs;
}

/** A job's steps, each as its lines, split on the `      - ` that starts one. */
function stepsOf(jobLines) {
  const steps = [];
  for (const line of jobLines) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (steps.length && /^ {7,}\S/.test(line)) steps.at(-1).push(line);
  }
  return steps.map((lines) => lines.join('\n'));
}

test('there are workflows to check', () => {
  assert.deepEqual(FILES, ['ci.yml', 'security.yml']);
});

for (const { name, text } of workflows) {
  test(`${name}: a fork's run gets the read-only token, never the privileged one`, () => {
    assert.match(text, /^ {2}pull_request:\s*$/m, 'it runs on pull requests');
    assert.doesNotMatch(text, /pull_request_target/, 'pull_request_target runs a fork\'s code with a write token and secrets');
    assert.doesNotMatch(text, /workflow_run/, 'a workflow_run follow-up is how an untrusted run\'s artifact reaches a privileged one');
  });

  test(`${name}: the token may read the repository and do nothing else`, () => {
    assert.match(text, /^permissions:\n {2}contents: read\n(?! {2}\S)/m, 'top-level permissions are exactly contents: read');
    assert.doesNotMatch(text, /:\s*write\b|write-all/, 'no permission is widened anywhere');
  });

  test(`${name}: no secret but the run's own token is named`, () => {
    const secrets = [...text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    for (const secret of secrets) assert.equal(secret, 'GITHUB_TOKEN', `${name} names secrets.${secret}`);
  });

  test(`${name}: no checkout leaves the token in .git/config for the code it checked out`, () => {
    const checkouts = Object.values(jobsOf(text)).flatMap(stepsOf).filter((s) => /uses: actions\/checkout@/.test(s));
    assert.ok(checkouts.length >= 1, 'found the checkouts');
    for (const step of checkouts) assert.match(step, /^\s+persist-credentials: false$/m, step);
  });
}

test('the screenshots job can read, upload one artifact, and nothing else', () => {
  const jobs = jobsOf(workflows.find((w) => w.name === 'ci.yml').text);
  const job = jobs.screenshots;
  assert.ok(job, 'ci.yml has the screenshots job');
  const body = job.join('\n');

  // Its own permissions, so that widening the workflow's for some other job leaves it alone.
  assert.match(body, /^ {4}permissions:\n {6}contents: read$/m);
  assert.doesNotMatch(body, /secrets\./, 'it names no secret at all');

  // Every action it uses is one of these; a new one (a release, a Pages deploy, a
  // commit-back) has to be argued in here.
  const allowed = ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node', 'actions/upload-artifact'];
  const steps = stepsOf(job);
  for (const step of steps) {
    const uses = /uses: ([^@\s]+)@/.exec(step);
    if (uses) assert.ok(allowed.includes(uses[1]), `the screenshots job uses ${uses[1]}`);
    assert.doesNotMatch(step, /git (push|commit)|\bgh /, 'nothing it runs writes back to GitHub');
  }

  // What it uploads is the pictures, for a short while.
  const upload = steps.find((s) => /upload-artifact@/.test(s));
  assert.match(upload, /^\s+path: docs\/images\/\*\.png$/m);
  const days = Number(/retention-days: (\d+)/.exec(upload)?.[1]);
  assert.ok(days > 0 && days <= 7, `kept ${days} days`);
});
