// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, startMockBrightwheel, writeSecureFile } from '../dist/index.js';
import { logTimestamp, stampLines } from '../dist/log-lines.js';
import * as schedule from '../dist/schedule.js';

/**
 * Every line of the daily log says when it was written, in ISO 8601 with the local offset
 * (2026-09-23). Before this only the tool's own START/OK/FAILED lines did; everything a
 * scheduled run printed — which launchd and cron write into the same file — did not.
 */

const SESSION = 'test-session-value';
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}  \s*\S/;

let mock;
before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 3 }); });
after(async () => { await mock?.close(); });

test('the stamp is ISO 8601 to the second, in local time, with the offset — and means the same instant', () => {
  const saved = process.env.TZ;
  try {
    const at = new Date('2026-09-24T00:00:04.808Z');
    for (const [zone, expected] of [
      ['America/Los_Angeles', '2026-09-23T17:00:04-07:00'],
      ['UTC', '2026-09-24T00:00:04+00:00'],
      ['Asia/Kolkata', '2026-09-24T05:30:04+05:30'],
      ['America/St_Johns', '2026-09-23T21:30:04-02:30'],
    ]) {
      process.env.TZ = zone;
      assert.equal(logTimestamp(at), expected, zone);
      assert.equal(Date.parse(logTimestamp(at)), Date.parse('2026-09-24T00:00:04Z'), `${zone}: one instant, however it is written`);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('output written in pieces is stamped once per line, and blank lines are left out', () => {
  const written = [];
  let called = 0;
  const stream = { write(chunk, encoding, callback) { written.push(chunk); if (typeof callback === 'function') callback(); return true; } };
  const original = stream.write;
  const restore = stampLines(stream, () => new Date(2026, 8, 23, 17, 0, 4));
  const s = logTimestamp(new Date(2026, 8, 23, 17, 0, 4));

  stream.write('  Looking for Robin\'s photos\n');
  stream.write('\n  Done. 3 new, 0 already had, 0 failed.\n  Photos are in: /x\n');
  stream.write('  Saving ');
  stream.write('one.jpg\n');
  stream.write(Buffer.from('  from a Buffer\n'));
  stream.write('\n\n   \n');
  stream.write('  last, unfinished', () => { called++; });
  stream.write('', 'utf8', () => { called++; });

  assert.equal(written.join(''), [
    `${s}    Looking for Robin's photos`,
    `${s}    Done. 3 new, 0 already had, 0 failed.`,
    `${s}    Photos are in: /x`,
    `${s}    Saving one.jpg`,
    `${s}    from a Buffer`,
    `${s}    last, unfinished`,
  ].join('\n'));
  assert.equal(called, 2, 'callbacks still reach the stream, with or without an encoding');
  restore();
  assert.equal(stream.write, original);
});

async function scheduledRun(env) {
  const configDir = await mkdtemp(join(tmpdir(), 'cas-log-config-'));
  const logDir = await mkdtemp(join(tmpdir(), 'cas-log-dir-'));
  // An archive the destination rules accept: they refuse temporary folders.
  const archive = join(REPO_ROOT, 'node_modules', '.cache', `cas-log-${Math.random().toString(16).slice(2, 10)}`);
  await mkdir(archive, { recursive: true });
  await writeSecureFile(join(configDir, 'session.json'), JSON.stringify({ cookie: SESSION, savedAt: new Date().toISOString() }));
  await writeSecureFile(join(configDir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: archive, delayMs: 0 }));
  const logFile = join(logDir, 'daily.log');
  // What launchd's StandardOutPath and StandardErrorPath, and cron's `>> log 2>&1`, do.
  const fd = openSync(logFile, 'a');
  const childEnv = { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir, CARE_ALBUM_LOG_DIR: logDir, ...env };
  delete childEnv.JOURNAL_STREAM;
  if (env.JOURNAL_STREAM) childEnv.JOURNAL_STREAM = env.JOURNAL_STREAM;
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'run', '--scheduled', '--base-url', `${mock.url}/api/v1`], { env: childEnv, stdio: ['ignore', fd, fd] });
      child.on('exit', resolve);
    });
    assert.equal(code, 0);
    return (await readFile(logFile, 'utf8')).split('\n').filter((l, i, all) => i < all.length - 1 || l !== '');
  } finally {
    closeSync(fd);
    await rm(archive, { recursive: true, force: true });
  }
}

test('a scheduled run whose output is the log: every line of it starts with when', async () => {
  const lines = await scheduledRun({});
  assert.ok(lines.length > 5, lines.join('\n'));
  for (const line of lines) assert.match(line, STAMP, `unstamped: ${JSON.stringify(line)}`);
  assert.ok(lines.some((l) => /  START   scheduled run$/.test(l)), 'the tool\'s own records');
  assert.ok(lines.some((l) => /  OK +\d+ saved/.test(l)));
  assert.ok(lines.some((l) => /  +Looking for .+ photos$/.test(l)), 'and what it printed on the way');
  assert.ok(!lines.some((l) => l.trim() === ''), 'no empty entries');
});

test('under systemd the journal stamps the output itself, so only the tool\'s own records are stamped', async () => {
  const lines = await scheduledRun({ JOURNAL_STREAM: '8:12345' });
  assert.ok(lines.some((l) => /^  Looking for .+ photos$/.test(l)), 'printed lines are left for the journal');
  assert.ok(lines.filter((l) => /START   scheduled run|  OK +\d/.test(l)).every((l) => STAMP.test(l)));
});

test('appendLog stamps what it is given, so no caller can forget', async () => {
  const dir = process.env.CARE_ALBUM_LOG_DIR;
  await mkdir(dir, { recursive: true });
  await schedule.appendLog('PHOTOS  added 2 to Photos');
  const last = (await readFile(schedule.logFile(), 'utf8')).trimEnd().split('\n').at(-1);
  assert.match(last, STAMP);
  assert.match(last, /  PHOTOS  added 2 to Photos$/);
});
