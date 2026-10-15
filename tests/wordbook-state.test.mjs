import test from 'node:test';
import assert from 'node:assert/strict';
import { splitWordbook, alignProgress, shuffleUnread } from '../static/wordbook-state.mjs';

const entries = (...words) => words.map(word => ({ word }));
test('Easy words are excluded only from the selected book and preserve source order', () => {
  const source = entries('minor', 'contagious', 'faithful');
  const result = splitWordbook(source, ['MINOR', 'faithful', 'unknown']);
  assert.deepEqual(result.main, entries('contagious'));
  assert.deepEqual(result.easy, entries('minor', 'faithful'));
  assert.deepEqual(splitWordbook(source, []).main, source);
  assert.deepEqual(source, entries('minor', 'contagious', 'faithful'));
});
test('Moving the current word advances to its next surviving neighbor without changing histories to another word', () => {
  const old = { read: 0, learn: 1, correct: [0, 1, 2], attempted: [1, 2], order: ['minor', 'contagious', 'faithful'] };
  const next = alignProgress(old, entries('minor', 'faithful'));
  assert.equal(next.read, 0);
  assert.equal(next.learn, 1);
  assert.deepEqual(next.correct, [0, 1]);
  assert.deepEqual(next.attempted, [1]);
});
test('Restoring an earlier word keeps the active word and history attached to their identities', () => {
  const old = { read: 0, learn: 0, correct: [0], attempted: [0], order: ['contagious', 'faithful'] };
  const next = alignProgress(old, entries('minor', 'contagious', 'faithful'));
  assert.equal(next.learn, 1);
  assert.deepEqual(next.correct, [1]);
});
test('A restored word becomes learnable again when the original collection was completed', () => {
  const old = { read: 2, learn: 2, correct: [0, 1], order: ['contagious', 'faithful'] };
  const next = alignProgress(old, entries('minor', 'contagious', 'faithful'));
  assert.equal(next.learn, 0);
  assert.deepEqual(next.correct, [1, 2]);
});
test('Moving all words to easy and restoring one handles empty collections and legacy progress', () => {
  const old = alignProgress({ read: 1, learn: 1, correct: [0] }, entries('minor', 'faithful'));
  const empty = alignProgress(old, []);
  assert.equal(empty.learn, 0);
  assert.deepEqual(empty.correct, []);
  const restored = alignProgress(empty, entries('minor'));
  assert.equal(restored.learn, 0);
  assert.deepEqual(restored.order, ['minor']);
});

test('Reload shuffles only unread words and keeps spelling history attached to canonical order', () => {
  const progress = alignProgress({ read: 2, read_order: ['faithful', 'minor', 'toil', 'alloy', 'salute'], learn: 3,
    order: ['minor', 'faithful', 'alloy', 'toil', 'salute'], correct: [0, 3], attempted: [3] }, entries('minor', 'faithful', 'alloy', 'toil', 'salute'));
  const previous = progress.read_order.slice();
  shuffleUnread(progress, () => 0.999);
  assert.deepEqual(progress.read_order.slice(0, 2), ['faithful', 'minor']);
  assert.notDeepEqual(progress.read_order.slice(2), previous.slice(2));
  assert.deepEqual(new Set(progress.read_order), new Set(previous));
  assert.equal(progress.read, 2);
  assert.equal(progress.learn, 3);
  assert.deepEqual(progress.correct, [0, 3]);
  assert.deepEqual(progress.order, ['minor', 'faithful', 'alloy', 'toil', 'salute']);
});

test('Moving the active shuffled word advances to its next unread neighbor', () => {
  const previous = { read: 1, read_order: ['faithful', 'alloy', 'minor', 'toil'], learn: 2,
    order: ['minor', 'faithful', 'alloy', 'toil'], correct: [0, 3], attempted: [0, 2] };
  const next = alignProgress(previous, entries('minor', 'faithful', 'toil'));
  assert.equal(next.read, 1);
  assert.deepEqual(next.read_order, ['faithful', 'minor', 'toil']);
  assert.deepEqual(next.correct, [0, 2]);
  assert.deepEqual(next.attempted, [0]);
});

test('Removing an already read word and restoring another preserves the unread set', () => {
  const previous = { read: 2, read_order: ['faithful', 'minor', 'toil'], order: ['minor', 'faithful', 'toil'] };
  const next = alignProgress(previous, entries('faithful', 'alloy', 'toil'));
  assert.equal(next.read, 1);
  assert.deepEqual(next.read_order, ['faithful', 'toil', 'alloy']);
  assert.deepEqual(shuffleUnread(next, () => 0).read_order, ['faithful', 'alloy', 'toil']);
});

test('A completed reading round stays complete until restarted, including zero and one-word books', () => {
  const complete = alignProgress({ read: 2, read_order: ['faithful', 'minor'], order: ['minor', 'faithful'] }, entries('minor', 'faithful'));
  shuffleUnread(complete);
  assert.equal(complete.read, 2);
  assert.deepEqual(complete.read_order, ['faithful', 'minor']);
  complete.read = 0; shuffleUnread(complete, () => 0.999);
  assert.deepEqual(complete.read_order, ['minor', 'faithful']);
  assert.deepEqual(shuffleUnread(alignProgress(null, [])).read_order, []);
  assert.deepEqual(shuffleUnread(alignProgress(null, entries('minor'))).read_order, ['minor']);
});
