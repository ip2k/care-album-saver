// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { configPath, sessionPath, startWebUi, writeSecureFile } from '../dist/index.js';
import { ConfigUnusableError, loadConfig, loadSession, SessionUnusableError } from '../dist/config.js';
import { download, Manifest, writeAtomically } from '../dist/ferry/index.js';
import { extensionOf } from '../dist/sync.js';
import { addToPhotos } from '../dist/photos.js';
import * as schedule from '../dist/schedule.js';

/**
 * The security review's ★ items (docs/SECURITY-REVIEW-2026-09-23.md §4.2), the ones to fix
 * before a first release: fs-2, fs-4, fs-5/outbound-5, outbound-3 and missed-web.
 */

before(assertIsolatedConfigDir);

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const posixOnly = { skip: process.platform === 'win32' ? 'symbolic links and POSIX modes' : false };

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-star-'));
  return assertIsolatedConfigDir();
}

/** A file somebody else owns the contents of, and what it looked like before. */
async function victim(dir) {
  const path = join(dir, 'not-ours.txt');
  await writeFile(path, 'somebody else\'s file\n', { mode: 0o644 });
  return { path, before: { text: await readFile(path, 'utf8'), mode: (await stat(path)).mode & 0o777 } };
}

async function untouched(v) {
  assert.equal(await readFile(v.path, 'utf8'), v.before.text, 'the file the link pointed at is unchanged');
  assert.equal((await stat(v.path)).mode & 0o777, v.before.mode, 'and so is its mode');
}

// ------------------------------------------------------------------ fs-2

test('fs-2: a symlink planted at the old fixed temporary names is never written through', posixOnly, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-fs2-'));
  const v = await victim(dir);

  // The manifest: `archive.json.tmp` was the name every run used.
  const archive = join(dir, 'archive');
  await mkdir(archive);
  await symlink(v.path, join(archive, 'archive.json.tmp'));
  const m = await Manifest.open(archive, 'test');
  await m.save();
  await untouched(v);
  assert.equal((await stat(join(archive, 'archive.json'))).mode & 0o777, 0o600, 'the manifest is owner-only');
  assert.ok(JSON.parse(await readFile(join(archive, 'archive.json'), 'utf8')).files, 'and it was written');

  // The settings and the session: `<name>.tmp` in the config folder.
  const config = await freshConfigDir();
  await symlink(v.path, join(config, 'session.json.tmp'));
  await writeSecureFile(join(config, 'session.json'), '{"cookie":"x"}');
  await untouched(v);
  assert.equal((await stat(join(config, 'session.json'))).mode & 0o777, 0o600);
});

test('fs-2: writeAtomically replaces a symlink at the target instead of following it, and leaves no litter', posixOnly, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-fs2-'));
  const v = await victim(dir);
  // A week folder's README and a photo's sidecar have names anyone can predict.
  for (const name of ['README.md', 'photo.jpg.json']) {
    const target = join(dir, name);
    await symlink(v.path, target);
    await writeAtomically(target, 'ours\n');
    await untouched(v);
    assert.ok(!(await lstat(target)).isSymbolicLink(), `${name} is now a file of its own`);
    assert.equal(await readFile(target, 'utf8'), 'ours\n');
  }

  // The mode is exact, whatever the umask; without one, it is an ordinary file.
  const secret = join(dir, 'secret.json');
  const old = process.umask(0);
  try {
    await writeAtomically(secret, '{}', 0o600);
    assert.equal((await stat(secret)).mode & 0o777, 0o600);
  } finally {
    process.umask(old);
  }

  // A write that cannot finish removes its temporary file.
  await mkdir(join(dir, 'a-folder'));
  await assert.rejects(writeAtomically(join(dir, 'a-folder'), 'x'));
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), [], 'no temporary file left behind');
});

test('fs-2: nothing rewrites a file in place through a fixed temporary name any more', async () => {
  const src = (p) => readFile(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8');
  for (const file of ['ferry/manifest.ts', 'maintenance.ts', 'paths.ts', 'metadata.ts', 'sync.ts']) {
    const text = await src(file);
    assert.doesNotMatch(text, /=\s*`\$\{\w+\}\.tmp`/, `${file} makes no fixed temporary name`);
    assert.doesNotMatch(text, /\bwriteFile\(/, `${file} writes through writeAtomically`);
  }
  assert.match(await src('ferry/download.ts'), /createWriteStream\(partPath, \{ flags: 'wx' \}\)/, 'the .part file is created exclusively');
});

test('fs-2: a symlink at a download\'s .part name is not written through', posixOnly, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-fs2-'));
  const v = await victim(dir);
  const server = createServer((req, res) => res.end('PHOTO-BYTES'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const destination = join(dir, 'photo.jpg');
    await symlink(v.path, `${destination}.part`);
    await download({ url: `http://127.0.0.1:${server.address().port}/p.jpg`, destination });
    await untouched(v);
    assert.equal(await readFile(destination, 'utf8'), 'PHOTO-BYTES');
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------------ fs-4

test('fs-4: a saved file takes its extension from a list for its kind, never whatever the URL ends in', () => {
  const at = (path) => `https://cdn.example.com/media/${path}?Signature=abc&Expires=1`;
  for (const hostile of ['page.html', 'drawing.svg', 'setup.exe', 'shortcut.lnk', 'script.js', 'run.command']) {
    assert.equal(extensionOf(at(hostile), 'image'), 'jpg', `${hostile} as a photo`);
    assert.equal(extensionOf(at(hostile), 'video'), 'mp4', `${hostile} as a video`);
  }
  assert.equal(extensionOf(at('a.JPEG'), 'image'), 'jpeg', 'case does not matter');
  for (const ext of ['jpg', 'png', 'heic', 'heif', 'webp', 'gif']) assert.equal(extensionOf(at(`a.${ext}`), 'image'), ext);
  for (const ext of ['mp4', 'mov', 'm4v']) assert.equal(extensionOf(at(`a.${ext}`), 'video'), ext);
  assert.equal(extensionOf(at('a.png'), 'video'), 'mp4', 'the list is per kind');
  assert.equal(extensionOf(at('a.mov'), 'image'), 'jpg');
  assert.equal(extensionOf(at('no-extension'), 'image'), 'jpg');
  assert.equal(extensionOf('not a url', 'video'), 'mp4');
});

// ------------------------------------------------------------------ fs-5 / outbound-5

test('fs-5: damaged settings are refused, never taken for a first run; missing ones are a first run', async () => {
  await freshConfigDir();
  assert.equal((await loadConfig()).includeStudents.length, 0, 'no file: the defaults');

  for (const [contents, why] of [['{"archiveDir": "/Volumes/Photos", "includeSt', /not valid JSON/], ['[]', /does not contain settings/], ['42', /does not contain settings/], ['null', /does not contain anything/]]) {
    await writeFile(configPath(), contents);
    await assert.rejects(loadConfig(), (error) => {
      assert.ok(error instanceof ConfigUnusableError);
      assert.match(error.message, why);
      assert.match(error.message, /Nothing has been changed and nothing has been downloaded/);
      assert.ok(!error.message.includes('/Volumes/Photos'), 'the file\'s contents are not quoted');
      return true;
    });
  }
});

test('fs-5: a damaged session says so, rather than "not connected", and never quotes itself', async () => {
  await freshConfigDir();
  assert.equal(await loadSession(), null, 'no file: not connected');
  const marker = 'SESSIONVALUE' + 'Z'.repeat(24);
  await writeFile(sessionPath(), `{"cookie": "${marker}`);
  await assert.rejects(loadSession(), (error) => {
    assert.ok(error instanceof SessionUnusableError);
    assert.match(error.message, /Connect again to replace it/);
    assert.ok(!error.message.includes(marker.slice(0, 10)));
    return true;
  });
});

test('fs-5: a damaged record of what went into Photos stops the Photos step instead of adding everything again', async () => {
  const dir = await freshConfigDir();
  await writeFile(join(dir, 'photos.json'), '{"added": {"a/b.jpg": ');
  let spawned = 0;
  const archiveDir = await mkdtemp(join(tmpdir(), 'cas-star-archive-'));
  const config = { ...(await loadConfig()), archiveDir, addToPhotos: true, addToPhotosFrom: null };
  await assert.rejects(
    addToPhotos(config, { platform: 'darwin', spawn: async () => { spawned++; return { code: 0, stdout: '', stderr: '' }; } }),
    /record of what has already been added to Photos .* cannot be read.*nothing has been added twice/s,
  );
  assert.equal(spawned, 0, 'Photos was never asked to do anything');
});

test('fs-5: the daily run refuses damaged settings, and writes the refusal down where the page will show it', async () => {
  const dir = await freshConfigDir();
  const archive = join(await mkdtemp(join(tmpdir(), 'cas-star-')), 'would-be-default');
  await writeFile(configPath(), '{"archiveDir": ');
  const env = { ...process.env, CARE_ALBUM_CONFIG_DIR: dir, CARE_ALBUM_DIR: archive };
  const result = await promisify(execFile)(process.execPath, [CLI, 'run', '--scheduled', '--base-url', 'http://127.0.0.1:9/api/v1'], { env })
    .then(() => ({ code: 0 }), (error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Your settings .* cannot be used: it is not valid JSON/);
  assert.ok(!existsSync(archive), 'no default folder was made');
  const last = JSON.parse(await readFile(join(dir, 'last-run.json'), 'utf8'));
  assert.equal(last.ok, false);
  assert.equal(last.trigger, 'schedule');
  assert.match(last.message, /cannot be used/);
  const log = await readFile(join(process.env.CARE_ALBUM_LOG_DIR, 'daily.log'), 'utf8');
  assert.match(log, /FAILED {2}Your settings/);
});

test('fs-5: the setup page shows a damaged session on step 1, and damaged settings at the top, instead of breaking', async () => {
  await freshConfigDir();
  await writeFile(sessionPath(), '{"cookie": ');
  const handle = await startWebUi({});
  try {
    const get = async () => {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/state`, { headers: { 'x-setup-token': handle.token } });
      return { status: res.status, body: await res.json() };
    };
    let r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.body.hasSession, false);
    assert.match(r.body.sessionProblem, /saved Brightwheel session .* cannot be read/);

    await writeFile(configPath(), '{');
    r = await get();
    assert.equal(r.status, 500);
    assert.match(r.body.error, /Your settings .* cannot be used/);
  } finally {
    await handle.close();
  }
  const page = await readFile(fileURLToPath(new URL('../src/web/page.ts', import.meta.url)), 'utf8');
  assert.match(page, /if \(!answer\.config\) \{/, 'the page stops painting when there are no settings');
  assert.match(page, /state\.sessionProblem/, 'and shows a session problem where connecting is');
});

// ------------------------------------------------------------------ outbound-3

test('outbound-3: a download sent compressed is not called truncated, and uncompressed is asked for', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-gzip-'));
  const body = Buffer.from('JPEG-ish '.repeat(500));
  const gz = gzipSync(body);
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.headers['accept-encoding']);
    if (req.url === '/gzip.jpg') {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(gz.length) });
      res.end(gz);
    } else {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const zipped = await download({ url: `${base}/gzip.jpg`, destination: join(dir, 'a.jpg') });
    assert.deepEqual(await readFile(join(dir, 'a.jpg')), body, 'the decoded file is saved whole');
    assert.equal(zipped.bytes, body.length);
    assert.equal(zipped.validators.size, null, 'the compressed length is not taken for the file\'s');
    const plain = await download({ url: `${base}/plain.jpg`, destination: join(dir, 'b.jpg') });
    assert.equal(plain.validators.size, body.length, 'an uncompressed length is still checked');
    assert.deepEqual(asked, ['identity', 'identity']);
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------------ missed-web

/** A copy of the tool on disk: `<root>/packages/care-album-saver/dist/cli.js`. */
async function copyOfTheTool(name, { production = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), `cas-copy-${name}-`));
  const dist = join(root, 'packages', 'care-album-saver', 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'cli.js'), '');
  if (production) await writeFile(join(root, '.care-album-saver-production'), '');
  return join(dist, 'cli.js');
}

async function scheduler() {
  const home = await mkdtemp(join(tmpdir(), 'cas-home-'));
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  return (cliPath) => ({ platform: 'darwin', home, run, cliPath, nodePath: '/usr/local/bin/node', uid: 501 });
}

test('missed-web: another copy that is still there cannot take over the daily run unless told to', async () => {
  await freshConfigDir();
  const env = await scheduler();
  const mine = await copyOfTheTool('mine');
  const stray = await copyOfTheTool('stray');

  await schedule.install('17:00', env(mine));
  assert.equal((await loadConfig()).schedule.cliPath, mine, 'the copy that set it up is written down');
  await schedule.install('18:00', env(mine));

  await assert.rejects(schedule.install('19:00', env(stray)), (error) => {
    assert.ok(error instanceof schedule.ScheduleOwnedElsewhereError);
    assert.equal(error.production, false);
    assert.match(error.message, /set up by another copy of this tool, in .*packages[\\/]care-album-saver/);
    return true;
  });
  assert.equal((await loadConfig()).schedule.cliPath, mine, 'still the original copy');
  assert.equal((await loadConfig()).schedule.time, '18:00');

  await schedule.install('19:00', env(stray), { replace: true });
  assert.equal((await loadConfig()).schedule.cliPath, stray, 'taken over when told to');

  // Turning another copy's daily run off is the safe direction, and allowed.
  await schedule.remove(env(mine));
  assert.equal((await loadConfig()).schedule, null);
});

test('missed-web: a copy that is gone owns nothing, and a record from before copies were written down names no owner', async () => {
  await freshConfigDir();
  const env = await scheduler();
  const gone = join(await mkdtemp(join(tmpdir(), 'cas-gone-')), 'packages', 'care-album-saver', 'dist', 'cli.js');
  const mine = await copyOfTheTool('mine');
  await schedule.install('17:00', env(gone));
  await schedule.install('18:00', env(mine));
  assert.equal((await loadConfig()).schedule.cliPath, mine);

  const config = await loadConfig();
  const { cliPath: _, ...legacy } = config.schedule;
  await writeFile(configPath(), JSON.stringify({ ...config, schedule: legacy }));
  await schedule.install('19:00', env(await copyOfTheTool('other')));
});

test('missed-web: a production copy\'s daily run is not taken or turned off from anywhere else, except by --replace', async () => {
  await freshConfigDir();
  const env = await scheduler();
  const production = await copyOfTheTool('production', { production: true });
  const stray = await copyOfTheTool('stray');
  const dev = await copyOfTheTool('dev');

  // The production copy takes the daily run from whatever had it: that is deploying.
  await schedule.install('17:00', env(dev));
  await schedule.install('17:00', env(production));
  assert.equal((await loadConfig()).schedule.cliPath, production);

  for (const attempt of [
    () => schedule.install('19:00', env(stray)),
    () => schedule.install('19:00', env(stray), { replace: true }),
    () => schedule.remove(env(stray)),
    () => schedule.remove(env(stray), { replace: true }),
  ]) {
    await assert.rejects(attempt(), (error) => error instanceof schedule.ScheduleOwnedElsewhereError && error.production);
  }
  assert.equal((await loadConfig()).schedule.cliPath, production, 'nothing moved');
  await schedule.install('19:00', env(stray), { replace: true, replaceProduction: true });
  assert.equal((await loadConfig()).schedule.cliPath, stray, 'the command line\'s --replace does');
});

test('missed-web: the setup page asks before taking another copy\'s daily run, and never takes a production one', async () => {
  await freshConfigDir();
  const env = await scheduler();
  const other = await copyOfTheTool('other');
  const here = await copyOfTheTool('here');
  await schedule.install('17:00', env(other));

  const handle = await startWebUi({ schedule: env(here) });
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    let r = await post({ time: '19:00' });
    assert.equal(r.status, 409);
    assert.equal(r.body.replaceable, true);
    assert.match(r.body.error, /another copy of this tool/);
    r = await post({ time: '19:00', replace: true });
    assert.equal(r.status, 200);
    assert.equal((await loadConfig()).schedule.cliPath, here);

    await schedule.install('17:00', env(await copyOfTheTool('production', { production: true })));
    r = await post({ time: '19:00', replace: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.replaceable, false, 'the page is not offered a production copy\'s daily run');
  } finally {
    await handle.close();
  }
  const page = await readFile(fileURLToPath(new URL('../src/web/page.ts', import.meta.url)), 'utf8');
  assert.match(page, /d\.replaceable && window\.confirm\(/, 'the page asks the parent before sending replace');
});
