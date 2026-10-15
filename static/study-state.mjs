export const normalizeAnswer = value => String(value).normalize('NFKC').trim().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').toLocaleLowerCase('en-US');

export function checkAnswer(typed, expected) {
  if (!normalizeAnswer(typed)) return { status: 'empty', checked: false };
  return { status: normalizeAnswer(typed) === normalizeAnswer(expected) ? 'correct' : 'incorrect', checked: true };
}

export function spaceAction(result, typed, expected) {
  if (!result?.checked) return 'wait';
  if (result.clearedAfterCorrect) {
    return typed === '' && result.status === 'correct' && normalizeAnswer(result.answer) === normalizeAnswer(expected) ? 'advance' : 'wait';
  }
  if (result.answer !== typed) return 'wait';
  return result.status === 'correct' && normalizeAnswer(typed) === normalizeAnswer(expected) ? 'advance' : 'retry';
}
