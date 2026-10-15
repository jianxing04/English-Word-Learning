import { checkAnswer, spaceAction, normalizeAnswer } from './study-state.mjs';
import { splitWordbook, alignProgress, shuffleUnread } from './wordbook-state.mjs';
import { buildBatch, batchDraft, nextBatchOffset, batchCanAdvance, resetBatchRound, clearBatchInputs, shuffleBatchRows } from './batch-state.mjs';

const $ = id => document.getElementById(id);
const state = { folder: '', book: null, sourceBook: null, collection: 'main', mode: 'read', readingDisplay: 'all', readingRevealed: false, batchSize: 1, batch: null, index: 0, result: null, progress: {}, sequence: 0, folderSequence: 0, loading: false, showingHint: false };
const tagNames = { ky: '考研', cet4: 'CET-4', cet6: 'CET-6', gk: '高考', zk: '中考', ielts: 'IELTS', toefl: 'TOEFL', gre: 'GRE' };
const formNames = { s: '复数', p: '过去式', d: '过去分词', i: '现在分词', '3': '第三人称单数', r: '比较级', t: '最高级', '0': '原形' };
const folderName = name => name === 'Postgraduate-Entrance-Examination' ? '考研词汇' : name;
const storageKey = 'wordroom.progress.v1';
const easyStorageKey = 'wordroom.easyWords.v1';
let legacyProgress = {}, legacyEasyWords = {};
try { const saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) legacyProgress = saved; } catch { /* Old browser data is optional. */ }
try { const saved = JSON.parse(localStorage.getItem(easyStorageKey) || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) legacyEasyWords = saved; } catch { /* Old browser data is optional. */ }
const revisions = new Map();
const pendingWrites = new Map();
let writing = null, saveTimer = null, saveConflict = false, saveError = '';

function easyWords() {
  return state.sourceBook?.easy_words || [];
}

function progressKey(collection = state.collection) {
  return `${state.book.path}:${state.book.fingerprint}${collection === 'easy' ? ':easy' : ''}`;
}

function refreshCollection(shuffle = false) {
  const lists = splitWordbook(state.sourceBook.words, easyWords());
  state.book = { ...state.sourceBook, words: lists[state.collection] };
  for (const collection of ['main', 'easy']) {
    const key = progressKey(collection);
    state.progress[key] = alignProgress(state.progress[key], lists[collection]);
  }
  if (state.mode === 'read') {
    if (shuffle) shuffleUnread(progress());
    const entries = new Map(lists[state.collection].map(entry => [normalizeAnswer(entry.word), entry]));
    state.book.words = progress().read_order.map(word => entries.get(normalizeAnswer(word)));
  }
  state.index = progress()[state.mode];
}

function acceptBook(book, shuffle = false) {
  state.batch = null;
  state.sourceBook = book;
  revisions.set(book.path, { revision: book.revision, etag: book.etag });
  state.batchSize = [1, 5, 10].includes(book.settings?.batch_size) ? book.settings.batch_size : 1;
  for (const collection of ['main', 'easy']) {
    const key = `${book.path}:${book.fingerprint}${collection === 'easy' ? ':easy' : ''}`;
    state.progress[key] = book.progress?.[collection];
  }
  refreshCollection(shuffle);
}

function updateSaveStatus() {
  const button = $('save-status');
  button.textContent = saveError ? saveConflict ? '文件已更新，点击刷新' : '保存失败，点击重试' : pendingWrites.size || writing ? '正在保存到 JSON…' : '已保存到 JSON';
  button.disabled = !saveError;
}

async function flushSaves() {
  clearTimeout(saveTimer);
  if (writing) return writing;
  writing = (async () => {
    while (pendingWrites.size) {
      const [path, snapshot] = pendingWrites.entries().next().value;
      pendingWrites.delete(path);
      try {
        const response = await api('/api/progress', { ...snapshot, ...revisions.get(path) });
        revisions.set(path, { revision: response.revision, etag: response.etag });
      } catch (error) {
        if (!pendingWrites.has(path)) pendingWrites.set(path, snapshot);
        saveError = error.message; saveConflict = error.status === 409;
        showError('学习进度未保存到文件：' + saveError);
        return false;
      }
    }
    if (saveError && $('app-error').textContent === '学习进度未保存到文件：' + saveError) showError('');
    saveError = ''; saveConflict = false;
    return true;
  })();
  updateSaveStatus();
  try { return await writing; }
  finally { writing = null; updateSaveStatus(); }
}

function save() {
  if (!state.book) return;
  const value = progress();
  value[state.mode] = state.index;
  if (state.mode === 'learn') {
    if (state.batch && state.batch.start === state.index) value.batch = batchDraft(state.batch);
    else if (!isBatchMode()) delete value.batch;
  }
  const snapshot = { path: state.book.path, batch_size: state.batchSize, progress: {} };
  for (const collection of ['main', 'easy']) snapshot.progress[collection] = structuredClone(state.progress[progressKey(collection)]);
  pendingWrites.set(state.book.path, snapshot);
  clearTimeout(saveTimer); saveTimer = setTimeout(flushSaves, 150);
  updateSaveStatus();
  try { localStorage.setItem('wordroom.lastBook', state.book.path); localStorage.setItem('wordroom.mode', state.mode); localStorage.setItem('wordroom.collection', state.collection); } catch { /* File persistence does not depend on browser storage. */ }
}

function progress() {
  if (!state.book) return { correct: [], attempted: [] };
  const key = progressKey();
  if (!state.progress[key]) state.progress[key] = alignProgress(null, state.book.words);
  const value = state.progress[key];
  value.correct = Array.isArray(value.correct) ? value.correct.filter(Number.isInteger) : [];
  value.attempted = Array.isArray(value.attempted) ? value.attempted.filter(Number.isInteger) : [];
  return value;
}

function showError(message) { $('app-error').textContent = message; $('app-error').hidden = !message; }

async function api(url, payload) {
  const response = await fetch(url, payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: url !== '/api/migrate' });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || '请求失败，请重试。'); error.status = response.status; throw error; }
  return result;
}

function icon(kind) {
  const template = document.createElement('template');
  template.innerHTML = kind === 'folder'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v13H3z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6"/></svg>';
  return template.content.firstElementChild;
}

async function browse(folder = '') {
  const sequence = ++state.folderSequence;
  try {
    const data = await api('/api/browse?path=' + encodeURIComponent(folder));
    if (sequence !== state.folderSequence) return;
    state.folder = data.path;
    $('folder-crumbs').replaceChildren();
    const root = document.createElement('button'); root.textContent = '单词本'; root.onclick = () => browse(''); $('folder-crumbs').append(root);
    let accumulated = '';
    for (const part of state.folder.split('/').filter(Boolean)) {
      accumulated += (accumulated ? '/' : '') + part;
      const target = accumulated;
      const separator = document.createElement('span'); separator.textContent = '/';
      const button = document.createElement('button'); button.textContent = folderName(part); button.onclick = () => browse(target);
      $('folder-crumbs').append(separator, button);
    }
    $('files').replaceChildren();
    if (state.folder) {
      const up = document.createElement('button'); up.className = 'file-row'; up.textContent = '… 返回上一级';
      up.onclick = () => browse(state.folder.split('/').slice(0, -1).join('/')); $('files').append(up);
    }
    for (const entry of data.entries) {
      const button = document.createElement('button'); button.className = 'file-row ' + entry.type; button.dataset.path = entry.path;
      button.title = entry.error || entry.name;
      const name = document.createElement('span'); name.className = 'file-name'; name.textContent = entry.type === 'folder' ? folderName(entry.name) : entry.name.replace(/\.[^.]+$/, '');
      const count = document.createElement('span'); count.className = 'file-count'; count.textContent = entry.type === 'folder' ? '文件夹' : entry.error ? '无法读取' : `${entry.count} 词`;
      button.append(icon(entry.type), name, count);
      button.onclick = () => entry.type === 'folder' ? browse(entry.path) : openBook(entry.path);
      if (entry.error) button.disabled = true;
      $('files').append(button);
      if (entry.type === 'book' && !entry.error) {
        const count = entry.easy_count || 0;
        if (count) {
          const easy = document.createElement('button'); easy.className = 'file-row easy-book'; easy.dataset.easyPath = entry.path;
          const label = document.createElement('span'); label.className = 'file-name'; label.textContent = '简单词本';
          const total = document.createElement('span'); total.className = 'file-count'; total.textContent = `${count} 词`;
          easy.append(icon('book'), label, total);
          easy.onclick = () => openBook(entry.path, 'easy');
          $('files').append(easy);
        }
      }
    }
    if (!data.entries.length) { const text = document.createElement('p'); text.className = 'muted'; text.textContent = '这个文件夹里还没有单词本。'; $('files').append(text); }
    highlightBook();
  } catch (error) { if (sequence === state.folderSequence) showError(error.message); }
}

function highlightBook() {
  document.querySelectorAll('.file-row[data-path]').forEach(row => {
    const selected = row.dataset.path === state.book?.path && state.collection === 'main';
    row.classList.toggle('selected', selected);
    if (selected) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
  });
  document.querySelectorAll('.file-row[data-easy-path]').forEach(row => {
    const selected = row.dataset.easyPath === state.book?.path && state.collection === 'easy';
    row.classList.toggle('selected', selected);
    if (selected) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
  });
}

async function openBook(path, collection = 'main') {
  if (state.loading) return;
  save();
  const sequence = ++state.sequence;
  state.loading = true;
  showError('');
  $('book-name').textContent = '正在打开单词本…';
  $('word-content').hidden = true;
  $('complete-state').hidden = true;
  $('empty-state').hidden = true;
  $('next').disabled = true;
  $('previous').disabled = true;
  try {
    if (!await flushSaves()) { state.loading = false; render(); return; }
    const book = await api('/api/book?path=' + encodeURIComponent(path));
    if (sequence !== state.sequence) return;
    state.collection = collection;
    acceptBook(book, state.mode === 'read');
    state.result = null;
    state.loading = false;
    save(); highlightBook(); render();
  } catch (error) {
    if (sequence !== state.sequence) return;
    state.loading = false;
    showError(error.message);
    render();
  }
}

function putLines(target, value) {
  target.replaceChildren();
  for (const line of value.split(/\n|\\n/).filter(Boolean)) { const text = document.createElement('p'); text.textContent = line; target.append(text); }
}

function fitWordTitle() {
  const title = $('word-title');
  const line = title.parentElement;
  if (!title.getClientRects().length || !line.clientWidth) return;
  const maxSize = Number.parseFloat(getComputedStyle(title).getPropertyValue('--word-max-size')) || 58;
  title.style.fontSize = `${maxSize}px`;
  const buttonWidth = $('speak').getBoundingClientRect().width;
  const gap = buttonWidth ? Number.parseFloat(getComputedStyle(line).columnGap) || 0 : 0;
  const available = Math.max(1, line.clientWidth - buttonWidth - gap - 1);
  const range = document.createRange();
  range.selectNodeContents(title);
  const width = range.getBoundingClientRect().width;
  if (width > available) title.style.fontSize = `${Math.floor(maxSize * available / width * 100) / 100}px`;
}

if ('ResizeObserver' in window) {
  let previousWidth = 0;
  const titleObserver = new ResizeObserver(entries => {
    const width = entries[0].contentRect.width;
    if (width === previousWidth) return;
    previousWidth = width;
    if (width > 0) requestAnimationFrame(fitWordTitle);
  });
  titleObserver.observe(document.querySelector('.word-line'));
}
window.addEventListener('resize', fitWordTitle);
document.fonts?.ready.then(fitWordTitle);

function updateReadingView() {
  if (state.mode !== 'read' || !state.book || state.index >= state.book.words.length) return;
  const concealed = !state.readingRevealed;
  const hideWord = state.readingDisplay === 'hide-word' && concealed;
  const hideMeaning = state.readingDisplay === 'hide-meaning' && concealed;
  $('word-display').hidden = hideWord;
  $('translations').hidden = hideMeaning;
  $('reading-details').hidden = hideMeaning;
  $('word-forms-section').hidden = hideWord;
  $('reading-prompt').hidden = !hideWord && !hideMeaning;
  $('reading-prompt').textContent = hideWord ? '先回想单词，按空格揭示。' : '先回想释义，按空格揭示。';
  const label = hideWord ? '显示单词 ' : hideMeaning ? '显示释义 ' : '下一个 ';
  $('next').replaceChildren(document.createTextNode(label));
  const key = document.createElement('kbd'); key.textContent = 'Space'; $('next').append(key);
  const enterGuide = state.collection === 'main' ? 'Enter 移入简单词' : 'Enter 放回原词本';
  $('keyboard-guide').querySelector('span').textContent = hideWord || hideMeaning ? `先揭示，再按空格下一词 · ${enterGuide}` : `下一个单词 · ${enterGuide}`;
  $('session-stats').textContent = state.readingDisplay === 'all' ? '阅读释义 · 练习拼写' : `${state.readingDisplay === 'hide-word' ? '隐藏单词' : '隐藏释义'} · 空格揭示，再按空格下一词`;
  fitWordTitle();
}

function setReadingDisplay(value) {
  if (state.loading || !['all', 'hide-meaning', 'hide-word'].includes(value)) return;
  state.readingDisplay = value;
  try { localStorage.setItem('wordroom.readingDisplay', value); } catch { /* Keep the selected display usable for this session. */ }
  render();
  if (!$('next').disabled) $('next').focus({ preventScroll: true });
}

function isBatchMode() { return state.mode === 'learn' && state.batchSize > 1; }

function setBatchSize(size) {
  if (state.loading || ![1, 5, 10].includes(size)) return;
  save();
  if (state.book) delete progress().batch;
  state.batchSize = size;
  state.batch = null;
  try { localStorage.setItem('wordroom.batchSize', String(size)); } catch { /* Keep the selected size usable. */ }
  save(); render();
}

function focusBatch(offset, preventScroll = false) {
  if (!state.batch?.rows[offset]) return;
  if (state.batch.active !== offset) hideWordHint();
  state.batch.active = offset;
  document.querySelectorAll('.batch-row').forEach((card, index) => card.classList.toggle('active', index === offset));
  const input = $('batch-answer-' + offset);
  if (!input) return;
  input.focus({ preventScroll: true });
  if (!preventScroll) {
    const viewport = $('batch-scroll');
    const bounds = viewport.getBoundingClientRect();
    const box = input.getBoundingClientRect();
    const target = viewport.scrollTop + box.top - bounds.top - viewport.clientTop + box.height / 2 - viewport.clientHeight / 2;
    viewport.scrollTo({ top: Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, target)), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}

function placeBatchViewport() {
  if (!isBatchMode() || $('batch-content').hidden) return;
  const viewport = $('batch-scroll');
  const bounds = viewport.getBoundingClientRect();
  if (bounds.top < 16 || bounds.bottom > innerHeight - 16) {
    window.scrollTo({ top: window.scrollY + bounds.top + bounds.height / 2 - innerHeight / 2, behavior: 'auto' });
  }
}

// Keep wheel gestures inside the word panel even at its boundaries or when it is empty.
$('batch-scroll').addEventListener('wheel', event => {
  if (event.ctrlKey || event.metaKey || !event.deltaY) return;
  const viewport = $('batch-scroll');
  if (viewport.scrollHeight <= viewport.clientHeight || (event.deltaY < 0 && viewport.scrollTop <= 0) || (event.deltaY > 0 && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1)) event.preventDefault();
}, { passive: false });
window.addEventListener('resize', () => requestAnimationFrame(() => { placeBatchViewport(); if (state.batch) focusBatch(state.batch.active, false); }));

function updateBatchStatus() {
  if (!state.batch) return;
  const correct = state.batch.rows.filter(row => row.status === 'correct').length;
  const passed = batchCanAdvance(state.batch);
  $('batch-summary').textContent = passed ? '本组全部通过，输入已清空并重新打乱顺序。可以再练一轮，或按空格进入下一组。' : `本组已答对 ${correct} / ${state.batch.rows.length} · 每轮随机顺序 · 全部通过后统一清空`;
  $('next').disabled = !passed;
  $('next').replaceChildren(document.createTextNode('下一组 '));
  const key = document.createElement('kbd'); key.textContent = 'Space'; $('next').append(key);
  $('session-stats').textContent = `已掌握 ${progress().correct.length} 词 · 每组 ${state.batchSize} 词`;
}

function paintBatchRow(offset) {
  const row = state.batch?.rows[offset];
  if (!row) return;
  $('batch-row-' + offset).classList.toggle('correct', row.status === 'correct');
  $('batch-row-' + offset).classList.toggle('incorrect', row.status === 'incorrect');
  $('batch-answer-' + offset).setAttribute('aria-invalid', String(row.status === 'incorrect'));
  $('batch-feedback-' + offset).textContent = row.status === 'correct' ? row.clearedAfterCorrect ? '✓ 全组通过，输入已清空。' : '✓ 拼写正确' : row.status === 'incorrect' ? '拼写不正确，按住 Tab 查看提示后再试一次。' : row.status === 'empty' ? '先输入单词，再按回车检查。' : '输入英文单词，按回车检查。';
}

function renderBatch() {
  state.batch = buildBatch(state.book.words, state.index, state.batchSize, progress().batch);
  paintBatch();
}

function paintBatch() {
  $('batch-content').hidden = false;
  $('batch-list').replaceChildren();
  $('position-label').textContent = `${state.index + 1}–${state.index + state.batch.rows.length} / ${state.book.words.length} 词`;
  $('keyboard-guide').replaceChildren();
  const key = document.createElement('kbd'); key.textContent = 'Space';
  const guide = document.createElement('span'); guide.textContent = '全组通过后下一组 · 按住 Tab 提示';
  $('keyboard-guide').append(key, guide);
  for (const [offset, row] of state.batch.rows.entries()) {
    const card = document.createElement('article'); card.className = 'batch-row'; card.id = 'batch-row-' + offset;
    const heading = document.createElement('div'); heading.className = 'batch-row-heading';
    const number = document.createElement('span'); number.className = 'batch-number'; number.textContent = String(offset + 1).padStart(2, '0');
    const label = document.createElement('label'); label.htmlFor = 'batch-answer-' + offset; label.textContent = '根据释义填写英文单词';
    heading.append(number, label);
    const meaning = document.createElement('div'); meaning.className = 'batch-meaning'; meaning.textContent = row.entry.translation || '暂无中文释义，可按住 Tab 查看单词。';
    const hint = document.createElement('div'); hint.id = 'batch-hint-' + offset; hint.className = 'batch-hint'; hint.hidden = true; hint.setAttribute('aria-live', 'polite');
    const wrap = document.createElement('div'); wrap.className = 'batch-answer-wrap';
    const input = document.createElement('input'); input.id = 'batch-answer-' + offset; input.className = 'batch-answer'; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('autocapitalize', 'off'); input.placeholder = '输入英文单词…'; input.value = row.answer; input.setAttribute('aria-describedby', 'batch-feedback-' + offset); input.setAttribute('aria-label', `本组第 ${offset + 1} 个答案`);
    input.onfocus = () => {
      if (!state.batch) return;
      if (state.batch.active !== offset) hideWordHint();
      state.batch.active = offset;
      document.querySelectorAll('.batch-row').forEach((item, index) => item.classList.toggle('active', index === offset));
    };
    input.oninput = () => {
      const current = state.batch?.rows[offset]; if (!current) return;
      if (batchCanAdvance(state.batch)) beginBatchRound();
      if (current.status === 'correct') progress().correct = progress().correct.filter(index => index !== current.index);
      current.answer = input.value; current.status = null; current.checkedAnswer = ''; current.clearedAfterCorrect = false;
      paintBatchRow(offset); updateBatchStatus(); save();
    };
    input.onkeydown = event => {
      if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) checkBatch(offset); }
      else if (event.code === 'Space' && (batchCanAdvance(state.batch) || state.batch?.rows[offset].status === 'correct')) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) continueStudy(); }
    };
    const checkButton = document.createElement('button'); checkButton.type = 'button'; checkButton.textContent = '检查'; checkButton.onclick = () => checkBatch(offset);
    wrap.append(input, checkButton);
    const feedback = document.createElement('div'); feedback.id = 'batch-feedback-' + offset; feedback.className = 'batch-feedback'; feedback.setAttribute('aria-live', 'polite');
    const move = document.createElement('button'); move.type = 'button'; move.className = 'batch-move'; move.textContent = state.collection === 'main' ? '移入简单词' : '放回原词本'; move.onclick = () => moveWord(row.index);
    card.append(heading, meaning, hint, wrap, feedback, move);
    $('batch-list').append(card);
    paintBatchRow(offset);
  }
  updateBatchStatus();
  save();
  requestAnimationFrame(() => { placeBatchViewport(); focusBatch(state.batch?.active); });
}

function checkBatch(offset) {
  if (state.loading || !isBatchMode() || !state.batch?.rows[offset]) return;
  hideWordHint();
  const row = state.batch.rows[offset];
  const typed = $('batch-answer-' + offset).value;
  if (typed === '' && row.status === 'correct' && row.clearedAfterCorrect) { focusBatch(offset); return { status: 'correct', position: row.index + 1 }; }
  if (typed !== '' && batchCanAdvance(state.batch)) beginBatchRound();
  row.answer = typed;
  row.status = checkAnswer(row.answer, row.entry.word).status;
  row.checkedAnswer = row.status === 'correct' ? row.answer : '';
  row.clearedAfterCorrect = false;
  const history = progress();
  if (row.status !== 'empty' && !history.attempted.includes(row.index)) history.attempted.push(row.index);
  if (row.status === 'correct') { if (!history.correct.includes(row.index)) history.correct.push(row.index); }
  else history.correct = history.correct.filter(index => index !== row.index);
  if (clearBatchInputs(state.batch)) {
    shuffleBatchRows(state.batch);
    paintBatch();
    return { status: row.status, position: row.index + 1 };
  }
  paintBatchRow(offset);
  updateBatchStatus(); save();
  const response = { status: row.status, position: row.index + 1 };
  if (row.status !== 'correct') { focusBatch(offset); return response; }
  const next = nextBatchOffset(state.batch.rows, offset);
  focusBatch(next >= 0 ? next : 0);
  return response;
}

function beginBatchRound() {
  if (!state.batch) return;
  const indices = new Set(state.batch.rows.map(row => row.index));
  progress().correct = progress().correct.filter(index => !indices.has(index));
  resetBatchRound(state.batch);
  state.batch.rows.forEach((row, offset) => paintBatchRow(offset));
}

function render() {
  state.showingHint = false;
  state.batch = null;
  $('batch-content').hidden = true;
  state.readingRevealed = false;
  state.result = null;
  $('translations').hidden = false;
  $('word-forms-section').hidden = false;
  $('reading-prompt').hidden = true;
  $('answer').value = '';
  $('learn-area').classList.remove('correct', 'incorrect');
  $('feedback').className = 'feedback';
  $('feedback').textContent = '← / → 切换单词；按住 Tab 提示；回车检查；空格继续。';
  $('continue-answer').disabled = true;
  $('continue-answer').firstChild.textContent = '检查后按空格继续 ';
  $('read-mode').setAttribute('aria-pressed', String(state.mode === 'read'));
  $('learn-mode').setAttribute('aria-pressed', String(state.mode === 'learn'));
  $('empty-state').hidden = Boolean(state.book);
  $('word-content').hidden = true;
  $('complete-state').hidden = true;
  $('previous').disabled = !state.book || state.index === 0;
  $('next').disabled = !state.book;
  $('collection-toolbar').hidden = !state.book;
  $('reading-options').hidden = state.mode !== 'read' || !state.book;
  $('batch-options').hidden = state.mode !== 'learn' || !state.book;
  $('batch-size').value = String(state.batchSize);
  $('previous').textContent = isBatchMode() ? '上一组' : '上一个';
  $('reading-display').value = state.readingDisplay;
  $('word-actions').hidden = true;
  $('collection-notice').textContent = '';
  if (!state.book) return;
  const { book } = state;
  const collections = splitWordbook(state.sourceBook.words, easyWords());
  $('main-collection').textContent = `原词本 · ${collections.main.length}`;
  $('easy-collection').textContent = `简单词本 · ${collections.easy.length}`;
  $('main-collection').setAttribute('aria-pressed', String(state.collection === 'main'));
  $('easy-collection').setAttribute('aria-pressed', String(state.collection === 'easy'));
  $('move-word').textContent = state.collection === 'main' ? '移入简单词' : '放回原词本';
  const total = book.words.length;
  const complete = total > 0 && state.index >= total;
  $('book-name').textContent = book.name + (state.collection === 'easy' ? ' · 简单词本' : '');
  $('book-path').textContent = book.path.split('/').map(folderName).join(' / ');
  $('position-label').textContent = `${complete ? total : total ? state.index + 1 : 0} / ${total} 词`;
  const percent = total ? Math.round(state.index / total * 100) : 0;
  $('progress-fill').style.width = `${percent}%`; $('progress-percent').textContent = `${percent}%`;
  document.querySelector('.progress-track').setAttribute('aria-valuenow', String(percent));
  $('keyboard-guide').replaceChildren();
  const key = document.createElement('kbd'); key.textContent = state.mode === 'read' ? 'Space' : 'Enter';
  const tip = document.createElement('span'); tip.textContent = state.mode === 'read' ? '下一个单词 · ← / → 切换' : '检查 · Space 继续 · Tab 提示 · ← / → 切换';
  $('keyboard-guide').append(key, tip);
  $('next').replaceChildren(document.createTextNode(state.mode === 'read' ? '下一个 ' : '检查答案 '));
  const nextKey = document.createElement('kbd'); nextKey.textContent = state.mode === 'read' ? 'Space' : 'Enter'; $('next').append(nextKey);
  $('mode-label').textContent = state.mode === 'read' ? 'READ & REMEMBER' : 'RECALL & SPELL';
  $('session-stats').textContent = state.mode === 'read' ? '阅读释义 · 练习拼写' : `已掌握 ${progress().correct.length} 词 · 按自己的节奏来`;
  if (!total) {
    $('empty-state').hidden = false;
    $('empty-state').querySelector('h3').textContent = state.collection === 'easy' ? '这个简单词本是空的' : collections.easy.length ? '这些词都放进简单词本了' : '这本词表还是空的';
    $('empty-state').querySelector('p').textContent = state.collection === 'easy' ? '在原词本中把熟悉的词移进来，之后可以在这里测试、放回。' : collections.easy.length ? '点击上方“简单词本”继续复习，不熟悉的词可以手动放回。' : '在文件里每行添加一个英文单词，再重新打开。';
    $('next').disabled = true;
    return;
  }
  if (complete) {
    $('complete-state').hidden = false;
    $('complete-message').textContent = state.mode === 'read' ? `已读完 ${total} 个单词，按空格从第一个词重新开始。` : `完成了 ${total} 个单词的拼写练习。继续打开另一本，或者再复习一遍。`;
    $('next').disabled = state.mode !== 'read';
    if (state.mode === 'read') {
      tip.textContent = '从第一个词重新开始';
      $('next').firstChild.textContent = '从头再读 ';
      requestAnimationFrame(() => { if (!state.loading && !$('next').disabled) $('next').focus({ preventScroll: true }); });
    }
    return;
  }
  if (isBatchMode()) { renderBatch(); return; }
  const word = book.words[state.index];
  $('word-content').hidden = false;
  $('word-actions').hidden = false;
  $('word-title').textContent = word.word;
  $('phonetic').textContent = word.phonetic ? `/ ${word.phonetic} /` : '暂无音标';
  putLines($('translations'), word.translation || '暂无中文释义；可在阅读模式查看英文解释。');
  $('word-tags').replaceChildren();
  for (const tag of word.tag.split(' ').filter(Boolean).slice(0, 6)) { const label = document.createElement('span'); label.textContent = tagNames[tag] || tag.toUpperCase(); $('word-tags').append(label); }
  $('word-stars').textContent = word.collins ? '★'.repeat(Math.min(5, Math.max(0, Number(word.collins)))) : '';
  $('definitions').textContent = word.definition || '暂无英文释义。';
  $('forms').textContent = word.exchange.split('/').map(part => { const [kind, value] = part.split(':'); return formNames[kind] && value ? `${formNames[kind]}：${value}` : ''; }).filter(Boolean).join(' · ') || '暂无词形变化。';
  $('learn-area').hidden = state.mode !== 'learn';
  $('word-display').hidden = state.mode === 'learn';
  $('recall-title').hidden = state.mode !== 'learn';
  $('reading-details').hidden = state.mode === 'learn';
  $('word-stars').hidden = state.mode === 'learn';
  if (state.mode === 'read') updateReadingView();
  fitWordTitle();
  if (state.mode === 'learn') requestAnimationFrame(() => $('answer').focus({ preventScroll: true }));
  else requestAnimationFrame(() => { if (!state.loading && !$('next').disabled) $('next').focus({ preventScroll: true }); });
}

function check() {
  if (isBatchMode()) return checkBatch(state.batch?.active);
  if (state.loading || state.mode !== 'learn' || !state.book || state.index >= state.book.words.length) return;
  const word = state.book.words[state.index];
  const answer = $('answer').value;
  if (answer === '' && state.result?.clearedAfterCorrect) {
    $('answer').focus({ preventScroll: true });
    return;
  }
  state.result = { ...checkAnswer(answer, word.word), answer };
  const { status } = state.result;
  $('feedback').className = 'feedback ' + (status === 'empty' ? '' : status);
  $('learn-area').classList.toggle('correct', status === 'correct');
  $('learn-area').classList.toggle('incorrect', status === 'incorrect');
  if (status === 'empty') {
    $('feedback').textContent = '先输入单词，再按回车检查。';
    $('continue-answer').disabled = true;
    $('answer').focus();
    return;
  }
  $('word-display').hidden = false;
  $('recall-title').hidden = true;
  $('word-stars').hidden = false;
  $('reading-details').hidden = false;
  fitWordTitle();
  if (status === 'correct') {
    $('answer').value = '';
    state.result.clearedAfterCorrect = true;
    $('answer').focus({ preventScroll: true });
  }
  $('feedback').textContent = status === 'correct' ? '✓ 拼写正确，输入已清空。可以再练一遍，或按空格进入下一个单词。' : `还差一点，正确拼写是 ${word.word}。按空格，留在本词重新输入。`;
  $('continue-answer').disabled = false;
  $('continue-answer').firstChild.textContent = status === 'correct' ? '下一个单词 ' : '重新输入这个词 ';
  const history = progress();
  if (!history.attempted.includes(state.index)) history.attempted.push(state.index);
  save();
}

function continueStudy() {
  if (state.loading || !state.book || !state.book.words.length) return;
  if (state.index >= state.book.words.length) {
    if (state.mode === 'read') restartStudy();
    return;
  }
  if (isBatchMode()) {
    if (!batchCanAdvance(state.batch)) {
      $('batch-summary').textContent = '本组还有单词未通过，请先完成检查，再按空格进入下一组。';
      focusBatch(state.batch?.active); return;
    }
    delete progress().batch;
    state.index = state.batch.start + state.batch.rows.length;
    state.batch = null;
    save(); render(); return;
  }
  if (state.mode === 'read') {
    if (state.readingDisplay !== 'all' && !state.readingRevealed) {
      state.readingRevealed = true;
      updateReadingView();
      return;
    }
    state.index += 1; save(); render(); return;
  }
  const action = spaceAction(state.result, $('answer').value, state.book.words[state.index].word);
  if (action === 'wait') { $('feedback').textContent = '请先按回车检查当前答案，再按空格继续。'; return; }
  if (action === 'advance') { const history = progress(); if (!history.correct.includes(state.index)) history.correct.push(state.index); state.index += 1; }
  save(); render();
}

function switchWord(direction) {
  if (state.loading || !state.book || !state.book.words.length) return;
  if (direction > 0 && state.index >= state.book.words.length) return;
  if (isBatchMode()) {
    if (direction > 0 && state.index + state.batchSize >= state.book.words.length) return;
    delete progress().batch;
    state.index = state.index >= state.book.words.length ? Math.floor((state.book.words.length - 1) / state.batchSize) * state.batchSize : Math.max(0, state.index + direction * state.batchSize);
    state.batch = null; save(); render(); return;
  }
  const index = Math.max(0, Math.min(state.book.words.length - 1, state.index + direction));
  if (index === state.index) return;
  state.index = index;
  save(); render();
}

function setMode(mode) {
  if (state.loading) return;
  if (state.mode === mode) return;
  save(); state.mode = mode;
  if (state.sourceBook) refreshCollection(mode === 'read');
  save(); render();
}

function setCollection(collection) {
  if (state.loading || !state.sourceBook || state.collection === collection) return;
  save();
  state.batch = null;
  state.collection = collection;
  refreshCollection(state.mode === 'read');
  save(); highlightBook(); render();
}

async function moveWord(index) {
  if (state.loading || !state.book || state.index >= state.book.words.length) return;
  const position = Number.isInteger(index) ? index : state.index;
  const word = state.book.words[position]?.word;
  if (!word) return;
  const path = state.book.path;
  save();
  state.loading = true;
  try {
    if (!await flushSaves()) return;
    const book = await api('/api/classify', { path, ...revisions.get(path), word, collection: state.collection === 'main' ? 'easy' : 'main' });
    acceptBook(book);
    showError('');
    state.loading = false;
    save(); render();
    $('collection-notice').textContent = state.collection === 'main' ? '已移入简单词本并保存' : '已放回原词本并保存';
    browse(state.folder);
  } catch (error) { showError('未移动单词：' + error.message); }
  finally { state.loading = false; }
}

function restartStudy() {
  if (state.loading || !state.book) return;
  state.index = 0;
  if (state.mode === 'read') {
    progress().read = 0;
    refreshCollection(true);
  } else {
    progress().correct = []; progress().attempted = []; delete progress().batch;
    state.batch = null;
  }
  save(); render();
}

function hideWordHint(focusInput = false) {
  if (!state.showingHint) return;
  state.showingHint = false;
  if (isBatchMode()) {
    document.querySelectorAll('.batch-hint').forEach(hint => { hint.hidden = true; });
    if (focusInput) focusBatch(state.batch?.active, true);
    return;
  }
  const hasWord = !state.loading && state.book && state.index < state.book.words.length;
  if (state.mode !== 'learn' || !hasWord) return;
  $('word-display').hidden = !state.result?.checked;
  $('recall-title').hidden = Boolean(state.result?.checked);
  if (focusInput) $('answer').focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return;
  if (state.loading || state.mode !== 'learn' || !state.book || state.index >= state.book.words.length) return;
  if (!event.target.closest('.study-panel') || event.target.closest('.mode-switch, .collection-switch, .reading-options')) return;
  event.preventDefault();
  event.stopPropagation();
  state.showingHint = true;
  if (isBatchMode()) {
    const offset = state.batch?.active;
    const row = state.batch?.rows[offset];
    if (!row) return;
    const hint = $('batch-hint-' + offset); hint.textContent = row.entry.word; hint.hidden = false;
    hint.style.fontSize = '24px';
    const range = document.createRange(); range.selectNodeContents(hint);
    const width = range.getBoundingClientRect().width;
    if (width > hint.clientWidth) hint.style.fontSize = `${Math.floor(24 * (hint.clientWidth - 1) / width * 100) / 100}px`;
    focusBatch(offset, true);
    return;
  }
  $('word-display').hidden = false;
  $('recall-title').hidden = true;
  fitWordTitle();
  $('answer').focus({ preventScroll: true });
}, true);
document.addEventListener('keyup', event => {
  if (event.key !== 'Tab' || !state.showingHint) return;
  event.preventDefault();
  hideWordHint(true);
}, true);
window.addEventListener('blur', () => hideWordHint());
document.addEventListener('visibilitychange', () => { if (document.hidden) hideWordHint(); });

document.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  if (state.loading || !state.book || !state.book.words.length) return;
  if (event.target.closest('.sidebar, .mode-switch, .collection-switch') || event.target.isContentEditable) return;
  if (event.target.matches('input, textarea, select') && event.target.id !== 'answer' && !event.target.classList.contains('batch-answer')) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) {
    if (isBatchMode() && state.batch) focusBatch(Math.max(0, Math.min(state.batch.rows.length - 1, state.batch.active + (event.key === 'ArrowLeft' ? -1 : 1))));
    else switchWord(event.key === 'ArrowLeft' ? -1 : 1);
  }
}, true);

document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  if (state.mode !== 'read' || state.loading || !state.book || state.index >= state.book.words.length) return;
  if (event.target.closest('.sidebar, .mode-switch, .collection-switch, .reading-options') || event.target.matches('input, textarea, select, a') || event.target.isContentEditable) return;
  if (!event.target.closest('.study-panel') && event.target !== document.body && event.target !== document.documentElement) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  moveWord();
}, true);

$('read-mode').onclick = () => setMode('read');
$('learn-mode').onclick = () => setMode('learn');
$('reading-display').onchange = event => setReadingDisplay(event.target.value);
$('batch-size').onchange = event => setBatchSize(Number(event.target.value));
$('main-collection').onclick = () => setCollection('main');
$('easy-collection').onclick = () => setCollection('easy');
$('move-word').onclick = moveWord;
$('check-answer').onclick = check;
$('continue-answer').onclick = continueStudy;
$('next').onclick = () => state.mode === 'read' || isBatchMode() ? continueStudy() : check();
$('previous').onclick = () => switchWord(-1);
$('restart').onclick = restartStudy;
$('save-status').onclick = () => saveConflict ? location.reload() : flushSaves();
window.addEventListener('pagehide', () => { flushSaves(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves(); });
$('refresh').onclick = () => { showError(''); browse(state.folder); };
$('answer').addEventListener('input', () => {
  if (!state.result) return;
  state.result = null;
  $('feedback').className = 'feedback'; $('feedback').textContent = '答案已修改，请重新按回车检查。';
  $('learn-area').classList.remove('correct', 'incorrect');
  $('continue-answer').disabled = true;
});
$('answer').addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || event.repeat) return;
  if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); check(); }
  else if (event.code === 'Space' && state.result?.checked) { event.preventDefault(); event.stopPropagation(); continueStudy(); }
});
document.addEventListener('keydown', event => {
  if (event.isComposing || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
  if (isBatchMode()) {
    if (event.key === 'Enter' && event.target.closest('.study-panel') && !event.target.matches('input, textarea, select') && !event.target.closest('.mode-switch, .collection-switch') && event.target.id !== 'restart') {
      event.preventDefault(); checkBatch(state.batch?.active);
    } else if (event.code === 'Space' && !event.target.matches('input, textarea, select') && (event.target.closest('.study-panel') || event.target === document.body)) {
      event.preventDefault(); continueStudy();
    }
    return;
  }
  if (state.mode === 'read' && event.code === 'Space' && event.target.closest('.study-panel') && !event.target.matches('input, textarea, select')) {
    event.preventDefault(); continueStudy(); return;
  }
  if (state.mode === 'learn' && event.target.closest('.study-panel') && !event.target.closest('.mode-switch, .collection-switch') && event.target.id !== 'restart') {
    if (event.key === 'Enter') { event.preventDefault(); check(); return; }
    if (event.code === 'Space' && !event.target.matches('input, textarea, select')) { event.preventDefault(); continueStudy(); return; }
  }
  if (event.target.matches('input, textarea, select, button, a, summary')) return;
  if (event.code === 'Space') { event.preventDefault(); continueStudy(); }
  else if (event.key === 'Enter' && state.mode === 'learn') { event.preventDefault(); check(); }
});
$('speak').onclick = () => {
  const word = state.book?.words[state.index];
  if (!word || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const voice = new SpeechSynthesisUtterance(word.word); voice.lang = 'en-US'; voice.rate = 0.85; speechSynthesis.speak(voice);
};
if (!('speechSynthesis' in window)) $('speak').hidden = true;

async function initialize() {
  let lastBook = ''; let collection = 'main'; try { lastBook = localStorage.getItem('wordroom.lastBook') || ''; state.mode = localStorage.getItem('wordroom.mode') === 'learn' ? 'learn' : 'read'; collection = localStorage.getItem('wordroom.collection') === 'easy' ? 'easy' : 'main'; } catch { /* Defaults are sufficient. */ }
  try { const display = localStorage.getItem('wordroom.readingDisplay'); if (['all', 'hide-meaning', 'hide-word'].includes(display)) state.readingDisplay = display; } catch { /* Show all by default. */ }
  try { const size = Number(localStorage.getItem('wordroom.batchSize')); if ([1, 5, 10].includes(size)) state.batchSize = size; } catch { /* Use the original single-word mode. */ }
  try {
    if (Object.keys(legacyProgress).length || Object.keys(legacyEasyWords).length) {
      const migrated = await api('/api/migrate', { progress: legacyProgress, easy_words: legacyEasyWords, batch_size: state.batchSize });
      if (migrated.imported.length) $('collection-notice').textContent = `已将 ${migrated.imported.length} 本旧学习记录迁入 JSON`;
    }
    await browse('');
    const status = await api('/api/status');
    if (!status.dictionary) showError('未找到词典。请用 --dict 参数指定 dict.db 的路径后重新启动。');
    if (lastBook) { await browse(lastBook.split('/').slice(0, -1).join('/')); await openBook(lastBook, collection); return; }
    const root = await api('/api/browse');
    const firstBook = root.entries.find(item => item.type === 'book' && !item.error);
    if (firstBook) { await openBook(firstBook.path); return; }
    const firstFolder = root.entries.find(item => item.type === 'folder');
    if (firstFolder) {
      await browse(firstFolder.path);
      const folder = await api('/api/browse?path=' + encodeURIComponent(firstFolder.path));
      const book = folder.entries.find(item => item.type === 'book' && !item.error);
      if (book) await openBook(book.path);
    }
  } catch (error) { showError(error.message); }
  render();
}
initialize();

// Optional browser-native tools reuse the exact actions exposed by the page.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const tools = [
    {
      name: 'read_wordbook_folder', title: '查看单词本文件夹',
      description: 'Browse folders and word books under the local words root. Legacy lists are imported as JSON with local backups; learning progress is not changed.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input) { if (input?.path !== undefined && typeof input.path !== 'string') throw new Error('path must be a string'); return api('/api/browse?path=' + encodeURIComponent(input?.path || '')); },
    },
    {
      name: 'check_current_spelling', title: '检查当前单词拼写',
      description: 'Check the active spelling input. Batch mode retains each answer until all pass, then clears the group together and waits for Space; the next input scrolls toward screen center.',
      inputSchema: { type: 'object', properties: { answer: { type: 'string', maxLength: 200 } }, required: ['answer'], additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute(input) {
        if (typeof input?.answer !== 'string' || input.answer.length > 200) throw new Error('answer must be a string up to 200 characters');
        if (state.loading || state.mode !== 'learn' || !state.book || state.index >= state.book.words.length) throw new Error('No active spelling session');
        if (isBatchMode()) {
          const offset = state.batch.active;
          $('batch-answer-' + offset).value = input.answer;
          return checkBatch(offset);
        }
        $('answer').value = input.answer; check();
        return { status: state.result.status, position: state.index + 1, feedback: $('feedback').textContent };
      },
    },
    {
      name: 'continue_current_word', title: '根据检查结果继续',
      description: 'Apply Space behavior: advance after a correct checked answer, retry the same word after a wrong answer. Reading mode reveals or advances, and restarts a shuffled round after completion.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute() {
        if (state.loading || !state.book?.words.length || (state.index >= state.book.words.length && state.mode !== 'read')) throw new Error('No active word');
        if (isBatchMode()) {
          if (!batchCanAdvance(state.batch)) throw new Error('All words in the batch must pass before continuing.');
          const previous = state.index; continueStudy();
          return { advanced: state.index !== previous, position: state.index + 1, complete: state.index >= state.book.words.length };
        }
        if (state.mode === 'learn' && !state.result?.checked) throw new Error('Check the answer before continuing');
        const previous = state.index; continueStudy();
        return { advanced: state.index !== previous, position: state.index + 1, complete: state.index >= state.book.words.length };
      },
    },
  ];
  for (const tool of tools) {
    try { Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Browser tools are optional. */ }
  }
}
