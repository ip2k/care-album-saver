import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * .dockerignore keeps sessions, photos and the host's build output out of the image
 * (security review sc-1 and img, fixed 2026-09-23; the missing test is the missed-sc
 * verifier's point).
 *
 * The fix was proven once with a real `docker build` and planted markers, and nothing kept
 * it proven. Its whole defect had been anchoring: Docker reads `dist` as the root's dist
 * only, so packages/care-album-saver/dist and node_modules went into the image. So this
 * reads the file two ways. Lexically, every rule must start with `**`/. And behaviourally,
 * through a small copy of Docker's own matcher (moby/patternmatcher, the code both the
 * classic builder and BuildKit use), every kind of file the review named must be left out
 * wherever it sits, and every file the Dockerfile builds from must be let in.
 *
 * The matcher copy was checked against Docker 29.5 (the classic builder) on 2026-09-23: a
 * `FROM scratch` image that copied a context holding all 81 paths below, synthetic files
 * each, contained exactly the 46 this file expects to be kept, and none of the other 35.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PKG = 'packages/care-album-saver';

/** The rules as Docker reads them: trimmed, comments and blank lines dropped. */
function rulesOf(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

const RULES = rulesOf(readFileSync(join(ROOT, '.dockerignore'), 'utf8'));

/**
 * One rule as moby/patternmatcher compiles it: cleaned like filepath.Clean (so a trailing
 * slash means nothing), `**` for any number of folders including none, `*` and `?` within
 * one path segment, character classes passed through, and a few regex characters escaped.
 */
function compile(rule) {
  const exclusion = rule.startsWith('!');
  let p = (exclusion ? rule.slice(1) : rule).trim();
  p = p.replace(/\/+/g, '/').replace(/^\/(?=.)/, '').replace(/(?<=.)\/$/, '');
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') i++;
        re += i + 1 >= p.length ? '.*' : '(.*/)?';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+()|{}$'.includes(ch)) {
      re += `\\${ch}`;
    } else if (ch === '\\') {
      i++;
      re += `\\${p[i]}`;
    } else {
      re += ch;
    }
  }
  return { exclusion, re: new RegExp(`${re}$`) };
}

/**
 * Whether Docker leaves `file` (slash-separated, relative to the context) out of the build
 * context: the last rule that matches the file or any folder above it decides, as in
 * PatternMatcher.MatchesOrParentMatches.
 */
function excluded(rules, file) {
  const compiled = rules.map(compile);
  const parts = file.split('/');
  let matched = false;
  for (const { exclusion, re } of compiled) {
    if (exclusion !== matched) continue;
    let match = re.test(file);
    for (let i = 1; !match && i < parts.length; i++) match = re.test(parts.slice(0, i).join('/'));
    if (match) matched = !exclusion;
  }
  return matched;
}

/** Each kind of file the review said must never reach the image, at the root and deep. */
const MUST_EXCLUDE = {
  'the archive folders': [
    'Care Album Photos/Robin-Maple/2026-W38/2026-09-18_1530_ab12cd34.jpg',
    'Care Album Photos/archive.json',
    `${PKG}/Care Album Photos/Robin-Maple/2026-W38/README.md`,
    'Brightwheel Photos/Sam-Maple/2026-W38/2026-09-18_1530_ab12cd34.jpg.json',
    `${PKG}/src/Brightwheel Photos/archive.json`,
  ],
  sessions: ['session.json', `${PKG}/session.json`, `${PKG}/src/session.json`],
  cookies: ['cookies.txt', 'cookies.json', `${PKG}/cookies.txt`],
  HARs: ['capture.har', `${PKG}/capture.har`, `${PKG}/src/debug/network.har`],
  'env files': ['.env', '.env.local', 'production.env', `${PKG}/.env`, `${PKG}/.env.production`, `${PKG}/src/local.env`],
  'config.json': ['config.json', `${PKG}/config.json`, `${PKG}/src/config.json`],
  dist: ['dist/cli.js', `${PKG}/dist/cli.js`, `${PKG}/dist/api/client.js`],
  node_modules: ['node_modules/typescript/package.json', `${PKG}/node_modules/exiftool-vendored/package.json`],
  'the production marker': ['.care-album-saver-production', `${PKG}/.care-album-saver-production`],
  'keys, certificates and secrets': ['server.pem', `${PKG}/private.key`, `${PKG}/secrets/token.txt`, `${PKG}/har/notes.txt`],
  'browser automation state': [
    `${PKG}/storageState.json`,
    `${PKG}/playwright-state.json`,
    `${PKG}/user-data-dir/Default/Cookies`,
    `${PKG}/.playwright/state.json`,
  ],
  'photos and sidecars in a folder of any name': [
    `${PKG}/kids/archive.json`,
    `${PKG}/kids/Robin-Maple/2026-W38/README.md`,
    `${PKG}/kids/2026-09-18_1.webp`,
    `${PKG}/kids/2026-09-18_1.webp.json`,
    `${PKG}/kids/2026-09-18_1.m4v`,
    `${PKG}/kids/2026-09-18_1.jpg.xmp`,
  ],
  'git, agent worktrees and docs': [
    '.git/config',
    `${PKG}/.git/HEAD`,
    '.claude/worktrees/wf_1/session.json',
    'docs/images/01-connect.png',
    `${PKG}/tsconfig.tsbuildinfo`,
  ],
};

/** What the Dockerfile's build stage copies by name; the tsconfig files sit next to config.json lookalikes. */
const MUST_KEEP = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  `${PKG}/package.json`,
  `${PKG}/tsconfig.json`,
];

/** Every file under a folder of the repository, slash-separated and relative to the root. */
function filesUnder(folder) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(ROOT, path).split(sep).join('/'));
    }
  };
  walk(join(ROOT, folder));
  return out;
}

test('every .dockerignore rule is **/-anchored, so it applies inside packages/ too', () => {
  assert.ok(RULES.length >= 10, `found ${RULES.length} rules`);
  for (const rule of RULES) {
    const pattern = rule.startsWith('!') ? rule.slice(1) : rule;
    assert.ok(pattern.startsWith('**/'), `"${rule}" matches at the root of the build context only`);
  }
});

for (const [kind, paths] of Object.entries(MUST_EXCLUDE)) {
  test(`.dockerignore leaves ${kind} out of the build context, wherever they sit`, () => {
    for (const path of paths) assert.equal(excluded(RULES, path), true, `${path} would be sent to the builder`);
  });
}

test('every rule .gitignore has for credentials and archive files has its match here', () => {
  // The two files are kept by hand and drifted apart once already: .dockerignore had no rule
  // for keys, browser state or photos outside the default folders while .gitignore did.
  // Each .gitignore rule above its build-and-tooling heading is turned into a file it would
  // catch, and that file must be kept out of the image too, at the root and deep in packages/.
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').replace(/\r\n/g, '\n');
  const personal = gitignore.slice(0, gitignore.indexOf('# ── Build and tooling'));
  const rules = personal.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  assert.ok(rules.length > 40, `read ${rules.length} rules`);
  for (const rule of rules) {
    const sample = rule.replace(/\[0-9\]/g, '1').replace(/\*/g, 'x') + (rule.endsWith('/') ? 'inside.txt' : '');
    for (const path of [sample, `${PKG}/src/deep/${sample}`]) {
      assert.equal(excluded(RULES, path), true, `.gitignore's "${rule}" keeps ${path} out of git, but it would reach the image`);
    }
  }
});

test('and lets in every file the image is built from', () => {
  const sources = [...MUST_KEEP, ...filesUnder(`${PKG}/src`), ...filesUnder(`${PKG}/applescript`)];
  assert.ok(sources.length > MUST_KEEP.length + 20, `found ${sources.length} files`);
  for (const path of sources) assert.equal(excluded(RULES, path), false, `${path} would be missing from the build`);
});

test('the matcher reproduces the defect the audit found in the first version', () => {
  // Bare names are root-anchored in Docker: the host's build output and node_modules under
  // packages/ went into the image. A copy of the matcher that did not show this would prove
  // nothing about the rules above.
  const first = ['.git', 'node_modules', 'dist', 'session.json'];
  assert.equal(excluded(first, 'dist/cli.js'), true);
  assert.equal(excluded(first, `${PKG}/dist/cli.js`), false);
  assert.equal(excluded(first, `${PKG}/node_modules/x/index.js`), false);
  assert.equal(excluded(first, `${PKG}/session.json`), false);
  // `**/` matches at the root as well, a trailing slash changes nothing, and `*` stays
  // within one segment, so config.json's rule cannot take tsconfig.json with it.
  assert.equal(excluded(['**/dist'], 'dist/cli.js'), true);
  assert.equal(excluded(['**/Care*Album*Photos/'], 'Care Album Photos'), true);
  assert.equal(excluded(['**/config.json'], 'tsconfig.json'), false);
  // An exception re-admits, and the last matching rule decides.
  assert.equal(excluded(['**/*.md', '!**/README.md'], 'docs/README.md'), false);
  assert.equal(excluded(['**/*.md', '!**/README.md', '**/docs'], 'docs/README.md'), true);
});
