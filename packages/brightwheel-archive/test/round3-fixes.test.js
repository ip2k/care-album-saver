import '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyMetadata,
  BrightwheelClient,
  buildTags,
  DEFAULT_CONFIG,
  Secret,
  startMockBrightwheel,
  startWebUi,
  sync,
} from '../dist/index.js';
import { closeMetadata } from '../dist/metadata.js';
import { placeholderJpeg, placeholderMp4 } from '../dist/mock/fixtures.js';
import { assertIsolatedConfigDir, exifToolSkipReason } from '../../../scripts/test-env.js';

/**
 * The three fixes an independent audit of the merged lanes asked for that nothing was
 * watching. Each one is a case where the tool did the right thing in the ordinary path and
 * the wrong thing in the path nobody had walked:
 *
 *   - a page of the feed carrying no photos, while someone is pressing Ctrl+C
 *   - a .xmp sidecar that cannot be written, while the photo itself is fine
 *   - a stop arriving in the moment between "a run has started" and "the run has begun"
 */

const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';

const clientFor = (mock) =>
  new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });

const configFor = (dir, extra = {}) =>
  ({ ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0, includeStudents: [ROBIN], ...extra });

/**
 * False when ExifTool is here, the reason to skip when it is not. scripts/test-env.js holds
 * the policy, including why a CI runner that has lost the optional dependency fails rather
 * than skipping: a skipped metadata test reads as a pass and proves nothing.
 */
const exiftoolMissing = await exifToolSkipReason(() => import('exiftool-vendored'));

// ---------------------------------------------------------------- stopping, mid-listing

test('a stop is noticed on a page carrying no photos, not only between photos', async () => {
  // The feed is check-ins, naps and meals as well as media, and the walk deliberately does
  // not end at the first page without a photo. The abort used to be checked only inside
  // the per-photo loop — which such a page never enters — so Ctrl+C during a long stretch
  // of them kept listing page after page, at the politeness delay, after the CLI had
  // already said it was stopping.
  const mock = await startMockBrightwheel({
    validSession: SESSION,
    activitiesPerStudent: 40,
    leadingCheckIns: 250,
  });
  const dir = await mkdtemp(join(tmpdir(), 'bw-stop-listing-'));
  try {
    const stop = new AbortController();
    const seen = [];
    // Abort on the first listing event: at that moment the walk is in the check-in run and
    // has downloaded nothing, so only a page-level check can observe it.
    const result = await sync(
      clientFor(mock),
      configFor(dir, { organiseBy: 'week' }),
      (p) => {
        seen.push(p);
        if (p.phase === 'listing' && !stop.signal.aborted) stop.abort();
      },
      { allowTemporaryDir: true, signal: stop.signal },
    );

    assert.equal(result.stopped, true, 'the run reports that it was stopped');
    assert.equal(result.saved, 0, 'and it stopped before any photo was fetched');
    assert.equal(seen.filter((p) => p.phase === 'stopped').length, 1, 'said once');
    assert.equal(seen.at(-1).phase, 'stopped', 'and last');
    assert.ok(!seen.some((p) => p.phase === 'done'), 'a stopped run never claims to be done');

    // The proof that it stopped promptly: two listings, not the dozens the check-in run
    // would have taken to reach a page with a photo on it.
    const listings = mock.requests.filter((r) => r.path.endsWith('/activities')).length;
    assert.ok(listings <= 2, `expected the walk to stop listing at once, got ${listings} listings`);

    // Nothing was downloaded, so nothing may be claimed: the cut-off must not move.
    const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
    assert.deepEqual(manifest.state?.walkedThrough ?? {}, {});
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the sidecar nobody saw

test('a .xmp sidecar that cannot be written is reported by the run, not swallowed', { skip: exiftoolMissing }, async () => {
  // applyMetadata learned to report a failed sidecar honestly, but sync only passed on a
  // failure to embed, so with the sidecar option turned on the failure reached nobody. The
  // person had ticked a box and been told nothing when it did not happen.
  const mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 3 });
  const dir = await mkdtemp(join(tmpdir(), 'bw-sidecar-'));
  try {
    // A directory where the first .xmp must go. ExifTool cannot write over a directory, so
    // the sidecar fails while the photo itself is embedded exactly as usual.
    const probe = await sync(clientFor(mock), configFor(dir), () => {}, { allowTemporaryDir: true });
    assert.equal(probe.failed, 0, 'the plain run must succeed for this test to mean anything');
    assert.deepEqual(probe.warnings, [], 'and warn about nothing');

    const first = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8')).files[0].path;
    const blocked = await mkdtemp(join(tmpdir(), 'bw-sidecar-2-'));
    await mkdir(join(blocked, first.split('/').slice(0, -1).join('/')), { recursive: true });
    await mkdir(join(blocked, `${first}.xmp`), { recursive: true });

    const result = await sync(
      clientFor(mock),
      configFor(blocked, { writeSidecar: true }),
      () => {},
      { allowTemporaryDir: true },
    );

    assert.equal(result.failed, 0, 'the photo itself is fine');
    assert.ok(
      result.warnings.some((w) => /sidecar/i.test(w)),
      `expected a warning naming the sidecar, got ${JSON.stringify(result.warnings)}`,
    );
    await rm(blocked, { recursive: true, force: true });
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- stopping, at the start

let uiMock;
before(assertIsolatedConfigDir);
before(async () => { uiMock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 8 }); });
after(async () => { await uiMock?.close(); });

const PHOTOS_ROOT = fileURLToPath(new URL('../../../node_modules/.cache/bw-round3-test/', import.meta.url));
after(async () => { await rm(PHOTOS_ROOT, { recursive: true, force: true }); });

test('a stop that arrives in the instant a run is starting still stops it', async () => {
  // The handler marked the run as running, then read the config file — an await — and only
  // then published the handle that a stop needs. A stop landing in that gap was told
  // "nothing is running", and a close() in that gap returned at once and took the server
  // down with the run still going and the manifest unwritten.
  process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'bw-race-'));
  delete process.env.BRIGHTWHEEL_SESSION;
  assertIsolatedConfigDir();

  const photos = join(PHOTOS_ROOT, 'run-1');
  await mkdir(photos, { recursive: true });

  const handle = await startWebUi({ baseUrl: `${uiMock.url}/api/v1` });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await call('/api/session', { cookie: SESSION })).status, 200);
    assert.equal((await call('/api/config', { archiveDir: photos })).status, 200);

    const started = await call('/api/sync', {});
    assert.equal(started.status, 202);

    // No waiting, no polling: the very next request is the stop. What makes this test
    // discriminating is the ORDER inside the handler, not the timing out here — the run's
    // "202 accepted" is only written after the thing a stop needs has been published, so
    // there is no instant in which a client can hold a 202 and be told nothing is running.
    // (Confirmed by moving the 202 back above that publication: this assertion then sees
    // the 409 the bug produced.)
    const stopped = await call('/api/stop', {});
    assert.equal(stopped.status, 202, 'a run that has just started is a run that can be stopped');
    assert.equal(stopped.body.ok, true);

    // And it really stopped, rather than merely being told to.
    const deadline = Date.now() + 20000;
    let state;
    do {
      state = (await call('/api/state')).body;
      if (!state.running) break;
      await new Promise((r) => setTimeout(r, 25));
    } while (Date.now() < deadline);
    assert.equal(state.running, false, 'the run ended');
    assert.equal(state.progress.phase, 'stopped', 'and ended as a stop, not as an error or a full run');

    // close() waits for the run, so the manifest is on disk by the time it returns.
    await handle.close();
    const manifest = JSON.parse(await readFile(join(photos, 'archive.json'), 'utf8'));
    assert.ok(Array.isArray(manifest.files), 'the manifest was written before the server went away');
  } finally {
    await handle.close().catch(() => {});
  }
});

// ---------------------------------------------------------------- what "no names" means

/**
 * The switch reads, to a parent, as "do not make this photo self-identifying". It used to
 * govern only the child's name, while the nursery's name and the name of whoever posted the
 * photo went in regardless — so a file shared with the switch off still said which nursery
 * the child attends. All three now follow the same switch.
 */
const NAMED = {
  student: { id: 'stu-x', firstName: 'Robin', lastName: 'Maple', fullName: 'Robin Maple', schoolName: 'Sunnybrook Early Learning' },
  activity: {
    id: 'act-1',
    studentId: 'stu-x',
    capturedAt: new Date('2026-09-18T09:15:00'),
    note: 'Water play in the garden.',
    url: 'https://example.invalid/a.jpg',
    kind: 'image',
    author: 'Ms. Alvarez',
  },
  /**
   * The three names the switch governs, and the note — which has a switch of its own but
   * is governed by this one as well, because a note routinely names the child, the room
   * and the teacher in one sentence.
   */
  names: ['Robin', 'Sunnybrook', 'Alvarez'],
  note: 'Water play',
};

const namedInput = (kind, tagChildName, filePath = '/dev/null') => ({
  filePath,
  activity: { ...NAMED.activity, kind },
  student: NAMED.student,
  tagChildName,
  tagNote: true,
  stripLocation: true,
  writeSidecar: false,
});

test('turning the names off keeps all three out of the tags that would be written', () => {
  for (const kind of ['image', 'video']) {
    const off = JSON.stringify(buildTags(namedInput(kind, false)));
    for (const name of NAMED.names) assert.ok(!off.includes(name), `${kind}: ${name} must not be written`);
    assert.ok(!off.includes(NAMED.note), `${kind}: nor the note, which names all three at once`);

    const on = JSON.stringify(buildTags(namedInput(kind, true)));
    for (const name of NAMED.names) assert.ok(on.includes(name), `${kind}: ${name} belongs there with the switch on`);
    assert.ok(on.includes(NAMED.note), `${kind}: and so does the note, with both switches on`);
  }
});

test('turning the names off leaves no name of any kind inside the file', { skip: exiftoolMissing }, async () => {
  // The test above reads the tag object buildTags hands back, which is a plan and not a
  // file. This one is the claim in the title: a real JPEG and a real MP4 are written by the
  // same code a run uses, and the bytes on disk are searched for each name. A tag table that
  // omitted a name while ExifTool wrote it anyway — from a template, a duplicate group, an
  // MWG fan-out — would pass the first test and fail this one.
  const { ExifTool } = await import('exiftool-vendored');
  const reader = new ExifTool();
  const dir = await mkdtemp(join(tmpdir(), 'bw-names-'));
  try {
    for (const kind of ['image', 'video']) {
      const id = kind === 'video' ? 'act-111-0005' : 'act-111-0000';
      for (const tagChildName of [false, true]) {
        const file = join(dir, `${kind}-${tagChildName}.${kind === 'video' ? 'mp4' : 'jpg'}`);
        await writeFile(file, kind === 'video' ? placeholderMp4(id) : placeholderJpeg(id));
        const outcome = await applyMetadata(namedInput(kind, tagChildName, file));
        assert.equal(outcome.embedded, true, `${kind}: ${outcome.reason ?? 'nothing was embedded'}`);

        const bytes = await readFile(file);
        // Both encodings a metadata block may use. A name hidden as UTF-16 is still a name.
        const inFile = (text) =>
          bytes.includes(Buffer.from(text, 'utf8')) || bytes.includes(Buffer.from(text, 'utf16le'));
        // And what a gallery reads, which is not always what a byte search finds.
        const tags = JSON.stringify(await reader.readRaw(file, { readArgs: ['-G1', '-a'] }));

        for (const name of NAMED.names) {
          assert.equal(inFile(name), tagChildName, `${kind}, switch ${tagChildName}: "${name}" in the bytes`);
          assert.equal(tags.includes(name), tagChildName, `${kind}, switch ${tagChildName}: "${name}" in the tags`);
        }
        // The note follows the names switch as well: it is the field most likely to name
        // the child, the room and the teacher in one sentence.
        assert.equal(inFile(NAMED.note), tagChildName, `${kind}, switch ${tagChildName}: the note in the bytes`);
        // Dates go in whatever the switch says, which is also what shows the write happened
        // at all rather than the file being left exactly as the mock served it.
        assert.ok(tags.includes('2026'), `${kind}: the capture date is written either way`);
      }
    }
  } finally {
    await reader.end();
    await closeMetadata();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- where photos may land

test('a config nobody gave a folder to cannot archive into the real home directory', () => {
  // DEFAULT_CONFIG.archiveDir is defaultArchiveDir(), so any code that builds a config
  // without naming a folder — a test, or a throwaway script — used to archive straight into
  // ~/Brightwheel Photos. It happened three times on 2026-09-22, each time from code whose
  // author believed the config-directory isolation covered it. It does not: they are two
  // different directories, and now two different variables.
  const dir = DEFAULT_CONFIG.archiveDir;
  assert.equal(dir, process.env.BRIGHTWHEEL_ARCHIVE_DIR, 'the test run redirects the default');
  assert.notEqual(dir, join(homedir(), 'Brightwheel Photos'));
  assert.ok(!dir.startsWith(homedir() + '/Brightwheel'), 'and never the real photos folder');
});
