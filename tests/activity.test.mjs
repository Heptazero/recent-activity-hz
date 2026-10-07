import assert from 'node:assert/strict';
import test from 'node:test';

import { backfillTimes, dateGroupFor, fileTypeFor, latestActivity } from '../activity.ts';

test('classifies common vault files', () => {
  assert.equal(fileTypeFor('10_atom/词条.md'), 'markdown');
  assert.equal(fileTypeFor('paper.PDF'), 'pdf');
  assert.equal(fileTypeFor('board.canvas'), 'canvas');
  assert.equal(fileTypeFor('Drawing.excalidraw.md'), 'canvas');
  assert.equal(fileTypeFor('photo.webp'), 'image');
  assert.equal(fileTypeFor('voice.opus'), 'audio');
  assert.equal(fileTypeFor('clip.mp4'), 'video');
  assert.equal(fileTypeFor('data.json'), 'other');
});

test('keeps immediate template writes under new-file activity', () => {
  const file = { path: 'new.md', basename: 'new', createdAt: 1_000, modifiedAt: 2_000 };
  assert.deepEqual(latestActivity(file), { at: 2_000, kind: 'created' });
  assert.deepEqual(latestActivity({ ...file, openedAt: 3_000 }), { at: 3_000, kind: 'opened' });
  assert.deepEqual(latestActivity({ ...file, modifiedAt: 200_000 }), { at: 200_000, kind: 'modified' });
});

test('groups local calendar days without overlap', () => {
  const now = new Date(2026, 9, 7, 12).getTime();
  const day = (daysAgo) => new Date(2026, 9, 7 - daysAgo, 12).getTime();
  assert.equal(dateGroupFor(day(0), now), 'today');
  assert.equal(dateGroupFor(day(1), now), 'yesterday');
  assert.equal(dateGroupFor(day(6), now), 'week');
  assert.equal(dateGroupFor(day(7), now), 'month');
  assert.equal(dateGroupFor(day(29), now), 'month');
  assert.equal(dateGroupFor(day(30), now), 'older');
});

test('backfills offline AI edits while respecting clear and dismiss times', () => {
  const stat = { ctime: 1_000, mtime: 8_000 };
  const options = {
    now: 10_000, threshold: 5_000, dismissedAt: 0,
    trackCreated: true, trackModified: true,
  };
  assert.deepEqual(backfillTimes(stat, options), { createdAt: 0, modifiedAt: 8_000 });
  assert.deepEqual(backfillTimes(stat, { ...options, threshold: 9_000 }),
    { createdAt: 0, modifiedAt: 0 });
  assert.deepEqual(backfillTimes(stat, { ...options, dismissedAt: 8_500 }),
    { createdAt: 0, modifiedAt: 0 });
});
