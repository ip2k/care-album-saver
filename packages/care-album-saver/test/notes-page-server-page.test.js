// First, before anything that can read the config directory. Nothing here reads it, but the
// rule is "every file", so that a line added later cannot start writing over a real session.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext, Script } from 'node:vm';
import { PAGE } from '../dist/web/page.js';
import { COOKIE_FIGURES, COOKIE_HELP, COOKIE_HELP_SCRIPT, escapeMarkup } from '../dist/web/cookie-help.js';

/**
 * The security review's NOTEs for the setup page (docs/SECURITY-REVIEW-2026-09-23.md §4.3 and
 * the verifiers' additions): page-12 with web-13, and the unguarded picture guide.
 *
 * The suite has no browser, so the page's own functions are cut out of its one script and run
 * in node:vm against a small stand-in for the document — enough of an element to hold
 * attributes, children and listeners — as page-warnings.test.js does for page-1 and page-2.
 */

before(assertIsolatedConfigDir);

const TAG = '<script nonce="__NONCE__">';
const SCRIPT = PAGE.slice(PAGE.indexOf(TAG) + TAG.length, PAGE.indexOf('</script>'));
const MARKUP = PAGE.slice(0, PAGE.indexOf(TAG));

function slice(from, to) {
  const a = SCRIPT.indexOf(from);
  const b = SCRIPT.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `expected the page script to contain ${from} ... ${to}`);
  return SCRIPT.slice(a, b);
}

/** Enough of a DOM element for the page's own code. */
class El {
  constructor(tag, id) {
    this.tag = tag;
    this.id = id ?? '';
    this.attrs = {};
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this._text = '';
    this.classes = new Set();
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      toggle: (c, on) => (on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c),
    };
  }
  get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this._text = ''; this.children = []; this.html = v; }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set src(v) { this.attrs.src = String(v); }
  get src() { return this.attrs.src; }
  setAttribute(n, v) { this.attrs[n] = String(v); if (n === 'class') this.className = v; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  removeAttribute(n) { delete this.attrs[n]; }
  toggleAttribute(n, on) { if (on) this.attrs[n] = ''; else delete this.attrs[n]; }
  append(...kids) { for (const k of kids) { if (typeof k === 'object') k.parent = this; this.children.push(typeof k === 'number' ? String(k) : k); } }
  appendChild(k) { this.append(k); return k; }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  replaceWith(node) {
    const at = this.parent.children.indexOf(this);
    this.parent.children[at] = node;
    node.parent = this.parent;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] ?? []) fn({ target: this }); }
  focus() {}
  pause() {}
  load() {}
  querySelector() { return null; }
  insertBefore() {}
}

/** A document of El, made on first ask. `missing` lists ids that are not in it at all. */
function fakeDocument(missing = []) {
  const els = new Map();
  const $ = (id) => {
    if (missing.includes(id)) return null;
    if (!els.has(id)) els.set(id, new El('div', id));
    return els.get(id);
  };
  const document = {
    getElementById: $,
    createElement: (tag) => new El(tag),
    activeElement: null,
    querySelectorAll: () => [],
  };
  return { $, document, els };
}

// ------------------------------------------------------------------ page-12 and web-13

test('page-12: the browser is told once, and both the written steps and the picture guide follow it', () => {
  const sniffs = SCRIPT.match(/navigator\.userAgent/g) ?? [];
  const at = SCRIPT.indexOf('const BROWSER =');
  assert.ok(at > 0, 'one place decides');
  assert.equal(sniffs.length, (slice('const BROWSER =', ';\n').match(/navigator\.userAgent/g) ?? []).length, 'and it is the only place that reads the user agent');
  assert.doesNotMatch(COOKIE_HELP_SCRIPT, /navigator|userAgent/, 'the picture guide does not sniff again');
  assert.match(COOKIE_HELP_SCRIPT, /\}\)\(BROWSER\);$/, 'it is handed the answer');
  assert.ok(SCRIPT.indexOf(COOKIE_HELP_SCRIPT) > at, 'after it is known');
  assert.doesNotMatch(SCRIPT, /change both/, 'no pair of tests left to keep in step by hand');

  const UAS = {
    chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  };
  const expected = { chrome: 'chrome', edge: 'chrome', firefox: 'firefox', safari: 'safari' };
  for (const [name, userAgent] of Object.entries(UAS)) {
    const { $, document } = fakeDocument();
    const context = createContext({ $, document, navigator: { userAgent } });
    runInContext(slice('function howToSteps()', "$('howto').innerHTML"), context);
    assert.equal(runInContext('BROWSER', context), expected[name], name);
    const steps = runInContext('howToSteps()', context);
    assert.match(steps[2], expected[name] === 'chrome' ? /Application/ : /Storage/, `${name}: the tab to click`);
    assert.equal(/Show features for web developers/.test(steps[1]), expected[name] === 'safari', `${name}: the Develop menu step`);
    // The picture guide, run as the page runs it, puts the same browser first.
    runInContext(COOKIE_HELP_SCRIPT, context);
    assert.match($(`ck-${expected[name]}-h`).textContent, /what you are reading this in$/, `${name}: the same browser`);
  }
});

test('page-12: the picture guide\'s script is written as the page is, so it reads exactly as it is served', () => {
  // String.raw: a backslash in the source is a backslash in the page. A plain template needed
  // every one doubled, and a regex written the page's way (/Firefox\//) came out broken.
  const source = readFileSync(new URL('../src/web/cookie-help.ts', import.meta.url), 'utf8');
  assert.match(source, /export const COOKIE_HELP_SCRIPT = String\.raw`/, 'built as the page is');
  assert.match(source, /\+= ' \\u2014 what you are reading/, 'so the escape in its source');
  assert.ok(COOKIE_HELP_SCRIPT.includes(String.raw`' \u2014 what you are reading this in'`), 'the escape reaches the browser as written');
  assert.ok(PAGE.includes(COOKIE_HELP_SCRIPT), 'and the page carries it unchanged');
  assert.doesNotThrow(() => new Script(SCRIPT), 'the page script still parses');
});

test('the picture guide gives up quietly when its markup is missing, and the rest of the page script still runs', () => {
  for (const missing of [['ck-toggle'], ['ck-panel'], ['ck-toggle-text'], ['ck-toggle', 'ck-panel', 'ck-toggle-text']]) {
    const { $, document } = fakeDocument(missing);
    const context = createContext({ $, document, BROWSER: 'safari' });
    assert.doesNotThrow(() => runInContext(COOKIE_HELP_SCRIPT, context), `without ${missing.join(', ')}`);
  }
  // With it all there, it works.
  const { $, document } = fakeDocument();
  const context = createContext({ $, document, BROWSER: 'firefox' });
  runInContext(COOKIE_HELP_SCRIPT, context);
  $('ck-toggle').attrs['aria-expanded'] = 'false';
  $('ck-toggle').fire('click');
  assert.equal($('ck-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal($('ck-panel').hidden, false);
  assert.equal($('ck-toggle-text').textContent, 'Hide the pictures');
});

test('every id the page script asks for is in the page, or is made by the script before it is asked for', () => {
  const script = SCRIPT.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const asked = new Set();
  for (const m of script.matchAll(/(?:\$|getElementById)\('([^']+)'\)/g)) asked.add(m[1]);
  assert.ok(asked.size > 100, `found the ids the script asks for (${asked.size})`);
  const inMarkup = new Set([...MARKUP.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const madeByScript = new Set([
    ...[...script.matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]),
    ...[...script.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
  ]);
  const nowhere = [...asked].filter((id) => !inMarkup.has(id) && !madeByScript.has(id));
  assert.deepEqual(nowhere, [], 'each of these would be null, and the first property read on one ends the whole script');
  for (const id of ['ck-toggle', 'ck-panel', 'ck-toggle-text']) assert.ok(inMarkup.has(id), `${id}, which the picture guide needs`);
});

test('web-13: one escaper, all five characters, the single quote included', () => {
  assert.equal(escapeMarkup(`<a href='x' title="y">&</a>`), '&lt;a href=&#39;x&#39; title=&quot;y&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeMarkup('plain words'), 'plain words');
  // The server's banner uses it too (its test is in page-warnings.test.js); no second copy is left.
  assert.doesNotMatch(SCRIPT, /&#39;|&quot;/, 'the page script escapes nothing: it builds text nodes');
});

test('web-13: every attribute the drawings and the picture guide write is double-quoted', () => {
  const sources = [...COOKIE_FIGURES.map((f) => [f.id, f.svg]), ['COOKIE_HELP', COOKIE_HELP]];
  let checked = 0;
  for (const [name, markup] of sources) {
    for (const [tag] of markup.matchAll(/<[a-zA-Z][^>]*>/g)) {
      // Take away every name="value" pair: what is left must hold no attribute at all.
      const rest = tag.replace(/\s[a-zA-Z_:][-a-zA-Z0-9_:.]*="[^"]*"/g, '');
      assert.ok(!rest.includes('='), `${name}: ${tag} has an attribute that is not double-quoted`);
      assert.ok(!/'/.test(tag.replace(/"[^"]*"/g, '""')), `${name}: ${tag} has a single quote outside a double-quoted value`);
      checked += 1;
    }
  }
  assert.ok(checked > 500, `read every tag (${checked})`);
  // The words that go into an attribute go through the escaper on the way.
  for (const figure of COOKIE_FIGURES) {
    assert.ok(figure.svg.includes(`aria-label="${escapeMarkup(figure.alt)}"`), `${figure.id}: its label, escaped`);
  }
});
