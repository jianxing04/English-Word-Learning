import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBatch, batchDraft, nextBatchOffset, batchCanAdvance, resetBatchRound, clearBatchInputs, shuffleBatchRows } from '../static/batch-state.mjs';
import { alignProgress } from '../static/wordbook-state.mjs';

const words = ['minor', 'contagious', 'faithful', 'snobbish', 'statistics', 'alloy', 'ridiculous'].map(word => ({ word }));
// Most cases exercise restoring historical drafts with a known order.
const historicalBatch = (source, start, size, draft) => buildBatch(source, start, size, draft || {size,startWord:source[start]?.word,rows:source.slice(start,start+size).map(entry=>({word:entry.word,answer:'',status:null}))});
test('Batch loads forward from the current word and truncates the last group', () => {
  assert.deepEqual(historicalBatch(words, 1, 5).rows.map(row => row.index), [1, 2, 3, 4, 5]);
  assert.deepEqual(historicalBatch(words, 5, 10).rows.map(row => row.entry.word), ['alloy', 'ridiculous']);
});
test('Correct answers select the next unfinished input, wrapping around after mouse selection', () => {
  const batch = historicalBatch(words, 0, 5);
  batch.rows[1].status = 'correct'; batch.rows[4].status = 'correct';
  assert.equal(nextBatchOffset(batch.rows, 0), 2);
  assert.equal(nextBatchOffset(batch.rows, 4), 0);
  batch.rows.forEach(row => { row.status = 'correct'; });
  assert.equal(nextBatchOffset(batch.rows, 3), -1);
});
test('Draft restores pending input and checks confirmed answers against their own words', () => {
  const batch = historicalBatch(words, 0, 5);
  batch.rows[0].answer = 'MINOR'; batch.rows[0].status = 'correct';
  batch.rows[1].answer = 'conta'; batch.rows[1].status = null;
  const restored = historicalBatch(words, 0, 5, batchDraft(batch));
  assert.equal(restored.rows[0].status, 'correct');
  assert.equal(restored.rows[1].answer, 'conta');
  assert.equal(restored.rows[1].status, null);
  assert.equal(restored.active, 1);
  restored.rows[0].answer = 'wrong';
  assert.equal(historicalBatch(words, 0, 5, batchDraft(restored)).rows[0].status, 'incorrect');
});
test('Other groups and sizes do not inherit prior answers', () => {
  const batch = historicalBatch(words, 0, 5); batch.rows[0].answer = 'minor'; batch.rows[0].status = 'correct';
  assert.equal(historicalBatch(words, 5, 5, batchDraft(batch)).rows[0].answer, '');
  assert.equal(historicalBatch(words, 0, 10, batchDraft(batch)).rows[0].answer, '');
});
test('Moving the first word to easy retains other answers by word identity', () => {
  const batch = historicalBatch(words, 0, 5); batch.rows[1].answer = 'contagious'; batch.rows[1].status = 'correct';
  const history = alignProgress({ learn: 0, batch: batchDraft(batch), order: words.map(entry => entry.word) }, words.slice(1));
  const next = historicalBatch(words.slice(1), history.learn, 5, history.batch);
  assert.equal(next.rows[0].entry.word, 'contagious');
  assert.equal(next.rows[0].status, 'correct');
  assert.equal(next.rows[4].entry.word, 'alloy');
  assert.equal(next.rows[4].status, null);
});

test('Cleared correct inputs remain passed after restoration and only a fully passed batch permits Space', () => {
  const batch = historicalBatch(words, 0, 5);
  assert.equal(batchCanAdvance(batch), false);
  batch.rows.forEach(row => { row.status = 'correct'; row.checkedAnswer = row.entry.word; row.clearedAfterCorrect = true; row.answer = ''; });
  assert.equal(batchCanAdvance(batch), true);
  const restored = historicalBatch(words, 0, 5, batchDraft(batch));
  assert.equal(batchCanAdvance(restored), true);
  assert.ok(restored.rows.every(row => row.answer === ''));
  restored.rows[2].answer = 'wrong';
  assert.equal(batchCanAdvance(restored), false);
});
test('Starting another round invalidates every prior pass and requires the entire group again', () => {
  const batch = historicalBatch(words, 0, 5);
  batch.rows.forEach(row => { row.status = 'correct'; row.checkedAnswer = row.entry.word; row.clearedAfterCorrect = true; });
  resetBatchRound(batch);
  assert.equal(batchCanAdvance(batch), false);
  assert.ok(batch.rows.every(row => row.status === null && row.answer === '' && row.checkedAnswer === ''));
});

test('Partial passes retain their text; inputs clear together only when the entire batch passes', () => {
  const batch = historicalBatch(words, 0, 5);
  batch.rows[0].answer = 'minor'; batch.rows[0].status = 'correct'; batch.rows[0].checkedAnswer = 'minor';
  assert.equal(clearBatchInputs(batch), false);
  assert.equal(batch.rows[0].answer, 'minor');
  const restored = historicalBatch(words, 0, 5, batchDraft(batch));
  assert.equal(restored.rows[0].answer, 'minor');
  restored.rows.forEach(row => { row.answer = row.entry.word; row.checkedAnswer = row.answer; row.status = 'correct'; });
  assert.equal(clearBatchInputs(restored), true);
  assert.ok(restored.rows.every(row => row.answer === '' && row.clearedAfterCorrect));
  assert.equal(batchCanAdvance(restored), true);
});
test('Old individually cleared partial drafts recover their checked text for the new grouped-clear behavior', () => {
  const batch = historicalBatch(words, 0, 5);
  batch.rows[0].status = 'correct'; batch.rows[0].checkedAnswer = 'minor'; batch.rows[0].clearedAfterCorrect = true;
  const restored = historicalBatch(words, 0, 5, batchDraft(batch));
  assert.equal(restored.rows[0].answer, 'minor');
  assert.equal(restored.rows[0].clearedAfterCorrect, false);
});

test('Fresh groups shuffle their order without changing the selected words or source indices', () => {
  const batch = buildBatch(words, 1, 5, undefined, () => .999);
  assert.deepEqual(batch.rows.map(row => row.index).sort((a,b)=>a-b), [1,2,3,4,5]);
  assert.notDeepEqual(batch.rows.map(row => row.entry.word), words.slice(1,6).map(entry=>entry.word));
  assert.equal(batchDraft(batch).startWord, 'contagious');
});
test('Consecutive rounds change order even if the random shuffle returns the previous permutation', () => {
  const batch = buildBatch(words, 0, 5, undefined, () => .999);
  const before = batch.rows.map(row=>row.entry.word);
  shuffleBatchRows(batch, () => .999);
  assert.notDeepEqual(batch.rows.map(row=>row.entry.word), before);
  assert.deepEqual(batch.rows.map(row=>row.entry.word).sort(), before.slice().sort());
});
test('Reload restores shuffled order and associates each partial answer with its own word', () => {
  const batch = buildBatch(words, 0, 5, undefined, () => .2);
  const before = batch.rows.map(row=>row.entry.word);
  batch.rows[0].answer=batch.rows[0].entry.word;batch.rows[0].checkedAnswer=batch.rows[0].answer;batch.rows[0].status='correct';
  batch.rows[2].answer='partial';
  const restored = buildBatch(words, 0, 5, batchDraft(batch), () => .8);
  assert.deepEqual(restored.rows.map(row=>row.entry.word), before);
  assert.equal(restored.rows[0].answer,before[0]);assert.equal(restored.rows[0].status,'correct');
  assert.equal(restored.rows[2].answer,'partial');assert.equal(restored.rows[2].status,null);
});
test('Reordering a completed group preserves all checked identities and permission to continue', () => {
  const batch = buildBatch(words, 0, 5);
  batch.rows.forEach(row=>{row.answer=row.entry.word;row.checkedAnswer=row.answer;row.status='correct'});
  clearBatchInputs(batch);shuffleBatchRows(batch);
  assert.equal(batchCanAdvance(batch),true);
  assert.ok(batch.rows.every(row=>row.checkedAnswer===row.entry.word&&row.answer===''));
});
test('A last group with one word stays valid and keeps its only member', () => {
  const batch=buildBatch(words,6,10);
  shuffleBatchRows(batch);
  assert.deepEqual(batch.rows.map(row=>row.entry.word),['ridiculous']);
});
