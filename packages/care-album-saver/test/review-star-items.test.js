// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { BrightwheelClient, configPath, DEFAULT_CONFIG, Secret, sessionPath, startMockBrightwheel, startWebUi, sync, writeSecureFile } from '../dist/index.js';
import { closeMetadata } from '../dist/metadata.js';
import { auditArchive } from '../dist/maintenance.js';
import { photosStatus } from '../dist/photos.js';
import { exifToolSkipReason } from '../../../scripts/test-env.js';
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
const exiftoolMissing = await exifToolSkipReason(() => import('exiftool-vendored'));
after(() => closeMetadata());

const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';
const clientFor = (mock) => new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
const configFor = (dir, extra = {}) => ({ ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0, includeStudents: [ROBIN], ...extra });

/** The archive-relative paths one run against the mock saves, so a second archive can be prepared for them. */
async function namesTheMockSaves(mock) {
  const dir = await mkdtemp(join(tmpdir(), 'cas-names-'));
  const probe = await sync(clientFor(mock), configFor(dir), () => {}, { allowTemporaryDir: true });
  assert.equal(probe.failed, 0);
  return JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8')).files.map((f) => f.path);
}

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

test('fs-4: a saved file takes a photo or video extension, never whatever the URL ends in', () => {
  const at = (path) => `https://cdn.example.com/media/${path}?Signature=abc&Expires=1`;
  for (const hostile of ['page.html', 'drawing.svg', 'setup.exe', 'shortcut.lnk', 'script.js', 'run.command']) {
    assert.equal(extensionOf(at(hostile), 'image'), 'jpg', `${hostile} as a photo`);
    assert.equal(extensionOf(at(hostile), 'video'), 'mp4', `${hostile} as a video`);
  }
  assert.equal(extensionOf(at('a.JPEG'), 'image'), 'jpeg', 'case does not matter');
  for (const ext of ['jpg', 'png', 'heic', 'heif', 'webp', 'gif', 'avif', 'tif', 'tiff', 'bmp']) assert.equal(extensionOf(at(`a.${ext}`), 'image'), ext);
  for (const ext of ['mp4', 'mov', 'm4v', '3gp', 'webm', 'avi']) assert.equal(extensionOf(at(`a.${ext}`), 'video'), ext);
  // The kind is the post's, not the file's: a video post with no video carries its still,
  // and a JPEG named .mp4 goes to a player that cannot play it and past a tagger that refuses it.
  assert.equal(extensionOf(at('thumb.jpg'), 'video'), 'jpg', 'a photo on a video post stays a photo');
  assert.equal(extensionOf(at('a.mov'), 'image'), 'mov');
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
  assert.equal(result.stdout, '', 'under the scheduler what is printed is the log, which has it already');
  assert.ok(!existsSync(archive), 'no default folder was made');
  const last = JSON.parse(await readFile(join(dir, 'last-run.json'), 'utf8'));
  assert.equal(last.ok, false);
  assert.equal(last.trigger, 'schedule');
  assert.match(last.message, /cannot be used/);
  const log = await readFile(join(process.env.CARE_ALBUM_LOG_DIR, 'daily.log'), 'utf8');
  assert.match(log, /FAILED {2}Your settings .* cannot be used: it is not valid JSON/);
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

test('outbound-3: uncompressed is asked for as a browser asks for media, and a compressed body is refused, not saved unchecked', async () => {
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
    // Not "truncated" for the wrong reason, and not saved either: a compressed stream cut
    // off inside a complete response decodes to a shorter file with no error at all.
    await assert.rejects(download({ url: `${base}/gzip.jpg`, destination: join(dir, 'a.jpg') }), /compressed \(gzip\) although it was asked not to/);
    assert.ok(!existsSync(join(dir, 'a.jpg')) && !existsSync(join(dir, 'a.jpg.part')), 'nothing was kept');
    const plain = await download({ url: `${base}/plain.jpg`, destination: join(dir, 'b.jpg') });
    assert.equal(plain.validators.size, body.length);
    assert.deepEqual(await readFile(join(dir, 'b.jpg')), body);
    assert.deepEqual(asked, ['identity;q=1, *;q=0', 'identity;q=1, *;q=0'], 'what a browser sends for a video, not wget\'s bare identity');
  } finally {
    server.close();
  }
});

test('outbound-3: a connection that ends short of Content-Length is said in words, and nothing is kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-short-'));
  const server = createTcpServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n' + 'x'.repeat(5000));
      setTimeout(() => socket.destroy(), 50);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      download({ url: `http://127.0.0.1:${server.address().port}/p.jpg`, destination: join(dir, 'p.jpg') }),
      /stopped part-way .*Nothing was kept; it will be fetched again/,
    );
    assert.deepEqual(await readdir(dir), [], 'no photo and no half-file');
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
  if (production) await writeFile(join(root, '.care-album-saver-production'), `${root}\nproduction\n`);
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

  // A copy of the production folder carries the marker, but the marker names the original:
  // it is not production, and cannot take the daily run on the strength of it.
  const copy = await copyOfTheTool('copy-of-production');
  await writeFile(join(copy, '..', '..', '..', '..', '.care-album-saver-production'), `${join(production, '..', '..', '..', '..')}\nproduction\n`);
  await assert.rejects(schedule.install('19:00', env(copy)), (error) => error instanceof schedule.ScheduleOwnedElsewhereError);

  // Another folder that really is production — where production was before deploy.js --to —
  // takes it only with --replace, which is what deploy.js says.
  const earlier = await copyOfTheTool('earlier-production', { production: true });
  await assert.rejects(schedule.install('19:00', env(earlier)), (error) => error instanceof schedule.ScheduleOwnedElsewhereError);
  assert.equal((await loadConfig()).schedule.cliPath, production);

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

test('missed-web: a malformed owner in the settings is no owner, and deploy.js marks production with its own folder and moves the run with --replace', async () => {
  await freshConfigDir();
  const env = await scheduler();
  const here = await copyOfTheTool('here');
  await writeFile(configPath(), JSON.stringify({ schedule: { time: '17:00', mechanism: 'launchd', location: 'x', installedAt: new Date().toISOString(), cliPath: 42 } }));
  await schedule.install('19:00', env(here));
  assert.equal((await loadConfig()).schedule.cliPath, here);

  const deploy = await readFile(fileURLToPath(new URL('../../../scripts/deploy.js', import.meta.url)), 'utf8');
  assert.match(deploy, /writeFileSync\(join\(PROD, MARKER\), `\$\{realpathSync\(PROD\)\}\\n/);
  assert.match(deploy, /'schedule', 'on', '--at', time, '--replace'\]/);
});

// ------------------------------------------------------------------ found by the adversarial pass

test('fs-2: a save is staged privately, so links planted at ExifTool\'s and the sidecars\' names send nothing outside', { skip: exiftoolMissing || posixOnly.skip }, async () => {
  const mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 3 });
  try {
    const names = (await namesTheMockSaves(mock)).filter((n) => /\.jpe?g$/i.test(n));
    assert.ok(names.length > 0);
    const archive = await mkdtemp(join(tmpdir(), 'cas-staged-'));
    const outside = await mkdtemp(join(tmpdir(), 'cas-outside-'));
    for (const [i, rel] of names.entries()) {
      await mkdir(join(archive, rel, '..'), { recursive: true });
      // Dangling: ExifTool takes a dangling link for a free name and writes through it.
      await symlink(join(outside, `leak-${i}.xmp`), join(archive, `${rel}.xmp`));
      await symlink(join(outside, `moved-${i}.jpg`), join(archive, `${rel}_exiftool_tmp`));
    }
    const result = await sync(clientFor(mock), configFor(archive, { writeSidecar: true }), () => {}, { allowTemporaryDir: true });
    assert.equal(result.failed, 0, JSON.stringify(result.warnings));
    assert.deepEqual(await readdir(outside), [], 'nothing was written outside the archive');
    for (const rel of names) {
      assert.ok((await lstat(join(archive, rel))).isFile(), `${rel} is a file in the archive, not a link out of it`);
      assert.ok((await lstat(join(archive, `${rel}.xmp`))).isFile(), 'the sidecar replaced the link');
      assert.ok((await lstat(join(archive, `${rel}.json`))).isFile());
    }
    const leftovers = (await readdir(join(archive, names[0], '..'))).filter((n) => n.startsWith('.saving-'));
    assert.deepEqual(leftovers, [], 'the private staging folders are gone');
  } finally {
    await mock.close();
  }
});

test('fs-2: a week folder that is a link out of the archive is refused, and nothing is written where it points', posixOnly, async () => {
  const mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 3 });
  try {
    const [first] = await namesTheMockSaves(mock);
    const week = first.split('/').slice(0, -1);
    const archive = await mkdtemp(join(tmpdir(), 'cas-linked-'));
    const outside = await mkdtemp(join(tmpdir(), 'cas-outside-'));
    await writeFile(join(outside, 'README.md'), 'THE OWNER\'S OWN README\n');
    await mkdir(join(archive, ...week.slice(0, -1)), { recursive: true });
    await symlink(outside, join(archive, ...week));
    const result = await sync(clientFor(mock), configFor(archive), () => {}, { allowTemporaryDir: true });
    assert.ok(result.failed > 0);
    assert.ok(result.warnings.some((w) => /is a link to a folder somewhere else, so nothing was saved into it/.test(w)), JSON.stringify(result.warnings));
    assert.deepEqual(await readdir(outside), ['README.md'], 'nothing was saved into the folder the link points at');
    assert.equal(await readFile(join(outside, 'README.md'), 'utf8'), 'THE OWNER\'S OWN README\n');
  } finally {
    await mock.close();
  }
});

test('fs-2: a file replaced without a mode keeps the one it had; the audit ignores staging folders and old half-files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-keep-'));
  const readme = join(dir, 'README.md');
  await writeFile(readme, 'old\n');
  if (process.platform !== 'win32') {
    await chmod(readme, 0o600);
    await writeAtomically(readme, 'new\n');
    assert.equal((await stat(readme)).mode & 0o777, 0o600, 'a README the parent made owner-only stays owner-only');
  }

  await mkdir(join(dir, 'Robin-Maple', '2026-W38', '.saving-abc123'), { recursive: true });
  await writeFile(join(dir, 'Robin-Maple', '2026-W38', '.saving-abc123', 'photo.jpg'), 'half');
  await writeFile(join(dir, 'Robin-Maple', '2026-W38', 'old.jpg.part'), 'half');
  await writeFile(join(dir, 'Robin-Maple', '2026-W38', 'old.jpg_exiftool_tmp'), 'half');
  const audit = await auditArchive({ ...DEFAULT_CONFIG, archiveDir: dir });
  assert.deepEqual(audit.unrecorded, [], 'none of those is a photo');
});

test('fs-5: a byte-order mark is not damage; a setting of the wrong kind is refused rather than read as its default', async () => {
  await freshConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'cas-bom-'));
  await writeFile(configPath(), '\uFEFF' + JSON.stringify({ archiveDir: dir, includeStudents: ['a'] }));
  assert.equal((await loadConfig()).archiveDir, dir, 'a file Notepad saved as UTF-8 still loads');

  for (const [settings, name] of [[{ includeStudents: 'Robin' }, 'includeStudents'], [{ archiveDir: 5 }, 'archiveDir'], [{ archiveDir: '' }, 'archiveDir'], [{ schedule: 'daily' }, 'schedule']]) {
    await writeFile(configPath(), JSON.stringify(settings));
    await assert.rejects(loadConfig(), new RegExp(`"${name}" setting is not the kind of value it should be`));
  }
});

test('fs-5: a session file that holds no usable session is damaged; only a missing one is "not connected"', async () => {
  await freshConfigDir();
  for (const contents of ['{}', '[]', '"x"', '{"cookie": 5}', '{"cookie": "has a space"}']) {
    await writeFile(sessionPath(), contents);
    await assert.rejects(loadSession(), (error) => error instanceof SessionUnusableError && /care-album-saver login/.test(error.message), contents);
  }
  await writeFile(sessionPath(), JSON.stringify({ cookie: 'abc', savedAt: 'not a date' }));
  assert.equal((await loadSession()).session.expose(), 'abc');
  const handle = await startWebUi({});
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/state`, { headers: { 'x-setup-token': handle.token } });
    assert.equal(res.status, 200, 'a date that is not one does not take the page down');
    assert.equal((await res.json()).sessionSavedAt, null);
  } finally {
    await handle.close();
  }
});

test('fs-5: a daily run that finds no settings, or no session, records it instead of starting over or stopping in silence', async () => {
  const run = (env) => promisify(execFile)(process.execPath, [CLI, 'run', '--scheduled', '--base-url', 'http://127.0.0.1:9/api/v1'], { env: { ...process.env, ...env } }).then(() => ({ code: 0 }), (e) => e);

  // Moved aside, as the refusal suggests: not a first run.
  let dir = await freshConfigDir();
  const archive = join(await mkdtemp(join(tmpdir(), 'cas-star-')), 'would-be-default');
  let result = await run({ CARE_ALBUM_CONFIG_DIR: dir, CARE_ALBUM_DIR: archive });
  assert.equal(result.code, 1);
  assert.ok(!existsSync(archive), 'no second archive was begun');
  let last = JSON.parse(await readFile(join(dir, 'last-run.json'), 'utf8'));
  assert.equal(last.ok, false);
  assert.match(last.message, /found no settings/);

  // Settings, but no session.
  dir = await freshConfigDir();
  await writeFile(configPath(), JSON.stringify({ archiveDir: await mkdtemp(join(tmpdir(), 'cas-star-archive-')) }));
  result = await run({ CARE_ALBUM_CONFIG_DIR: dir });
  assert.equal(result.code, 1);
  last = JSON.parse(await readFile(join(dir, 'last-run.json'), 'utf8'));
  assert.equal(last.ok, false);
  assert.match(last.message, /Not connected to Brightwheel/);
});

test('fs-5: with damaged settings, `where` still answers, and the daily run can still be turned off without touching them', async () => {
  const dir = await freshConfigDir();
  await writeFile(configPath(), '{"archiveDir": ');
  const where = await promisify(execFile)(process.execPath, [CLI, 'where'], { env: { ...process.env, CARE_ALBUM_CONFIG_DIR: dir } });
  assert.match(where.stdout, /Photos: {3}\(unknown until the settings can be read\)/);
  assert.match(where.stdout, /cannot be used: it is not valid JSON/);

  const env = await scheduler();
  const calls = [];
  const status = await schedule.remove({ ...env(await copyOfTheTool('here')), run: async (file, args) => { calls.push([file, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal(status.installed, false);
  assert.match(status.summary, /settings still cannot be read, and have been left as they are/);
  assert.ok(calls.some((c) => c.startsWith('launchctl bootout')), 'the scheduler was told');
  assert.equal(await readFile(configPath(), 'utf8'), '{"archiveDir": ', 'the damaged file is exactly as it was');
});

test('fs-5: a damaged Photos record is reported beside the switch, not taken for "this is not a Mac"', async () => {
  const dir = await freshConfigDir();
  await writeFile(join(dir, 'photos.json'), '{"added": {');
  const archiveDir = await mkdtemp(join(tmpdir(), 'cas-star-archive-'));
  const on = { ...DEFAULT_CONFIG, archiveDir, addToPhotos: true };
  const status = await photosStatus(on, { platform: 'darwin' });
  assert.equal(status.supported, true);
  assert.equal(status.enabled, true);
  assert.match(status.problem, /record of what has already been added to Photos .* cannot be read/);
  assert.equal((await photosStatus({ ...on, addToPhotos: false }, { platform: 'darwin' })).problem, null, 'off, it is nobody\'s problem yet');
  assert.equal((await photosStatus(on, { platform: 'linux' })).problem, null);
  const page = await readFile(fileURLToPath(new URL('../src/web/page.ts', import.meta.url)), 'utf8');
  assert.match(page, /if \(p\.enabled && p\.problem\)/);
});
