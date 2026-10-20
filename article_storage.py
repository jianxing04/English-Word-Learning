"""Merge analyzed articles without changing existing classifications or study history."""
from __future__ import annotations

import copy
import hashlib
import unicodedata


def key(text):
    return ' '.join(unicodedata.normalize('NFKC', text).replace('’', "'").replace('‘', "'").split()).casefold()


def validate_sentences(sentences):
    if not isinstance(sentences, list):
        raise ValueError('article_sentences 必须是原句数组。')
    for sentence in sentences:
        if not isinstance(sentence, dict) or not isinstance(sentence.get('text'), str) or not sentence['text'].strip():
            raise ValueError('每条文章原句必须包含 text。')
        spans = sentence.get('spans')
        if not isinstance(spans, list) or not spans:
            raise ValueError('每条文章原句必须包含高亮位置 spans。')
        for span in spans:
            if not isinstance(span, list) or len(span) != 2 or any(type(value) is not int for value in span) or not 0 <= span[0] < span[1] <= len(sentence['text']):
                raise ValueError('文章原句的高亮位置超出文字范围。')
        sources = sentence.get('sources', [])
        if not isinstance(sources, list) or any(not isinstance(source, dict) or not isinstance(source.get('article_id'), str) or type(source.get('sentence_index')) is not int or source['sentence_index'] < 0 for source in sources):
            raise ValueError('文章原句的来源格式有误。')


def selected_groups(analysis, selection):
    available = {key(group['word']): group for group in analysis['words']}
    if selection is None:
        return list(available.values())
    if not isinstance(selection, list) or not selection or len(selection) > len(available):
        raise ValueError('请至少选择一个要添加的单词。')
    result, seen = [], set()
    for item in selection:
        if not isinstance(item, dict) or not isinstance(item.get('lemma'), str) or not isinstance(item.get('word'), str):
            raise ValueError('预览单词的格式有误，请重新解析。')
        original = key(item['lemma'])
        word = item['word'].strip()
        if original not in available or original in seen or not word or len(word) > 100 or '\n' in word or '\r' in word:
            raise ValueError('预览单词的原型有误，请检查输入。')
        seen.add(original)
        result.append({**available[original], 'word': word})
    return result


def merge(document, analysis, text, title='', selection=None):
    result = copy.deepcopy(document)
    existing = {key(word): word for word in result['words'] + result['easy_words']}
    details = result.setdefault('word_details', {})
    detail_keys = {key(word): word for word in details}
    articles = result.setdefault('articles', {})
    article_id = hashlib.sha256(text.encode('utf-8')).hexdigest()
    if article_id not in articles:
        articles[article_id] = {'title': title.strip() or f'文章 {len(articles) + 1}', 'text': text, 'engine': analysis['engine']}
    new_words, existing_words, new_sentences, updated = [], set(), 0, set()
    for group in selected_groups(analysis, selection):
        identity = key(group['word'])
        if identity in existing:
            actual = existing[identity]
            if actual not in new_words:
                existing_words.add(identity)
        else:
            actual = group['word']
            existing[identity] = actual
            new_words.append(actual)
            result['words'].append(actual)
        detail_name = detail_keys.setdefault(identity, actual)
        detail = details.setdefault(detail_name, {})
        records = detail.setdefault('article_sentences', [])
        by_text = {record['text']: record for record in records}
        for occurrence in group['occurrences']:
            number = occurrence['sentence']
            sentence_text = analysis['sentences'][number]
            record = by_text.get(sentence_text)
            if record is None:
                record = {'text': sentence_text, 'spans': [], 'sources': []}
                records.append(record)
                by_text[sentence_text] = record
                new_sentences += 1
                updated.add(identity)
            span = [occurrence['start'], occurrence['end']]
            if span not in record['spans']:
                record['spans'].append(span)
                record['spans'].sort()
                updated.add(identity)
            source = {'article_id': article_id, 'sentence_index': number}
            if source not in record['sources']:
                record['sources'].append(source)
                updated.add(identity)
        validate_sentences(records)
    if new_words:
        original = document.get('word_order', document['words'] + document['easy_words'])
        result['word_order'] = list(original) + new_words
    return result, {'new_words': len(new_words), 'existing_words': len(existing_words),
                    'new_sentences': new_sentences, 'updated_words': len(updated),
                    'sentence_count': len(analysis['sentences']), 'article_count': len(articles)}
