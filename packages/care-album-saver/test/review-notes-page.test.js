// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PAGE } from '../dist/web/page.js';

/**
 * The page review's F24 (docs/SECURITY-REVIEW-2026-09-23.md §4.6): save() shared one catch
 * between the request and reading its answer, so a tool that did answer, with an HTML 403 or a
 * 500 page, was reported as "This page cannot reach the tool". The page's own save() is run
 * here in node:vm against stand-in answers.
 */

before(assertIsolatedConfigDir);

const TAG = '<script nonce="__NONCE__">';
const SCRIPT = PAGE.slice(PAGE.indexOf(TAG) + TAG.length, PAGE.indexOf('</script>'));
function slice(from, to) {
  const a = SCRIPT.indexOf(from);
  const b = SCRIPT.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `expected the page script to contain ${from} ... ${to}`);
  return SCRIPT.slice(a, b);
}

/** save() against a stand-in api(): what it returned, what it left in saveTrouble, what it showed. */
async function saveWith(api) {
  const shown = [];
  const context = createContext({
    api,
    savedDir: '/somewhere',
    clearDirError: () => {},
    savedNote: () => {},
    showSaveError: (d) => shown.push(d.error),
    applySaved: () => {},
    $: () => ({ value: '' }),
  });
  runInContext(`let saveTrouble = null;\n${slice('const UNREACHABLE = ', 'function persist(')}`, context);
  runInContext(slice('async function save(patch, opts) {', '\n/**'), context);
  const ok = await runInContext("save({ includeAll: true }, {})", context);
  return { ok, trouble: runInContext('saveTrouble', context), UNREACHABLE: runInContext('UNREACHABLE', context), shown };
}

const answer = (status, body, type = 'text/html') => async () => new Response(body, { status, headers: { 'content-type': type } });

test('F24: no answer at all is "cannot reach the tool"', async () => {
  const r = await saveWith(async () => { throw new TypeError('fetch failed'); });
  assert.equal(r.ok, false);
  assert.equal(r.trouble, r.UNREACHABLE);
});

test('F24: an answer the page cannot read is said as that, with its status', async () => {
  const forbidden = await saveWith(answer(403, '<h1>Wrong or missing setup link</h1>'));
  assert.equal(forbidden.ok, false);
  assert.notEqual(forbidden.trouble, forbidden.UNREACHABLE);
  assert.match(forbidden.trouble, /did not accept this page.*open the new link/);
  assert.match(forbidden.shown[0], /^Could not save that\. The tool did not accept this page/);

  const broken = await saveWith(answer(500, '<h1>oops</h1>'));
  assert.notEqual(broken.trouble, broken.UNREACHABLE);
  assert.match(broken.trouble, /answered in a way this page could not read \(500\)/);
});

test('F24: a refusal in words is still shown as the tool said it, and is no trouble', async () => {
  const refused = await saveWith(answer(400, JSON.stringify({ ok: false, error: 'That folder is a temporary folder.' }), 'application/json'));
  assert.equal(refused.ok, false);
  assert.equal(refused.trouble, null);
  assert.deepEqual(refused.shown, ['That folder is a temporary folder.']);
});
