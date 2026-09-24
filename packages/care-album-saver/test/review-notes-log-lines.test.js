// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { stampLines } from '../dist/log-lines.js';

/**
 * processes-7 (docs/SECURITY-REVIEW-2026-09-23.md §4.3, open until §4.6): each write's bytes were
 * decoded on their own, so a character split between two writes became two U+FFFDs in the log,
 * and a line begun with whitespace in one write and ended in the next was stamped and kept,
 * though blank lines are dropped.
 */

before(assertIsolatedConfigDir);

function stream() {
  const written = [];
  const s = { write(chunk, encoding, callback) { written.push(String(chunk)); if (typeof callback === 'function') callback(); return true; } };
  const restore = stampLines(s, () => new Date('2026-09-18T12:00:00Z'));
  return { s, text: () => written.join(''), restore };
}

test('processes-7: a character split across two writes arrives whole', () => {
  const { s, text } = stream();
  const bytes = Buffer.from('Looking for Robin’s photos\n');
  const cut = bytes.indexOf(0x80); // inside the three bytes of the apostrophe
  s.write(bytes.subarray(0, cut));
  s.write(bytes.subarray(cut));
  assert.match(text(), /Looking for Robin’s photos\n$/);
  assert.doesNotMatch(text(), /�/);
});

test('processes-7: a line of whitespace finished in a later write is dropped like any blank line', () => {
  const { s, text } = stream();
  s.write('   ');
  s.write('\n');
  s.write('  ');
  s.write('Saved 3 photos\n');
  const lines = text().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, JSON.stringify(text()));
  assert.match(lines[0], /^\S+ {2} {2}Saved 3 photos$/, 'whitespace before words is kept, after one stamp');
});

test('processes-7: every write still reaches its callback, even one that is only held', () => {
  const { s } = stream();
  let called = 0;
  s.write('   ', () => (called += 1));
  s.write('x\n', 'utf8', () => (called += 1));
  assert.equal(called, 2);
});
