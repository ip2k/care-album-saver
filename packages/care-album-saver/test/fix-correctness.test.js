import '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import {
  ApiShapeError,
  BrightwheelClient,
  DEFAULT_CONFIG,
  Secret,
  parseActivities,
  startMockBrightwheel,
  startWebUi,
  sync,
  validateExtraction,
} from '../dist/index.js';
import { PAGES_PAST_THE_CUT_OFF } from '../dist/api/client.js';
import { hashFile, Manifest } from '../dist/ferry/index.js';
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';

/**
 * The ways a run could quietly lose a photo, or quietly claim to have saved one.
 *
 * Every test here stands for a failure that leaves no trace a parent would notice: a walk
 * that stops above the photos it came for, a page limit that passes for the end of a feed,
 * a manifest thrown away and rebuilt as duplicates, two runs writing one archive, a gate
 * that can never fire, one dead photo blocking every future run, and a checksum that
 * describes a file that no longer exists.
 */

const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';

const clientFor = (mock) =>
  new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });

const configFor = (dir, extra = {}) => ({
  ...DEFAULT_CONFIG,
  archiveDir: dir,
  incremental: false,
  delayMs: 0,
  includeStudents: [ROBIN],
  ...extra,
});

const run = (mock, dir, extra = {}, onProgress = () => {}) =>
  sync(clientFor(mock), configFor(dir, extra), onProgress, { allowTemporaryDir: true });

const manifestOf = async (dir) => JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));

let exiftoolMissing = false;
try {
  await import('exiftool-vendored');
} catch (error) {
  exiftoolMissing = `exiftool-vendored did not load; it is an optional dependency: ${error.message}`;
}

// ------------------------------------------------- the walk that stopped too early

test('an incremental walk does not stop at a back-dated batch', async () => {
  // The feed is ordered by upload time; the cut-off is a capture time. Three photos taken
  // two months ago and uploaded this morning fill page 0, and every photo the run actually
  // came for is underneath them. Stopping at the first page that is entirely older than
  // the cut-off ends the walk there — and since such a run saves nothing new, the cut-off
  // never moves either, so no later run reaches them. That is a photo lost for good.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 6, backDatedUploads: 3, maxPageSize: 3 });
  try {
    const cutOff = new Date('2026-09-01T00:00:00Z');
    const pages = [];
    for await (const page of clientFor(mock).activityPages(ROBIN, { stopBefore: cutOff })) pages.push(page);

    const first = pages[0].items;
    assert.equal(first.length, 3, 'page 0 is the back-dated batch');
    assert.ok(first.every((i) => i.postedAt < cutOff), 'and every one of them is older than the cut-off');

    const newer = pages.flatMap((p) => p.items).filter((i) => i.postedAt > cutOff);
    assert.equal(newer.length, 6, 'the six photos below the batch were still reached');
    assert.ok(pages.length > 1, `the walk read ${pages.length} page(s)`);
  } finally {
    await mock.close();
  }
});

test('the walk still stops, a bounded number of pages past the cut-off', async () => {
  // The other half of the same trade: keeping going must not turn into reading the whole
  // feed every night. Nothing here is newer than the cut-off, so every page votes to stop.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 40, maxPageSize: 2 });
  try {
    const pages = [];
    for await (const page of clientFor(mock).activityPages(ROBIN, { stopBefore: new Date('2030-01-01') })) {
      pages.push(page);
    }
    assert.equal(pages.length, PAGES_PAST_THE_CUT_OFF, 'exactly the lookback, then it stops');
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------- the page limit that passed for the end

test('a walk cut short by the page limit does not move the cut-off', async () => {
  // maxPages ends the generator exactly like the end of a feed. Treated as a finished walk,
  // the cut-off moves to the newest post this run saw, and every post below the limit is
  // skipped by every run from then on: they are older than the cut-off and never listed.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 23, maxPageSize: 10 });
  try {
    class ShortWalk extends BrightwheelClient {
      async *activityPages(studentId, opts) {
        yield* super.activityPages(studentId, { ...opts, maxPages: 2 });
      }
    }
    const client = new ShortWalk({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
    const dir = await mkdtemp(join(tmpdir(), 'bw-truncated-'));
    const result = await sync(client, configFor(dir, { incremental: true }), () => {}, { allowTemporaryDir: true });

    assert.equal(result.saved, 20, 'the two pages it did read are saved');
    assert.deepEqual((await manifestOf(dir)).state.walkedThrough, {}, 'but that feed is not finished');
    assert.ok(
      result.warnings.some((w) => /longer than this tool reads in one go/.test(w)),
      `the person is told, in words: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(result.warnings.some((w) => w.includes('stopped after 2 pages')), 'and where it stopped');

    // The proof that it is not silently lost: the next run starts from the top again.
    const second = await sync(client, configFor(dir, { incremental: true }), () => {}, { allowTemporaryDir: true });
    assert.equal(second.skipped, 20, 'it walked the same stretch again rather than stepping over it');
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------- the manifest that was thrown away

test('an archive.json that cannot be read stops the run instead of being replaced', async () => {
  const mock = await startMockBrightwheel({ activitiesPerStudent: 3 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-manifest-bad-'));
    // What a full disk or a killed process leaves behind: a truncated file.
    const damaged = '{"schema": 2, "files": [{"path": "Robin-Maple/2026-W38/a.jpg", "sha2';
    await writeFile(join(dir, 'archive.json'), damaged, 'utf8');

    await assert.rejects(
      () => run(mock, dir),
      (error) => {
        assert.equal(error.name, 'ManifestUnusableError');
        assert.match(error.message, /archive\.json/, 'names the file');
        assert.match(error.message, /Nothing has been changed/, 'and says nothing was touched');
        assert.match(error.message, /Move that file somewhere safe/, 'and what to do about it');
        return true;
      },
    );

    assert.equal(await readFile(join(dir, 'archive.json'), 'utf8'), damaged, 'the file is exactly as it was');
    const entries = (await readdir(dir)).filter((f) => f !== 'archive.json');
    assert.deepEqual(entries, [], 'and not one photo was downloaded over the top of it');
  } finally {
    await mock.close();
  }
});

test('a manifest from a newer version of the tool is refused, never downgraded', async () => {
  const mock = await startMockBrightwheel({ activitiesPerStudent: 3 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-manifest-new-'));
    const future = JSON.stringify({ schema: 99, source: 'brightwheel', files: [], state: { walkedThrough: {} } });
    await writeFile(join(dir, 'archive.json'), future, 'utf8');

    await assert.rejects(
      () => run(mock, dir),
      (error) => {
        assert.equal(error.name, 'ManifestUnusableError');
        assert.match(error.message, /newer version of this tool/);
        return true;
      },
    );
    assert.equal(await readFile(join(dir, 'archive.json'), 'utf8'), future, 'left alone for that newer version');
  } finally {
    await mock.close();
  }
});

test('no archive.json at all is an ordinary first run', async () => {
  // The distinction this rests on: absent is fine, present-but-unusable is not.
  const dir = await mkdtemp(join(tmpdir(), 'bw-manifest-none-'));
  const manifest = await Manifest.open(dir, 'brightwheel');
  assert.equal(manifest.size, 0);
  assert.deepEqual(manifest.state, {});
});

// ------------------------------------------------- two runs over one archive

test('two Start clicks in the same instant start one run, not two', async () => {
  // The handler checked `running` before reading the session file and set it afterwards, so
  // two POSTs landing either side of that await both passed. Two syncs then wrote the same
  // archive and the same manifest at once, and the second one's save overwrote the first's
  // record of what it had saved.
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'bw-two-starts-'));
  delete process.env.CARE_ALBUM_SESSION;
  assertIsolatedConfigDir();

  const photos = join(PHOTOS_ROOT, 'two-starts');
  await mkdir(photos, { recursive: true });
  const handle = await startWebUi({ baseUrl: `${uiMock.url}/api/v1` });
  /**
   * One request on a connection of its own.
   *
   * `fetch` pools connections per origin and sends these one after another, which is
   * exactly the interleaving the bug needs and never gets — with `fetch` this test passes
   * against the bug. A fresh socket each time (`agent: false`) lets both requests be in the
   * handler at once, which is what a parent double-clicking Start produces.
   */
  const call = (path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: handle.port,
          path,
          method: payload === undefined ? 'GET' : 'POST',
          agent: false,
          headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            text += c;
          });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  try {
    assert.equal((await call('/api/session', { cookie: SESSION })).status, 200);
    assert.equal((await call('/api/config', { archiveDir: photos })).status, 200);

    const [a, b] = await Promise.all([call('/api/sync', {}), call('/api/sync', {})]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [202, 409], 'one run accepted, one refused');

    await handle.stop();
    const manifest = JSON.parse(await readFile(join(photos, 'archive.json'), 'utf8'));
    const paths = manifest.files.map((f) => f.path);
    assert.equal(new Set(paths).size, paths.length, 'and no photo was saved twice');
  } finally {
    await handle.close().catch(() => {});
  }
});

// ------------------------------------------------- the gate that could never fire

test('a page of photos with no readable date is refused, not read as an empty feed', async () => {
  // The documented extraction gate could not fire: the parser threw on exactly the items
  // the gate looked for, so they never reached it. This is the shape Brightwheel renaming
  // event_date would produce, and reading it as "no photos" would report "you are up to
  // date" every night for ever.
  const renamed = {
    count: 2,
    activities: [
      { object_id: 'act-1', action_type: 'ac_photo', taken_at: '2026-09-18T15:30:00Z', media: { image_url: 'https://cdn.example/a.jpg' } },
      { object_id: 'act-2', action_type: 'ac_photo', taken_at: '2026-09-18T16:30:00Z', media: { image_url: 'https://cdn.example/b.jpg' } },
    ],
  };

  const parsed = parseActivities(renamed, ROBIN);
  assert.deepEqual(parsed.items, [], 'nothing is filed under a guessed date');
  assert.equal(parsed.undated, 2, 'and the two are counted rather than dropped');

  const check = validateExtraction(parsed.items, 0, parsed.undated);
  assert.equal(check.status, 'suspicious', 'the gate fires');
  assert.match(check.message, /no date this tool could read/);

  // And the client acts on it rather than returning an empty page.
  const client = new BrightwheelClient({
    session: new Secret(SESSION),
    delayMs: 0,
    fetchImpl: async () =>
      new Response(JSON.stringify(renamed), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    () => client.activitiesPage(ROBIN, 0),
    (error) => {
      assert.ok(error instanceof ApiShapeError);
      assert.match(error.message, /2 posts on page 0/);
      return true;
    },
  );
});

// ------------------------------------------------- one dead photo, every future run

test('a photo Brightwheel no longer has stops blocking every later run', async () => {
  // A failed item holds the cut-off back so the next run retries it. For a post deleted on
  // Brightwheel's side that never ends: the feed is re-listed in full, for ever, to fail on
  // the same item again. It is written down instead.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 4, missingMediaIds: ['act-111-0002'] });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-gone-'));
    const first = await run(mock, dir, { incremental: true });
    assert.equal(first.saved, 3);
    assert.equal(first.failed, 1, 'it is still counted as a failure, not hidden');
    assert.ok(
      first.warnings.some((w) => /Brightwheel no longer has this one/.test(w)),
      `told in plain words: ${JSON.stringify(first.warnings)}`,
    );

    const manifest = await manifestOf(dir);
    assert.deepEqual(Object.keys(manifest.state.unavailable), ['brightwheel:act-111-0002']);
    assert.equal(manifest.state.unavailable['brightwheel:act-111-0002'].reason, 'HTTP 404');
    assert.ok(!JSON.stringify(manifest.state.unavailable).includes('signature='), 'and no signed URL with it');
    assert.deepEqual(
      Object.keys(manifest.state.walkedThrough),
      [ROBIN],
      'the cut-off moves, because no later run can cure this one',
    );
  } finally {
    await mock.close();
  }
});

test('a failure a retry could cure still holds the cut-off back', async () => {
  // The other side of that judgement: a refusal may well work next time, so it must keep
  // the window open. Every signature here is dead on arrival, so every item is refused.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 3, mediaUrlExpiresAfterRequests: 0 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-retryable-'));
    const result = await run(mock, dir, { incremental: true });
    assert.equal(result.failed, 3);
    const manifest = await manifestOf(dir);
    assert.deepEqual(manifest.state.walkedThrough, {}, 'nothing is written off');
    assert.deepEqual(manifest.state.unavailable, {}, 'and nothing is recorded as gone');
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------- a checksum of the file on disk

test('the checksum in archive.json is the checksum of the file that is there', { skip: exiftoolMissing }, async () => {
  // It was taken before the dates and the child's name were written into the file, so it
  // described a file that existed for a fraction of a second and could never be used to
  // check the archive.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 3 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-hash-'));
    const result = await run(mock, dir);
    assert.equal(result.failed, 0, result.warnings.join('; '));
    assert.deepEqual(result.warnings, [], 'the tags really were embedded, or this proves nothing');

    const manifest = await manifestOf(dir);
    assert.equal(manifest.files.length, 3);
    for (const record of manifest.files) {
      const onDisk = await hashFile(join(dir, ...record.path.split('/')));
      assert.equal(record.sha256, onDisk, `${record.path} does not match its recorded checksum`);
    }
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------- which clock filed these photos

test('the archive says which clock it was filed by', async () => {
  // Brightwheel gives an instant and no timezone, so the day a photo lands under comes from
  // the archiving machine's clock. That is a real limitation, and the archive says so in
  // writing rather than leaving a reader years later to guess.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 2 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-zone-'));
    await run(mock, dir, { organiseBy: 'week' });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const weeks = (await readdir(dir)).filter((f) => /^\d{4}-W\d{2}$/.test(f));
    assert.ok(weeks.length > 0, `expected a week folder, got ${(await readdir(dir)).join(', ')}`);
    const readme = await readFile(join(dir, weeks[0], 'README.md'), 'utf8');
    assert.ok(readme.includes(zone), `the week README names the timezone: ${readme}`);
    assert.match(readme, /but not\s+the timezone it was taken in/, 'and says why that matters');

    const manifest = await manifestOf(dir);
    assert.ok(manifest.files.every((f) => f.provenance.filedInTimezone === zone), 'and so does every record');
  } finally {
    await mock.close();
  }
});

// A web UI test needs a mock that outlives it, and a photos folder outside the repo.
let uiMock;
before(assertIsolatedConfigDir);
before(async () => {
  uiMock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 4 });
});
after(async () => {
  await uiMock?.close();
});

const PHOTOS_ROOT = fileURLToPath(new URL('../../../node_modules/.cache/bw-correctness-test/', import.meta.url));
after(async () => {
  await rm(PHOTOS_ROOT, { recursive: true, force: true });
});

test('a feed that ends exactly on the page limit is finished, not truncated', async () => {
  // The other side of the truncation warning. A feed whose last page is the last page the
  // walk is allowed to read looks identical to one that was cut short — unless the page is
  // short, which is the feed ending. Getting this wrong told a parent on every single run
  // that their archive might be incomplete, about an archive that was complete.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 15, maxPageSize: 10 });
  try {
    class ShortWalk extends BrightwheelClient {
      async *activityPages(studentId, opts) {
        // 15 posts at 10 a page is two pages, the second holding 5. maxPages 2 means the
        // walk ends on the limit and on the end of the feed at the same moment.
        yield* super.activityPages(studentId, { ...opts, maxPages: 2 });
      }
    }
    const client = new ShortWalk({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
    const dir = await mkdtemp(join(tmpdir(), 'bw-not-truncated-'));
    const result = await sync(client, configFor(dir, { incremental: true }), () => {}, { allowTemporaryDir: true });

    assert.ok(
      !result.warnings.some((w) => /longer than this tool reads in one go/.test(w)),
      `a finished feed must not be reported as cut short: ${JSON.stringify(result.warnings)}`,
    );
    assert.notDeepEqual(
      (await manifestOf(dir)).state.walkedThrough,
      {},
      'and a finished walk moves the cut-off, so the next run is cheap',
    );
  } finally {
    await mock.close();
  }
});

test('who posted a photo is recorded, from the fields the real API actually has', async () => {
  // `actor.name` came from another project's fixtures and does not exist. Because the mock
  // was written from the same guess, every test agreed with the mistake and every archive
  // this tool has ever written recorded no author at all. Verified against live Brightwheel
  // on 2026-09-22: the record carries actor.first_name, actor.last_name, actor.object_id,
  // actor.email and actor.role.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 3 });
  const dir = await mkdtemp(join(tmpdir(), 'bw-author-'));
  try {
    await sync(
      new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 }),
      configFor(dir, { incremental: false }),
      () => {},
      { allowTemporaryDir: true },
    );
    const manifest = await manifestOf(dir);
    const authors = manifest.files.map((f) => f.provenance.author);
    assert.ok(
      authors.every((a) => typeof a === 'string' && a.length > 0),
      `every photo should record who posted it, got ${JSON.stringify(authors)}`,
    );
    assert.ok(authors.some((a) => /Alvarez|Okafor|Lindqvist/.test(a)), 'and it is the staff name');

    // The staff email is on the record and must not be taken: a member of staff did not
    // agree to be in a parent's archive, and a name is all the provenance an archive needs.
    const raw = await readFile(join(dir, 'archive.json'), 'utf8');
    assert.ok(!raw.includes('@sunnybrook.example'), 'and never their email address');
  } finally {
    await mock.close();
  }
});
