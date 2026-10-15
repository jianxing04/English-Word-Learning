import { checkAnswer, normalizeAnswer } from './study-state.mjs';

export function shuffleBatchRows(batch, random = Math.random) {
  const previous = batch.rows.slice();
  for (let index = batch.rows.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [batch.rows[index], batch.rows[other]] = [batch.rows[other], batch.rows[index]];
  }
  // Avoid presenting the same sequence by chance on consecutive rounds.
  if (batch.rows.length > 1 && batch.rows.every((row, index) => row === previous[index])) {
    [batch.rows[0], batch.rows[batch.rows.length - 1]] = [batch.rows[batch.rows.length - 1], batch.rows[0]];
  }
  batch.active = 0;
}

export function buildBatch(words, start, size, draft, random = Math.random) {
  const entries = words.slice(start, start + size);
  const startWord = entries[0]?.word;
  const sameStart = draft?.startWord && normalizeAnswer(draft.startWord) === normalizeAnswer(startWord || '');
  const removedStart = draft?.startWord && !words.some(entry => normalizeAnswer(entry.word) === normalizeAnswer(draft.startWord));
  const restore = draft?.size === size && (sameStart || removedStart) && Array.isArray(draft.rows);
  const saved = new Map(restore ? draft.rows.filter(row => typeof row?.word === 'string').map(row => [normalizeAnswer(row.word), row]) : []);
  const rows = entries.map((entry, offset) => {
    const previous = saved.get(normalizeAnswer(entry.word));
    let answer = typeof previous?.answer === 'string' ? previous.answer : '';
    let status = ['correct', 'incorrect', 'empty'].includes(previous?.status) ? checkAnswer(answer, entry.word).status : null;
    let checkedAnswer = '';
    if (previous?.status === 'correct' && previous.clearedAfterCorrect && answer === '' && checkAnswer(previous.checkedAnswer || '', entry.word).status === 'correct') {
      status = 'correct'; checkedAnswer = previous.checkedAnswer;
    }
    if (status === 'correct') checkedAnswer ||= answer;
    return { index: start + offset, entry, answer, status, checkedAnswer, clearedAfterCorrect: status === 'correct' && answer === '' };
  });
  const batch = { start, size, anchorWord: startWord, rows, active: 0 };
  if (restore) {
    const ranks = new Map(draft.rows.filter(row => typeof row?.word === 'string').map((row, index) => [normalizeAnswer(row.word), index]));
    rows.sort((a, b) => (ranks.get(normalizeAnswer(a.entry.word)) ?? Infinity) - (ranks.get(normalizeAnswer(b.entry.word)) ?? Infinity));
  } else shuffleBatchRows(batch, random);
  batch.active = Math.max(0, rows.findIndex(row => row.status !== 'correct'));
  if (batchCanAdvance(batch)) clearBatchInputs(batch);
  else for (const row of rows) {
    if (row.status === 'correct' && row.clearedAfterCorrect) { row.answer = row.checkedAnswer; row.clearedAfterCorrect = false; }
  }
  return batch;
}

export function batchDraft(batch) {
  return { size: batch.size, startWord: batch.anchorWord, rows: batch.rows.map(row => ({ word: row.entry.word, answer: row.answer, status: row.status, checkedAnswer: row.checkedAnswer, clearedAfterCorrect: row.clearedAfterCorrect })) };
}

export function batchCanAdvance(batch) {
  return Boolean(batch?.rows.length) && batch.rows.every(row => row.status === 'correct' && (row.clearedAfterCorrect ? row.answer === '' && checkAnswer(row.checkedAnswer || '', row.entry.word).status === 'correct' : checkAnswer(row.answer, row.entry.word).status === 'correct'));
}

export function resetBatchRound(batch) {
  for (const row of batch.rows) { row.answer = ''; row.status = null; row.checkedAnswer = ''; row.clearedAfterCorrect = false; }
}

export function clearBatchInputs(batch) {
  if (!batchCanAdvance(batch)) return false;
  for (const row of batch.rows) { row.checkedAnswer ||= row.answer; row.answer = ''; row.clearedAfterCorrect = true; }
  return true;
}

export function nextBatchOffset(rows, current) {
  for (let step = 1; step <= rows.length; step += 1) {
    const offset = (current + step) % rows.length;
    if (rows[offset].status !== 'correct') return offset;
  }
  return -1;
}
