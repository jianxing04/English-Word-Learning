import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAnswer, spaceAction, normalizeAnswer } from '../static/study-state.mjs';

test('Enter checks correct and incorrect spelling without a navigation action', () => {
  assert.deepEqual(checkAnswer('  MINOR  ', 'minor'), { status: 'correct', checked: true });
  assert.deepEqual(checkAnswer('minro', 'minor'), { status: 'incorrect', checked: true });
  assert.deepEqual(checkAnswer(' ', 'minor'), { status: 'empty', checked: false });
});
test('Space advances only a checked correct answer; wrong answers retry', () => {
  assert.equal(spaceAction(null, 'minor', 'minor'), 'wait');
  assert.equal(spaceAction({ ...checkAnswer('minor', 'minor'), answer: 'minor' }, 'minor', 'minor'), 'advance');
  assert.equal(spaceAction({ ...checkAnswer('minro', 'minor'), answer: 'minro' }, 'minro', 'minor'), 'retry');
});
test('Editing after checking invalidates the decision, including changing a wrong answer to correct', () => {
  assert.equal(spaceAction({ ...checkAnswer('minor', 'minor'), answer: 'minor' }, 'minro', 'minor'), 'wait');
  assert.equal(spaceAction({ ...checkAnswer('minro', 'minor'), answer: 'minro' }, 'minor', 'minor'), 'wait');
});
test('A correct answer remains eligible for Space after the app clears the input for another attempt', () => {
  const result = { ...checkAnswer('  MINOR  ', 'minor'), answer: '  MINOR  ', clearedAfterCorrect: true };
  assert.equal(spaceAction(result, '', 'minor'), 'advance');
  assert.equal(spaceAction(result, 'minor', 'minor'), 'wait');
  assert.equal(spaceAction(result, 'minro', 'minor'), 'wait');
  assert.equal(spaceAction(result, '', 'contagious'), 'wait');
});
test('Clearing an incorrect or unchecked answer never permits advancing', () => {
  assert.equal(spaceAction({ ...checkAnswer('minro', 'minor'), answer: 'minro', clearedAfterCorrect: true }, '', 'minor'), 'wait');
  assert.equal(spaceAction({ ...checkAnswer('', 'minor'), answer: '', clearedAfterCorrect: true }, '', 'minor'), 'wait');
});
test('Phrases, hyphens, Unicode apostrophes and full-width input are handled intentionally', () => {
  assert.equal(normalizeAnswer('  ＴＡＫＥ   ＯＦＦ  '), 'take off');
  assert.equal(checkAnswer('one’s own', "one's own").status, 'correct');
  assert.equal(checkAnswer('up to date', 'up-to-date').status, 'incorrect');
});
