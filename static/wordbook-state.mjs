import { normalizeAnswer } from './study-state.mjs';

export function splitWordbook(words, easyWords) {
  const easyKeys = new Set(easyWords.map(normalizeAnswer));
  return {
    main: words.filter(entry => !easyKeys.has(normalizeAnswer(entry.word))),
    easy: words.filter(entry => easyKeys.has(normalizeAnswer(entry.word))),
  };
}

// Track word identity so moving a word never transfers its history to a neighbor.
export function alignProgress(saved, words) {
  const order = words.map(entry => entry.word);
  const previous = Array.isArray(saved?.order) ? saved.order : null;
  const oldKeys = previous?.map(normalizeAnswer);
  const keys = order.map(normalizeAnswer);
  const positions = new Map(keys.map((word, index) => [word, index]));
  const unchanged = !previous || (keys.length === oldKeys.length && keys.every((word, index) => word === oldKeys[index]));
  const validIndex = value => Math.max(0, Number.isInteger(value) ? value : 0);
  function cursor(value) {
    const index = validIndex(value);
    if (unchanged) return Math.min(index, words.length);
    if (index >= previous.length) {
      const oldSet = new Set(oldKeys);
      const added = keys.findIndex(word => !oldSet.has(word));
      return added >= 0 ? added : words.length;
    }
    for (const word of oldKeys.slice(index)) {
      if (positions.has(word)) return positions.get(word);
    }
    return words.length;
  }
  function history(values) {
    const indices = Array.isArray(values) ? values.filter(index => Number.isInteger(index) && index >= 0) : [];
    const mapped = unchanged ? indices : indices.map(index => positions.get(oldKeys[index]));
    return [...new Set(mapped.filter(index => Number.isInteger(index) && index < words.length))];
  }
  const oldReading = Array.isArray(saved?.read_order) ? saved.read_order : previous || order;
  const readAt = Math.min(validIndex(saved?.read), oldReading.length);
  const readKeys = new Set(oldReading.slice(0, readAt).map(normalizeAnswer));
  const completed = [...new Set(oldReading.slice(0, readAt).map(normalizeAnswer))].filter(key => positions.has(key));
  const orderedRead = oldReading.map(normalizeAnswer).filter((key, index, list) => positions.has(key) && list.indexOf(key) === index);
  const remaining = [...orderedRead.filter(key => !readKeys.has(key)), ...keys.filter(key => !orderedRead.includes(key))];
  const readOrder = [...completed, ...remaining].map(key => order[positions.get(key)]);
  return { read: completed.length, read_order: readOrder, learn: cursor(saved?.learn), correct: history(saved?.correct), attempted: history(saved?.attempted), order, ...(saved?.batch && typeof saved.batch === 'object' ? { batch: saved.batch } : {}) };
}

export function shuffleUnread(progress, random = Math.random) {
  const remaining = progress.read_order.slice(progress.read);
  const previous = remaining.slice();
  for (let index = remaining.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [remaining[index], remaining[other]] = [remaining[other], remaining[index]];
  }
  if (remaining.length > 1 && remaining.every((word, index) => word === previous[index])) {
    [remaining[0], remaining[remaining.length - 1]] = [remaining[remaining.length - 1], remaining[0]];
  }
  progress.read_order = [...progress.read_order.slice(0, progress.read), ...remaining];
  return progress;
}
