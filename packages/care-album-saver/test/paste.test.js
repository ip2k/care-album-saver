// First, before anything that can read the config directory (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { inspectCookiePaste, cleanPastedPath, PASTE_CLIENT_SOURCE, normaliseCookieInput, startWebUi } from '../dist/index.js';

assertIsolatedConfigDir();

// Every synthetic value below carries "NotARealSession", which .gitleaks.toml allowlists,
// so the tests can spell out a value long enough to look like one without tripping the
// scanner that exists to catch a real one.
const RAILS = 'NotARealSession' + 'A'.repeat(180) + '%3D%3D--' + 'b'.repeat(40);
const RAILS3 = 'NotARealSession' + 'C'.repeat(120) + '--' + 'D'.repeat(16) + '--' + 'E'.repeat(22) + '%3D%3D';
const b64url = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const JWT = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"NotARealSession","exp":1}')}.${'f'.repeat(43)}`;

test('a clean value passes and is recognised as a Rails session', () => {
  const v = inspectCookiePaste(RAILS);
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'rails');
  assert.equal(v.level, 'ok');
  assert.equal(v.value, RAILS);
  assert.deepEqual(v.notes, []);
  assert.equal(inspectCookiePaste(RAILS3).kind, 'rails', 'the three-part encrypted shape too');
});

test('the name alone is refused with the reason', () => {
  for (const s of ['_brightwheel_v2', '"_brightwheel_v2"', ' _brightwheel_v2 ', 'brightwheel_v2']) {
    const v = inspectCookiePaste(s);
    assert.equal(v.ok, false, s);
    assert.match(v.message, /cookie's name/);
  }
  const empty = inspectCookiePaste('_brightwheel_v2=');
  assert.equal(empty.ok, false);
  assert.match(empty.message, /no value follows/);
});

test('name=value, a header line, a copied table row and a HAR entry all yield the value', () => {
  const cases = [
    `_brightwheel_v2=${RAILS}`,
    `Cookie: other=1; _brightwheel_v2=${RAILS}; z=2`,
    `_brightwheel_v2\t${RAILS}\tschools.mybrightwheel.com\t/\t2026-10-01T00:00:00.000Z\t312\t✓\t✓\tLax\tMedium`,
    `_brightwheel_v2 ${RAILS} schools.mybrightwheel.com / Session`,
    `"name": "_brightwheel_v2",\n      "value": "${RAILS}",\n      "domain": ".mybrightwheel.com"`,
    `_brightwheel_v2: ${RAILS}`,
  ];
  for (const s of cases) {
    const v = inspectCookiePaste(s);
    assert.equal(v.ok, true, s);
    assert.equal(v.value, RAILS, s);
    assert.ok(v.notes.some((n) => /beside its name|header line/.test(n)), `says what it did: ${s}`);
  }
});

test('a value wrapped over several lines is joined, and says so', () => {
  const wrapped = RAILS.slice(0, 80) + '\n' + RAILS.slice(80, 160) + '\r\n' + RAILS.slice(160);
  const v = inspectCookiePaste(wrapped);
  assert.equal(v.ok, true);
  assert.equal(v.value, RAILS);
  assert.match(v.notes.join(' '), /joined 3 pieces/);
});

test('a table row without the name is refused, not joined into nonsense', () => {
  const v = inspectCookiePaste(`${RAILS}\tschools.mybrightwheel.com\t/\tSession`);
  assert.equal(v.ok, false);
  assert.match(v.message, /whole row/);
});

test('word-processor dressing is stripped: curly quotes, non-breaking spaces, zero-width characters', () => {
  const dressed = `\u201C\uFEFF${RAILS.slice(0, 50)}\u200B${RAILS.slice(50)}\u00A0\u201D`;
  const v = inspectCookiePaste(dressed);
  assert.equal(v.ok, true);
  assert.equal(v.value, RAILS);
  assert.match(v.notes.join(' '), /invisible/);
  assert.match(v.notes.join(' '), /quotes/);
});

test('things that are certainly not a session are refused by name', () => {
  assert.match(inspectCookiePaste('https://schools.mybrightwheel.com/').message, /web address/);
  assert.match(inspectCookiePaste('parent@example.com').message, /email address/);
  assert.match(inspectCookiePaste('a=1; b=2; c=3').message, /list of cookies/);
  assert.match(inspectCookiePaste('').message, /Nothing pasted/);
  assert.match(inspectCookiePaste('   \n  ').message, /Nothing pasted/);
});

test('a control character is refused, and the message never contains the pasted text', () => {
  const bad = `NotARealSession${'x'.repeat(30)}\u0001${'y'.repeat(30)}`;
  const v = inspectCookiePaste(bad);
  assert.equal(v.ok, false);
  assert.equal(v.value, '');
  assert.ok(!v.message.includes('NotARealSession'));
  assert.match(v.message, /cannot hold/);
});

test('a JWT is recognised and warned about but allowed', () => {
  const v = inspectCookiePaste(JWT);
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'jwt');
  assert.equal(v.level, 'warn');
  assert.match(v.message, /JWT/);
});

test('a short or unfamiliar value warns but is allowed, which keeps the mock usable', () => {
  const short = inspectCookiePaste('test-session-value');
  assert.equal(short.ok, true);
  assert.equal(short.level, 'warn');
  assert.match(short.message, /shorter than/);
  const odd = inspectCookiePaste('NotARealSession' + 'q'.repeat(40));
  assert.equal(odd.ok, true);
  assert.equal(odd.level, 'warn');
  assert.match(odd.message, /Not a shape/);
});

test('the value is passed on exactly as the browser holds it: no percent-decoding', () => {
  assert.equal(inspectCookiePaste(`_brightwheel_v2=${RAILS}`).value, RAILS);
  assert.ok(RAILS.includes('%3D'), 'the fixture is percent-encoded');
  assert.equal(normaliseCookieInput(`_brightwheel_v2=${RAILS}`).expose(), RAILS);
});

test('normaliseCookieInput follows the verdict', () => {
  assert.equal(normaliseCookieInput('_brightwheel_v2'), null);
  assert.equal(normaliseCookieInput(`  "${RAILS}"  `).expose(), RAILS);
  assert.equal(normaliseCookieInput('test-session-value').expose(), 'test-session-value');
});

test('cleanPastedPath strips quotes and invisible characters and nothing else', () => {
  assert.equal(cleanPastedPath('  "/Users/alex/Pictures/Brightwheel"  '), '/Users/alex/Pictures/Brightwheel');
  assert.equal(cleanPastedPath("'C:\\Users\\alex\\Pictures'"), 'C:\\Users\\alex\\Pictures');
  assert.equal(cleanPastedPath('\u201C/tmp/x y\u201D'), '/tmp/x y');
  assert.equal(cleanPastedPath('\uFEFF/tmp/x\u00A0'), '/tmp/x');
  assert.equal(cleanPastedPath('/tmp/keep "inner" quotes'), '/tmp/keep "inner" quotes');
});

test('the client-side source is standalone JavaScript that gives the same answers', () => {
  const script = new Script(`${PASTE_CLIENT_SOURCE}\n({ inspectCookiePaste, cleanPastedPath })`);
  const fns = script.runInNewContext({ globalThis: { atob: (s) => Buffer.from(s, 'base64').toString('binary') } });
  assert.equal(fns.inspectCookiePaste(`_brightwheel_v2=${RAILS}`).value, RAILS);
  assert.equal(fns.inspectCookiePaste('_brightwheel_v2').ok, false);
  assert.equal(fns.inspectCookiePaste(JWT).kind, 'jwt');
  assert.equal(fns.cleanPastedPath('"/a/b"'), '/a/b');
});

// --- the setup page and its server -------------------------------------------------------

let handle;
before(async () => {
  handle = await startWebUi({ port: 0, baseUrl: 'http://127.0.0.1:1' });
});
after(async () => {
  await handle?.close();
});

const call = (path, init = {}) =>
  fetch(`http://127.0.0.1:${handle.port}${path}`, {
    ...init,
    headers: { 'x-setup-token': handle.token, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

test('the page carries the shared checker, a live message under the box, and a paste box browsers leave alone', async () => {
  const html = await (await fetch(`http://127.0.0.1:${handle.port}/?token=${handle.token}`)).text();
  assert.ok(html.includes('function inspectCookiePaste('), 'the checker is embedded');
  assert.ok(html.includes('id="cookie-check"'), 'and has somewhere to speak');
  assert.match(html, /<textarea id="cookie"[^>]*spellcheck="false"/, 'no spell-check upload');
  assert.match(html, /<textarea id="cookie"[^>]*autocomplete="off"/, 'no autofill');
  assert.match(html, /<textarea id="cookie"[^>]*data-1p-ignore/, 'no password-manager offer');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/g).map((s) => s.replace(/<\/?script>/g, '')).join('\n');
  new Script(inline); // still parses with the embedded functions in it
});

test('the server refuses a name-only paste and a control character with the friendly reason, echoing nothing', async () => {
  const nameOnly = await call('/api/session', { method: 'POST', body: JSON.stringify({ cookie: '_brightwheel_v2' }) });
  assert.equal(nameOnly.status, 400);
  assert.match((await nameOnly.json()).error, /cookie's name/);

  const marker = 'NotARealSessionZZZ' + 'k'.repeat(30);
  const withControl = await call('/api/session', { method: 'POST', body: JSON.stringify({ cookie: `${marker}\u0001${marker}` }) });
  assert.equal(withControl.status, 400);
  const text = await withControl.text();
  assert.ok(!text.includes(marker), 'the 400 body does not contain the pasted value');

  const notAString = await call('/api/session', { method: 'POST', body: JSON.stringify({ cookie: { nested: marker } }) });
  assert.equal(notAString.status, 400);
  assert.ok(!(await notAString.text()).includes(marker));
});

test('a value wrapped over lines reaches the server whole, and the server tries it rather than refusing', async () => {
  const wrapped = RAILS.slice(0, 100) + '\n' + RAILS.slice(100);
  const r = await call('/api/session', { method: 'POST', body: JSON.stringify({ cookie: wrapped }) });
  // baseUrl points at a closed port, so the only acceptable outcomes are "tried and could
  // not reach Brightwheel" (400 from verifySession) — never the shape refusal.
  const d = await r.json();
  assert.equal(d.ok, false);
  assert.doesNotMatch(d.error, /does not look like|cannot hold|whole row/);
  assert.ok(!d.error.includes('NotARealSession'), 'and nothing of the value comes back');
});

// --- the rename, and what it must not break ---------------------------------------------

test('a session saved before the rename is still found, and nothing is moved to find it', async () => {
  // In a child process with its own HOME, so the real config directory is never consulted
  // and nothing here can touch it. Both CARE_ALBUM_* names are removed from the child's
  // environment: they take precedence by design, and would hide the fallback under test.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, mkdir, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = await mkdtemp(join(tmpdir(), 'cas-home-'));
  const support = join(home, 'Library', 'Application Support');
  const legacy = join(support, 'brightwheel-archive');
  await mkdir(legacy, { recursive: true });
  await mkdir(join(home, '.config', 'brightwheel-archive'), { recursive: true });

  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  for (const k of Object.keys(env)) if (k.startsWith('CARE_ALBUM_') || k.startsWith('BRIGHTWHEEL_')) delete env[k];

  const entry = new URL('../dist/index.js', import.meta.url).pathname;
  const run = (code) => promisify(execFile)(process.execPath, ['-e', code], { env, encoding: 'utf8' });

  const before = await run(`import(${JSON.stringify(entry)}).then(m => console.log(m.configDir()))`);
  assert.equal(before.stdout.trim(), legacy, 'the old folder is used while it is the only one');

  // Nothing is moved or created by asking: the old folder is read where it stands.
  assert.deepEqual(await readdir(support), ['brightwheel-archive'], 'no new folder appeared beside it');

  // Once the new folder exists, it wins — that is how a fresh install and an upgraded one
  // converge without either being asked to migrate.
  await mkdir(join(support, 'care-album-saver'), { recursive: true });
  const after = await run(`import(${JSON.stringify(entry)}).then(m => console.log(m.configDir()))`);
  assert.equal(after.stdout.trim(), join(support, 'care-album-saver'), 'the new folder wins once it is there');

  // And a machine that has neither gets the new name, never the old one.
  const fresh = await mkdtemp(join(tmpdir(), 'cas-home-'));
  const freshEnv = { ...env, HOME: fresh, XDG_CONFIG_HOME: join(fresh, '.config') };
  const clean = await promisify(execFile)(process.execPath, ['-e', `import(${JSON.stringify(entry)}).then(m => console.log(m.configDir()))`], { env: freshEnv, encoding: 'utf8' });
  assert.match(clean.stdout.trim(), /care-album-saver$/, 'a first run never lands in the old name');
});

test('the pre-rename environment variables are still honoured', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'cas-legacy-env-'));
  const photos = await mkdtemp(join(tmpdir(), 'cas-legacy-photos-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CARE_ALBUM_')) delete env[k];
  env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = dir;
  env.BRIGHTWHEEL_ARCHIVE_DIR = photos;

  const entry = new URL('../dist/index.js', import.meta.url).pathname;
  const out = await promisify(execFile)(
    process.execPath,
    ['-e', `import(${JSON.stringify(entry)}).then(m => console.log(m.configDir() + '\\n' + m.defaultArchiveDir()))`],
    { env, encoding: 'utf8' },
  );
  const [config, archive] = out.stdout.trim().split('\n');
  assert.equal(config, dir, 'the old config variable still redirects');
  assert.equal(archive, photos, 'and so does the old photos variable — isolation must not depend on a rename');
});

// --- one wrong clock must not silently stop every later run -----------------------------

test('a post dated in the future cannot become a cut-off that skips the rest of the feed', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startMockBrightwheel, sync, BrightwheelClient, Secret, DEFAULT_CONFIG } = await import('../dist/index.js');

  const dir = await mkdtemp(join(tmpdir(), 'cas-future-'));
  // One post dated a year ahead, at the top of the feed, and a small page so that three
  // pages is a small part of it. Without the clamp the first run writes that year-ahead
  // date as the cut-off, and the second run stops three pages in having looked at nothing.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 24, futureDatedPosts: 1, maxPageSize: 3 });
  try {
    const config = { ...DEFAULT_CONFIG, archiveDir: dir, incremental: true, delayMs: 0, includeStudents: [] };
    const client = () => new BrightwheelClient({ session: new Secret('test-session-value'), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });

    const first = await sync(client(), config, () => {}, { allowTemporaryDir: true });
    assert.ok(first.saved > 20, `the first run saves the feed (saved ${first.saved}, failed ${first.failed}): ${first.warnings.join('; ')}`);
    assert.match(
      first.warnings.join(' '),
      /dated in the future/,
      'and says plainly that something on the account has its clock wrong',
    );

    // The cut-off it left behind must be a moment that has actually happened.
    const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
    const cutOffs = Object.values(manifest.state?.walkedThrough ?? {});
    assert.ok(cutOffs.length > 0, 'a complete walk recorded a cut-off');
    for (const at of cutOffs) {
      assert.ok(new Date(at).getTime() <= Date.now() + 1000, `the cut-off is not in the future (${at})`);
    }

    // The proof that matters: a second run over the same feed still examines it rather
    // than stopping three pages in, and recognises everything it already has.
    const before = mock.requests.filter((r) => r.path.endsWith('/activities')).length;
    const second = await sync(client(), config, () => {}, { allowTemporaryDir: true });
    const listings = mock.requests.filter((r) => r.path.endsWith('/activities')).length - before;
    assert.equal(second.saved, 0, 'nothing new to save');
    assert.ok(second.skipped > 20, `it really did look: ${second.skipped} already-had`);
    assert.ok(listings > 3, `and it read past the three-page lookback (${listings} listing requests)`);
  } finally {
    await mock.close();
  }
});

test('the login prompt never echoes the session into terminal scrollback', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // The value is assembled here rather than written as a literal, for the same reason the
  // scanner rules test does it: nothing in this file should look like a session on disk.
  const value = 'NotARealSession' + 'Q'.repeat(60);
  const config = await mkdtemp(join(tmpdir(), 'cas-echo-config-'));
  const photos = await mkdtemp(join(tmpdir(), 'cas-echo-photos-'));
  const cli = new URL('../dist/cli.js', import.meta.url).pathname;

  const output = await new Promise((resolve) => {
    // baseUrl points nowhere on purpose: this is about what reaches the terminal before
    // any request is made, so the sign-in failing afterwards is fine.
    const child = spawn(process.execPath, [cli, 'login', '--base-url', 'http://127.0.0.1:1'], {
      env: { ...process.env, CARE_ALBUM_CONFIG_DIR: config, CARE_ALBUM_DIR: photos },
    });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    const typed = setTimeout(() => child.stdin.write(value + '\n'), 500);
    const giveUp = setTimeout(() => child.kill(), 15000);
    child.on('close', () => { clearTimeout(typed); clearTimeout(giveUp); resolve(text); });
  });

  assert.ok(!output.includes(value), 'the pasted session is not printed back');
  assert.match(output, /Paste it here/, 'but the prompt itself still is — a silent prompt is a hung program');
  assert.match(output, /it will not be shown/, 'and it says why nothing appears as you type');
});

// --- verify must not print an identifier when a session dies mid-check ------------------

test('a session that expires part-way through verify names the endpoint, never an id', async () => {
  const { startMockBrightwheel, verify, Secret } = await import('../dist/index.js');

  // The session works for the first request and not the second. That is the exact window
  // in which the old code printed `/guardians/<object_id>/students` — an identifier, into
  // a report whose whole promise is that it carries none.
  const mock = await startMockBrightwheel({ expireSessionAfterRequests: 1 });
  try {
    let failure = '';
    try {
      await verify(new Secret('test-session-value'), { baseUrl: `${mock.url}/api/v1` });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    assert.notEqual(failure, '', 'it did fail — the mock retired the session');
    assert.doesNotMatch(failure, /\/guardians\/|\/students\/|\/users\/me/, 'no URL path in the message');
    assert.doesNotMatch(failure, /[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-/i, 'and no id-shaped string either');
  } finally {
    await mock.close();
  }
});

// --- the page has two jobs, and shows one of them at a time ------------------------------

test('the page keeps one of each control, moving the setup flow rather than copying it', async () => {
  const html = await (await fetch(`http://127.0.0.1:${handle.port}/?token=${handle.token}`)).text();

  // The two ways out of the main view, both labelled. An icon alone is announced as
  // nothing by a screen reader, and a gear means "settings" only to people taught that.
  assert.match(html, /id="btn-settings"[^>]*>[\s\S]{0,80}Settings and Maintenance/, 'a labelled settings button');
  assert.match(html, /id="btn-help"[^>]*>[\s\S]{0,60}FAQ and Docs/, 'a labelled help button');
  for (const id of ['dlg-settings', 'dlg-help', 'dlg-logs']) {
    assert.ok(html.includes(`<dialog id="${id}"`), `${id} is a real dialog element`);
  }

  // The question-and-answer material moved off the main page into the help dialog, and the
  // project's source is linked from there.
  const help = html.slice(html.indexOf('<dialog id="dlg-help"'), html.indexOf('<dialog id="dlg-logs"'));
  assert.match(help, /Where your photos go/, 'the privacy explanation is in the FAQ');
  assert.match(help, /github\.com/, 'and the FAQ links to the source');
  assert.ok(!html.includes('<aside class="privacy"'), 'and it is not also sitting on the main page');

  // One of each control in the document. Two would drift: a folder typed into one and a
  // folder chosen in the other, with only one of them saved.
  for (const id of ['archiveDir', 'cookie', 'schedule-time', 'btn-run']) {
    const count = html.split(`id="${id}"`).length - 1;
    assert.equal(count, 1, `exactly one #${id} in the document, found ${count}`);
  }

  // The setup flow is a single node, so moving it between the page and the dialog is one
  // appendChild and every handler inside it survives untouched.
  assert.ok(html.includes('<div id="setup-flow">'), 'the flow is one movable node');
  assert.ok(html.includes('id="settings-body"'), 'and Settings is where it goes');
});

test('the dashboard asks for photos by index, and the page never contains a file path', async () => {
  const html = await (await fetch(`http://127.0.0.1:${handle.port}/?token=${handle.token}`)).text();
  // The gallery builds its URLs as /photo?i=<index>. If this ever became a path, the route
  // would have something to traverse with; today it has only a number.
  assert.match(html, /'\/photo\?i=' \+ item\.id/, 'thumbnails are addressed by manifest index');
  assert.ok(!/\/photo\?path=/.test(html), 'never by path');
});
