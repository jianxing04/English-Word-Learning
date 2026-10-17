export function setupGlobalSearch({ api, openWord }) {
  const $ = id => document.getElementById(id);
  const pageSize = 30;
  let sequence = 0, timer, active = false, showAll = false, offset = 0;

  function highlight(word, query) {
    const fragment = document.createDocumentFragment();
    const position = word.toLowerCase().indexOf(query.toLowerCase());
    if (!query || position < 0) { fragment.append(word); return fragment; }
    fragment.append(word.slice(0, position));
    const mark = document.createElement('mark'); mark.textContent = word.slice(position, position + query.length);
    fragment.append(mark, word.slice(position + query.length));
    return fragment;
  }

  function render(data) {
    const unique = data.unique_words.toLocaleString();
    const stats = `${data.books} 本词本 · ${unique} 个不重复单词`;
    const skipped = data.errors.length ? `；另有 ${data.errors.length} 本词本无法读取` : '';
    $('search-status').textContent = (active ? `${data.query ? `“${data.query}”找到 ${data.total} 个词` : `全部 ${unique} 个词，按字母排序`} · ${stats}` : `${stats} · 含原词本和简单词，前缀匹配优先`) + skipped;
    $('search-status').classList.remove('search-error');
    $('search-output').hidden = !active;
    $('search-results').replaceChildren();
    if (!active) return;
    if (!data.total) {
      const empty = document.createElement('li'); empty.className = 'search-empty'; empty.textContent = '没有找到包含这段拼写的词，试试更短的片段。'; $('search-results').append(empty);
    }
    const labels = {exact: '完全匹配', prefix: '前缀匹配', contains: '包含匹配'};
    for (const entry of data.results) {
      const row = document.createElement('li'); row.className = 'search-result';
      const heading = document.createElement('div'); heading.className = 'search-word-heading';
      const word = document.createElement('h3'); word.append(highlight(entry.word, data.query)); heading.append(word);
      if (labels[entry.match]) { const tag = document.createElement('span'); tag.className = 'search-match'; tag.textContent = labels[entry.match]; heading.append(tag); }
      if (entry.phonetic) { const phonetic = document.createElement('span'); phonetic.className = 'search-phonetic'; phonetic.textContent = `/ ${entry.phonetic} /`; heading.append(phonetic); }
      const meaning = document.createElement('p'); meaning.className = 'search-meaning'; meaning.textContent = (entry.translation || '暂无中文释义').replace(/\\n/g, '\n');
      const sources = document.createElement('div'); sources.className = 'search-sources';
      for (const source of entry.sources) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = `${source.name} · ${source.collection === 'easy' ? '简单词' : '原词本'}`;
        button.title = `在 ${source.path} 中查看 ${entry.word}`;
        button.onclick = async () => {
          button.disabled = true;
          try { await openWord(source.path, source.collection, entry.word); }
          finally { button.disabled = false; }
        };
        sources.append(button);
      }
      row.append(heading, meaning, sources); $('search-results').append(row);
    }
    $('search-pagination').hidden = !data.total;
    $('search-previous').disabled = data.offset === 0;
    $('search-next').disabled = data.offset + data.results.length >= data.total;
    $('search-page').textContent = `${data.offset + 1}–${data.offset + data.results.length} / ${data.total}`;
    $('search-results').scrollTop = 0;
  }

  async function refresh(nextOffset = 0) {
    clearTimeout(timer);
    offset = nextOffset;
    const current = ++sequence;
    const query = $('global-query').value.trim();
    active = Boolean(query) || showAll;
    $('search-clear').hidden = !query;
    if (!active) $('search-output').hidden = true;
    $('search-status').textContent = '正在搜索所有词本…';
    $('search-results').setAttribute('aria-busy', 'true');
    $('search-previous').disabled = true; $('search-next').disabled = true;
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}&offset=${offset}&limit=${active ? pageSize : 1}`);
      if (current !== sequence) return;
      // Files may have been edited or words removed between pages.
      if (active && offset > 0 && offset >= data.total) return refresh(0);
      render(data);
    } catch (error) {
      if (current !== sequence) return;
      $('search-status').textContent = '搜索失败：' + error.message + '，请重新搜索。';
      $('search-status').classList.add('search-error'); $('search-output').hidden = true;
    } finally {
      if (current === sequence) $('search-results').setAttribute('aria-busy', 'false');
    }
  }

  $('global-query').addEventListener('input', event => {
    ++sequence; clearTimeout(timer); showAll = false;
    $('search-output').hidden = true; $('search-clear').hidden = !event.target.value;
    $('search-status').textContent = '正在搜索所有词本…';
    if (!event.isComposing) timer = setTimeout(() => refresh(), 180);
  });
  $('global-query').addEventListener('compositionend', () => { clearTimeout(timer); timer = setTimeout(() => refresh(), 180); });
  $('search-form').addEventListener('submit', event => { event.preventDefault(); showAll = !$('global-query').value.trim(); refresh(); });
  $('search-all').onclick = () => { $('global-query').value = ''; showAll = true; refresh(); };
  $('search-clear').onclick = () => { $('global-query').value = ''; showAll = false; refresh(); $('global-query').focus(); };
  $('search-collapse').onclick = () => { $('global-query').value = ''; showAll = false; refresh(); $('global-query').focus(); };
  $('search-previous').onclick = () => refresh(Math.max(0, offset - pageSize));
  $('search-next').onclick = () => refresh(offset + pageSize);
  refresh();
  return { refresh: () => refresh(offset) };
}
