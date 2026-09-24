// First, before anything that can read the config directory. Nothing here reads it, but the
// rule is "every file", so that a line added later cannot start writing over a real session.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext, Script } from 'node:vm';
import { PAGE } from '../dist/web/page.js';
import { COOKIE_FIGURES, COOKIE_HELP, COOKIE_HELP_SCRIPT, escapeMarkup } from '../dist/web/cookie-help.js';
import { PASTE_CLIENT_SOURCE } from '../dist/paste.js';

/**
 * The security review's NOTEs for the setup page (docs/SECURITY-REVIEW-2026-09-23.md §4.3 and
 * the verifiers' additions): page-6, page-10, page-11, page-12 with web-13, the silent
 * schedule failure, the unguarded picture guide, and Start with no answer from the tool.
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

/** The page's own h(), put() and say(), which the code under test builds its messages with. */
const BUILDERS = () => slice('const parts =', '/** A message box from markup');

// ------------------------------------------------------------------ page-6

test('page-6: a date the archive holds wrongly is "an unknown day", never "Invalid Date"', () => {
  const context = createContext({});
  runInContext(slice('/** A date from the archive', '/** The archive, in one sentence'), context);
  runInContext(slice('const postedOn =', '\n'), context);
  const run = (code) => runInContext(code, context);
  for (const bad of ['not a date', '2026-13-45', 'NaN']) {
    assert.equal(run(`day(${JSON.stringify(bad)})`), 'an unknown day', bad);
    assert.equal(run(`postedOn({ postedAt: ${JSON.stringify(bad)} })`), 'an unknown day', bad);
    assert.equal(run(`dateOr(${JSON.stringify(bad)}, '', {})`), '', `${bad}: the thumbnail caption is left empty`);
  }
  assert.equal(run('day(null)'), 'never', 'nothing at all is still "never"');
  assert.equal(run('postedOn({})'), 'an unknown day');
  const good = '2026-09-18T09:30:00Z';
  assert.equal(run(`day('${good}')`), new Date(good).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }));
  assert.doesNotMatch(run(`postedOn({ postedAt: '${good}' })`), /Invalid|unknown/);

  // And the page uses it everywhere an archive date is written: the old unchecked forms are gone.
  assert.doesNotMatch(SCRIPT, /new Date\(item\.postedAt\)/);
  assert.match(slice('async function paintGallery()', 'const turnGalleryPage'), /const when = dateOr\(item\.postedAt, '', \{\}\);/);
});

// ------------------------------------------------------------------ page-10

/** paintGallery and the viewer, with one page of items already fetched. */
function galleryHarness(items) {
  const { $, document } = fakeDocument();
  const context = createContext({
    $,
    document,
    TOKEN: 't',
    api: async () => { throw new Error('every page this test needs is cached'); },
    openViewer: () => {},
    Image: class { set src(v) { this.url = v; } },
  });
  runInContext(BUILDERS(), context);
  runInContext(slice('/** A date from the archive', '/** The archive, in one sentence'), context);
  runInContext(slice('const gallery = {', 'const turnGalleryPage'), context);
  runInContext(slice('const viewer = {', 'const stepViewer'), context);
  const run = (code) => runInContext(code, context);
  context.items = items;
  run('gallery.cache = new Map([[0, items]]); gallery.count = items.length; gallery.pages = 1; gallery.page = 0;');
  return { $, run };
}

const ITEMS = [
  { id: 0, kind: 'image', child: 'Robin Maple', postedAt: '2026-09-18T09:30:00Z', label: 'a' },
  { id: 1, kind: 'image', child: 'Robin Maple', postedAt: 'not a date', label: 'b' },
];

test('page-10: a thumbnail the browser cannot draw says so in words where the picture was', async () => {
  const t = galleryHarness(ITEMS);
  await t.run('paintGallery()');
  const tiles = t.$('gallery').children;
  assert.equal(tiles.length, 2);
  const [img, cap] = tiles[0].children;
  assert.equal(img.tag, 'img');
  assert.equal(img.src, '/photo?i=0&token=t');
  assert.ok(img.listeners.error?.length, 'the thumbnail listens for its own failure');
  img.fire('error');
  assert.equal(tiles[0].children[0].tag, 'span', 'the broken image is replaced');
  assert.equal(tiles[0].children[0].className, 'nothumb');
  assert.equal(tiles[0].children[0].textContent, 'No preview here');
  assert.equal(tiles[0].children[1], cap, 'the date caption stays');
  // The second tile's date could not be read: its caption is empty, not "Invalid Date".
  assert.equal(tiles[1].children[1].textContent, '');
  assert.match(tiles[1].attrs['aria-label'], /^Robin Maple, $/);
  assert.match(PAGE, /\.gallery \.nothumb \{/, 'and it has a style');
});

test('page-10: a photo the viewer cannot show says it is in the folder, as a video it cannot play does', async () => {
  const t = galleryHarness(ITEMS);
  const img = t.$('viewer-img');
  await t.run('showInViewer(0)');
  assert.equal(img.getAttribute('src'), '/photo?i=0&token=t');
  assert.equal(img.hidden, false);
  img.fire('error');
  assert.equal(t.$('viewer-unshowable').hidden, false, 'the line is shown');
  assert.equal(img.hidden, true, 'in place of a broken-image icon');
  assert.equal(t.$('viewer-unplayable').hidden, true, 'and not the video one');

  // The next photo starts clean.
  await t.run('showInViewer(1)');
  assert.equal(t.$('viewer-unshowable').hidden, true);
  assert.equal(img.hidden, false);
  assert.match(t.$('viewer-cap').textContent, /posted an unknown day/, 'page-6 in the viewer too');

  // An error with no photo asked for (the src taken away for a video) says nothing.
  img.removeAttribute('src');
  img.fire('error');
  assert.equal(t.$('viewer-unshowable').hidden, true);

  const line = /<p class="viewer-cap" id="viewer-unshowable" role="status" hidden>([^<]*)<\/p>/.exec(MARKUP);
  assert.ok(line, 'the line is in the page, hidden until needed');
  assert.match(line[1], /saved in your folder/);
});

// ------------------------------------------------------------------ page-11

test('page-11: after a successful Connect the page holds no copy of the pasted session', async () => {
  const { $, document } = fakeDocument();
  const sent = [];
  const context = createContext({
    $,
    document,
    api: async (path, opts) => { sent.push([path, JSON.parse(opts.body)]); return { json: async () => ({ ok: true }) }; },
    refresh: async () => {},
    show: () => {},
  });
  runInContext(BUILDERS(), context);
  runInContext(PASTE_CLIENT_SOURCE, context);
  runInContext(slice('let cookieVerdict = null;', '/* ----'), context);
  runInContext(slice("$('btn-connect').onclick = async () => {", '// Ticks and the layout menu'), context);
  const value = 'RXhhbXBsZU9ubHktTm90QVJlYWxWYWx1ZQ%3D%3D--0000000000000000';
  $('cookie').value = value;
  runInContext('checkCookieField(true)', context);
  assert.equal(runInContext('cookieVerdict && cookieVerdict.value', context), value, 'judged as it was pasted');
  $('btn-run').offsetParent = {};
  await $('btn-connect').onclick();
  assert.deepEqual(sent, [['/api/session', { cookie: value }]]);
  assert.equal($('cookie').value, '', 'the box is emptied');
  assert.equal(runInContext('cookieVerdict', context), null, 'and so is the verdict that held the cleaned value');
});

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

// ------------------------------------------------------------------ the schedule, said when it fails

function scheduleHarness(answer) {
  const { $, document } = fakeDocument();
  const painted = [];
  const context = createContext({
    $,
    document,
    api: async (path) => { assert.equal(path, '/api/schedule'); return answer(); },
    paintSchedule: () => painted.push('schedule'),
    paintFacts: () => painted.push('facts'),
  });
  runInContext(BUILDERS(), context);
  runInContext('let sched = null; let proposed = null;', context);
  runInContext(slice('async function loadSchedule()', 'function paintSchedule()'), context);
  return { $, painted, run: (code) => runInContext(code, context) };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('loadSchedule: the tool failing to ask the scheduler is said in step 4 and on the dashboard', async () => {
  const t = scheduleHarness(() => json(500, { ok: false, error: 'launchctl could not be asked about the daily run.' }));
  await t.run('loadSchedule()');
  assert.equal(t.$('schedule-msg').textContent, 'launchctl could not be asked about the daily run.', 'the tool\'s own words');
  assert.equal(t.$('schedule-msg').children[0].className, 'msg err');
  assert.match(t.$('dash-schedule').textContent, /could not be checked/, 'the daily-run line does not vanish');
  assert.ok(t.$('dash-schedule').classes.has('warn-text'), 'and is not dressed as all well');
  assert.deepEqual(t.painted, [], 'nothing is painted from an answer that is not one');

  const garbled = scheduleHarness(() => new Response('<h1>Bad gateway</h1>', { status: 502 }));
  await garbled.run('loadSchedule()');
  assert.match(garbled.$('schedule-msg').textContent, /could not say whether a daily run is set up \(it answered 502\)/);

  // The tool gone altogether is the run card's to say, as it was.
  const gone = scheduleHarness(() => { throw new TypeError('Failed to fetch'); });
  await gone.run('loadSchedule()');
  assert.equal(gone.$('schedule-msg').textContent, '');
  assert.equal(gone.$('dash-schedule').textContent, '');

  const fine = scheduleHarness(() => json(200, { ok: true, schedule: { installed: false }, proposed: {} }));
  await fine.run('loadSchedule()');
  assert.deepEqual(fine.painted, ['schedule', 'facts']);
});

// ------------------------------------------------------------------ Start, and saving, with no answer

function startHarness(answers) {
  const { $, document } = fakeDocument();
  const calls = { poll: 0, ready: 0, saveErrors: [] };
  const context = createContext({
    $,
    document,
    calls,
    api: async (path) => {
      const next = answers[path]?.shift();
      assert.ok(next, `an answer for ${path}`);
      return next();
    },
    savedDir: '',
    formState: () => ({ tagNote: true }),
    showSaveError: (d) => calls.saveErrors.push(d.error),
    applySaved: () => {},
    clearDirError: () => {},
    savedNote: () => {},
    updateRunReady: () => { calls.ready += 1; },
    poll: () => { calls.poll += 1; },
    show: (el, kind, html) => { el.textContent = html; el.kind = kind; },
  });
  runInContext(BUILDERS(), context);
  runInContext(slice('let saves = Promise.resolve();', 'function applySaved(d)'), context);
  runInContext(slice("$('btn-run').onclick = async () => {", "$('btn-stop').onclick"), context);
  return { $, calls, run: (code) => runInContext(code, context), context };
}

const unreachable = () => { throw new TypeError('Failed to fetch'); };

test('Start: a tool that does not answer the save is said as that, not as a setting to fix', async () => {
  const t = startHarness({ '/api/config': [unreachable] });
  await t.$('btn-run').onclick();
  const said = t.$('run-result').textContent;
  assert.match(said, /^Not started\. This page cannot reach the tool\./);
  assert.match(said, /press Start saving again/);
  assert.doesNotMatch(said, /Fix the setting/);
  assert.match(t.calls.saveErrors[0], /Could not save that\. This page cannot reach the tool/);
  assert.ok(t.calls.ready > 0, 'Start is given back');
  assert.equal(t.calls.poll, 0);
});

test('Start: a tool that stops answering between the save and the start is said in words, not left as a pressed button', async () => {
  const t = startHarness({ '/api/config': [() => json(200, { ok: true, config: {} })], '/api/sync': [unreachable] });
  await t.$('btn-run').onclick();
  assert.match(t.$('run-result').textContent, /^Not started\. This page cannot reach the tool\. It may have been closed/);
  assert.ok(t.calls.ready > 0, 'Start is given back');
  assert.equal(t.calls.poll, 0, 'nothing is polled for a run that never began');

  // And a refusal in the tool's words still reads as before.
  const refused = startHarness({ '/api/config': [() => json(400, { ok: false, error: 'That folder cannot be used.', field: 'archiveDir' })] });
  await refused.$('btn-run').onclick();
  assert.match(refused.$('run-result').textContent, /Fix the setting/);

  const started = startHarness({ '/api/config': [() => json(200, { ok: true, config: {} })], '/api/sync': [() => json(202, { ok: true })] });
  await started.$('btn-run').onclick();
  assert.equal(started.calls.poll, 1, 'an ordinary start still polls');
});

test('persist: a save that throws is said in words and never rejects, so the saves after it still run', async () => {
  const t = startHarness({ '/api/config': [() => json(200, { ok: true, config: {} })] });
  // A save that throws past its own catch — here the stand-in for a bug in what follows the answer.
  t.run('applySaved = () => { throw new Error("a bug"); }');
  const first = await t.run('persist({ tagNote: false })');
  assert.equal(first, false);
  assert.match(t.$('config-msg').textContent, /Something went wrong in this page while saving/);
  t.run('applySaved = () => {}');
  t.context.api = async () => json(200, { ok: true, config: {} });
  assert.equal(await t.run('persist({ tagNote: true })'), true, 'the queue is not jammed');
});
