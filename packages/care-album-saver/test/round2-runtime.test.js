import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  BrightwheelClient,
  DEFAULT_CONFIG,
  Secret,
  applyMetadata,
  startMockBrightwheel,
  sync,
  writeSecureFile,
} from '../dist/index.js';
import { closeMetadata } from '../dist/metadata.js';
import { placeholderJpeg } from '../dist/mock/fixtures.js';
import { Manifest } from '../dist/ferry/index.js';
import { exifToolSkipReason } from '../../../scripts/test-env.js';

/**
 * Stopping a run on purpose, and the three ways a run used to mislead the person watching
 * it: a failure told twice, a failure not told at all, and a guess about the outside world
 * (a CDN's `expires=`, a platform's path separator) charged to the account or to the
 * archive's portability.
 *
 * Every mock here is per-test, as in sync-resilience.test.js: the failure modes are
 * stateful, and a shared server would let one test's request counter decide another's.
 */

const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const clientFor = (mock) =>
  new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });

const configFor = (dir, extra = {}) =>
  ({ ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0, includeStudents: [ROBIN], ...extra });

const run = (mock, dir, extra = {}, onProgress = () => {}, options = {}) =>
  sync(clientFor(mock), configFor(dir, extra), onProgress, { allowTemporaryDir: true, ...options });

const listings = (mock, page) =>
  mock.requests.filter(
    (r) => r.path.endsWith('/activities') && (page === undefined || new URLSearchParams(r.search).get('page') === String(page)),
  ).length;
const mediaRequests = (mock) => mock.requests.filter((r) => r.path.startsWith('/media/')).length;
const manifestOf = async (dir) => JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
/** How many progress events of one phase have arrived so far. */
const soFar = (progress, phase) => progress.filter((p) => p.phase === phase).length;

/**
 * False when ExifTool is here, and the reason when it is not. Handed to node:test's `skip`
 * option below rather than decided inside a test body, so the reason is declared up front
 * rather than reached on one path and not another. (Node counts an in-body `t.skip()` as
 * skipped too — the option is about clarity, not about the totals.) What stops a machine
 * without the optional dependency from printing a green run that examined no metadata is
 * scripts/test-env.js, which turns these skips into failures on CI.
 */
const exiftoolMissing = await exifToolSkipReason(() => import('exiftool-vendored'));

// ---------------------------------------------------------------- stopping on purpose

test('a run stopped mid-download keeps what it saved and leaves the cut-off where it was', async () => {
  const mock = await startMockBrightwheel({ activitiesPerStudent: 23, maxPageSize: 10 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-stop-'));
    const stop = new AbortController();
    const progress = [];

    // The stop arrives while the fifth photo is being fetched. That one finishes — a
    // half-written file helps nobody — and the sixth never starts.
    const result = await run(
      mock,
      dir,
      { incremental: true },
      (p) => {
        progress.push(p);
        if (p.phase === 'downloading' && soFar(progress, 'downloading') === 5) stop.abort();
      },
      { signal: stop.signal },
    );

    assert.equal(result.stopped, true, 'a stop is an ending, not a rejection');
    assert.equal(result.saved, 5);
    assert.equal(result.failed, 0, result.warnings.join('; '));

    const stopped = progress.filter((p) => p.phase === 'stopped');
    assert.equal(stopped.length, 1, 'said exactly once');
    assert.equal(progress.at(-1), stopped[0], 'and last: nothing follows a stop');
    assert.equal(soFar(progress, 'done'), 0, 'a stopped run never claims to have finished');
    assert.equal(
      stopped[0].message,
      'Stopped. 5 item(s) saved so far are kept; run again to carry on where it left off.',
    );
    assert.equal(stopped[0].saved, 5);
    assert.equal(stopped[0].failed, 0);

    // On disk, not merely in the returned counts: five is below the periodic-save
    // threshold of 25, so only the save on the way out can have written these.
    const manifest = await manifestOf(dir);
    assert.equal(manifest.files.length, 5);
    for (const record of manifest.files) await access(join(dir, ...record.path.split('/')));

    // The interrupted walk holds the newest five posts and nothing older. Taking its
    // newest as the floor would skip the rest of that feed on every later run.
    assert.deepEqual(manifest.state.walkedThrough, {});

    // Which is the whole point: running again finds everything the stop left behind.
    const second = await run(mock, dir, { incremental: true });
    assert.equal(second.stopped, false);
    assert.equal(second.saved, 18);
    assert.equal(second.skipped, 5);
    assert.deepEqual(Object.keys((await manifestOf(dir)).state.walkedThrough), [ROBIN], 'a finished walk does move it');
  } finally {
    await mock.close();
  }
});

test('a signal that has already aborted stops the run before it downloads anything', async () => {
  const mock = await startMockBrightwheel({ activitiesPerStudent: 6 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-stop-early-'));
    const stop = new AbortController();
    stop.abort();
    const progress = [];
    const result = await run(mock, dir, {}, (p) => progress.push(p), { signal: stop.signal });

    assert.equal(result.stopped, true);
    assert.equal(result.saved, 0);
    assert.equal(mediaRequests(mock), 0, 'nothing was fetched');
    assert.equal(soFar(progress, 'stopped'), 1);
    assert.equal((await manifestOf(dir)).files.length, 0, 'and an empty manifest is still written');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------- failures, told once and truthfully

test('a manifest that cannot be saved is reported, not left as a stalled progress bar', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX file modes do not exist on Windows');
  const mock = await startMockBrightwheel({ activitiesPerStudent: 3 });
  const dir = await mkdtemp(join(tmpdir(), 'bw-readonly-'));
  try {
    const progress = [];
    // Read-only from the last download onwards. The photos are already inside their week
    // folder, which stays writable; it is the manifest at the archive root that cannot be
    // written — what a disk filling up at the worst moment looks like from in here.
    await assert.rejects(
      () =>
        run(mock, dir, {}, (p) => {
          progress.push(p);
          if (p.phase === 'downloading' && soFar(progress, 'downloading') === 3) chmodSync(dir, 0o500);
        }),
      (error) => /EACCES|EPERM/.test(error.message),
    );

    const last = progress.at(-1);
    assert.equal(last.phase, 'error', 'a polling UI must not be left on the last "Saving…" line');
    assert.match(last.message, /could not be written/);
    assert.equal(last.saved, 3, 'with the counts it had reached');
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await mock.close();
  }
});

// ---------------------------------------------------------------- an expiry that is not a time

/**
 * A CDN whose `expires=` counts seconds of life rather than seconds since 1970.
 *
 * Both are real conventions and the parameter does not say which it is, so a lifetime of
 * 900 reads as a moment in January 1970 — permanently expired. The fresh listing that
 * follows says the same thing about every URL on it, which is why the re-fetch has to be
 * budgeted rather than repeated. Overriding the single-page fetch as well as the walk is
 * the point: a real CDN does not change its convention when asked a second time.
 */
class RelativeExpiry extends BrightwheelClient {
  async activitiesPage(studentId, page, opts) {
    const fetched = await super.activitiesPage(studentId, page, opts);
    return { ...fetched, items: fetched.items.map((i) => ({ ...i, url: i.url.replace(/expires=\d+/, 'expires=900') })) };
  }
}

test('an expiry parameter that cannot be read costs one listing per page, not one per photo', async () => {
  const mock = await startMockBrightwheel({ activitiesPerStudent: 4 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-relative-expiry-'));
    const client = new RelativeExpiry({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
    const result = await sync(client, configFor(dir), () => {}, { allowTemporaryDir: true });

    assert.equal(result.saved, 4);
    assert.equal(result.failed, 0, result.warnings.join('; '));
    assert.equal(listings(mock, 0), 2, 'the walk, and one re-fetch on the claim of expiry — never a third');
    assert.equal(mediaRequests(mock), 4, 'and the CDN, which knows, was left to refuse if it wanted to');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------- a path a Windows archive can carry

test('recorded paths use forward slashes, and a lookup accepts either slash', async () => {
  const mock = await startMockBrightwheel({ activitiesPerStudent: 4 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-paths-'));
    await run(mock, dir);
    const manifest = await manifestOf(dir);
    assert.equal(manifest.files.length, 4);
    for (const record of manifest.files) {
      assert.ok(!record.path.includes('\\'), `${record.path} carries a separator only Windows understands`);
      assert.match(record.path, /^Robin-Maple\/\d{4}-W\d{2}\/[^/]+$/);
      // And splitting on the one separator the manifest promises names a real file.
      await access(join(dir, ...record.path.split('/')));
    }

    // The manifest travels with the archive, so a record written by a run on Windows — and
    // a reader asking in Windows terms — must both land on the file the Mac sees.
    const reopened = await Manifest.open(dir, 'brightwheel');
    const [first] = manifest.files;
    assert.ok(reopened.findByPath(first.path.replaceAll('/', '\\')), 'a backslash lookup finds the record');
    assert.ok(reopened.findByPath(first.path), 'and so does a forward-slash one');
    const added = reopened.add({
      path: 'Sam-Maple\\2026-W38\\2026-09-18_153000_deadbeef.jpg',
      sourceId: 'brightwheel:act-bbb-9999',
      transferId: null,
      bytes: 1,
      sha256: 'f'.repeat(64),
    });
    assert.equal(added.path, 'Sam-Maple/2026-W38/2026-09-18_153000_deadbeef.jpg', 'normalised on the way in');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------- the .xmp sidecar

test('with the .xmp sidecar on, one is written for every file and reported as written', { skip: exiftoolMissing }, async () => {
  const mock = await startMockBrightwheel({ activitiesPerStudent: 4 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-xmp-'));
    const result = await run(mock, dir, { writeSidecar: true });
    assert.equal(result.saved, 4);
    assert.deepEqual(result.warnings, [], 'nothing degraded, so nothing to warn about');

    const manifest = await manifestOf(dir);
    for (const record of manifest.files) {
      const file = join(dir, ...record.path.split('/'));
      const xmp = await readFile(`${file}.xmp`, 'utf8');
      assert.match(xmp, /<x:xmpmeta/, 'a real XMP packet');
      assert.match(xmp, /Robin Maple/, 'carrying what the file itself carries');
      // An .xmp holds XMP and nothing else; the EXIF and QuickTime fields have no home there.
      assert.doesNotMatch(xmp, /DateTimeOriginal/);
    }
  } finally {
    await mock.close();
  }
});

test('an .xmp sidecar that cannot be written is reported as such, and the photo still is embedded', { skip: exiftoolMissing }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-xmp-fail-'));
  const file = join(dir, 'a.jpg');
  await writeFile(file, placeholderJpeg('act-111-0000'));
  // A folder where the sidecar has to go: ExifTool cannot write that path, whatever it
  // does with the photo. Before this, the failure was swallowed and the result claimed
  // both had been written.
  await mkdir(`${file}.xmp`);
  try {
    const outcome = await applyMetadata({
      filePath: file,
      activity: {
        id: 'act-111-0000',
        studentId: ROBIN,
        postedAt: new Date('2026-09-17T18:14:55Z'),
        note: 'Water play in the garden this morning.',
        url: 'https://cdn.example/a.jpg',
        author: 'Ms. Alvarez',
        kind: 'image',
      },
      student: { id: ROBIN, firstName: 'Robin', lastName: 'Maple', fullName: 'Robin Maple', schoolName: 'Example Care Provider' },
      tagChildName: true,
      tagNote: true,
      stripLocation: true,
      writeSidecar: true,
    });

    assert.equal(outcome.embedded, true, 'the photo itself was written and must not be disowned');
    assert.equal(outcome.sidecar, true, 'the JSON sidecar needs no external tool');
    assert.equal(outcome.xmpSidecar, false);
    assert.match(outcome.reason, /\.xmp sidecar was not written/);
  } finally {
    await closeMetadata();
  }
});

// ---------------------------------------------------------------- the command line

/**
 * Somewhere a real `run` will agree to archive into.
 *
 * It refuses a temporary folder, correctly — the operating system empties those — so a
 * test of the actual command cannot hand it `mkdtemp()`. `node_modules` is ignored by git,
 * is not judged temporary, and the test removes what it puts there.
 */
async function cliArchiveDir() {
  const dir = join(REPO_ROOT, 'node_modules', '.cache', `bw-cli-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function signedInConfigDir(config) {
  const dir = await mkdtemp(join(tmpdir(), 'bw-cli-config-'));
  await writeSecureFile(join(dir, 'session.json'), JSON.stringify({ cookie: SESSION, savedAt: new Date().toISOString() }));
  if (config) await writeSecureFile(join(dir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...config }));
  return dir;
}

test('`run` stops on Ctrl+C, says so in words, and exits as the success it is', async (t) => {
  if (process.platform === 'win32') return t.skip('Ctrl+C cannot be delivered to a child process on Windows');
  const mock = await startMockBrightwheel({ activitiesPerStudent: 23, maxPageSize: 10 });
  const archive = await cliArchiveDir();
  const configDir = await signedInConfigDir();
  try {
    const child = spawn(process.execPath, [CLI, 'run', '--dir', archive, '--base-url', `${mock.url}/api/v1`], {
      env: { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir },
    });
    let out = '';
    let interrupted = false;
    child.stdout.on('data', (chunk) => {
      out += chunk;
      // The first line is printed before the first request, and the politeness delay
      // between requests leaves the better part of a second afterwards, so the interrupt
      // lands in a run that is genuinely under way rather than in a race with its start.
      if (!interrupted && out.includes('Checking your Brightwheel session')) {
        interrupted = true;
        child.kill('SIGINT');
      }
    });
    const code = await new Promise((resolve) => child.on('close', resolve));

    assert.equal(code, 0, `a stop the parent asked for is not a failure:\n${out}`);
    assert.match(out, /Stopping after the current photo…/);
    assert.match(out, /Stopped\. \d+ item\(s\) saved so far are kept/);
    assert.match(out, /Run the same command again to carry on where it left off\./);
    assert.doesNotMatch(out, /^\s*Done\./m, 'and it does not also claim to have finished');
  } finally {
    await rm(archive, { recursive: true, force: true });
    await mock.close();
  }
});

test('`run` stops the same careful way on SIGTERM, which is how the scheduler says stop', async (t) => {
  // Turning the daily run off, changing its time or reinstalling it sends SIGTERM to a run
  // in progress. Node's default was to die on the spot: the list of what had been saved
  // since the last 25 was lost, and the next run fetched those photos again as copies.
  if (process.platform === 'win32') return t.skip('POSIX signals cannot be delivered to a child process on Windows');
  const mock = await startMockBrightwheel({ activitiesPerStudent: 23, maxPageSize: 10 });
  const archive = await cliArchiveDir();
  const configDir = await signedInConfigDir();
  try {
    const child = spawn(process.execPath, [CLI, 'run', '--dir', archive, '--base-url', `${mock.url}/api/v1`], {
      env: { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir },
    });
    let out = '';
    let terminated = false;
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (!terminated && out.includes('Checking your Brightwheel session')) {
        terminated = true;
        child.kill('SIGTERM');
      }
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, `a stop is not a failure:\n${out}`);
    assert.match(out, /Stopping after the current photo…/);
    assert.match(out, /Stopped\. \d+ item\(s\) saved so far are kept/);
  } finally {
    await rm(archive, { recursive: true, force: true });
    await mock.close();
  }
});

test('a mid-run failure is printed once, not once as progress and again as a crash', async () => {
  // me, students and page 0 are served; the session is dead by page 1, ten photos in.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 23, maxPageSize: 10, expireSessionAfterRequests: 3 });
  const archive = await cliArchiveDir();
  const configDir = await signedInConfigDir({ delayMs: 0, archiveDir: archive });
  try {
    const { code, stdout } = await promisify(execFile)(
      process.execPath,
      [CLI, 'run', '--dir', archive, '--base-url', `${mock.url}/api/v1`],
      { env: { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir } },
    ).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (error) => ({ code: error.code, stdout: error.stdout ?? '' }),
    );

    assert.equal(code, 1);
    assert.equal((stdout.match(/sign in again/g) ?? []).length, 1, `said twice:\n${stdout}`);
    assert.match(stdout, /10 items saved before this are kept/, 'and the one telling is the useful one');
  } finally {
    await rm(archive, { recursive: true, force: true });
    await mock.close();
  }
});

test('a run that fails on every photo prints its refusals with the signature already stripped', async () => {
  // A signed URL is a bearer credential for that file, and the session is worse.
  //
  // The title used to say "still prints no credential" and the comment claimed this pinned
  // the progress printer's scrub(). It did not, and saying so was the problem: in this
  // scenario the credential never reaches the printer. src/ferry's redactUrl() rewrites
  // the URL as it builds the DownloadError, so what the CLI is handed is redacted before it
  // is printed, and removing scrub() from the printer leaves this test green. A test cited
  // as proof of a layer it does not touch is worse than no test.
  //
  // So this now names the layer it really pins: the redaction inside the download error,
  // checked by its result rather than by the absence of a signature — absence would also
  // hold if the URL were dropped entirely, or if nothing were printed at all. `Secret`'s
  // unprintability is pinned in integration.test.js ('a Secret cannot be printed by
  // accident'), and scrub()'s own pattern table there too ('scrub catches credentials that
  // leaked into free text'). The printer's scrub() is a backstop for the day some future
  // error message arrives carrying one; nothing here exercises it, and nothing here says it
  // does.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 3, mediaUrlExpiresAfterRequests: 0 });
  const archive = await cliArchiveDir();
  const configDir = await signedInConfigDir({ delayMs: 0, archiveDir: archive });
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [CLI, 'run', '--dir', archive, '--base-url', `${mock.url}/api/v1`],
      { env: { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir } },
    ).catch((error) => ({ stdout: error.stdout ?? '' }));

    assert.match(stdout, /HTTP 403/, 'the refusals were reported');
    // Every refusal names its file in the form redactUrl() produces: the origin and path
    // kept, so the parent can see which photo it was, and the whole query gone. Six photos,
    // six lines; a layer that stopped redacting would print the signature instead.
    const redacted = stdout.match(/HTTP 403 for \S+/g) ?? [];
    assert.equal(redacted.length, 6, `expected one line per photo, got:\n${stdout}`);
    for (const line of redacted) {
      assert.match(line, /\/media\/act-\d+-\d+\.jpg\?<redacted>$/, line);
    }
    assert.ok(!/signature=[^&\s]+/.test(stdout), 'a signature must never reach the terminal');
    assert.ok(!stdout.includes(SESSION), 'nor the session');
  } finally {
    await rm(archive, { recursive: true, force: true });
    await mock.close();
  }
});
