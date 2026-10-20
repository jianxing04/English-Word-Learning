export function setupWordbookEditor({api, folderName, beforeOpen, onVisibility, onSaved, onSelected, onClose, currentPath}) {
  const $ = id => document.getElementById(id);
  let opened = false, busy = false, loaded = null, original = '';
  const dirty = () => $('editor-words').value !== original;
  function status(message, error = false) {
    $('editor-status').textContent = message;
    $('editor-status').classList.toggle('editor-error', error);
  }
  function controls() {
    $('editor-book').disabled = busy;
    $('editor-words').disabled = busy || !loaded;
    $('editor-save').disabled = busy || !loaded || !dirty();
    $('editor-cancel').disabled = busy;
    $('editor-reload').disabled = busy;
    $('editor-cancel').textContent = dirty() ? '取消修改' : '返回学习';
    const count = $('editor-words').value.split(/\r?\n/).filter(word => word.trim()).length;
    $('editor-count').textContent = loaded ? `${count} 行词汇` : '';
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
      accept(book); status(`已加载 ${book.words.length} 个单词。`);
    } catch (error) {
      if (loaded) $('editor-book').value = loaded.path;
      status('无法打开词本：' + error.message, true);
    } finally { busy = false; controls(); }
  }
  async function open() {
    if (opened || busy) return;
    $('edit-wordbook').disabled = true;
    try {
      if (!await beforeOpen()) return;
      opened = true; loaded = null; original = ''; $('editor-words').value = '';
      onVisibility(true); $('wordbook-editor').hidden = false;
      busy = true; controls(); status('正在读取单词本…');
      const catalog = await api('/api/edit-books');
      $('editor-book').replaceChildren();
      for (const book of catalog.books) {
        const option = document.createElement('option'); option.value = book.path;
        option.textContent = book.path.split('/').slice(0, -1).map(folderName).concat(book.name).join(' / ');
        $('editor-book').append(option);
      }
      busy = false;
      const path = catalog.books.find(book => book.path === currentPath())?.path || catalog.books[0]?.path;
      if (path) { $('editor-book').value = path; await select(path); }
      else status('还没有可修改的单词本，请先添加词表。');
      $('wordbook-editor').scrollIntoView({block:'start'});
    } catch (error) { status('无法读取词本：' + error.message, true); }
    finally { busy = false; controls(); $('edit-wordbook').disabled = false; }
  }
  $('edit-wordbook').onclick = open;
  $('editor-book').onchange = event => select(event.target.value);
  $('editor-words').oninput = () => { controls(); status(dirty() ? '有未保存的修改。' : ''); };
  $('editor-save').onclick = async () => {
    if (busy || !loaded || !dirty()) return;
    busy = true; controls(); status('正在保存…');
    try {
      const result = await api('/api/edit-book', {path:loaded.path, revision:loaded.revision, etag:loaded.etag, words:$('editor-words').value.split(/\r?\n/)});
      accept(result);
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
    opened = false; loaded = null; original = ''; $('editor-words').value = '';
    $('wordbook-editor').hidden = true; onVisibility(false); onClose();
  };
  $('editor-reload').onclick = () => { if (loaded) select(loaded.path, true); };
  window.addEventListener('beforeunload', event => { if (opened && dirty()) { event.preventDefault(); event.returnValue = ''; } });
  return {select};
}
