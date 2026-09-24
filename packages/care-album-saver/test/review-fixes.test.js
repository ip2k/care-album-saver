// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, configPath, startWebUi, writeSecureFile } from '../dist/index.js';
import { photoAt } from '../dist/gallery.js';
import * as schedule from '../dist/schedule.js';

/**
 * What the 2026-09-23 dead-code audit found and did not change, fixed before the security
 * review: a malformed body echoed part of itself in a 500; the settings patch stored
 * whatever it was sent; /photo's containment check hard-coded '/' and followed symlinks; the
 * Photos-failure notice could never be shown; the demo's "open the log" ran a real viewer.
 */

before(assertIsolatedConfigDir);

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-fixes-'));
  return assertIsolatedConfigDir();
}

async function ui(options = {}) {
  const handle = await startWebUi(options);
  const post = async (path, body, raw = false) => {
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      body: raw ? body : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
  return { handle, post };
}

test('a body that is not JSON, or not an object, gets a fixed 400 that never quotes it', async () => {
  await freshConfigDir();
  const { handle, post } = await ui();
  try {
    const marker = 'PASTEDVALUE' + 'Q'.repeat(30);
    for (const [path, body] of [
      ['/api/session', `{"cookie": ${marker}`],
      ['/api/session', marker],
      ['/api/config', `[${JSON.stringify(marker)}]`],
      ['/api/config', 'null'],
      ['/api/update', `"${marker}"`],
    ]) {
      const r = await post(path, body, true);
      assert.equal(r.status, 400, `${path} ${body.slice(0, 12)}`);
      assert.ok(!r.text.includes(marker), 'nothing of the body comes back');
      assert.ok(!r.text.includes(marker.slice(0, 8)), 'not even a fragment of it');
      assert.match(r.text, /not understood, so nothing was changed/);
    }
  } finally {
    await handle.close();
  }
});

test('the settings patch stores only the settings the page may change, in the right shape', async () => {
  await freshConfigDir();
  await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: '/tmp/x' }));
  const { handle, post } = await ui();
  try {
    const wrong = await post('/api/config', { incremental: 'yes' });
    assert.equal(wrong.status, 400);
    assert.equal(JSON.parse(wrong.text).field, 'incremental');
    const notAPath = await post('/api/config', { archiveDir: 5 });
    assert.equal(notAPath.status, 400);
    assert.equal(JSON.parse(notAPath.text).field, 'archiveDir');
    const layout = await post('/api/config', { organiseBy: 'by-teacher' });
    assert.equal(layout.status, 400);

    const smuggled = await post('/api/config', {
      tagNote: false,
      delayMs: 0,
      schedule: { time: '03:00', mechanism: 'cron', location: '/x', installedAt: 'now' },
      addToPhotos: true,
      checkForUpdates: true,
      somethingNew: 'stored?',
    });
    assert.equal(smuggled.status, 200, smuggled.text);
    const stored = JSON.parse(await readFile(configPath(), 'utf8'));
    assert.equal(stored.tagNote, false, 'the real setting changed');
    assert.equal(stored.delayMs, DEFAULT_CONFIG.delayMs, 'the pause between requests is not the page\'s to set');
    assert.equal(stored.schedule, null, 'no schedule record without the scheduler');
    assert.equal(stored.addToPhotos, false);
    assert.equal(stored.checkForUpdates, null);
    assert.equal('somethingNew' in stored, false, 'unknown keys are dropped, not stored');
  } finally {
    await handle.close();
  }
});

test('/photo resolves both sides before comparing: no `..`, no symbolic link out of the archive', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'cas-outside-'));
  const archive = join(outside, 'archive');
  await mkdir(archive);
  await writeFile(join(outside, 'escape.jpg'), 'outside');
  await writeFile(join(archive, 'ok.jpg'), 'inside');
  const files = [
    { path: '../escape.jpg', bytes: 7, sha256: 'x', downloadedAt: '2026-09-23T00:00:00Z' },
    { path: 'link.jpg', bytes: 7, sha256: 'y', downloadedAt: '2026-09-23T00:00:00Z' },
    { path: 'ok.jpg', bytes: 6, sha256: 'z', downloadedAt: '2026-09-23T00:00:00Z' },
  ];
  await writeFile(join(archive, 'archive.json'), JSON.stringify({ files }));
  const config = { ...DEFAULT_CONFIG, archiveDir: archive };
  assert.equal(await photoAt(config, '0'), null, 'a manifest entry that climbs out');
  const found = await photoAt(config, '2');
  assert.ok(found && found.bytes === 6, 'an ordinary entry is served');
  if (process.platform === 'win32') return t.skip('symbolic links need a privilege on Windows');
  await symlink(join(outside, 'escape.jpg'), join(archive, 'link.jpg'));
  assert.equal(await photoAt(config, '1'), null, 'a link planted inside the archive that points outside');
});

test('the Photos-failure notice is one of the two the tool can show, and only fixed text reaches osascript', async () => {
  const calls = [];
  const env = { platform: 'darwin', home: await mkdtemp(join(tmpdir(), 'cas-notify-')), run: async (file, args) => { calls.push([file, args]); return { code: 0, stdout: '', stderr: '' }; } };
  assert.equal(await schedule.notify(schedule.PHOTOS_NOTICE, env), true);
  assert.equal(await schedule.notify(schedule.FAILED_NOTICE, env), true);
  assert.equal(await schedule.notify('Something with a child\'s name in it', env), false, 'an unknown message is not shown');
  assert.equal(calls.length, 2);
  for (const [file, args] of calls) {
    assert.equal(file, 'osascript');
    assert.equal(args[0], '-e');
    assert.match(args[1], /^display notification "[^"$]+" with title "Care Album Saver"$/, 'a literal, with nothing interpolated');
  }
  assert.match(calls[0][1][1], /could not be added to Photos/);
});

test('the log routes use the stand-in scheduler, so the demo never opens a real log viewer', async () => {
  await freshConfigDir();
  const calls = [];
  const home = await mkdtemp(join(tmpdir(), 'cas-logs-home-'));
  const run = async (file, args) => { calls.push([file, args]); return { code: 0, stdout: '', stderr: '' }; };
  const handle = await startWebUi({ schedule: { platform: 'darwin', home, run } });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/open-logs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': handle.token }, body: '{}' });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map(([f, a]) => [f, a[0], a[1]]), [['open', '-a', 'Console']], 'the stand-in saw the call; nothing real ran');
    const logs = await fetch(`http://127.0.0.1:${handle.port}/api/logs`, { headers: { 'x-setup-token': handle.token } });
    assert.equal((await logs.json()).ok, true);
  } finally {
    await handle.close();
  }
});
