// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { startWebUi } from '../dist/index.js';
import { updateSteps } from '../dist/updates.js';
import { PAGE } from '../dist/web/page.js';

/**
 * The security review's WARNINGs about the setup page (docs/SECURITY-REVIEW-2026-09-23.md
 * §4.2), one section each. The page's script is read as text, the way the rest of the suite
 * reads it.
 */

before(assertIsolatedConfigDir);

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

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
