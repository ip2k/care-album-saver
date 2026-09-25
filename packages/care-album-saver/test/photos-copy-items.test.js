// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { PAGE } from '../dist/web/page.js';

/**
 * Apple Photos.app's "Copy items to the Photos library" setting (docs/PHOTOS.md, DECISIONS C8).
 * This tool hands Apple Photos.app a private copy of each photo and deletes it once it has
 * it, so with the setting off it keeps a link to nothing, the photo never reaches iCloud,
 * and it is written down as added and never offered again. The tool cannot see the setting,
 * so the page says so above the switch and asks, every time, before turning it on; the same
 * question says how many photos will go in. The switch's own code is run here in node:vm;
 * nothing reaches Apple Photos.app.
 */

before(assertIsolatedConfigDir);

const TAG = '<script nonce="__NONCE__">';
const SCRIPT = PAGE.slice(PAGE.indexOf(TAG) + TAG.length, PAGE.indexOf('</script>'));
const COPY_ITEMS = /Copy items to the Photos library/;
/** The same words in Markdown, which wraps lines anywhere. */
const COPY_ITEMS_MD = /Copy\s+items\s+to\s+the\s+Photos\s+library/;

function between(text, from, to) {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `expected to find ${from} ... ${to}`);
  return text.slice(a, b);
}

/** The Photos switch, run with a stand-in page: what it asked, posted and showed, in order. */
function photosSwitch(confirmAnswer, { pending = 0 } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, checked: false, disabled: false, innerHTML: '', textContent: '' });
    return els.get(id);
  };
  const log = [];
  const context = createContext({
    $: el,
    photosNow: { supported: true, enabled: false, pending },
    window: {
      confirm: (question) => {
        log.push({ asked: question, disabled: el('addToPhotos').disabled });
        return confirmAnswer;
      },
    },
    show: (target, kind, html) => { target.innerHTML = `${kind}: ${html}`; },
    say: (target, kind, ...parts) => { target.innerHTML = `${kind}: ${parts.flat().join('')}`; },
    bold: (text) => String(text),
    paintPhotos: () => {},
    api: async (path, init) => {
      log.push({ posted: path, body: JSON.parse(init.body) });
      const on = JSON.parse(init.body).enabled;
      return { json: async () => ({ ok: true, photos: { supported: true, enabled: on, pending: on ? pending : 0 } }) };
    },
  });
  runInContext(between(SCRIPT, 'function photosQuestion(n)', "\n$('btn-photos-faq').onclick"), context);
  const box = el('addToPhotos');
  const flip = async (on) => {
    box.checked = on;
    await box.onchange({ target: box });
  };
  return {
    box,
    asked: () => log.filter((e) => e.asked).map((e) => e.asked),
    posted: () => log.filter((e) => e.posted).map(({ posted, body }) => ({ path: posted, body })),
    log,
    msg: () => el('photos-msg').innerHTML,
    flip,
  };
}

test('the card says to check the setting, above the switch, and the switch is described by it', () => {
  const card = between(PAGE, 'id="card-photos"', '</section>');
  assert.match(card, /<h2 id="h-photos">Also add them to Apple Photos\.app<\/h2>/);
  const note = between(card, 'id="photos-copy"', '</p>');
  assert.match(note, COPY_ITEMS);
  assert.match(note, /Settings &rsaquo; General<\/span> \(Preferences on macOS 12 and earlier\)/);
  assert.match(note, /would not open, and would never reach iCloud/);
  const tag = card.match(/<p[^>]*\bid="photos-copy"[^>]*>/)[0];
  assert.doesNotMatch(tag, /\bhidden\b/, 'shown, not tucked away');
  assert.ok(card.indexOf('id="photos-copy"') < card.indexOf('id="addToPhotos"'), 'it is read before the switch');
  assert.match(card, /id="addToPhotos" aria-describedby="photos-copy /, 'a screen reader hears it with the switch');
  assert.match(between(card, 'id="photos-why"', '</span>'), /Every photo and video saved so far, for every child/);
});

test('turning it on asks first; Cancel leaves it off, and asks the Mac nothing', async () => {
  const s = photosSwitch(false, { pending: 12 });
  await s.flip(true);
  assert.equal(s.asked().length, 1);
  const [question] = s.asked();
  assert.match(question, COPY_ITEMS);
  assert.match(question, /Settings › General \(Preferences on macOS 12 and earlier\)/);
  assert.match(question, /12 photos and videos saved so far, for every child, have not been given to Apple Photos\.app yet\. They will be added/);
  assert.match(question, /Nothing goes in until the next run, or until you press “Add them to Apple Photos\.app now”/);
  assert.match(question, /Is that setting ticked, and should they be added\?$/);
  assert.equal(s.log[0].disabled, false, 'the box is not greyed out while it asks');
  assert.deepEqual(s.posted(), [], 'nothing is turned on, and no permission question reaches the Mac');
  assert.equal(s.box.checked, false);
  assert.equal(s.box.disabled, false);
  assert.match(s.msg(), /^warn: Not turned on, and nothing was changed\./);
  assert.match(s.msg(), /<b>Copy items to the Photos library<\/b>/);
});

test('the question counts what would go in: one, or none yet', async () => {
  const one = photosSwitch(false, { pending: 1 });
  await one.flip(true);
  assert.match(one.asked()[0], /One photo or video saved so far has not been given to Apple Photos\.app yet\. It will be added/);
  const none = photosSwitch(false, { pending: 0 });
  await none.flip(true);
  assert.match(none.asked()[0], /Each run’s new photos will be added to Apple Photos\.app\./);
});

test('OK turns it on, after the question and never before, and says what is waiting', async () => {
  const s = photosSwitch(true, { pending: 12 });
  await s.flip(true);
  assert.ok(s.log[0].asked && s.log[1].posted, 'asked, then posted');
  assert.deepEqual(s.posted(), [{ path: '/api/photos', body: { enabled: true } }], 'turned on, and nothing added yet');
  assert.equal(s.box.checked, true);
  assert.match(s.msg(), /^ok: On\. The next run adds the 12 waiting to Apple Photos\.app/);
  assert.match(s.msg(), /Add them to Apple Photos\.app now/);
});

test('turning it off asks nothing', async () => {
  const s = photosSwitch(false);
  await s.flip(false);
  assert.deepEqual(s.asked(), []);
  assert.deepEqual(s.posted(), [{ path: '/api/photos', body: { enabled: false } }]);
  assert.match(s.msg(), /^ok: Off\./);
});

test('"Add them to Apple Photos.app now" starts an import on its own and follows it to its count', async () => {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, hidden: false, disabled: false, innerHTML: '', textContent: '' });
    return els.get(id);
  };
  const posted = [];
  const states = [
    { photosRun: { running: true, message: 'Apple Photos.app has imported 50 of 120…', last: null }, photos: { supported: true, enabled: true, pending: 70 } },
    { photosRun: { running: false, message: null, last: { ok: true, added: 118, unconfirmed: 2, remaining: 0, missing: 0 } }, photos: { supported: true, enabled: true, pending: 0 } },
  ];
  const said = [];
  const timers = [];
  const context = createContext({
    $: el,
    photosNow: { supported: true, enabled: true, pending: 120 },
    show: (target, kind, html) => { said.push(`${kind}: ${html}`); },
    say: (target, kind, ...parts) => { said.push(`${kind}: ${parts.flat(2).join('')}`); },
    bold: (text) => String(text),
    paintPhotos: () => {},
    answeredOddly: () => '',
    readState: async () => ({ ok: true, state: states.shift() }),
    setTimeout: (fn) => { timers.push(fn); },
    api: async (path, init) => {
      posted.push({ path, body: JSON.parse(init.body) });
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    },
  });
  runInContext(between(SCRIPT, 'let photosFollowing = false;', "\n$('btn-photos-now').onclick"), context);
  await runInContext('addToPhotosNow()', context);
  assert.deepEqual(posted, [{ path: '/api/photos', body: { now: true } }]);
  assert.equal(el('btn-photos-now').disabled, true, 'not pressed twice');
  await new Promise((r) => setImmediate(r));
  assert.match(said.at(-1), /^ok: Apple Photos\.app has imported 50 of 120…$/, 'its progress, in Apple Photos.app’s count');
  await timers.shift()();
  assert.match(said.at(-1), /^warn: Apple Photos\.app imported 118, into the Brightwheel folder\. Apple Photos\.app did not confirm 2 of the photos it was given\./);
  assert.equal(timers.length, 0, 'and it stops asking');
});

test('the help and the docs say it too', async () => {
  const faq = between(PAGE, 'id="faq-photos"', '<h3');
  assert.match(faq, COPY_ITEMS);
  const doc = await readFile(new URL('../../../docs/PHOTOS.md', import.meta.url), 'utf8');
  const steps = between(doc, '## Turning it on', '### The daily run asks separately');
  const copy = steps.search(COPY_ITEMS_MD);
  assert.ok(copy >= 0 && copy < steps.indexOf('tick **Add them to Apple Photos.app**'), 'checked before the switch is ticked');
  assert.match(steps, /Settings and Maintenance\*\*[\s\S]*\*\*Integrations\*\*/);
  assert.match(doc, /### If photos in the Brightwheel folder will not open/);
  assert.match(doc, /\(#if-photos-in-the-brightwheel-folder-will-not-open\)/, 'and the settings section links to it');
  const recovery = between(doc, '### If photos in the Brightwheel folder will not open', '## Shared albums');
  assert.match(recovery, /\*\*Command-Delete\*\*/, 'Delete alone only takes them out of the album');
  assert.match(recovery, /Find Original…/, 'and it warns off the fix that would leave a link again');
  const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8');
  assert.match(between(readme, '### Adding them to Apple Photos.app', '### Keeping it up to date'), COPY_ITEMS_MD);
});

/** The card painted from a status, with a stand-in page: its status line, and the main page's line. */
function painted(status) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const classes = new Set();
      els.set(id, {
        id, hidden: false, checked: false, disabled: false, innerHTML: '', textContent: '',
        classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
      });
    }
    return els.get(id);
  };
  const context = createContext({
    $: el,
    photosNow: null,
    photosFollowing: false,
    day: (at) => at.slice(0, 10),
    say: (target, kind, ...parts) => { target.innerHTML = `${kind}: ${parts.flat(2).join('')}`; },
    bold: (text) => String(text),
  });
  runInContext(between(SCRIPT, 'function paintPhotos(p) {', '\n/* Adding to Apple Photos.app on its own'), context);
  runInContext('paintPhotos(status)', Object.assign(context, { status }));
  return { status: el('photos-status').textContent, dash: el('dash-photos'), msg: el('photos-msg').innerHTML };
}

const ON = { supported: true, enabled: true, pending: 0, limitedFrom: null, earlier: 0, problem: null, warning: null, lastAttempt: null };

test('a batch Apple Photos.app counted short is said on the card and, as a warning, on the main page', () => {
  const p = painted({ ...ON, lastAttempt: { at: '2026-09-24T19:00:00Z', ok: true, added: 48, unconfirmed: 2 } });
  assert.match(p.status, /Apple Photos\.app last imported 48/);
  assert.match(p.status, /It did not confirm 2 of the photos it was given then/);
  assert.match(p.dash.textContent, /did not confirm some of the last photos/);
  assert.equal(p.dash.classList.contains('warn-text'), true);
  const fine = painted({ ...ON, lastAttempt: { at: '2026-09-24T19:00:00Z', ok: true, added: 48 } });
  assert.equal(fine.dash.classList.contains('warn-text'), false);
});

test('an install limited by an earlier version says what is held back and how to add it', () => {
  const p = painted({ ...ON, limitedFrom: '2026-09-20T10:00:00Z', earlier: 30 });
  assert.match(p.status, /^Nothing new is waiting\./, 'not "every photo saved so far"');
  assert.match(p.status, /Only photos saved since 2026-09-20 are added, as when you turned this on\. 30 saved before then are not: to add every photo, untick this and tick it again\./);
});

test('an import stopped by turning it off does not promise the next run', () => {
  const context = createContext({ $: () => ({}), bold: (t) => String(t) });
  runInContext(between(SCRIPT, '/** What an import on its own came to', '\nasync function followPhotos()'), context);
  const said = (last, p) => runInContext('photosOutcome(last, p)', Object.assign(context, { last, p })).flat(2).join('');
  const stopped = { ok: true, added: 50, remaining: 70, missing: 0 };
  assert.match(said(stopped, { enabled: false }), /Stopped, because adding to Apple Photos\.app was turned off\. The other 70 were not added\./);
  assert.match(said(stopped, { enabled: true }), /Stopped\. The other 70 will be added on the next run\./);
  // Nothing imported because the files had gone is not "nothing was waiting".
  const gone = said({ ok: true, added: 0, remaining: 0, missing: 3 }, { enabled: true });
  assert.doesNotMatch(gone, /Nothing was waiting/);
  assert.match(gone, /^Nothing was imported\. 3 listed in your archive are no longer in the folder/);
});
