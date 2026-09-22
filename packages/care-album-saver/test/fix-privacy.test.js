import '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_CONFIG,
  Secret,
  buildTags,
  formatReport,
  startMockBrightwheel,
  sync,
  verify,
  BrightwheelClient,
} from '../dist/index.js';
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';

/**
 * Promises this tool makes to a parent that the code did not keep.
 *
 * Every test here started as a sentence in the README or on the setup page. The tool did
 * something else, quietly, in the configuration a parent gets by default:
 *
 *   - "Turn this off and nothing inside the file says who or where" — while the teacher's
 *     note, which names the child, the room and the teacher, went in anyway.
 *   - "Remove location information", on by default — while a machine without ExifTool
 *     removed nothing and said only that the dates had moved to a sidecar.
 *   - photo folders only your account can open — true of a folder the tool created, and
 *     not of one the parent made in Finder first.
 *   - the session never leaves the Brightwheel API — except in `verify`, the one command
 *     the README tells a parent to run and paste in public.
 *
 * A promise is a behaviour, so each one is asserted as a behaviour.
 */

assertIsolatedConfigDir();

const run = promisify(execFile);
const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';
const posixOnly = process.platform === 'win32' && 'POSIX file modes; Windows inherits the folder ACL';

const STUDENT = {
  id: 'stu-x',
  firstName: 'Robin',
  lastName: 'Maple',
  fullName: 'Robin Maple',
  schoolName: 'Sunnybrook Early Learning',
};
const ACTIVITY = {
  id: 'act-1',
  studentId: 'stu-x',
  postedAt: new Date('2026-09-18T09:15:00'),
  // Shaped like a real one: it names the child, the room and, with the author beside it,
  // the teacher. This is why the note cannot be a "neutral caption".
  note: 'Robin fell asleep mid-song at circle time in the Sunflower room.',
  url: 'https://example.invalid/a.jpg',
  kind: 'image',
  author: 'Ms. Alvarez',
};

const tagsWith = (overrides) =>
  buildTags({
    filePath: '/dev/null',
    activity: ACTIVITY,
    student: STUDENT,
    tagChildName: true,
    tagNote: true,
    stripLocation: true,
    writeSidecar: false,
    ...overrides,
  });

let mock;
before(async () => {
  mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 3 });
});
after(async () => {
  await mock?.close();
});

const clientFor = () =>
  new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });

const configFor = (dir, extra = {}) => ({
  ...DEFAULT_CONFIG,
  archiveDir: dir,
  incremental: false,
  delayMs: 0,
  includeStudents: [ROBIN],
  ...extra,
});

// ------------------------------------------------- the names switch is the master switch

test('with the names off, the teacher\'s note stays out of the file as well', () => {
  for (const kind of ['image', 'video']) {
    const off = JSON.stringify(tagsWith({ activity: { ...ACTIVITY, kind }, tagChildName: false }));
    // The note is the sentence that gives all of it away at once, so it is the one that
    // matters most here: the child by name, the room, and the ritual of a particular
    // nursery. `tagNote` is left at its default of true, which is the whole point — the
    // broken promise was in the configuration a parent gets without touching anything.
    assert.ok(!off.includes('Robin'), `${kind}: the child's name must not be written`);
    assert.ok(!off.includes('Sunflower'), `${kind}: nor the room, which the note names`);
    assert.ok(!off.includes('circle time'), `${kind}: nor any of the note`);
    assert.ok(!off.includes('Alvarez'), `${kind}: nor whoever posted it`);
    assert.ok(!off.includes('Sunnybrook'), `${kind}: nor the nursery`);

    // And the dates, which say nothing about who, are written either way. Without this the
    // test above would pass just as well on a function that returned nothing at all.
    const tags = tagsWith({ activity: { ...ACTIVITY, kind }, tagChildName: false });
    assert.ok(Object.keys(tags).length > 0, `${kind}: the dates are still written`);
    assert.ok(
      Object.keys(tags).every((t) => !/subject|keywords|description|caption|creator|person|author|usercomment/i.test(t)),
      `${kind}: no field that carries a person or a place survives`,
    );
  }
});

test('with the names on, the note is written — the switch turns something off, not everything', () => {
  for (const kind of ['image', 'video']) {
    const on = JSON.stringify(tagsWith({ activity: { ...ACTIVITY, kind } }));
    assert.ok(on.includes('circle time'), `${kind}: the note goes in when both switches are on`);
    assert.ok(on.includes('Robin'), `${kind}: and so does the child's name`);

    // The note's own switch still works on its own, with the names left on.
    const noteOff = JSON.stringify(tagsWith({ activity: { ...ACTIVITY, kind }, tagNote: false }));
    assert.ok(!noteOff.includes('circle time'), `${kind}: the note switch still turns the note off`);
    assert.ok(noteOff.includes('Robin'), `${kind}: without taking the name with it`);
  }
});

test('nothing is lost: the .json sidecar keeps the note and the nursery whatever the switches say', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-sidecar-'));
  const result = await sync(clientFor(), configFor(dir, { tagChildName: false }), () => {}, {
    allowTemporaryDir: true,
  });
  assert.equal(result.failed, 0, result.warnings.join('; '));

  const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
  const first = manifest.files[0];
  const sidecar = JSON.parse(await readFile(join(dir, `${first.path}.json`), 'utf8'));
  assert.equal(sidecar.child.name, 'Robin Maple', 'the sidecar is the record, and keeps the name');
  assert.equal(sidecar.school, 'Sunnybrook Early Learning');
  assert.ok(sidecar.postedBy, 'and who posted it');
  t.diagnostic(`sidecar note: ${sidecar.note === null ? '(none on this record)' : 'present'}`);
});

// ---------------------------------------------- what "remove location" means with no tool

test('without ExifTool the parent is told that location was NOT removed, not only that dates moved', async () => {
  // A machine without the optional dependency, produced the way the suite already does it:
  // a module loader in a child process that refuses `exiftool-vendored`. Nothing here
  // touches the network or the real config directory.
  const hooks =
    `export async function resolve(s, c, next) {` +
    ` if (s === 'exiftool-vendored') throw new Error('simulated: not installed');` +
    ` return next(s, c); }`;
  const register =
    `import { register } from 'node:module';` +
    ` register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;
  const script = `
    import { mkdtemp, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const m = await import(${JSON.stringify(new URL('../dist/metadata.js', import.meta.url).href)});
    const dir = await mkdtemp(join(tmpdir(), 'bw-noexif-gps-'));
    const file = join(dir, 'photo.jpg');
    await writeFile(file, 'stand-in for a photo; nothing here reads the bytes');
    const base = {
      filePath: file,
      activity: ${JSON.stringify({ ...ACTIVITY, postedAt: ACTIVITY.postedAt.toISOString() })},
      student: ${JSON.stringify(STUDENT)},
      tagChildName: true,
      tagNote: true,
      writeSidecar: false,
    };
    base.activity.postedAt = new Date(base.activity.postedAt);
    console.log(JSON.stringify({
      asked: await m.applyMetadata({ ...base, stripLocation: true }),
      notAsked: await m.applyMetadata({ ...base, stripLocation: false }),
    }));
  `;
  const { stdout } = await run(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(register)}`,
    '--input-type=module', '-e', script,
  ]);
  const { asked, notAsked } = JSON.parse(stdout.trim().split('\n').pop());

  assert.equal(asked.embedded, false);
  assert.equal(asked.sidecar, true, 'the sidecar is still written, so nothing is lost');
  assert.match(asked.reason, /ExifTool is not installed/);
  assert.match(
    asked.reason,
    /location information could not be removed/i,
    'the parent asked for location to be removed; they must be told it was not',
  );
  assert.match(asked.reason, /still there/i, 'and what that leaves behind');

  // And it is not boilerplate bolted onto every message: a parent who turned the switch off
  // is not told about a removal they never asked for.
  assert.match(notAsked.reason, /ExifTool is not installed/);
  assert.ok(
    !/location/i.test(notAsked.reason),
    'with the switch off there is nothing to report about location',
  );
});

// ------------------------------------------------------- who can read the archive folder

test('an archive folder the parent made first is tightened to owner-only, and the run says so', { skip: posixOnly }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-perm-'));
  // What Finder, Explorer or `mkdir` gives you: readable by every account on the machine.
  // `mkdir(..., { mode })` in sync() applies its mode only to folders it creates, so before
  // this fix the folder stayed exactly like this and the README's promise was untrue.
  await chmod(dir, 0o755);

  const result = await sync(clientFor(), configFor(dir), () => {}, { allowTemporaryDir: true });
  assert.equal(result.failed, 0, result.warnings.join('; '));

  const mode = (await stat(dir)).mode & 0o777;
  assert.equal(mode, 0o700, `expected 700, got ${mode.toString(8)}`);

  const told = result.warnings.find((w) => w.includes(dir));
  assert.ok(told, `the change must be reported, not silent. warnings: ${JSON.stringify(result.warnings)}`);
  assert.match(told, /other accounts/i, 'and say what was wrong');
  assert.match(told, /changed to allow only yours/i, 'and what was done about it');
});

test('a folder that is already owner-only is left alone, and nobody is warned about nothing', { skip: posixOnly }, async () => {
  // mkdtemp already gives 0700, which is the state after any previous run of this tool.
  const dir = await mkdtemp(join(tmpdir(), 'bw-perm-ok-'));
  const result = await sync(clientFor(), configFor(dir), () => {}, { allowTemporaryDir: true });
  assert.equal(result.failed, 0, result.warnings.join('; '));
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.ok(
    !result.warnings.some((w) => /other accounts/i.test(w)),
    `a folder that was never open must not be reported as changed: ${JSON.stringify(result.warnings)}`,
  );
});

test('archive.json is owner-only: it names every child, every note and everyone who posted', { skip: posixOnly }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-manifest-mode-'));
  const result = await sync(clientFor(), configFor(dir), () => {}, { allowTemporaryDir: true });
  assert.equal(result.failed, 0, result.warnings.join('; '));

  const mode = (await stat(join(dir, 'archive.json'))).mode & 0o777;
  assert.equal(mode, 0o600, `archive.json is ${mode.toString(8)}, expected 600`);

  // Worth asserting rather than assuming: the reason the mode matters is what is in there.
  const raw = await readFile(join(dir, 'archive.json'), 'utf8');
  assert.ok(raw.includes('Robin Maple'), 'the manifest really does carry the child by name');
});

// --------------------------------------------------- verify must not leak what it verifies

/** A stand-in Brightwheel that records every request, so a test can see what was sent. */
function fakeApi() {
  const calls = [];
  // The signature is the literal the secret scanner's allowlist names, so that this
  // fixture cannot be mistaken for a real one — see .gitleaks.toml. The host deliberately
  // carries the nursery's name, because a per-tenant bucket really can, and the test below
  // is about verify not printing it.
  const mediaUrl =
    'https://sunnybrook-early-learning.media.example.net/p/1.jpg?signature=not-a-real-signature&expires=99';
  const json = (body) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const path = String(url);
    if (path.includes('/users/me')) return json({ object_id: 'usr-1', email: 'parent@example.invalid' });
    if (path.includes('/students?')) {
      return json({ students: [{ student: { object_id: 'stu-1', first_name: 'Robin' }, relationship_type: 'parent' }] });
    }
    if (path.includes('/activities?')) {
      return json({
        count: 40,
        offset: 0,
        page: 0,
        page_size: 5,
        activities: [
          {
            object_id: 'act-1',
            action_type: 'ac_photo',
            event_date: '2026-09-18T09:15:00Z',
            created_at: '2026-09-18T15:15:00Z',
            note: 'Robin fell asleep mid-song at circle time.',
            media: { image_url: mediaUrl },
            actor: { name: 'Ms. Alvarez' },
          },
        ],
      });
    }
    return new Response(null, { status: 200 });
  };
  return { calls, fetchImpl, mediaUrl };
}

test('verify never sends the session anywhere but the Brightwheel API', async () => {
  const { calls, fetchImpl } = fakeApi();
  const report = await verify(new Secret(SESSION), { baseUrl: 'https://api.example.invalid/v1', fetchImpl });

  const cookieOf = (init) => {
    const headers = init?.headers ?? {};
    const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === 'cookie');
    return hit?.[1];
  };
  const toMedia = calls.filter((c) => c.url.includes('media.example.net'));
  const toApi = calls.filter((c) => c.url.startsWith('https://api.example.invalid/'));

  assert.ok(toMedia.length > 0, 'the no-cookie probe is the useful half and must still happen');
  for (const call of toMedia) {
    assert.equal(cookieOf(call.init), undefined, `a request to the media host carried a cookie: ${call.url}`);
  }
  // The other half of the proof: this test is not passing because nothing anywhere sends a
  // cookie. The API calls do, and must.
  assert.ok(toApi.length > 0 && toApi.every((c) => String(cookieOf(c.init)).includes(SESSION)),
    'the API calls must still carry the session, or this test proves nothing');

  // And the report says what it did not do, rather than quietly dropping the question.
  const text = formatReport(report);
  assert.match(text, /NOT CHECKED, deliberately/, 'the unanswered question must be stated');
  assert.match(text, /WITH the session cookie/, 'and named, so a reader knows what is missing');
  assert.match(text, /WITHOUT the session cookie: HTTP 200/, 'the half that was checked is reported');
});

test('the verify report is safe to paste in public: no session, no signature, no nursery', async () => {
  const { fetchImpl, mediaUrl } = fakeApi();
  const report = await verify(new Secret(SESSION), { baseUrl: 'https://api.example.invalid/v1', fetchImpl });
  const text = formatReport(report);

  assert.ok(!text.includes(SESSION), 'the session must never be in the report');
  assert.ok(!text.includes('abcdefghijklmnopqrstuvwx'), 'nor a URL signature, which is itself a credential');
  assert.ok(!text.includes(mediaUrl), 'nor the media URL');
  // A per-tenant host can carry the nursery's name. The company that serves the media is
  // the useful answer; the labels in front of it are somebody's family.
  assert.ok(!text.includes('sunnybrook-early-learning'), 'nor anything that names the nursery');
  assert.match(text, /Media is served from example\.net/, 'the useful half of the host is still reported');

  // How many children are on the account is a fact about the family, not about the API.
  assert.ok(!/\d+ found/.test(text), `the child count must not be printed: ${text}`);
  assert.match(text, /at least one entry/, 'the shape question is still answered');

  // Neither is the parent's email, which /users/me returns in full.
  assert.ok(!text.includes('parent@example.invalid'), 'nor the account email');
});
