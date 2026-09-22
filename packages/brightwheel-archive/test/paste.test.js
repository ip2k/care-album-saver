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
