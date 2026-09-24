// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { createContext, runInContext, Script } from 'node:vm';
import { startMockBrightwheel, startWebUi } from '../dist/index.js';
import { updateSteps } from '../dist/updates.js';
import { PAGE } from '../dist/web/page.js';

/**
 * The security review's four WARNINGs about the setup page (docs/SECURITY-REVIEW-2026-09-23.md
 * §4.2, page-1 to page-4), one section each.
 *
 * The suite has no browser, so what the page's script does is checked two ways: as text, the
 * way the rest of the suite reads it, and — for the parts that decide what happens when
 * something goes wrong — by running those functions in node:vm against stand-ins for the
 * document and the network, so that a retry that never retries fails here rather than only
 * in front of a parent.
 */

before(assertIsolatedConfigDir);

const SESSION = 'test-session-value';
const execFileP = promisify(execFile);

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-page-warnings-'));
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

const TAG = '<script nonce="__NONCE__">';
/** The page's one script, as the template holds it. */
const SCRIPT = PAGE.slice(PAGE.indexOf(TAG) + TAG.length, PAGE.indexOf('</script>'));

/** The script from one marker up to the next marker after it, so an assertion cannot match elsewhere. */
function slice(from, to) {
  const a = SCRIPT.indexOf(from);
  const b = SCRIPT.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `expected the page script to contain ${from} ... ${to}`);
  return SCRIPT.slice(a, b);
}

const call = async (handle, path, body) => {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
};

/** A stand-in for document.getElementById: plain objects, made on first use and kept. */
function fakeDocument() {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) {
      const attributes = new Set();
      els.set(id, {
        id,
        textContent: '',
        dataset: {},
        attributes,
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        toggleAttribute: (name, on) => { if (on) attributes.add(name); else attributes.delete(name); },
        removeAttribute: (name) => attributes.delete(name),
      });
    }
    return els.get(id);
  };
  return { $, els };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ------------------------------------------------------------------ page-1

/**
 * poll() and refresh() with the network and the timers in the test's hands. `answers` is the
 * queue /api/state is answered from: a function returning a Response, or throwing as fetch
 * does when nothing is listening.
 */
function pollHarness() {
  const { $ } = fakeDocument();
  const answers = [];
  const timers = [];
  const notices = [];
  const painted = [];
  const context = createContext({
    $,
    Response,
    answers,
    timers,
    notices,
    painted,
    api: async (path) => {
      assert.equal(path, '/api/state');
      const next = answers.shift();
      assert.ok(next, 'an answer was queued for every request');
      return next();
    },
    say: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
    paint: (...args) => painted.push(args),
    paintPhotos: () => {},
    paintDashboard: () => {},
  });
  runInContext(slice('const RETRY_FIRST_MS', 'let refreshWait'), context);
  runInContext('stateNotice = (text) => { notices.push(text); };', context);
  runInContext(slice('/** Which poll is the current one', '/* ----'), context);
  runInContext('let refreshWait = 0;\n' + slice('async function refresh()', '\n  state = answer;') + '}', context);
  return { $, answers, timers, notices, painted, run: (code) => runInContext(code, context) };
}

const unreachable = () => { throw new TypeError('Failed to fetch'); };

test('page-1: a refused or unreachable /api/state is said in words, and asked again from one second doubling to thirty', async () => {
  const t = pollHarness();
  // The tool has gone away mid-run: fetch itself throws.
  t.answers.push(unreachable);
  await t.run('poll()');
  assert.equal(t.timers.length, 1, 'it asks again');
  assert.equal(t.timers[0].ms, 1000, 'after a second');
  assert.match(t.$('run-msg').textContent, /cannot reach the tool/, 'in words, where the progress was');
  assert.match(t.$('run-msg').textContent, /Asking again in a second\./);
  assert.equal(t.$('bar').dataset.stopped, 'true', 'the bar holds still rather than implying progress');
  assert.equal(t.$('bar').dataset.indeterminate, 'true', 'and claims no percentage, a finished run\'s full bar included');
  assert.ok(t.$('card-run').attributes.has('data-running'), 'and the progress line is shown in Settings too, where it hides between runs');
  assert.match(t.notices.at(-1), /cannot reach the tool.*keeps asking/, 'and across the top of the page');

  // Refused with the tool's own reason: shown as the tool put it.
  t.answers.push(() => json(500, { ok: false, error: 'The settings file is damaged.' }));
  await t.timers[0].fn();
  assert.equal(t.timers[1].ms, 2000);
  assert.match(t.$('run-msg').textContent, /^The settings file is damaged\. Asking again in 2 seconds\.$/);

  // Refused with no reason at all, and not even JSON: still words, with what came back.
  t.answers.push(() => new Response('<h1>Bad gateway</h1>', { status: 502 }));
  await t.timers[1].fn();
  assert.equal(t.timers[2].ms, 4000);
  assert.match(t.$('run-msg').textContent, /did not say how things stand \(it answered 502\)/);

  // Doubling, and never more than half a minute apart.
  for (let i = 3; i < 7; i += 1) {
    t.answers.push(unreachable);
    await t.timers[i - 1].fn();
  }
  assert.deepEqual(t.timers.map((x) => x.ms), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);

  // The tool answers again: the run carries on painting, the notice goes, the wait resets.
  t.answers.push(() => json(200, { config: {}, progress: { phase: 'saving', message: 'Saving', saved: 1, skipped: 0, failed: 0 }, running: true }));
  await t.timers[6].fn();
  assert.equal(t.painted.length, 1, 'the run is painted again');
  assert.equal(t.notices.at(-1), null, 'the notice is taken away');
  assert.equal(t.timers[7].ms, 700, 'and the ordinary pace resumes');
  t.answers.push(unreachable);
  await t.timers[7].fn();
  assert.equal(t.timers[8].ms, 1000, 'a later failure starts from a second again');
});

test('page-1: a tool that was started again refuses this page for good, which is said once and not retried', async () => {
  const t = pollHarness();
  t.answers.push(() => new Response('<h1>Wrong or missing setup link</h1>', { status: 403 }));
  await t.run('poll()');
  assert.equal(t.timers.length, 0, 'asking again cannot help, so it does not');
  assert.match(t.$('run-msg').textContent, /no longer accepts this page\u2019s link/);
  assert.match(t.$('run-msg').textContent, /Open the new link/);
  assert.doesNotMatch(t.notices.at(-1), /keeps asking/, 'and does not promise to');
});

test('page-1: the notice across the top is written once per change of words, and taken away when the tool answers', () => {
  const { $ } = fakeDocument();
  const said = [];
  let inserted = 0;
  let removed = 0;
  $('main').insertAdjacentHTML = (where, html) => {
    assert.equal(html, '<div id="state-error" role="alert"></div>', 'an empty box, filled as text');
    inserted += 1;
  };
  $('state-error').remove = () => { removed += 1; };
  const context = createContext({ $: (id) => (id === 'state-error' && removed ? null : $(id)), say: (el, kind, text) => said.push([el.id, kind, text]), Response });
  runInContext(slice('const RETRY_FIRST_MS', 'let refreshWait'), context);
  runInContext('stateNotice("The tool has gone.")', context);
  runInContext('stateNotice("The tool has gone.")', context);
  assert.deepEqual(said, [['state-error', 'err', 'The tool has gone.']], 'the same words are not announced twice');
  runInContext('stateNotice("Something else.")', context);
  assert.equal(said.length, 2);
  runInContext('stateNotice(null)', context);
  assert.equal(removed, 1, 'and it goes when there is nothing to say');
  assert.equal(inserted, 0, 'the box that was there was used');
});

test('page-1: two polls at once collapse into one, so retries never multiply', async () => {
  const t = pollHarness();
  const running = () => json(200, { config: {}, progress: { phase: 'saving', message: 'Saving', saved: 0, skipped: 0, failed: 0 }, running: true });
  t.answers.push(running, running);
  await Promise.all([t.run('poll()'), t.run('poll()')]);
  assert.equal(t.timers.length, 1, 'only the newer one carries on');
});

test('page-1: the first load retries too, rather than leaving a blank page', async () => {
  const t = pollHarness();
  t.answers.push(unreachable);
  await t.run('refresh()');
  assert.equal(t.timers.length, 1);
  assert.equal(t.timers[0].ms, 1000);
  assert.match(t.notices.at(-1), /cannot reach the tool.*keeps asking/);
  t.answers.push(() => json(500, { ok: false, error: 'The settings file is damaged.' }));
  await t.timers[0].fn();
  assert.equal(t.timers[1].ms, 2000);
  assert.match(t.notices.at(-1), /^The settings file is damaged\. This page keeps asking/);

  t.answers.push(() => new Response('no', { status: 403 }));
  await t.timers[1].fn();
  assert.equal(t.timers.length, 2, 'a refused link is not asked again');
});

// ------------------------------------------------------------------ page-2

test('page-2: /api/children answers a session Brightwheel refuses with a 401 the page can act on, in words for a browser', async () => {
  await freshConfigDir();
  // Connecting reads one API response; the next finds the session gone.
  const mock = await startMockBrightwheel({ validSession: SESSION, expireSessionAfterRequests: 1 });
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    assert.equal((await call(handle, '/api/session', { cookie: SESSION })).status, 200);
    const refused = await call(handle, '/api/children');
    assert.equal(refused.status, 401, 'not a 500: the tool is fine, Brightwheel said no');
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.sessionRejected, true, 'a flag the page acts on, not a sentence it has to parse');
    assert.match(refused.body.error, /Brightwheel no longer accepts the saved session/);
    assert.match(refused.body.error, /paste it in the box above/, 'and what to do about it');
    assert.doesNotMatch(refused.body.error, /care-album-saver login|Run `/, 'no command-line instruction in a browser');
  } finally {
    await handle.close();
    await mock.close();
  }
});

test('page-2: any other failure to read the children is not reported as a refused session', async () => {
  await freshConfigDir();
  // A pretend Brightwheel that accepts the session, then answers in a shape the tool does not
  // recognise: an error about the answer, not about the session, and one that is not retried.
  let asked = 0;
  const odd = createServer((req, res) => {
    asked += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(asked === 1 ? { object_id: 'guardian-1', email: null } : { nothing: 'recognisable' }));
  });
  await new Promise((resolve) => odd.listen(0, '127.0.0.1', resolve));
  const handle = await startWebUi({ baseUrl: `http://127.0.0.1:${odd.address().port}/api/v1` });
  try {
    assert.equal((await call(handle, '/api/session', { cookie: SESSION })).status, 200);
    const failed = await call(handle, '/api/children');
    assert.equal(failed.status, 500);
    assert.notEqual(failed.body.sessionRejected, true, 'an answer the tool cannot read says nothing about the session');
    assert.match(failed.body.error, /account id/, 'and is reported as what it is');
  } finally {
    await handle.close();
    await new Promise((resolve) => odd.close(resolve));
  }
});

/** loadChildren and what it calls, with the page's other functions as recording stand-ins. */
function childrenHarness(answer, state) {
  const { $ } = fakeDocument();
  const calls = { setStep: [], say: [], placeSetupFlow: [], put: [] };
  const context = createContext({
    $,
    state,
    sessionOk: true,
    kids: [{ id: 'stu-aaa-111', fullName: 'Robin Maple' }],
    calls,
    api: async (path) => {
      assert.equal(path, '/api/children');
      return answer();
    },
    h: (tag, attrs, ...children) => ({ tag, attrs, children, dataset: {}, addEventListener() {} }),
    put: (el, ...children) => calls.put.push([el.id, children]),
    say: (el, kind, ...parts) => calls.say.push([el.id, kind, parts.join('')]),
    setStep: (card, num, sr, s, text) => calls.setStep.push([card.id, s, text]),
    describeSelection: () => {},
    updateRunReady: () => {},
    placeSetupFlow: (inSettings) => calls.placeSetupFlow.push(inSettings),
    paintFacts: () => {},
    onChildToggled: () => {},
  });
  runInContext(slice('function needsSetup(s)', '\n}\n') + '\n}', context);
  runInContext(slice('function sessionRefused(sentence)', 'function onChildToggled()'), context);
  return { $, calls, run: (code) => runInContext(code, context) };
}

test('page-2: a refused session sends the page back to step 1, with the sentence under it, and off the dashboard', async () => {
  const state = { hasSession: true, archive: { totalFiles: 12 }, progress: { phase: 'done', message: 'Done' } };
  const t = childrenHarness(
    () => json(401, { ok: false, sessionRejected: true, error: 'Brightwheel no longer accepts the saved session. Paste it in the box above.' }),
    state,
  );
  await t.run('loadChildren()');
  assert.equal(t.run('sessionOk'), false, 'Start saving waits for step 1 again');
  assert.equal(state.sessionRejected, true);
  assert.deepEqual(t.calls.setStep[0].slice(0, 2), ['card-connect', 'active'], 'step 1 is the step to do');
  assert.match(t.calls.setStep[0][2], /Step 1 of 4\. Brightwheel no longer accepts the saved session/);
  assert.deepEqual(t.calls.say, [['connect-msg', 'err', 'Brightwheel no longer accepts the saved session. Paste it in the box above.']]);
  assert.equal(t.run('kids.length'), 0, 'no children are claimed');
  assert.equal(t.calls.put[0][0], 'kids');
  assert.deepEqual(t.calls.put[0][1][0].children, ['Connect again to see your children here.'], 'and the empty list says to connect again');
  assert.deepEqual(t.calls.placeSetupFlow, [false], 'the steps come back out of Settings');
  assert.equal(t.run('needsSetup(state)'), true, 'however many photos are saved');

});

test('page-2: children that cannot be read for another reason are said beside the names, and the session is left alone', async () => {
  const state = { hasSession: true, archive: { totalFiles: 12 } };
  const t = childrenHarness(() => json(500, { ok: false, error: 'Brightwheel could not be reached.' }), state);
  await t.run('loadChildren()');
  assert.equal(t.run('sessionOk'), true);
  assert.equal(state.sessionRejected, undefined);
  assert.equal(t.$('kids-status').textContent, 'Brightwheel could not be reached.');

  const gone = childrenHarness(unreachable, { hasSession: true });
  await gone.run('loadChildren()');
  assert.match(gone.$('kids-status').textContent, /Could not ask Brightwheel who is on this account/);
});

test('page-2: the page asks for the children before it says "Connected"', () => {
  const refresh = slice('async function refresh()', 'function sessionRefused(');
  const asked = refresh.indexOf('await loadChildren()');
  const connected = refresh.indexOf("'Connected'");
  assert.ok(asked > 0 && connected > asked, 'a refused session is never shown as connected on its way to being found out');
  assert.match(refresh, /if \(state\.hasSession && !state\.sessionRejected\) \{/);
  assert.match(slice('function paintFacts()', 'async function postSchedule('), /state\.sessionRejected/, 'the dashboard line does not say "Connected" either');
});

// ------------------------------------------------------------------ page-3

const nonceOf = (html) => /<script nonce="([^"]+)">/.exec(html)?.[1];

test('page-3: the page script runs by a nonce made fresh for each response, and no inline script can', async () => {
  await freshConfigDir();
  const handle = await startWebUi({});
  try {
    const url = `http://127.0.0.1:${handle.port}/?token=${handle.token}`;
    const first = await fetch(url);
    const second = await fetch(url);
    const [a, b] = [await first.text(), await second.text()];
    const csp = first.headers.get('content-security-policy');

    const nonce = nonceOf(a);
    assert.ok(nonce, 'the script tag carries a nonce');
    assert.ok(Buffer.from(nonce, 'base64').length >= 16, 'of at least 128 bits');
    assert.notEqual(nonceOf(b), nonce, 'a new one for every response');
    assert.ok(!a.includes('__NONCE__'), 'the placeholder is always replaced');
    assert.equal((a.match(/<script\b/g) || []).length, 1, 'and there is one script to carry it');

    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    assert.equal(scriptSrc, `script-src 'nonce-${nonce}' 'strict-dynamic'`, 'the header names exactly that nonce');
    assert.ok(!scriptSrc.includes('unsafe-inline'), 'no inline script without it');
    assert.ok(second.headers.get('content-security-policy').includes(`'nonce-${nonceOf(b)}'`));
    assert.match(csp, /style-src 'unsafe-inline'/, 'styles keep working');
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /default-src 'none'/);

    // Everything that is not the page runs no script at all.
    const state = await call(handle, '/api/state');
    assert.ok(!state.headers.get('content-security-policy').includes('script-src'), 'default-src \'none\' covers it');
    const refused = await fetch(`http://127.0.0.1:${handle.port}/`);
    assert.equal(refused.status, 403);
    assert.ok(!refused.headers.get('content-security-policy').includes('script-src'));
  } finally {
    await handle.close();
  }
});

test('the page response: a banner is spliced in as text, with no replacement patterns (the review\'s web-11 note)', async () => {
  await freshConfigDir();
  const handle = await startWebUi({ banner: "Demo $& and $' and $` and __NONCE__" });
  try {
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/?token=${handle.token}`)).text();
    assert.ok(html.includes('<div class="demo-ribbon" role="note">Demo $&amp; and $&#39; and $` and __NONCE__</div>'));
  } finally {
    await handle.close();
  }
});

test('page-3: nothing in the page runs from an attribute: no inline handlers, no javascript: links', () => {
  const markup = PAGE.slice(0, PAGE.indexOf(TAG)) + PAGE.slice(PAGE.indexOf('</script>'));
  assert.deepEqual(markup.match(/<[^>]*\son[a-z]+\s*=/gi) ?? [], [], 'no onclick= or the like in the markup');
  assert.ok(!/javascript:/i.test(PAGE), 'no javascript: URLs');
  // Nor in anything the script writes: static markup it inserts, and elements it builds.
  assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(SCRIPT.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')), 'no handler attribute in markup the script writes');
  assert.ok(!/setAttribute\(\s*'on/.test(SCRIPT), 'none set as an attribute');
  assert.ok(!/\bh\('[a-z]+', \{[^}]*\bon[a-z]+:/.test(SCRIPT), 'none passed to h()');
});

/**
 * The argument list that starts at `i` (just after an opening bracket), split at its top-level
 * commas, skipping string literals and nested brackets. Enough for the page's call sites, which
 * are what this reads.
 */
function argsAt(src, i) {
  const args = [];
  let depth = 0;
  let start = i;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "'" || c === '"') {
      for (i += 1; src[i] !== c; i += 1) if (src[i] === '\\') i += 1;
    } else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  args.push(src.slice(start, i));
  return args.map((a) => a.trim());
}

/** The expression assigned at `i` (just after `=`), up to the end of its statement. */
function assignedAt(src, i) {
  let depth = 0;
  let j = i;
  for (; j < src.length; j += 1) {
    const c = src[j];
    if (c === "'" || c === '"') {
      for (j += 1; src[j] !== c; j += 1) if (src[j] === '\\') j += 1;
    } else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ';' && depth === 0) break;
  }
  return src.slice(i, j).trim();
}

test('page-3: every string the script parses as markup is written in this file, never anything from the server', () => {
  // The one place markup is made from a variable is show() itself, which takes markup by
  // contract; its callers are what is checked.
  const definition = /const show = \(el, kind, html\) => \{[^\n]*\n/;
  assert.match(SCRIPT, definition);
  const script = SCRIPT.replace(definition, '');
  const lineOf = (i) => script.slice(0, i).split('\n').length;
  const inComment = (i) => /\/\/|^\s*\*/.test(script.slice(script.lastIndexOf('\n', i) + 1, i));

  const sinks = [];
  for (const m of script.matchAll(/\.innerHTML\s*=(?!=)/g)) {
    if (!inComment(m.index)) sinks.push({ line: lineOf(m.index), html: assignedAt(script, m.index + m[0].length) });
  }
  for (const m of script.matchAll(/\.insertAdjacentHTML\(/g)) {
    if (!inComment(m.index)) sinks.push({ line: lineOf(m.index), html: argsAt(script, m.index + m[0].length)[1] });
  }
  for (const m of script.matchAll(/(?<![\w.$])show\(/g)) {
    if (!inComment(m.index)) sinks.push({ line: lineOf(m.index), html: argsAt(script, m.index + m[0].length)[2] });
  }
  assert.ok(sinks.length >= 20, `found the page's markup sinks (${sinks.length})`);

  // What is left of each once its string literals are taken out: operators, and only the
  // names that choose between two literals or build the static how-to list.
  const allowed = new Set(['on', '$', 'hidden', 'howToSteps', 'map', 's', 'join']);
  for (const sink of sinks) {
    assert.ok(sink.html, `line ${sink.line}: the markup argument was found`);
    const residue = sink.html.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
    const names = residue.match(/[A-Za-z_$][\w$]*/g) ?? [];
    const foreign = names.filter((n) => !allowed.has(n));
    assert.deepEqual(foreign, [], `line ${sink.line} of the script builds markup from ${foreign.join(', ')}: ${sink.html}`);
  }

  // And the ways that replaced them never parse anything.
  for (const [from, to] of [['const parts =', 'const bold ='], ['const say =', 'const show =']]) {
    assert.ok(!slice(from, to).includes('innerHTML'), `${from} builds nodes, never markup`);
  }
  assert.ok(!/\besc\(/.test(SCRIPT), 'no escaper left to forget');
  assert.ok(!/outerHTML|document\.write|insertAdjacentElement\(|\.srcdoc/.test(SCRIPT));
});

// ------------------------------------------------------------------ page-4

test('page-4: a folder is quoted for the shell the steps are for, and left alone when it needs nothing', () => {
  const git = (root, platform) => updateSteps('git', { root, platform }).commands[0];
  // The usual case reads exactly as before.
  assert.equal(git('~/care-album-saver', 'darwin'), 'cd ~/care-album-saver');
  assert.equal(git('/opt/care-album-saver', 'linux'), 'cd /opt/care-album-saver');
  assert.equal(git('C:\\Users\\robin\\care-album-saver', 'win32'), 'cd C:\\Users\\robin\\care-album-saver');

  // POSIX: single quotes, with ~/ outside them so it still means the home folder.
  assert.equal(git('~/My Tools/care album saver', 'darwin'), "cd ~/'My Tools/care album saver'");
  assert.equal(git('/Users/Some One/care-album-saver', 'linux'), "cd '/Users/Some One/care-album-saver'");
  assert.equal(git("/x/Robin's photos", 'darwin'), "cd '/x/Robin'\\''s photos'");
  assert.equal(git('/x/$(echo INJECTED)', 'linux'), "cd '/x/$(echo INJECTED)'");

  // Windows: double quotes, which cmd and PowerShell both read.
  assert.equal(git('C:\\Users\\Some One\\care-album-saver', 'win32'), 'cd "C:\\Users\\Some One\\care-album-saver"');
  assert.equal(git('C:\\Program Files (x86)\\care-album-saver', 'win32'), 'cd "C:\\Program Files (x86)\\care-album-saver"');

  // Every way of installing that names a folder.
  assert.equal(updateSteps('download', { root: '/a b', platform: 'linux' }).commands[0], "cd '/a b'");
  assert.equal(updateSteps('production', { source: '~/Code/a b', platform: 'darwin' }).commands[0], "cd ~/'Code/a b'");
  assert.equal(updateSteps('production', { source: 'D:\\a b', platform: 'win32' }).commands[0], 'cd "D:\\a b"');

  // Words standing in for an unknown folder are for the person to replace, not a folder.
  assert.equal(updateSteps('git', { platform: 'darwin' }).commands[0], 'cd the folder it is in');
  assert.equal(updateSteps('production', { platform: 'linux' }).commands[0], 'cd your development checkout');
});

test('page-4: the quoted command really does reach the folder in a POSIX shell', { skip: process.platform === 'win32' ? 'a POSIX shell; the Windows quoting is checked as text above' : false }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'cas-quote-home-'));
  // A space, a quote, brackets, an ampersand, and what would expand if it were not quoted.
  const folder = join(home, "Robin's Photos (2026) & more", 'a $HOME b', 'care album saver');
  await mkdir(folder, { recursive: true });
  const expected = realpathSync(folder);
  for (const [kind, where] of [
    ['git', { root: folder }],
    ['git', { root: '~/' + relative(home, folder) }],
    ['download', { root: folder }],
    ['production', { source: '~/' + relative(home, folder) }],
  ]) {
    const [cd] = updateSteps(kind, { ...where, platform: process.platform }).commands;
    const { stdout } = await execFileP('/bin/sh', ['-c', `${cd} && pwd -P`], { env: { ...process.env, HOME: home } });
    assert.equal(stdout.trim(), expected, `${kind}: ${cd}`);
  }
});

test('page-4: the server hands the page the quoted steps', async () => {
  await freshConfigDir();
  const root = process.platform === 'win32' ? 'C:\\Some Folder\\care-album-saver' : '/some folder/care-album-saver';
  const release = {
    tag_name: 'v9.9.0',
    html_url: 'https://github.com/ip2k/care-album-saver/releases/tag/v9.9.0',
    draft: false,
    prerelease: false,
    body: '',
  };
  const handle = await startWebUi({
    updates: { fetch: async () => json(200, release), version: { version: '0.1.0', commit: null }, install: 'git', root },
  });
  try {
    const yes = await call(handle, '/api/update', { enabled: true });
    assert.equal(yes.status, 200);
    assert.equal(yes.body.how.commands[0], process.platform === 'win32' ? `cd "${root}"` : `cd '${root}'`);
  } finally {
    await handle.close();
  }
});

test('the page script still parses with all of this in it', () => {
  assert.doesNotThrow(() => new Script(SCRIPT, { filename: 'setup-page-script.js' }));
});
