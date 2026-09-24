// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkArchiveDir } from '../dist/safety.js';
import { safeStem } from '../dist/ferry/names.js';
import { readManifestFile } from '../dist/ferry/manifest.js';
import { records } from '../dist/gallery.js';
import { DEFAULT_CONFIG } from '../dist/index.js';

/**
 * The archive review's NOTEs (docs/SECURITY-REVIEW-2026-09-23.md §4.6): a link followed by `..`
 * (F11), a named pipe at archive.json (F13), a stem cut to end in a dot (F14), and a race for
 * one abandoned lock between separate processes (F12).
 */

before(assertIsolatedConfigDir);

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const posixOnly = process.platform === 'win32' ? 'links and named pipes are POSIX here' : false;
const inTempCheckout = realpathSync(REPO_ROOT).startsWith(realpathSync(tmpdir()) + sep)
  ? 'this checkout is inside the temporary folder, where every archive is refused'
  : false;
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

test('F11: a link followed by .. is judged where the system takes it, not by its spelling', { skip: posixOnly || inTempCheckout }, async () => {
  const base = join(REPO_ROOT, 'node_modules', '.cache', `cas-notes-dotdot-${process.pid}`);
  const temp = await mkdtemp(join(tmpdir(), 'cas-notes-dotdot-'));
  await mkdir(join(temp, 'deeper'), { recursive: true });
  await mkdir(base, { recursive: true });
  try {
    await symlink(join(temp, 'deeper'), join(base, 'link'));
    // By spelling this is <base>/Photos, an ordinary folder; the system follows the link into
    // the temporary folder and climbs out of `deeper`, so it is <temp>/Photos.
    // Built as a string: join() would remove the `..` by spelling before the check saw it.
    const verdict = checkArchiveDir(`${base}/link/../Photos`);
    assert.equal(verdict.ok, false, JSON.stringify(verdict));
    assert.match(verdict.error, /temporary/i);
    // And from ~, the way a parent types it, the same.
    const underHome = checkArchiveDir(`~${base}/link/../Photos`, { homedir: '/' });
    assert.equal(underHome.ok, false, JSON.stringify(underHome));
    // Without the link, the same spelling is fine.
    assert.equal(checkArchiveDir(`${base}/plain/../Photos`).ok, true);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
});

test('F13: a named pipe at archive.json is refused in words, never waited on', { skip: posixOnly, timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-notes-fifo-'));
  try {
    execFileSync('mkfifo', [join(dir, 'archive.json')]);
    await assert.rejects(readManifestFile(dir), /archive\.json.*not an ordinary file|not an ordinary file/s);
    assert.deepEqual(await records({ ...DEFAULT_CONFIG, archiveDir: dir }), [], 'the gallery shows nothing, at once');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F14: a stem cut to 120 characters does not end in a dot or a space', () => {
  assert.equal(safeStem(`${'a'.repeat(119)}.b`), 'a'.repeat(119));
  assert.equal(safeStem(`${'a'.repeat(118)}. b`), 'a'.repeat(118));
  for (const tail of ['.', ' ', '-', '. -']) {
    const stem = safeStem(`${'r'.repeat(119)}${tail}xyz`);
    assert.doesNotMatch(stem, /[.\s-]$/, JSON.stringify(stem));
    assert.ok(stem.length <= 120);
  }
});

test('F12: six processes racing for one abandoned lock never hold the folder at the same time', { timeout: 120_000 }, async () => {
  // Each child waits for the same moment, tries to take the lock, and if it does, holds it
  // for a while and reports when it held it. Overlapping times are two runs in one folder.
  const child = `
    const { takeRunLock } = await import(${JSON.stringify(pathToFileURL(`${DIST}run-lock.js`).href)});
    const [dir, startAt] = process.argv.slice(1);
    while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 1));
    try {
      const lock = await takeRunLock(dir, { touchEveryMs: 10_000 });
      const from = Date.now();
      await new Promise((r) => setTimeout(r, 120));
      const to = Date.now();
      await lock.release();
      console.log(JSON.stringify({ held: [from, to] }));
    } catch (error) {
      console.log(JSON.stringify({ refused: error.name }));
    }
  `;
  const deadPid = (() => {
    for (let pid = 999_983; pid > 900_000; pid -= 1) {
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return pid; }
    }
    throw new Error('no free pid');
  })();
  for (let round = 0; round < 6; round += 1) {
    const dir = await mkdtemp(join(tmpdir(), 'cas-notes-race-'));
    try {
      await writeFile(join(dir, '.care-album-saver.lock'), JSON.stringify({
        pid: deadPid, host: hostname(), startedAt: new Date(Date.now() - 3_600_000).toISOString(), purpose: 'run',
      }));
      const startAt = Date.now() + 600;
      const answers = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
        const c = spawn(process.execPath, ['--input-type=module', '-e', child, dir, String(startAt)], { env: process.env });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.stderr.on('data', (d) => (out += d));
        c.on('error', reject);
        c.on('close', () => { try { resolve(JSON.parse(out.trim())); } catch { reject(new Error(out)); } });
      })));
      const held = answers.filter((a) => a.held).map((a) => a.held).sort((x, y) => x[0] - y[0]);
      assert.ok(held.length >= 1, `round ${round}: somebody holds it (${JSON.stringify(answers)})`);
      assert.ok(answers.every((a) => a.held || a.refused === 'RunInProgressError'), JSON.stringify(answers));
      for (let i = 1; i < held.length; i += 1) {
        assert.ok(held[i][0] >= held[i - 1][1], `round ${round}: two holders at once ${JSON.stringify(held)}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
