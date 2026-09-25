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
    { path: '../escape.jpg', bytes: 7, sha256: '1'.repeat(64), downloadedAt: '2026-09-23T00:00:00Z' },
    { path: 'link.jpg', bytes: 7, sha256: '2'.repeat(64), downloadedAt: '2026-09-23T00:00:00Z' },
    { path: 'ok.jpg', bytes: 6, sha256: '3'.repeat(64), downloadedAt: '2026-09-23T00:00:00Z' },
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
  // Chosen by kind since processes-9: the words, and the AppleScript made from them, are the tool's own.
  assert.equal(await schedule.notify('photos', env), true);
  assert.equal(await schedule.notify('failed', env), true);
  assert.equal(await schedule.notify('Something with a child\'s name in it', env), false, 'an unknown message is not shown');
  assert.equal(calls.length, 2);
  for (const [file, args] of calls) {
    assert.equal(file, '/usr/bin/osascript');
    assert.equal(args[0], '-e');
    assert.match(args[1], /^display notification "[^"$]+" with title "Care Album Saver"$/, 'a literal, with nothing interpolated');
  }
  assert.match(calls[0][1][1], /could not be added to Apple Photos\.app/);
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

// --- found by the security review itself, 2026-09-23 ---------------------------------------

test('every consumer of the archive list refuses an entry that leaves the archive, and one file is never its own duplicate', async () => {
  const { createHash } = await import('node:crypto');
  const { findDuplicates, removeDuplicates } = await import('../dist/maintenance.js');
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const outside = await mkdtemp(join(tmpdir(), 'cas-contain-'));
  const archive = join(outside, 'archive');
  await mkdir(join(archive, 'sub'), { recursive: true });
  await writeFile(join(outside, 'outside.jpg'), 'same-bytes');
  await writeFile(join(archive, 'a.jpg'), 'same-bytes');
  await writeFile(join(archive, 'only.jpg'), 'lone-bytes');
  const rec = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha(bytes), downloadedAt: '2026-09-23T00:00:00Z' });
  await writeFile(join(archive, 'archive.json'), JSON.stringify({ schema: 2, source: 'brightwheel', updatedAt: '2026-09-23T00:00:00Z', files: [
    rec('a.jpg', 'same-bytes'), rec('../outside.jpg', 'same-bytes'), rec('only.jpg', 'lone-bytes'), rec('sub/../only.jpg', 'lone-bytes'),
  ] }));
  const config = { ...DEFAULT_CONFIG, archiveDir: archive };
  const report = await findDuplicates(config);
  const mentioned = report.groups.flatMap((g) => [g.keep, ...g.extra]);
  assert.ok(!mentioned.includes('../outside.jpg'), 'a copy outside the archive is not a duplicate the tool would touch');
  assert.ok(!mentioned.some((p) => /only\.jpg$/.test(p)), 'two spellings of one file are one file');
  await assert.rejects(() => removeDuplicates(config, { confirm: ['../outside.jpg'] }), /changed since/, 'and it cannot be named for removal');
  assert.equal(await readFile(join(outside, 'outside.jpg'), 'utf8'), 'same-bytes', 'the file outside is untouched');
  assert.equal(await readFile(join(archive, 'only.jpg'), 'utf8'), 'lone-bytes', 'the only copy is untouched');
});

test('a crontab that cannot be read is not treated as empty, and a write that fails is reported', async () => {
  await freshConfigDir();
  const calls = [];
  const runner = (answers) => async (file, args, input) => {
    calls.push([file, args, input]);
    return { code: 0, stdout: '', stderr: '', ...(answers[`${file} ${args.join(' ')}`] ?? {}) };
  };
  const home = await mkdtemp(join(tmpdir(), 'cas-cron-'));
  const noSystemd = { 'systemctl --user --version': { code: 127 } };

  const unreadable = { platform: 'linux', home, run: runner({ ...noSystemd, 'crontab -l': { code: 1, stderr: 'crontab: permission denied' } }) };
  await assert.rejects(() => schedule.install('19:00', unreadable), /could not be read, so nothing was changed/);
  assert.ok(!calls.some(([f, a]) => f === 'crontab' && a[0] === '-'), 'nothing was written over it');

  calls.length = 0;
  const empty = { platform: 'linux', home, run: runner({ ...noSystemd, 'crontab -l': { code: 1, stderr: 'no crontab for sam' } }) };
  await schedule.install('19:00', empty);
  assert.ok(calls.some(([f, a, input]) => f === 'crontab' && a[0] === '-' && /care-album-saver/i.test(input)), '"no crontab" is the ordinary empty state, and the block is written');

  calls.length = 0;
  const refusing = { platform: 'linux', home, run: runner({ ...noSystemd, 'crontab -l': { code: 0, stdout: 'their own line\n' }, 'crontab -': { code: 1, stderr: 'not allowed' } }) };
  await assert.rejects(() => schedule.remove(refusing), /could not be removed from your crontab, so nothing was changed/);
});

test('/photo cannot take the server down: an empty file with a suffix range, and a file that cannot be opened', async (t) => {
  await freshConfigDir();
  const { parseRange } = await import('../dist/web/server.js');
  assert.equal(parseRange('bytes=-5', 0), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
  const archive = await mkdtemp(join(tmpdir(), 'cas-photo-crash-'));
  await writeFile(join(archive, 'empty.jpg'), '');
  await writeFile(join(archive, 'locked.jpg'), 'locked');
  await writeFile(join(archive, 'archive.json'), JSON.stringify({ schema: 2, source: 'brightwheel', updatedAt: '2026-09-23T00:00:00Z', files: [
    { path: 'empty.jpg', bytes: 0, sha256: 'a'.repeat(64), downloadedAt: '2026-09-23T00:00:00Z' },
    { path: 'locked.jpg', bytes: 6, sha256: 'b'.repeat(64), downloadedAt: '2026-09-23T00:00:00Z' },
  ] }));
  await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: archive }));
  const handle = await startWebUi({});
  const get = (path, headers = {}) => fetch(`http://127.0.0.1:${handle.port}${path}`, { headers: { 'x-setup-token': handle.token, ...headers } });
  try {
    const suffix = await get('/photo?i=0', { range: 'bytes=-5' });
    assert.equal(suffix.status, 416, 'nothing in an empty file can be asked for');
    assert.equal((await get('/api/state')).status, 200, 'and the server is still there');
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
      const { chmod } = await import('node:fs/promises');
      await chmod(join(archive, 'locked.jpg'), 0o000);
      const locked = await get('/photo?i=1');
      assert.ok(locked.status === 500 || locked.status === 404, `a file that cannot be opened is an error, got ${locked.status}`);
      await locked.arrayBuffer();
      assert.equal((await get('/api/state')).status, 200, 'and the server is still there');
      await chmod(join(archive, 'locked.jpg'), 0o600);
    } else {
      t.diagnostic('unreadable-file case skipped: needs a non-root POSIX account');
    }
  } finally {
    await handle.close();
  }
});

test('a release link is judged on its parsed address, so `..` cannot walk it off this repository', async () => {
  const { parseRelease } = await import('../dist/updates.js');
  const base = { tag_name: 'v9.9.9', draft: false, prerelease: false, body: '' };
  assert.equal(parseRelease({ ...base, html_url: 'https://github.com/ip2k/care-album-saver/releases/../../evil/releases/tag/v9.9.9' }), null);
  assert.equal(parseRelease({ ...base, html_url: 'https://user:pw@github.com/ip2k/care-album-saver/releases/tag/v9.9.9' }), null);
  assert.equal(parseRelease({ ...base, html_url: 'https://github.com/ip2k/care-album-saver/releases/tag/v9.9.9?x=1' }), null);
  assert.equal(parseRelease({ ...base, html_url: 'https://github.com/ip2k/care-album-saver/releases/tag/v9.9.9' })?.version, '9.9.9');
});

test('a stored User-Agent with a control character or non-ASCII in it is not sent', async () => {
  const { acceptableUserAgent } = await import('../dist/api/identity.js');
  const good = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15';
  assert.equal(acceptableUserAgent(good), good);
  assert.equal(acceptableUserAgent('Mozilla/5.0 (X\r\nCookie: injected) Safari/1'), null);
  assert.equal(acceptableUserAgent('Mozilla/5.0 (X\u0000) Safari/1'), null);
  assert.equal(acceptableUserAgent('Mozilla/5.0 (Macintosh; caf\u00e9) Safari/1'), null);
});
