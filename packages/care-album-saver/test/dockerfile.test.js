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
