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

/** The workflows a pull request runs, a fork's included. */
const PULL_REQUEST_WORKFLOWS = ['ci.yml', 'security.yml'];
/** Run only when the owner publishes a release on GitHub; never by a pull request or a push. */
const RELEASE_WORKFLOWS = ['release.yml'];

test('there are workflows to check, and each is one kind or the other', () => {
  // A new workflow has to be put in one of the two lists, and meet its rules.
  assert.deepEqual(FILES, [...PULL_REQUEST_WORKFLOWS, ...RELEASE_WORKFLOWS].sort());
});

for (const { name, text } of workflows.filter((w) => PULL_REQUEST_WORKFLOWS.includes(w.name))) {
  test(`${name}: a fork's run gets the read-only token, never the privileged one`, () => {
    assert.match(text, /^ {2}pull_request:\s*$/m, 'it runs on pull requests');
    assert.doesNotMatch(text, /pull_request_target/, 'pull_request_target runs a fork\'s code with a write token and secrets');
    assert.doesNotMatch(text, /workflow_run/, 'a workflow_run follow-up is how an untrusted run\'s artifact reaches a privileged one');
  });

  test(`${name}: the token may read the repository and do nothing else`, () => {
    assert.match(text, /^permissions:\n {2}contents: read\n(?! {2}\S)/m, 'top-level permissions are exactly contents: read');
    assert.doesNotMatch(text, /:\s*write\b|write-all/, 'no permission is widened anywhere');
  });

}

for (const { name, text } of workflows.filter((w) => RELEASE_WORKFLOWS.includes(w.name))) {
  test(`${name}: runs only when a release is published, never for a pull request or a push`, () => {
    const on = /^on:\n((?: {2}.*\n?)+)/m.exec(text)?.[1] ?? '';
    assert.equal(on.trim(), 'release:\n    types: [published]', 'its only trigger');
    assert.doesNotMatch(text, /pull_request|workflow_run|workflow_dispatch/);
  });

  test(`${name}: the one widened permission is the OIDC token, in the job the npm environment guards`, () => {
    assert.match(text, /^permissions:\n {2}contents: read\n(?! {2}\S)/m, 'top-level permissions are exactly contents: read');
    const widened = [...text.matchAll(/^\s*([\w-]+):\s*write\b/gm)].map((m) => m[1]);
    assert.deepEqual(widened, ['id-token'], 'trusted publishing needs id-token: write, and nothing more');
    assert.doesNotMatch(text, /write-all/);
    const [job] = Object.values(jobsOf(text)).filter((lines) => lines.some((l) => /id-token: write/.test(l)));
    assert.ok(job.some((l) => /^ {4}environment: npm$/.test(l)), 'in the `npm` environment, the one npmjs.com trusts');
  });
}

for (const { name, text } of workflows) {
  test(`${name}: no secret but the run's own token is named`, () => {
    // Every way an expression can reach the secrets: secrets.X, secrets['X'] and the whole
    // object at once (toJSON(secrets)). Only secrets.GITHUB_TOKEN is allowed. Only inside
    // ${{ }}, the one place they can be reached: a job may be called `secrets`.
    const uses = secretsIn(text);
    for (const use of uses) assert.equal(use, 'secrets.GITHUB_TOKEN', `${name} reaches the secrets as ${use}`);
  });

  test(`${name}: no checkout leaves the token in .git/config for the code it checked out`, () => {
    const checkouts = Object.values(jobsOf(text)).flatMap(stepsOf).filter((s) => /uses: actions\/checkout@/.test(s));
    assert.ok(checkouts.length >= 1, 'found the checkouts');
    for (const step of checkouts) assert.match(step, /^\s+persist-credentials: false$/m, step);
  });
}

/** Each reach for the secrets inside a ${{ }} expression, as written: `secrets.X` or bare `secrets`. */
function secretsIn(text) {
  return [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].flatMap(([, expression]) =>
    [...expression.matchAll(/\bsecrets\b(\.[A-Za-z_][A-Za-z0-9_]*)?/g)].map((m) => m[0]),
  );
}

test('the screenshots job can read, upload one artifact, and nothing else', () => {
  const jobs = jobsOf(workflows.find((w) => w.name === 'ci.yml').text);
  const job = jobs.screenshots;
  assert.ok(job, 'ci.yml has the screenshots job');
  const body = job.join('\n');

  // Its own permissions, so that widening the workflow's for some other job leaves it alone.
  assert.match(body, /^ {4}permissions:\n {6}contents: read$/m);
  assert.deepEqual(secretsIn(body), [], 'it names no secret at all, in any spelling');

  // Every action it uses is one of these; a new one (a release, a Pages deploy, a
  // commit-back) has to be argued in here.
  const allowed = ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node', 'actions/upload-artifact'];
  const steps = stepsOf(job);
  for (const step of steps) {
    // Every `uses:` line, in whatever form: a local action (./…) or a container
    // (docker://…) has no `@`, and must not slip past because of it.
    for (const [, ref] of step.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      const at = /^([\w.-]+\/[\w.-]+)@[\w.-]+$/.exec(ref);
      assert.ok(at && allowed.includes(at[1]), `the screenshots job uses ${ref}`);
    }
    assert.doesNotMatch(step, /git (push|commit)|\bgh /, 'nothing it runs writes back to GitHub');
  }

  // What it uploads is the pictures, for a short while.
  const upload = steps.find((s) => /upload-artifact@/.test(s));
  assert.match(upload, /^\s+path: docs\/images\/\*\.png$/m);
  const days = Number(/retention-days: (\d+)/.exec(upload)?.[1]);
  assert.ok(days > 0 && days <= 7, `kept ${days} days`);
});
