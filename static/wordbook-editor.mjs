export function setupWordbookEditor({api, folderName, beforeOpen, onVisibility, onSaved, onSelected, onClose, currentPath}) {
  const $ = id => document.getElementById(id);
  let opened = false, busy = false, loaded = null, original = '', mode = 'list', preview = null, savedArticle = '';
  const listDirty = () => $('editor-words').value !== original;
  const articleSignature = () => $('article-title').value + '\n' + $('article-text').value;
  const articleDirty = () => Boolean(preview) || (Boolean($('article-title').value.trim() || $('article-text').value.trim()) && articleSignature() !== savedArticle);
  const dirty = () => listDirty() || articleDirty();
  function clearPreview() { preview = null; $('article-preview').hidden = true; $('article-word-list').replaceChildren(); }
  function resetArticle() { $('article-title').value = ''; $('article-text').value = ''; savedArticle = ''; clearPreview(); }
  function setMode(value) {
    mode = value;
    $('editor-list-fields').hidden = value !== 'list'; $('editor-article-fields').hidden = value !== 'article';
    $('editor-list-mode').setAttribute('aria-pressed', String(value === 'list'));
    $('editor-article-mode').setAttribute('aria-pressed', String(value === 'article'));
    $('editor-save').hidden = value !== 'list'; controls();
  }
  function canOpen() {
    if (busy) return false;
    if (opened && dirty()) { status('当前修改尚未保存，请先保存，或取消修改后重新选择词本。', true); return false; }
    return true;
  }
  function status(message, error = false) {
    $('editor-status').textContent = message;
    $('editor-status').classList.toggle('editor-error', error);
  }
  function controls() {
    $('editor-book').disabled = busy;
    $('editor-words').disabled = busy || !loaded;
    $('editor-save').disabled = busy || !loaded || !listDirty();
    $('editor-cancel').disabled = busy;
    $('editor-reload').disabled = busy;
    $('editor-cancel').textContent = dirty() ? '取消修改' : '返回学习';
    const count = $('editor-words').value.split(/\r?\n/).filter(word => word.trim()).length;
    $('editor-count').textContent = loaded ? `${count} 行词汇` : '';
    for (const id of ['editor-list-mode','editor-article-mode','article-title','article-text']) $(id).disabled = busy || !loaded;
    $('article-analyze').disabled = busy || !loaded || !$('article-text').value.trim();
    const chosen = Array.from(document.querySelectorAll('.article-word-row')).filter(row => row.querySelector('.article-choose').checked);
    $('article-import').disabled = busy || !preview || !chosen.length || chosen.some(row => !row.querySelector('.article-lemma').value.trim());
    $('article-selected-count').textContent = `${chosen.length} 个词`;
    for (const field of document.querySelectorAll('#article-preview input')) field.disabled = busy;
  }
  function accept(book) {
    loaded = book;
    original = book.words.join('\n');
    $('editor-words').value = original;
    // Legacy lists can be imported into JSON when they are opened.
    const option = Array.from($('editor-book').options).find(option => option.value === book.path || option.value.replace(/\.[^.]+$/, '.json') === book.path);
    if (option) { option.value = book.path; $('editor-book').value = book.path; }
    $('editor-reload').hidden = true;
    onSelected(book.path);
  }
  async function select(path, reload = false) {
    if (busy) return;
    if (dirty() && !reload) {
      $('editor-book').value = loaded.path;
      status('当前修改尚未保存，请先保存，或取消修改后重新选择词本。', true);
      return;
    }
    busy = true; controls(); status('正在读取词汇列表…');
    try {
      const book = await api('/api/book-words?path=' + encodeURIComponent(path));
      accept(book); resetArticle(); setMode('list'); status(`已加载 ${book.words.length} 个单词。`);
    } catch (error) {
      if (loaded) $('editor-book').value = loaded.path;
      status('无法打开词本：' + error.message, true);
    } finally { busy = false; controls(); }
  }
  async function open(targetPath = '') {
    if (!canOpen() || (opened && !targetPath)) return false;
    $('edit-wordbook').disabled = true;
    try {
      if (!opened) {
        if (!await beforeOpen()) return false;
        opened = true; loaded = null; original = ''; $('editor-words').value = ''; resetArticle(); setMode('list');
        onVisibility(true); $('wordbook-editor').hidden = false;
      }
      busy = true; controls(); status('正在读取单词本…');
      const catalog = await api('/api/edit-books');
      $('editor-book').replaceChildren();
      for (const book of catalog.books) {
        const option = document.createElement('option'); option.value = book.path;
        option.textContent = book.path.split('/').slice(0, -1).map(folderName).concat(book.name).join(' / ');
        $('editor-book').append(option);
      }
      busy = false;
      const path = targetPath || catalog.books.find(book => book.path === currentPath())?.path || catalog.books[0]?.path;
      if (path) { $('editor-book').value = path; await select(path); }
      else status('还没有可修改的单词本，请先添加词表。');
      $('wordbook-editor').scrollIntoView({block:'start'});
      return Boolean(loaded && loaded.path === path);
    } catch (error) { status('无法读取词本：' + error.message, true); }
    finally { busy = false; controls(); $('edit-wordbook').disabled = false; }
  }
  $('edit-wordbook').onclick = () => open();
  $('editor-book').onchange = event => select(event.target.value);
  $('editor-words').oninput = () => { controls(); status(dirty() ? '有未保存的修改。' : ''); };
  $('editor-list-mode').onclick = () => setMode('list');
  $('editor-article-mode').onclick = () => setMode('article');
  for (const id of ['article-title','article-text']) $(id).oninput = () => { clearPreview(); controls(); status(articleDirty() ? '文章尚未添加，请解析并预览。' : ''); };
  $('article-select-all').onchange = event => { for (const field of document.querySelectorAll('.article-choose')) field.checked = event.target.checked; controls(); };
  $('article-analyze').onclick = async () => {
    if (busy || !loaded || !$('article-text').value.trim()) return;
    if (listDirty()) { status('请先保存逐行编辑中的修改，再解析文章。', true); return; }
    busy = true; clearPreview(); controls(); status('正在本机解析文章并还原词形…首次加载模型需要一些时间。');
    try {
      const result = await api('/api/article-preview', {path:loaded.path,revision:loaded.revision,etag:loaded.etag,title:$('article-title').value,text:$('article-text').value});
      preview = result; $('article-preview').hidden = false; $('article-select-all').checked = true;
      const summary = result.summary;
      $('article-summary').textContent = `${summary.sentence_count} 句 · ${result.words.length} 个原型 · 预计新增 ${summary.new_words} 个词，${summary.existing_words} 个词已在词本中`;
      for (const word of result.words) {
        const row = document.createElement('tr'); row.className = 'article-word-row'; row.dataset.lemma = word.word;
        const choice = document.createElement('input'); choice.type = 'checkbox'; choice.checked = true; choice.className = 'article-choose'; choice.setAttribute('aria-label',`添加 ${word.word}`); choice.onchange = controls;
        const lemma = document.createElement('input'); lemma.type = 'text'; lemma.maxLength = 100; lemma.value = word.word; lemma.className = 'article-lemma'; lemma.setAttribute('aria-label',`原型 ${word.word}`); lemma.oninput = controls;
        const cells = Array.from({length:4},()=>document.createElement('td'));
        cells[0].append(choice); cells[1].append(lemma); cells[2].textContent = word.forms.join(' / '); cells[3].textContent = `${word.existing ? '已有词' : '新增词'} · ${word.sentence_count} 句`;
        row.append(...cells); $('article-word-list').append(row);
      }
      status('解析完成，请核对原型并确认添加；尚未写入词本。');
    } catch (error) { status('无法解析：' + error.message, true); if(error.status===409) $('editor-reload').hidden=false; }
    finally { busy=false; controls(); }
  };
  $('article-import').onclick = async () => {
    if (busy || !loaded || !preview) return;
    const selection = Array.from(document.querySelectorAll('.article-word-row')).filter(row=>row.querySelector('.article-choose').checked).map(row=>({lemma:row.dataset.lemma,word:row.querySelector('.article-lemma').value}));
    if (!selection.length) return;
    busy=true; controls(); status('正在添加原型和文章原句…');
    try {
      const result = await api('/api/article-import',{path:loaded.path,revision:loaded.revision,etag:loaded.etag,preview_id:preview.preview_id,selection});
      accept(result); clearPreview(); savedArticle=articleSignature();
      status(`已保存：新增 ${result.summary.new_words} 个词 · 已有 ${result.summary.existing_words} 个词 · 新增 ${result.summary.new_sentences} 条词句关联（已去重）。`);
      try { await onSaved(result); } catch(error) { status('文章已保存，页面更新失败，请刷新：'+error.message,true); }
    } catch(error) { status('文章未添加：'+error.message,true); if(error.status===409) $('editor-reload').hidden=false; }
    finally { busy=false; controls(); }
  };
  $('editor-save').onclick = async () => {
    if (busy || !loaded || !listDirty()) return;
    busy = true; controls(); status('正在保存…');
    try {
      const result = await api('/api/edit-book', {path:loaded.path, revision:loaded.revision, etag:loaded.etag, words:$('editor-words').value.split(/\r?\n/)});
      accept(result); clearPreview();
      status(`已保存 ${result.words.length} 个单词。`);
      try { await onSaved(result); }
      catch (error) { status('词本已保存，页面更新失败，请刷新网页：' + error.message, true); }
    } catch (error) {
      status('未保存：' + error.message, true);
      if (error.status === 409) $('editor-reload').hidden = false;
    } finally { busy = false; controls(); }
  };
  $('editor-cancel').onclick = () => {
    if (busy) return;
    opened = false; loaded = null; original = ''; $('editor-words').value = ''; resetArticle();
    $('wordbook-editor').hidden = true; onVisibility(false); onClose();
  };
  $('editor-reload').onclick = () => { if (loaded) select(loaded.path, true); };
  window.addEventListener('beforeunload', event => { if (opened && dirty()) { event.preventDefault(); event.returnValue = ''; } });
  return {select, open, canOpen};
}
