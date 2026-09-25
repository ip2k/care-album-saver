// First, before anything that can read the config directory: the Photos list lives there.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, PHOTOS_SCRIPT, configPath, startMockBrightwheel, startWebUi, writeSecureFile } from '../dist/index.js';

/**
 * "Add them to Apple Photos.app now" (POST /api/photos with `now`): an import on its own,
 * from the Integrations panel, without a run. It fetches nothing from Brightwheel, refuses
 * beside a run or another import, holds off a run while it goes, stops when the option is
 * turned off or the page's tool is closed, and reports the count the script printed. Every
 * call to osascript goes to a stand-in that can be held mid-batch; nothing reaches the real app.
 */

const SESSION = 'test-session-value';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let mock;
before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 4 }); });
after(async () => { await mock?.close(); });

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-photos-now-'));
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

/** An archive the destination rules accept: temp folders are refused by design. */
async function archiveDir() {
  const dir = join(REPO_ROOT, 'node_modules', '.cache', `cas-photos-now-${Math.random().toString(16).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

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

async function until(handle, done) {
  for (let i = 0; i < 400; i += 1) {
    const state = await get(handle, '/api/state');
    if (done(state)) return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('gave up waiting');
}

/**
 * osascript, as the tool sees it: the permission check answers "ok", and each batch is held
 * until the test lets it go, then answers with the number of files, as the real script does.
 */
function heldOsascript() {
  const batches = [];
  let release = () => {};
  let gate = new Promise((r) => { release = r; });
  const spawn = async (file, args) => {
    if (!args.includes('--')) return { code: 0, stdout: 'ok\n', stderr: '' };
    batches.push(args);
    await gate;
    return { code: 0, stdout: `${args.length - args.indexOf('--') - 1}\n`, stderr: '' };
  };
  return {
    batches,
    spawn,
    let: () => { release(); },
    hold: () => { gate = new Promise((r) => { release = r; }); },
  };
}

/** A tool with photos saved for both children, with adding to Apple Photos.app switched on. */
async function saved(dir, osascript) {
  await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0 }));
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1`, native: { platform: 'darwin', spawn: osascript.spawn } });
  assert.equal((await post(handle, '/api/session', { cookie: SESSION })).status, 200);
  assert.equal((await post(handle, '/api/sync', {})).status, 202);
  const ran = await until(handle, (s) => !s.running);
  assert.ok(ran.lastResult.saved > 0);
  assert.equal(osascript.batches.length, 0, 'the run added nothing: the option was off');
  assert.equal((await post(handle, '/api/photos', { enabled: true })).status, 200);
  assert.equal(osascript.batches.length, 0, 'turning it on adds nothing either');
  return { handle, saved: ran.lastResult.saved };
}

test('off, it is refused and nothing is asked of Apple Photos.app', async () => {
  await freshConfigDir();
  const osascript = heldOsascript();
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1`, native: { platform: 'darwin', spawn: osascript.spawn } });
  try {
    const res = await post(handle, '/api/photos', { now: true });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /turned off, so nothing was added/);
    assert.equal(osascript.batches.length, 0);
  } finally {
    await handle.close();
  }
});

test('now adds everything waiting, holds off a run and a second press meanwhile, and reports the count it was given', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  const osascript = heldOsascript();
  const { handle, saved: count } = await saved(dir, osascript);
  try {
    const before = await get(handle, '/api/state');
    assert.equal(before.photos.pending, count, 'everything saved is waiting');
    const requestsBefore = mock.requests?.length;

    const started = await post(handle, '/api/photos', { now: true });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const going = await until(handle, (s) => osascript.batches.length > 0 && s.photosRun.running);
    assert.equal(going.photosRun.running, true);
    assert.equal(typeof going.photosRun.message, 'string');

    const again = await post(handle, '/api/photos', { now: true });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already being added to Apple Photos\.app/);
    const run = await post(handle, '/api/sync', {});
    assert.equal(run.status, 409, 'no run while it goes');
    assert.match(run.body.error, /being added to Apple Photos\.app right now\. Nothing was started\./);

    osascript.let();
    const done = await until(handle, (s) => !s.photosRun.running);
    assert.equal(done.photosRun.last.ok, true, JSON.stringify(done.photosRun.last));
    assert.equal(done.photosRun.last.added, count, 'the count the script printed');
    assert.equal(done.photos.pending, 0);
    assert.ok(osascript.batches.every((args) => args[0] === PHOTOS_SCRIPT));
    if (requestsBefore !== undefined) assert.equal(mock.requests.length, requestsBefore, 'nothing fetched from Brightwheel');

    // And a run now finds nothing more to hand over.
    const next = await post(handle, '/api/sync', {});
    assert.equal(next.status, 202);
    const after = await until(handle, (s) => !s.running);
    assert.equal(after.lastResult.photos?.added ?? 0, 0);
  } finally {
    osascript.let();
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run going refuses it, and says the run will add them', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  const osascript = heldOsascript();
  const { handle } = await saved(dir, osascript);
  try {
    // The run's own Apple Photos.app step is held, so the run is still going.
    assert.equal((await post(handle, '/api/sync', {})).status, 202);
    await until(handle, (s) => osascript.batches.length > 0);
    const res = await post(handle, '/api/photos', { now: true });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /A run is saving photos right now, and it adds the new ones to Apple Photos\.app/);
    osascript.let();
    await until(handle, (s) => !s.running);
  } finally {
    osascript.let();
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('turning it off stops the import after the batch in hand; closing the tool waits for that batch', async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  const osascript = heldOsascript();
  const { handle, saved: count } = await saved(dir, osascript);
  let closed = false;
  try {
    assert.equal((await post(handle, '/api/photos', { now: true })).status, 202);
    await until(handle, () => osascript.batches.length > 0);
    const off = await post(handle, '/api/photos', { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.photos.enabled, false);
    osascript.let();
    const done = await until(handle, (s) => !s.photosRun.running);
    assert.equal(osascript.batches.length, 1, 'no batch after the one in hand');
    const handed = osascript.batches[0].length - osascript.batches[0].indexOf('--') - 1;
    assert.ok(handed < count, 'the mock’s photos span more than one album, so there was a batch left to stop');
    assert.equal(done.photosRun.last.added, handed);
    assert.equal(done.photosRun.last.remaining, count - handed, 'the rest wait');
    assert.equal(JSON.parse(await readFile(configPath(), 'utf8')).addToPhotos, false);

    // On again, and closed mid-batch: close waits for the batch, and none follows it.
    assert.equal((await post(handle, '/api/photos', { enabled: true })).status, 200);
    osascript.hold();
    const before = osascript.batches.length;
    assert.equal((await post(handle, '/api/photos', { now: true })).status, 202);
    await until(handle, () => osascript.batches.length > before);
    const closing = handle.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, false, 'not while Apple Photos.app has a batch');
    osascript.let();
    await closing;
    assert.equal(osascript.batches.length, before + 1, 'and nothing after it');
  } finally {
    osascript.let();
    if (!closed) await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unticking it during a run's own Apple Photos.app step stops that step too, after the batch in hand", async () => {
  await freshConfigDir();
  const dir = await archiveDir();
  const osascript = heldOsascript();
  const { handle, saved: count } = await saved(dir, osascript);
  try {
    // A run finds nothing new to save, then hands over what is waiting: held at its first batch.
    assert.equal((await post(handle, '/api/sync', {})).status, 202);
    await until(handle, () => osascript.batches.length > 0);
    const again = await post(handle, '/api/sync', {});
    assert.equal(again.status, 409);
    assert.equal(again.body.running, true, 'a page that did not start it is told it can follow it');
    assert.equal((await post(handle, '/api/photos', { enabled: false })).status, 200);
    osascript.let();
    const done = await until(handle, (s) => !s.running);
    assert.equal(osascript.batches.length, 1, 'no batch after the one in hand');
    const handed = osascript.batches[0].length - osascript.batches[0].indexOf('--') - 1;
    assert.equal(done.lastResult.photos.turnedOff, true);
    assert.equal(done.lastResult.photos.added, handed);
    assert.equal(done.lastResult.photos.remaining, count - handed);
  } finally {
    osascript.let();
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});
