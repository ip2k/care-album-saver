import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every file the Dockerfile copies from the repository exists (2026-09-23).
 *
 * media-ferry was folded into this package on 23 September, and the Dockerfile went on
 * copying packages/media-ferry/package.json, so `docker build` failed at that line — and
 * nothing noticed, because no CI job builds the image. Building it needs Docker and a base
 * image download; checking the paths it names needs neither, and catches this whole class.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The sources of each COPY from the build context (not --from another stage). */
function contextSources(dockerfile) {
  const sources = [];
  for (const line of dockerfile.split('\n')) {
    const m = /^COPY\s+(.+)$/.exec(line.trim());
    if (!m || /--from=/.test(m[1])) continue;
    const parts = m[1].split(/\s+/).filter((p) => !p.startsWith('--'));
    sources.push(...parts.slice(0, -1));
  }
  return sources;
}

/** Whether a source, which may end in a simple glob like tsconfig*.json, names anything. */
function matches(source) {
  if (!source.includes('*')) return existsSync(join(ROOT, source));
  const dir = join(ROOT, dirname(source));
  const pattern = new RegExp(`^${source.split('/').at(-1).replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
  return existsSync(dir) && readdirSync(dir).some((f) => pattern.test(f));
}

test('every file the Dockerfile copies from the repository is there', () => {
  const sources = contextSources(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'));
  assert.ok(sources.length >= 4, `found ${sources.length} COPY sources`);
  for (const source of sources) assert.ok(matches(source), `the Dockerfile copies ${source}, which does not exist`);
});

test('and the check would have caught the folded package', () => {
  assert.deepEqual(contextSources('COPY packages/media-ferry/package.json packages/media-ferry/\nCOPY --from=build /app/x ./x\n'),
    ['packages/media-ferry/package.json']);
  assert.equal(matches('packages/media-ferry/package.json'), false);
  assert.equal(matches('tsconfig*.json'), true);
});

/**
 * The published image carries only what runs (security review sc-7, 2026-09-24).
 *
 * The runtime stage used to copy the build stage's whole packages/ tree, so the image shipped
 * src/, every test file (two of them holding deliberately fake sessions and signed URLs) and
 * the tsconfig. Each COPY into the runtime stage is now named, and the list must be exactly the
 * package's `files` (less README.md, which only npm shows), its package.json and the production
 * node_modules: a new COPY has to be argued in here.
 */

/** The stages of a Dockerfile by name, each as its instruction lines. */
function stagesOf(dockerfile) {
  const stages = {};
  let name = null;
  for (const raw of dockerfile.split('\n')) {
    const line = raw.trim();
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      name = from[1] ?? `stage${Object.keys(stages).length}`;
      stages[name] = [];
    } else if (name && line && !line.startsWith('#')) {
      stages[name].push(line);
    }
  }
  return stages;
}

/** Every source a stage copies in, and from where: `context` or the stage it names. */
function copiesIn(lines) {
  const out = [];
  for (const line of lines) {
    const m = /^(COPY|ADD)\s+(.+)$/i.exec(line);
    if (!m) continue;
    const parts = m[2].split(/\s+/);
    const from = parts.find((p) => p.startsWith('--from='))?.slice('--from='.length) ?? 'context';
    const plain = parts.filter((p) => !p.startsWith('--'));
    for (const source of plain.slice(0, -1)) out.push({ instruction: m[1].toUpperCase(), from, source });
  }
  return out;
}

const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, 'packages/care-album-saver/package.json'), 'utf8'));
const APP_PKG = '/app/packages/care-album-saver';
const RUNTIME_SOURCES = [
  '/app/node_modules',
  `${APP_PKG}/node_modules`,
  `${APP_PKG}/package.json`,
  ...PACKAGE_JSON.files.filter((f) => f !== 'README.md').map((f) => `${APP_PKG}/${f}`),
].sort();

test('the runtime stage copies only what runs: dist, applescript, LICENSE, package.json, production node_modules (sc-7)', () => {
  const stages = stagesOf(DOCKERFILE);
  assert.deepEqual(Object.keys(stages), ['build', 'runtime']);
  const copies = copiesIn(stages.runtime);
  for (const c of copies) {
    assert.equal(c.instruction, 'COPY', `${c.source}: ADD can fetch URLs and unpack archives; the runtime stage needs neither`);
    assert.equal(c.from, 'build', `${c.source} comes from the build context, not from the build stage`);
  }
  assert.deepEqual(copies.map((c) => c.source).sort(), RUNTIME_SOURCES);
  // The package's own list too, so a new entry in `files` fails here until it is copied as well.
  assert.deepEqual([...PACKAGE_JSON.files].sort(), ['LICENSE', 'README.md', 'applescript', 'dist']);
});

test('and the check fails on the copy that shipped src/ and the tests', () => {
  const wide = 'FROM node:22-slim AS build\nCOPY packages ./packages\nFROM node:22-slim AS runtime\n' +
    'COPY --from=build /app/node_modules ./node_modules\nCOPY --from=build /app/packages ./packages\n';
  const sources = copiesIn(stagesOf(wide).runtime).map((c) => c.source).sort();
  assert.notDeepEqual(sources, RUNTIME_SOURCES);
  assert.ok(sources.includes('/app/packages'));
});

test('the build stage installs with a pinned pnpm, frozen, and with no install scripts (sc-6)', () => {
  const build = stagesOf(DOCKERFILE).build;
  const pin = build.findIndex((l) => /^RUN corepack enable && corepack install -g pnpm@\d+\.\d+\.\d+$/.test(l));
  const install = build.findIndex((l) => /^RUN pnpm install\b/.test(l));
  assert.ok(pin >= 0, 'corepack is told which pnpm, rather than asking the registry for the latest');
  assert.ok(install > pin, 'and before the install');
  assert.match(build[install], /--frozen-lockfile/);
  assert.match(build[install], /--ignore-scripts/);
});
