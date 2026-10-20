export function setupWordbookCreation({api, folderName, getFolder, beforeCreate, onCreated}) {
  const $ = id => document.getElementById(id);
  let kind = 'folder', busy = false;
  function controls() {
    for (const id of ['new-folder', 'new-book', 'create-name', 'create-submit', 'create-cancel']) $(id).disabled = busy;
  }
  function location() {
    const folder = getFolder().split('/').filter(Boolean).map(folderName);
    $('create-parent').textContent = '创建位置：' + ['单词本', ...folder].join(' / ');
  }
  function message(text, error = false) {
    $('create-status').textContent = text;
    $('create-status').classList.toggle('create-error', error);
  }
  function open(type) {
    if (busy) return;
    kind = type;
    $('create-item-form').hidden = false;
    $('create-name-label').textContent = type === 'folder' ? '文件夹名称' : '单词本名称';
    $('create-name').value = type === 'folder' ? '新建文件夹' : '新单词本';
    message(type === 'book' ? '创建后可直接输入单词，每行一个。' : '创建后自动进入新文件夹。');
    location(); $('create-name').focus(); $('create-name').select();
  }
  $('new-folder').onclick = () => open('folder');
  $('new-book').onclick = () => open('book');
  $('create-cancel').onclick = () => { if (!busy) { $('create-item-form').hidden = true; $('new-folder').focus(); } };
  $('create-name').addEventListener('keydown', event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); $('create-item-form').hidden = true; $('new-folder').focus(); }
  });
  $('create-item-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true; controls();
    try {
      if (!await beforeCreate(kind)) { message('请先保存或取消当前词本的修改，再新建单词本。', true); return; }
      const item = await api('/api/create', {kind, parent:getFolder(), name:$('create-name').value});
      $('create-item-form').hidden = true;
      try { await onCreated(item); }
      catch (error) { $('create-item-form').hidden = false; message('已创建，打开失败，请刷新后打开：' + error.message, true); }
    } catch (error) { message(error.message, true); }
    finally { busy = false; controls(); }
  });
  return {location};
}
