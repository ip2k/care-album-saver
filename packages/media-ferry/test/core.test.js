import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isoWeek, weekFolder, weekLabel, exifDateTime, exifOffset,
  safeStem, safeExtension, uniqueName,
  transferIdentity, sameRemoteFile,
} from '../dist/index.js';

test('ISO week: the year-boundary cases that scatter an archive', () => {
  // 1 Jan 2027 is a Friday, which ISO 8601 places in week 53 of 2026.
  // Naively using the calendar year would file it under 2027 and split the week.
  assert.deepEqual(isoWeek(new Date(2027, 0, 1)), { year: 2026, week: 53 });
  assert.equal(weekFolder(new Date(2027, 0, 1)), '2026-W53');

  // 31 Dec 2024 is a Tuesday, belonging to week 1 of 2025.
  assert.deepEqual(isoWeek(new Date(2024, 11, 31)), { year: 2025, week: 1 });
  assert.equal(weekFolder(new Date(2024, 11, 31)), '2025-W01');

  // 4 January is always in week 1, by definition.
  assert.equal(isoWeek(new Date(2026, 0, 4)).week, 1);

  // Zero padding keeps folders sorting lexically.
  assert.equal(weekFolder(new Date(2026, 0, 8)), '2026-W02');
});

test('ISO week: Monday and Sunday land in the same week', () => {
  const monday = new Date(2026, 8, 14);
  const sunday = new Date(2026, 8, 20);
  assert.equal(weekFolder(monday), weekFolder(sunday));
  // ...and the next Monday does not.
  assert.notEqual(weekFolder(monday), weekFolder(new Date(2026, 8, 21)));
});

test('week labels read naturally across a month boundary', () => {
  assert.match(weekLabel(new Date(2026, 8, 16)), /September 2026/);
  assert.match(weekLabel(new Date(2026, 8, 30)), / - /);
});

test('EXIF datetime is naive local time, with a separate offset', () => {
  const d = new Date(2026, 8, 18, 9, 5, 3);
  assert.equal(exifDateTime(d), '2026:09:18 09:05:03');
  assert.match(exifOffset(d), /^[+-]\d{2}:\d{2}$/);
});

test('safe names survive a trip through Windows', () => {
  assert.equal(safeStem('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(safeStem('  trailing dots... '), 'trailing-dots');
  assert.equal(safeStem('José Müller'), 'Jose-Muller');
  assert.equal(safeStem(''), 'untitled');
  // Reserved device names cannot exist as files on Windows.
  assert.equal(safeStem('CON'), '_CON');
  assert.equal(safeStem('lpt1'), '_lpt1');
  // Path traversal must not survive.
  assert.ok(!safeStem('../../etc/passwd').includes('/'));
  assert.ok(!safeStem('../../etc/passwd').startsWith('.'));
});

test('extensions are normalised, not trusted', () => {
  assert.equal(safeExtension('.JPG'), '.jpg');
  assert.equal(safeExtension('jpeg'), '.jpeg');
  assert.equal(safeExtension('..//evil'), '.evil');
  assert.equal(safeExtension('!!!'), '');
});

test('collisions get suffixes instead of overwriting a photo', () => {
  const taken = new Set(['photo.jpg', 'photo-2.jpg']);
  assert.equal(uniqueName('photo', 'jpg', taken), 'photo-3.jpg');
  assert.equal(uniqueName('fresh', 'jpg', taken), 'fresh.jpg');
  // Case-insensitive, because macOS and Windows filesystems usually are.
  assert.equal(uniqueName('PHOTO', 'jpg', new Set(['photo.jpg'])), 'PHOTO-2.jpg');
});

test('signed CDN URLs resolve to one stable identity', () => {
  // This is the bug that would re-download the whole archive daily: the same file,
  // served twice, with a fresh signature each time.
  const a = 'https://cdn.example.com/media/abc.jpg?signature=aaa&expires=111';
  const b = 'https://cdn.example.com/media/abc.jpg?signature=zzz&expires=999';
  assert.equal(transferIdentity(a), transferIdentity(b));
  assert.ok(sameRemoteFile(a, b));

  // AWS and Google signature families too.
  assert.equal(
    transferIdentity('https://c/x.jpg?X-Amz-Signature=1&X-Amz-Date=2&size=large'),
    transferIdentity('https://c/x.jpg?X-Amz-Signature=9&X-Amz-Date=8&size=large'),
  );

  // Meaningful parameters must still distinguish files.
  assert.notEqual(
    transferIdentity('https://c/x.jpg?size=large'),
    transferIdentity('https://c/x.jpg?size=small'),
  );
  // Different paths are different files even with identical signatures.
  assert.notEqual(transferIdentity('https://c/a.jpg?sig=1'), transferIdentity('https://c/b.jpg?sig=1'));
});

test('transferIdentity does not throw on rubbish input', () => {
  assert.equal(transferIdentity('not a url'), 'not a url');
});
