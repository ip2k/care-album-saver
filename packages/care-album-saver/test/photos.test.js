// First, before anything that can read the config directory: the Photos list lives there.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  BrightwheelClient,
  DEFAULT_CONFIG,
  PHOTOS_FOLDER,
  PHOTOS_SCRIPT,
  PHOTOS_SCRIPT_URL,
  Secret,
  addToPhotos,
  albumPathFor,
  checkPhotosAccess,
  configPath,
  photosStatus,
  startMockBrightwheel,
  startWebUi,
  sync,
  writeSecureFile,
} from '../dist/index.js';

/**
 * Adding saved photos to Apple Photos.
 *
 * No test here, or anywhere, drives the real Photos app: with iCloud Photos on, that would
 * upload the mock's pictures to a real person's account. Every call goes through a stand-in
 * that records what it was asked to run, and scripts/test-env.js sets CARE_ALBUM_NO_PHOTOS
 * so that a test which forgot its stand-in is refused rather than obeyed — which the last
 * group below checks.
 *
 * What the recorded calls prove is the part that matters most: osascript is only ever given
 * the one script file, then folder and album names, then `--`, then files that exist inside
 * the archive — never `-e`, never source text, never a file twice.
 */

const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

let mock;
before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 4 }); });
after(async () => { await mock?.close(); });

/** A config directory per test, so one test's list of what was added is not the next one's. */
async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-photos-'));
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

/** An archive the destination rules accept: temp folders are refused by design. */
async function archiveDir() {
  const dir = join(REPO_ROOT, 'node_modules', '.cache', `cas-photos-${Math.random().toString(16).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

const clientFor = () => new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });

/** Save the mock's photos into `dir` with the given layout, and return the config used. */
async function savedArchive(dir, extra = {}) {
  const config = { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0, includeStudents: [ROBIN], ...extra };
  await sync(clientFor(), config, () => {}, { allowTemporaryDir: true });
  return config;
}

/** A stand-in for execFile that answers as told and remembers every call. */
function recorder(reply = () => ({ code: 0, stdout: '1\n', stderr: '' })) {
  const calls = [];
  const spawn = async (file, args, timeoutMs) => {
    calls.push({ file, args: [...args], timeoutMs });
    return { code: 0, stdout: '', stderr: '', ...(await reply(file, args)) };
  };
  return { calls, spawn };
}

const manifestOf = async (dir) => JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));

/** Split a recorded call into what the script sees: names before `--`, files after. */
function parts(call) {
  assert.equal(call.file, '/usr/bin/osascript', 'by its full path, never looked up on PATH');
  assert.equal(call.args[0], PHOTOS_SCRIPT, 'the first argument is always the one script file');
  const rest = call.args.slice(1);
  const at = rest.indexOf('--');
  return { names: rest.slice(0, at), files: rest.slice(at + 1) };
}

// ---------------------------------------------------------------- where they go

test('Photos gets the same folders and albums as the archive on disk, for every layout', async () => {
  await freshConfigDir();
  for (const organiseBy of ['child-then-week', 'week', 'week-per-child']) {
    const dir = await archiveDir();
    try {
      await savedArchive(dir, { organiseBy });
      const { files } = await manifestOf(dir);
      assert.ok(files.length > 0, 'the mock saved something to mirror');
      for (const record of files) {
        // The folders the file really sits in, read from the disk rather than the manifest.
        const onDisk = relative(dir, join(dir, record.path)).split(sep).slice(0, -1);
        assert.deepEqual(albumPathFor(record.path), [PHOTOS_FOLDER, ...onDisk], `${organiseBy}: ${record.path}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('the folders and album are named, never guessed: top-level folder, then each folder on disk', () => {
  assert.equal(PHOTOS_FOLDER, 'Brightwheel');
  assert.deepEqual(albumPathFor('Robin Maple/2026-W38/2026-09-18_1.jpg'), ['Brightwheel', 'Robin Maple', '2026-W38']);
  assert.deepEqual(albumPathFor('2026-W38/2026-09-18_1.jpg'), ['Brightwheel', '2026-W38']);
  assert.deepEqual(albumPathFor('2026-W38/Robin Maple/2026-09-18_1.jpg'), ['Brightwheel', '2026-W38', 'Robin Maple']);
  // No layout writes a file at the top, but one there is still given an album, not refused.
  assert.deepEqual(albumPathFor('stray.jpg'), ['Brightwheel', 'Other']);
});

// ---------------------------------------------------------------- what osascript is given

test('osascript is given the script file, names, `--` and private copies — never -e, never source', async () => {
  const configDir = await freshConfigDir();
  const dir = await archiveDir();
  try {
    const config = { ...(await savedArchive(dir)), addToPhotos: true, addToPhotosFrom: null };
    // Looked at while the call is being made: the copies are gone once Photos has them.
    const seen = [];
    const photos = recorder(async (file, args) => {
      const files = args.slice(args.indexOf('--') + 1);
      for (const copy of files) {
        const archived = join(dir, ...args.slice(2, args.indexOf('--')), basename(copy));
        seen.push({
          copy,
          file: (await lstat(copy)).isFile(),
          same: (await readFile(copy)).equals(await readFile(archived)),
        });
      }
      return { code: 0, stdout: `${files.length}\n`, stderr: '' };
    });
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    const { files: records } = await manifestOf(dir);

    assert.equal(result.ok, true);
    assert.equal(result.added, records.length);
    assert.ok(photos.calls.length > 0);
    for (const call of photos.calls) {
      assert.ok(!call.args.includes('-e'), 'no script text on the command line');
      const { names, files } = parts(call);
      assert.equal(names[0], PHOTOS_FOLDER);
      assert.ok(files.length > 0 && files.length <= 50, 'in batches of at most fifty');
    }
    for (const { copy, file, same } of seen) {
      assert.ok(copy.startsWith(join(configDir, 'photos-handover-')), `a private copy, not the archive's file: ${copy}`);
      assert.ok(file, 'a plain file, not a link');
      assert.ok(same, 'the same bytes as the file in the folder the names describe');
    }
    assert.deepEqual((await readdir(configDir)).filter((n) => n.startsWith('photos-handover-')), [], 'and the copies are gone afterwards');
    // Every saved file handed over exactly once.
    const handed = photos.calls.flatMap((c) => parts(c).files);
    assert.equal(new Set(handed).size, handed.length, 'no file twice in one attempt');
    assert.equal(handed.length, records.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nothing is handed to Photos twice: the next attempt finds nothing to do', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  try {
    const config = { ...(await savedArchive(dir)), addToPhotos: true, addToPhotosFrom: null };
    const first = recorder();
    await addToPhotos(config, { platform: 'darwin', spawn: first.spawn });
    const again = recorder();
    const second = await addToPhotos(config, { platform: 'darwin', spawn: again.spawn });
    assert.equal(second.ok, true);
    assert.equal(second.added, 0);
    assert.equal(again.calls.length, 0, 'Photos is not even asked');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('turning it on covers what is saved from then on; earlier photos wait to be asked for', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  try {
    const saved = await savedArchive(dir);
    const { files } = await manifestOf(dir);
    // Turned on a moment after everything was saved.
    const config = { ...saved, addToPhotos: true, addToPhotosFrom: new Date(Date.now() + 1000).toISOString() };

    const status = await photosStatus(config, { platform: 'darwin' });
    assert.equal(status.pending, 0);
    assert.equal(status.earlier, files.length, 'the earlier ones are counted, for the button');

    const photos = recorder();
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    assert.equal(result.added, 0);
    assert.equal(photos.calls.length, 0, 'nothing from before is added unasked');

    // "Add the earlier ones too".
    const all = { ...config, addToPhotosFrom: null };
    const later = await addToPhotos(all, { platform: 'darwin', spawn: recorder().spawn });
    assert.equal(later.added, files.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('off, or not a Mac, means Photos is never asked anything', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  try {
    const saved = await savedArchive(dir);
    const off = recorder();
    assert.equal((await addToPhotos({ ...saved, addToPhotos: false }, { platform: 'darwin', spawn: off.spawn })).added, 0);
    assert.equal(off.calls.length, 0);

    for (const platform of ['linux', 'win32']) {
      const other = recorder();
      const result = await addToPhotos({ ...saved, addToPhotos: true }, { platform, spawn: other.spawn });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'unsupported');
      assert.equal(other.calls.length, 0, platform);
      assert.equal((await photosStatus({ ...saved, addToPhotos: true }, { platform })).supported, false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- when Photos says no

test('a refusal from macOS is explained, nothing is recorded, and the next attempt tries again', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  try {
    const config = { ...(await savedArchive(dir)), addToPhotos: true, addToPhotosFrom: null };
    const denied = recorder(() => ({
      code: 1,
      stderr: `${PHOTOS_SCRIPT}: execution error: Not authorized to send Apple events to Photos. (-1743)\n`,
    }));
    const result = await addToPhotos(config, { platform: 'darwin', spawn: denied.spawn });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'denied');
    assert.match(result.error, /Privacy & Security › Automation/, 'says where the switch is');
    assert.match(result.error, /safe in your folder/, 'and that nothing was lost');
    assert.equal(denied.calls.length, 1, 'it stops at the first refusal rather than repeating it');

    const status = await photosStatus(config, { platform: 'darwin' });
    assert.equal(status.lastAttempt.ok, false, 'the page can say it failed, days later');
    assert.equal(status.pending, (await manifestOf(dir)).files.length, 'all still waiting');

    const retry = recorder();
    assert.equal((await addToPhotos(config, { platform: 'darwin', spawn: retry.spawn })).ok, true);
    assert.ok(retry.calls.length > 0, 'retried once permission is there');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file gone from disk is left out, not allowed to fail every batch after it', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  try {
    const config = { ...(await savedArchive(dir)), addToPhotos: true, addToPhotosFrom: null };
    const { files } = await manifestOf(dir);
    await rm(join(dir, files[0].path));
    const photos = recorder();
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    assert.equal(result.ok, true);
    assert.equal(result.missing, 1);
    assert.equal(result.added, files.length - 1);
    const handed = photos.calls.flatMap((c) => parts(c).files);
    assert.ok(!handed.includes(join(dir, files[0].path)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a manifest pointing outside the archive is ignored, not imported', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  try {
    await savedArchive(dir);
    const manifest = await manifestOf(dir);
    const outside = join(dir, '..', `cas-outside-${Date.now()}.jpg`);
    await writeFile(outside, 'not ours');
    manifest.files.push({ ...manifest.files[0], path: `../${outside.split(sep).pop()}`, sha256: 'f'.repeat(64) });
    await writeFile(join(dir, 'archive.json'), JSON.stringify(manifest));
    const photos = recorder();
    await addToPhotos({ ...DEFAULT_CONFIG, archiveDir: dir, addToPhotos: true, addToPhotosFrom: null }, { platform: 'darwin', spawn: photos.spawn });
    const handed = photos.calls.flatMap((c) => parts(c).files);
    assert.ok(!handed.includes(outside));
    await rm(outside, { force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two runs at once cannot both add the same photos; a lock left by a dead run is cleared', async () => {
  const configDir = await freshConfigDir();
  const dir = await archiveDir();
  try {
    const config = { ...(await savedArchive(dir)), addToPhotos: true, addToPhotosFrom: null };
    const lock = join(configDir, 'photos.lock');
    await writeFile(lock, '99999 held\n');
    const blocked = recorder();
    const busy = await addToPhotos(config, { platform: 'darwin', spawn: blocked.spawn });
    assert.equal(busy.reason, 'busy');
    assert.equal(blocked.calls.length, 0);

    // An hour old: whoever took it is not coming back.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lock, hourAgo, hourAgo);
    const after = recorder();
    assert.equal((await addToPhotos(config, { platform: 'darwin', spawn: after.spawn })).ok, true);
    assert.ok(after.calls.length > 0);
    await assert.rejects(stat(lock), 'and the lock is released when done');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the setup page

test('turning it on asks the Mac first, and a refusal leaves it off', async () => {
  await freshConfigDir();
  const denied = recorder(() => ({ code: 1, stderr: 'execution error: Not authorized to send Apple events to Photos. (-1743)' }));
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1`, native: { platform: 'darwin', spawn: denied.spawn } });
  try {
    const res = await post(handle, '/api/photos', { enabled: true });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Automation/);
    assert.deepEqual(denied.calls.map((c) => c.args), [[PHOTOS_SCRIPT]], 'the check is the script with nothing to add');
    assert.equal(JSON.parse(await readFile(configPath(), 'utf8').catch(() => '{}')).addToPhotos ?? false, false);
  } finally {
    await handle.close();
  }
});

test('turning it on stores the moment it was turned on, by the server clock', async () => {
  await freshConfigDir();
  const allowed = recorder(() => ({ code: 0, stdout: 'ok\n' }));
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1`, native: { platform: 'darwin', spawn: allowed.spawn } });
  try {
    const before = Date.now();
    const res = await post(handle, '/api/photos', { enabled: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.photos.enabled, true);
    const stored = JSON.parse(await readFile(configPath(), 'utf8'));
    assert.equal(stored.addToPhotos, true);
    assert.ok(Date.parse(stored.addToPhotosFrom) >= before - 1000, 'from now, not from the beginning');

    const earlier = await post(handle, '/api/photos', { earlier: true });
    assert.equal(earlier.status, 200);
    assert.equal(JSON.parse(await readFile(configPath(), 'utf8')).addToPhotosFrom, null, 'the earlier ones, on request');

    const off = await post(handle, '/api/photos', { enabled: false });
    assert.equal(off.body.photos.enabled, false);
  } finally {
    await handle.close();
  }
});

test('a settings patch cannot turn it on, or move where it starts', async () => {
  await freshConfigDir();
  const photos = recorder();
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1`, native: { platform: 'darwin', spawn: photos.spawn } });
  try {
    await post(handle, '/api/config', { addToPhotos: true, addToPhotosFrom: null, tagNote: false });
    const stored = JSON.parse(await readFile(configPath(), 'utf8'));
    assert.equal(stored.tagNote, false, 'the rest of the patch is stored');
    assert.equal(stored.addToPhotos, false, 'but not this');
    assert.equal(photos.calls.length, 0, 'and Photos was never asked');
  } finally {
    await handle.close();
  }
});

test('the route refuses on a computer with no Photos app', async () => {
  await freshConfigDir();
  const photos = recorder();
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1`, native: { platform: 'linux', spawn: photos.spawn } });
  try {
    const res = await post(handle, '/api/photos', { enabled: true });
    assert.equal(res.status, 400);
    assert.equal(photos.calls.length, 0);
    const state = await get(handle, '/api/state');
    assert.equal(state.photos.supported, false, 'and the page is told to hide the option');
  } finally {
    await handle.close();
  }
});

test('a run from the page adds its new photos to Photos afterwards, and says so', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  const photos = recorder();
  await writeSecureFile(
    configPath(),
    JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0, addToPhotos: true, addToPhotosFrom: new Date(0).toISOString() }),
  );
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1`, native: { platform: 'darwin', spawn: photos.spawn } });
  try {
    assert.equal((await post(handle, '/api/session', { cookie: SESSION })).status, 200);
    assert.equal((await post(handle, '/api/sync', {})).status, 202);
    let state;
    for (let i = 0; i < 200; i += 1) {
      state = await get(handle, '/api/state');
      if (!state.running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(state.progress.phase, 'done', 'the run ends on its own line, not a Photos one');
    assert.ok(state.lastResult.saved > 0);
    assert.equal(state.lastResult.photos.ok, true);
    assert.equal(state.lastResult.photos.added, state.lastResult.saved);
    assert.ok(photos.calls.every((c) => c.args[0] === PHOTOS_SCRIPT));
    assert.equal(state.photos.pending, 0);
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the option lives in Settings only, and the FAQ explains it and links to the script', async () => {
  await freshConfigDir();
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/?token=${handle.token}`)).text();
    const settings = html.slice(html.indexOf('<dialog id="dlg-settings"'), html.indexOf('</dialog>', html.indexOf('<dialog id="dlg-settings"')));
    const flow = html.slice(html.indexOf('<div id="setup-flow">'), html.indexOf('<dialog id="dlg-settings"'));
    assert.ok(settings.includes('id="card-photos"'), 'in Settings');
    assert.ok(!flow.includes('id="addToPhotos"'), 'not one of the setup steps');
    assert.match(settings, /<section class="card" id="card-photos"[^>]*\shidden>/, 'hidden until the server says this is a Mac');
    assert.equal(html.split('id="addToPhotos"').length - 1, 1, 'exactly one');
    assert.ok(!/<input type="checkbox" id="addToPhotos"[^>]*checked/.test(html), 'and not ticked by default');

    const help = html.slice(html.indexOf('<dialog id="dlg-help"'), html.indexOf('</dialog>', html.indexOf('<dialog id="dlg-help"')));
    assert.ok(help.includes('id="faq-photos"'));
    assert.ok(help.includes(PHOTOS_SCRIPT_URL), 'the FAQ links to the script itself');
    assert.match(help, /iCloud/);
    assert.match(help, /Nothing is uploaded anywhere else &mdash; unless/, 'the promise says where it stops');
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------- the script itself

test('the script exists, ships with the package, and does nothing but find, make and import', async () => {
  const source = await readFile(PHOTOS_SCRIPT, 'utf8');
  const code = source.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.match(code, /import theFiles into theAlbum with skip check duplicates/);
  for (const forbidden of [/\bdelete\b/, /do shell script/, /\bmove\b/, /\bduplicate\b(?! check)/, /run script/, /set name of/]) {
    assert.ok(!forbidden.test(code), `the script must not contain ${forbidden}`);
  }
  const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.ok(pkg.files.includes('applescript'), 'published with the package, or the tool cannot find it');
  assert.ok(PHOTOS_SCRIPT_URL.endsWith('/packages/care-album-saver/applescript/add-to-photos.applescript'));
});

test('the script compiles (compiled only, never run)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('osacompile exists only on macOS');
  const out = join(await mkdtemp(join(tmpdir(), 'cas-osacompile-')), 'check.scpt');
  // osacompile reads Photos' dictionary to resolve the words; it sends Photos nothing.
  await promisify(execFile)('osacompile', ['-o', out, PHOTOS_SCRIPT]);
  assert.ok((await stat(out)).size > 0);
});

// ---------------------------------------------------------------- the guard

test('without a stand-in, the test environment refuses to drive the real Photos', async () => {
  assert.equal(process.env.CARE_ALBUM_NO_PHOTOS, '1', 'scripts/test-env.js set it');
  await freshConfigDir();
  const access = await checkPhotosAccess({ platform: 'darwin' });
  assert.equal(access.ok, false);
  assert.match(access.error, /CARE_ALBUM_NO_PHOTOS/);
});

test('a CLI run on a Mac tries Photos after saving, and a refusal does not fail the run', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the Photos step only runs on macOS');
  const dir = await archiveDir();
  const configDir = await mkdtemp(join(tmpdir(), 'cas-photos-cli-'));
  const logDir = await mkdtemp(join(tmpdir(), 'cas-photos-log-'));
  try {
    await writeSecureFile(join(configDir, 'session.json'), JSON.stringify({ cookie: SESSION, savedAt: new Date().toISOString() }));
    await writeSecureFile(
      join(configDir, 'config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0, addToPhotos: true, addToPhotosFrom: new Date(0).toISOString() }),
    );
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'run', '--base-url', `${mock.url}/api/v1`], {
      env: { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir, CARE_ALBUM_LOG_DIR: logDir },
    });
    // The guard answers in place of Photos, so the step runs and is refused — which is
    // exactly the path a real refusal takes, and the run still exits 0.
    assert.match(stdout, /Not added to Photos: .*CARE_ALBUM_NO_PHOTOS/);
    assert.match(stdout, /Done\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- helpers

async function post(handle, path, body) {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(handle, path) {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, { headers: { 'x-setup-token': handle.token } });
  return res.json();
}
