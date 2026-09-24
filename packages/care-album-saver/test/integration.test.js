// First, before anything that can read the config directory: points this file at a
// throwaway one even when it is run on its own with `node --test`, which applies no
// --import (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir, platform, homedir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { request as httpRequest } from 'node:http';
import {
  BrightwheelClient, startMockBrightwheel, sync, Secret, scrub, scrubDeep,
  normaliseCookieInput, DEFAULT_CONFIG, writeSecureFile, startWebUi, checkArchiveDir, configDir,
} from '../dist/index.js';

let mock;
const SESSION = 'test-session-value';

/**
 * Windows has no POSIX file modes: a file simply inherits its parent folder's ACL. The
 * tests that assert 0600/0700 are skipped there with a reason that appears in the output,
 * because a silent pass would hide a regression on the platforms where the mode is the
 * whole protection. CARE_ALBUM_TEST_PLATFORM=win32 lets a Mac or Linux machine
 * rehearse the skip path before the change ever meets a real Windows runner.
 */
const testPlatform = process.env.CARE_ALBUM_TEST_PLATFORM || platform();
const posixOnly =
  testPlatform === 'win32' ? 'POSIX file modes do not exist on Windows; files inherit the parent ACL' : false;

before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 12 }); });
after(async () => { await mock?.close(); });

const client = (session = SESSION) =>
  new BrightwheelClient({ session: new Secret(session), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });

// ---------------------------------------------------------------- secrets

test('a Secret cannot be printed by accident', () => {
  const s = new Secret('super-secret-cookie-value');
  assert.equal(String(s), '[redacted]');
  assert.equal(`${s}`, '[redacted]');
  assert.equal(JSON.stringify({ cookie: s }), '{"cookie":"[redacted]"}');
  assert.ok(!inspect(s).includes('super-secret'));
  assert.ok(!inspect({ nested: { deep: s } }).includes('super-secret'));
  // The only way to the plaintext is the greppable call.
  assert.equal(s.expose(), 'super-secret-cookie-value');
});

test('a Secret survives the inspect options that defeat a custom inspector', () => {
  // customInspect:false bypasses [util.inspect.custom] entirely, and showHidden reveals
  // symbol-keyed properties. A true #private field is invisible to both — which is why
  // the value is stored in one.
  const s = new Secret('super-secret-cookie-value');
  assert.ok(!inspect(s, { customInspect: false }).includes('super-secret'));
  assert.ok(!inspect(s, { showHidden: true, getters: true, depth: 10 }).includes('super-secret'));
  assert.ok(!inspect({ deep: { deeper: s } }, { showHidden: true, depth: 10 }).includes('super-secret'));
  assert.ok(!JSON.stringify({ ...s }).includes('super-secret'), 'spread must not copy the value');
  assert.deepEqual(Object.keys(s), [], 'no enumerable keys at all');
  // Template-literal and numeric coercion both route through Symbol.toPrimitive.
  assert.equal(`${s}`, '[redacted]');
  assert.ok(!String(s).includes('super-secret'));
});

test('fingerprints identify a session without revealing it', () => {
  const a = new Secret('abc');
  assert.equal(a.fingerprint(), new Secret('abc').fingerprint());
  assert.notEqual(a.fingerprint(), new Secret('abd').fingerprint());
  assert.ok(!a.fingerprint().includes('abc'));
});

test('scrub catches credentials that leaked into free text', () => {
  assert.ok(!scrub('Cookie: _brightwheel_v2=abc123def').includes('abc123def'));
  assert.ok(!scrub('GET /m.jpg?signature=deadbeef&x=1').includes('deadbeef'));
  assert.ok(!scrub('authorization: Bearer tok_live_xyz').includes('tok_live_xyz'));
  // Ordinary text is left alone.
  assert.equal(scrub('saved 12 photos'), 'saved 12 photos');
});

test('scrubDeep redacts by key name as well as by value', () => {
  const out = scrubDeep({ ok: 1, sessionCookie: 'raw', nested: { password: 'hunter2' } });
  assert.equal(out.sessionCookie, '[redacted]');
  assert.equal(out.nested.password, '[redacted]');
  assert.equal(out.ok, 1);
});

test('cookie input is accepted in every form a parent might paste', () => {
  assert.equal(normaliseCookieInput('rawvalue123').expose(), 'rawvalue123');
  assert.equal(normaliseCookieInput('_brightwheel_v2=abc').expose(), 'abc');
  assert.equal(normaliseCookieInput('Cookie: other=1; _brightwheel_v2=abc; z=2').expose(), 'abc');
  assert.equal(normaliseCookieInput('   '), null);
});

// ---------------------------------------------------------------- api

test('client reads the account and the children', async () => {
  const me = await client().me();
  assert.equal(me.email, 'parent@example.com');
  const kids = await client().students(me.id);
  assert.equal(kids.length, 2);
  assert.equal(kids[0].fullName, 'Robin Maple');
  assert.equal(kids[0].schoolName, 'Example Care Provider');
});

test('an expired session is detected even when the server answers 200', async () => {
  // The trap: Brightwheel returns an HTML sign-in page with HTTP 200. Parsed loosely,
  // that reads as "zero photos" and an unattended nightly run would report success
  // forever while saving nothing.
  await assert.rejects(
    () => client('wrong-session').me(),
    (e) => e.name === 'SessionExpiredError',
  );
});

test('pagination walks to the end and stops', async () => {
  const pages = [];
  for await (const page of client().activities('stu-aaa-111', { pageSize: 5 })) pages.push(page.length);
  assert.ok(pages.length >= 3, `expected multiple pages, got ${pages.length}`);
  assert.equal(pages.reduce((a, b) => a + b, 0), 12);
});

test('event_date is preferred over created_at where the two differ', async () => {
  // This test used to be called "capture time is preferred over upload time", and it was
  // the project's founding claim. Checked against the live service on 2026-09-22, the two
  // fields are identical on every record and the photographs carry no capture time at all,
  // so there is no capture time to prefer — see docs/DECISIONS.md B2.
  //
  // The preference is kept, and so is this test, for a smaller reason: if some other
  // provider's records ever do distinguish them, event_date is the likelier of the two, and
  // the mock still models that case even though the real service does not exhibit it.
  for await (const p of client().activities('stu-aaa-111', { pageSize: 50 })) {
    const first = p[0];
    const uploaded = new Date(first.postedAt.getTime() + 6 * 3600 * 1000);
    assert.ok(first.postedAt < uploaded, 'the earlier of the two fields is the one kept');
    break;
  }
});

// ---------------------------------------------------------------- end to end

test('a full sync saves, organises, tags and does not re-download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-test-'));
  const config = { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0 };

  const first = await sync(client(), config, () => {}, { allowTemporaryDir: true });
  assert.equal(first.failed, 0, `failures: ${first.warnings.join('; ')}`);
  assert.equal(first.saved, 24, 'two children, twelve items each');
  assert.deepEqual(first.students, ['Robin Maple', 'Sam Maple']);

  // Layout: child, then ISO week.
  const top = (await readdir(dir)).filter((f) => !f.startsWith('.') && f !== 'archive.json');
  assert.ok(top.includes('Robin-Maple'), `top level was ${top.join(', ')}`);
  const weeks = await readdir(join(dir, 'Robin-Maple'));
  assert.ok(weeks.every((w) => /^\d{4}-W\d{2}$/.test(w)), `week folders were ${weeks.join(', ')}`);

  // Every photo has a JSON sidecar carrying the real capture time and the child's name.
  const week = weeks[0];
  const files = await readdir(join(dir, 'Robin-Maple', week));
  const sidecar = files.find((f) => f.endsWith('.json'));
  assert.ok(sidecar, 'expected a .json sidecar');
  const meta = JSON.parse(await readFile(join(dir, 'Robin-Maple', week, sidecar), 'utf8'));
  assert.equal(meta.child.name, 'Robin Maple');
  assert.equal(meta.source, 'brightwheel');
  assert.ok(meta.postedAt);
  assert.ok(files.includes('README.md'), 'each week folder explains itself');

  // Filenames start with the date so they sort chronologically in any file browser.
  const photo = files.find((f) => /^\d{4}-\d{2}-\d{2}_\d{6}_/.test(f));
  assert.ok(photo, `expected a dated filename, got ${files.join(', ')}`);

  // The second run must download nothing: the manifest matches on Brightwheel's media id,
  // even though the mock issues a brand-new signed URL on every single request.
  const second = await sync(client(), config, () => {}, { allowTemporaryDir: true });
  assert.equal(second.saved, 0, 'nothing new should be downloaded');
  assert.equal(second.skipped, 24, 'everything should be recognised as already held');
});

test('the manifest never records a local timestamp as a validator', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-manifest-'));
  await sync(client(), { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0 }, () => {}, { allowTemporaryDir: true });
  const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
  assert.equal(manifest.schema, 2);
  assert.ok(manifest.notes.includes('never used as validators'));
  for (const record of manifest.files) {
    assert.ok(record.sha256?.length === 64, 'every file is content-hashed');
    assert.ok(record.sourceId.startsWith('brightwheel:'));
    // transferId must have had the signature stripped.
    assert.ok(!record.transferId.includes('signature='), 'signature must not be stored');
  }
});

// ---------------------------------------------------------------- files on disk

test('files holding secrets are created owner-only', { skip: posixOnly }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-perm-'));
  const file = join(dir, 'session.json');
  await writeSecureFile(file, '{"cookie":"x"}');
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

// ---------------------------------------------------------------- web ui

test('the setup page refuses requests without the token', async () => {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    const res = await fetch(`http://127.0.0.1:${ui.port}/`);
    assert.equal(res.status, 403);
  } finally {
    await ui.close();
  }
});

/**
 * `fetch` refuses to set a Host header (it is a forbidden header name in undici), so a
 * rebinding attack cannot be simulated through it. The raw http client can, which is
 * exactly why the server must not trust the header.
 */
function rawRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the setup page blocks DNS-rebinding and cross-site requests', async () => {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    // A hostile domain resolved to 127.0.0.1 arrives with its own Host header.
    const rebind = await rawRequest(ui.port, `/?token=${ui.token}`, { Host: 'evil.example.com' });
    assert.equal(rebind.status, 403);

    // The same request with a legitimate Host is allowed, proving the check is the cause.
    const legit = await rawRequest(ui.port, `/?token=${ui.token}`, { Host: `127.0.0.1:${ui.port}` });
    assert.equal(legit.status, 200);

    // A page the parent is merely visiting must not be able to drive the UI.
    const csrf = await fetch(`http://127.0.0.1:${ui.port}/api/state?token=${ui.token}`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(csrf.status, 403);

    // The legitimate same-origin request still works.
    const ok = await fetch(`http://127.0.0.1:${ui.port}/api/state?token=${ui.token}`);
    assert.equal(ok.status, 200);
  } finally {
    await ui.close();
  }
});

test('the setup page binds only to the loopback interface', async () => {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    const res = await fetch(`http://127.0.0.1:${ui.port}/?token=${ui.token}`);
    assert.equal(res.status, 200);
    // Never cached: these pages list children's names.
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await res.text();
    assert.ok(html.includes('Care Album Saver'));
    // The token is bound into the page, not guessable.
    assert.ok(ui.token.length >= 30);
  } finally {
    await ui.close();
  }
});

test('the API never echoes a session back to the browser', async () => {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    await fetch(`http://127.0.0.1:${ui.port}/api/session?token=${ui.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: SESSION }),
    });
    const state = await (await fetch(`http://127.0.0.1:${ui.port}/api/state?token=${ui.token}`)).text();
    assert.ok(!state.includes(SESSION), 'the session value must never be sent to the browser');
    assert.equal(JSON.parse(state).hasSession, true);
  } finally {
    await ui.close();
  }
});

test('sensitive account fields are never written to disk', async () => {
  // The real /users/me response carries raw_passcode (the child's physical pickup code),
  // invite_code and phone numbers. Prior art in this space writes the raw API JSON straight
  // to the working directory. Nothing we persist may contain any of it.
  const dir = await mkdtemp(join(tmpdir(), 'bw-leak-'));
  await sync(client(), { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0 }, () => {}, { allowTemporaryDir: true });

  // These reach us from TWO responses, not one: /users/me, and — confirmed live on
  // 2026-09-22 — every activity record's `target`, which embeds the child's pickup code and
  // phone numbers beside the photo. The mock carries them in both places so that this
  // assertion covers the feed as well as the account.
  const forbidden = ['raw_passcode', 'INVITE-NEVER-STORE', '4821', '+15550000000', '+15550000001'];
  const files = [];
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (/\.(json|md)$/.test(entry.name)) files.push(p);
    }
  };
  await walk(dir);
  assert.ok(files.length > 0, 'expected files to inspect');

  for (const file of files) {
    // The manifest is full of 64-hex-digit content hashes, and a four-digit passcode is
    // a substring of one of them sooner or later. Mask the hashes, not the passcode.
    const text = (await readFile(file, 'utf8')).replace(/\b[0-9a-f]{64}\b/g, '<sha256>');
    for (const secret of forbidden) {
      assert.ok(!text.includes(secret), `${file} leaked "${secret}"`);
    }
  }
});

test('the signed media URL is never persisted with its signature', async () => {
  // A signed CDN URL is a bearer credential for one child's photo. Storing it verbatim in
  // the manifest would put a working, shareable link to every photo in a plain-text file.
  const dir = await mkdtemp(join(tmpdir(), 'bw-sig-'));
  await sync(client(), { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0 }, () => {}, { allowTemporaryDir: true });
  const raw = await readFile(join(dir, 'archive.json'), 'utf8');
  assert.ok(!raw.includes('signature='), 'manifest must not contain a URL signature');
  assert.ok(!raw.includes('expires='), 'manifest must not contain a URL expiry');
});

test('the setup page is structurally sound and accessible', async () => {
  // The page is one big template literal. A stray backtick or a broken tag would ship a
  // half-rendered page that still returns HTTP 200, so assert the landmarks explicitly.
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    const html = await (await fetch(`http://127.0.0.1:${ui.port}/?token=${ui.token}`)).text();

    assert.ok(!html.includes('__TOKEN__'), 'token placeholder must be substituted');
    assert.ok(html.includes('<main'), 'needs a main landmark');
    assert.ok(html.includes('class="skip"'), 'needs a skip link');
    assert.equal((html.match(/<h1/g) || []).length, 1, 'exactly one h1');

    // Every form control must have a real label or an explicit aria-label.
    for (const id of ['cookie', 'archiveDir', 'organiseBy', 'tagChildName', 'stripLocation']) {
      assert.ok(
        html.includes(`for="${id}"`) || new RegExp(`id="${id}"[^>]*aria-label`).test(html),
        `control #${id} has no associated label`,
      );
    }

    // State must be announced, not merely coloured (WCAG 1.4.1).
    assert.ok(html.includes('aria-live'), 'needs live regions for progress');
    assert.ok(html.includes('role="alert"'), 'connect errors must be announced');
    assert.ok(html.includes('role="progressbar"'), 'progress needs a role');
    assert.ok(html.includes('sr-only'), 'needs screen-reader-only step status');

    // Both colour schemes and reduced motion are handled.
    assert.ok(html.includes('prefers-color-scheme: dark'), 'needs dark mode');
    assert.ok(html.includes('prefers-reduced-motion'), 'needs reduced-motion handling');
    assert.ok(html.includes(':focus-visible'), 'needs a visible focus style');

    // A run already in flight must resume polling when the page is reopened or reloaded.
    // Without this the bar sits still, which reads as a hang that is not happening.
    assert.match(html, /if \(state\.running\) poll\(\)/, 'reopening during a run must restart polling');

    // No server-supplied string reaches innerHTML at all: they go in as text nodes, through
    // say() and h(), so there is no escaper left to forget (security review page-3; the
    // full check of every markup sink is in test/page-warnings.test.js).
    assert.ok(!/\besc\(/.test(html), 'no escaper, because nothing from the server is parsed as markup');
    for (const sink of ['d.error', 'p.message', 'state.email']) {
      assert.ok(html.includes(sink), sink + ' is still shown');
      assert.ok(!new RegExp('innerHTML[^;]*\\b' + sink.replace('.', '\\.')).test(html), sink + ' never reaches innerHTML');
    }

    // Jargon a non-technical parent would not know, per HIG inclusion guidance.
    // Checked against the visible copy only — script and style blocks carry developer
    // comments, which no user ever reads.
    // Strip scripts, styles, comments AND tags — what is left is the copy a parent reads.
    // Attribute values (id="incremental") are markup, not prose, and must not trip this.
    const visible = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ');
    for (const word of ['terminal', 'sidecar', 'manifest', 'incremental', 'cookie jar']) {
      assert.ok(
        !new RegExp('\\b' + word + '\\b', 'i').test(visible),
        'visible copy must not use the word "' + word + '"',
      );
    }

    // The tool does run a local HTTP server; claiming otherwise is untrue.
    assert.ok(!/no server/i.test(visible), 'must not claim there is no server — this page is served by one');

    // Nothing may be LOADED from another origin — that is what the CSP forbids, and the
    // markup must not even ask for it. A link the parent clicks is a navigation, not a
    // load: exactly one is allowed, to Brightwheel's own sign-in page, because the
    // alternative is an address they retype and mistype. Its rel, its target and its
    // "opens in a new tab" wording are checked in page-identity.test.js.
    const loads = html.match(/(?:src|<link[^>]+href)="https?:\/\/[^"]+"/g) || [];
    assert.deepEqual(loads, [], `page must not load from external origins: ${loads.join(', ')}`);

    // Two destinations are allowed and no others: Brightwheel's own sign-in page, because
    // the alternative is an address a parent retypes and mistypes, and the project's source,
    // because a tool that handles children's photographs should be readable by the person
    // running it. An allowlist rather than a count — a count says nothing about where a
    // third link would go, which is the part that matters.
    //
    // The project's source also covers two named files in it, and only those: the one
    // script the Photos option runs, and the page that explains it — so that a parent can
    // read exactly what will talk to their Photos library before turning it on. And the
    // update guide, for a copy installed some way the page cannot recognise. (A release's
    // own page is linked too, but only once the server has checked the address is exactly
    // this repository's releases — src/updates.ts — so it is not in the page as sent.)
    const ALLOWED = [
      'https://schools.mybrightwheel.com/',
      'https://github.com/ip2k/care-album-saver',
      'https://github.com/ip2k/care-album-saver/blob/main/packages/care-album-saver/applescript/add-to-photos.applescript',
      'https://github.com/ip2k/care-album-saver/blob/main/docs/PHOTOS.md',
      'https://github.com/ip2k/care-album-saver/blob/main/docs/UPDATING.md',
    ];
    // The WHOLE tag, not just up to the href: the rel is asserted below, and a pattern that
    // stopped at the closing quote of href would report every link as missing it.
    const outward = (html.match(/<a\b[^>]*>/g) || []).filter((a) => /href="https?:\/\//.test(a));
    const hrefs = outward.map((a) => /href="([^"]+)"/.exec(a)[1]);
    for (const href of hrefs) {
      assert.ok(ALLOWED.includes(href), `unexpected outward link: ${href}`);
    }
    for (const allowed of ALLOWED) {
      assert.ok(hrefs.includes(allowed), `expected an outward link to ${allowed}`);
    }
    // Every one of them, not just the first: a new tab must get no handle on this page and
    // no referrer, because this page's own address carries the setup token.
    for (const a of outward) {
      const rel = new Set((/rel="([^"]*)"/.exec(a)?.[1] ?? '').split(/\s+/).filter(Boolean));
      assert.ok(rel.has('noopener') && rel.has('noreferrer'), `outward link needs noopener and noreferrer: ${a}`);
    }
  } finally {
    await ui.close();
  }
});

// ---------------------------------------------------------------- archive location

test('temporary folders are refused — the OS deletes them', () => {
  // This is the bug that put 632 files of a real child's photos in /tmp/pwned, where
  // macOS would have quietly deleted them after three days. The system temp folders are
  // spelled per platform; tmpdir() is what every platform agrees on.
  const systemTemps = platform() === 'win32'
    ? [join(process.env.SystemRoot || 'C:\\Windows', 'Temp', 'x')]
    : ['/tmp/pwned', '/tmp/anything', '/private/tmp/x', '/var/tmp/y'];
  for (const bad of [join(tmpdir(), 'pwned'), tmpdir(), ...systemTemps]) {
    const v = checkArchiveDir(bad);
    assert.equal(v.ok, false, `${bad} should be refused`);
    assert.match(v.error, /temporary folder/i);
    assert.match(v.error, /delete/i, 'the message must say why, not just "no"');
  }
});

test('system locations and over-broad targets are refused', () => {
  // `/etc` resolves to `C:\etc` on Windows, an ordinary folder, so each platform is
  // given its own system locations and its own spelling of the drive root.
  const system = platform() === 'win32'
    ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32'), 'C:\\Program Files\\x', 'C:\\Program Files (x86)\\y', 'C:\\']
    : ['/System/Library', '/usr/local/x', '/etc', '/'];
  for (const bad of system) {
    assert.equal(checkArchiveDir(bad).ok, false, `${bad} should be refused`);
  }
  assert.equal(checkArchiveDir(homedir()).ok, false, 'the whole home folder is too broad');
  assert.equal(checkArchiveDir('').ok, false, 'empty is refused');
  assert.equal(checkArchiveDir('relative/path').ok, true, 'relative resolves against cwd, then is judged');
});

test('cloud-synced folders are allowed but warned about, never silently', () => {
  const cases = [
    [join(homedir(), 'Dropbox', 'Kids'), /Dropbox/],
    [join(homedir(), 'Library', 'Mobile Documents', 'Photos'), /iCloud/],
    [join(homedir(), 'OneDrive', 'Kids'), /OneDrive/],
    [join(homedir(), 'Desktop', 'Kids'), /iCloud/],
  ];
  for (const [path, expected] of cases) {
    const v = checkArchiveDir(path);
    assert.equal(v.ok, true, `${path} should be permitted`);
    assert.ok(v.warning, `${path} should warn`);
    assert.match(v.warning, expected);
  }
  // A plain folder gets no warning at all.
  const plain = checkArchiveDir(join(homedir(), 'Brightwheel Photos'));
  assert.equal(plain.ok, true);
  assert.equal(plain.warning, undefined);
});

test('the archive and every folder in it are created owner-only', { skip: posixOnly }, async () => {
  // Every file carries the child's name in its metadata, so these are identified
  // photographs. Other accounts on a shared family computer must not be able to read them.
  const dir = await mkdtemp(join(tmpdir(), 'bw-mode-'));
  await sync(client(), { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0 }, () => {}, {
    allowTemporaryDir: true,
  });

  const checked = [];
  const walk = async (d) => {
    checked.push(d);
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(d, entry.name));
    }
  };
  await walk(join(dir, 'Robin-Maple'));
  assert.ok(checked.length >= 2, 'expected child and week folders');
  for (const d of checked) {
    const mode = (await stat(d)).mode & 0o777;
    assert.equal(mode, 0o700, `${d} is ${mode.toString(8)}, expected 700`);
  }
});

test('the web config endpoint refuses a temporary destination', async () => {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/config?token=${ui.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archiveDir: join(tmpdir(), 'pwned') }),
    });
    assert.equal(res.status, 400, 'must not accept a temp path');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /temporary folder/i);

    // And it must not have been written to disk.
    const state = await (await fetch(`http://127.0.0.1:${ui.port}/api/state?token=${ui.token}`)).json();
    assert.notEqual(state.config.archiveDir, join(tmpdir(), 'pwned'));
  } finally {
    await ui.close();
  }
});

// ---------------------------------------------------------------- test isolation

test('the test suite never touches the real config directory', () => {
  // The import at the top of this file sets the variable when `pnpm test`'s --import did
  // not, and assertIsolatedConfigDir refuses a value that names a real config location.
  // Without both, every test that starts the setup UI writes the mock session over the
  // developer's own.
  const dir = assertIsolatedConfigDir();
  assert.ok(!dir.startsWith(join(homedir(), 'Library')), 'must not be under ~/Library');
  assert.ok(!dir.startsWith(join(homedir(), '.config')), 'must not be under ~/.config');
  assert.equal(configDir(), dir);
});
