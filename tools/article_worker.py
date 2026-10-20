"""One-shot English transformer worker; JSON stdin/stdout, no network requests."""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import unicodedata
from contextlib import closing
from functools import lru_cache
from pathlib import Path


def canonical(text):
    return unicodedata.normalize('NFKC', text).replace('’', "'").replace('‘', "'").replace('‐', '-').replace('‑', '-')


def is_word(text):
    value = canonical(text)
    if re.fullmatch(r'(?:[A-Za-z]\.){2,}', value):
        return True
    if not value or len(value) > 100 or not value[0].isalpha() or not value[-1].isalpha():
        return False
    return all((char.isalpha() and 'LATIN' in unicodedata.name(char, '')) or char in "-'" for char in value)


def extract(doc, known):
    sentences, groups, token_count = [], {}, 0
    for sentence in doc.sents:
        original = sentence.text
        text = original.strip()
        if not text:
            continue
        start = sentence.start_char + len(original) - len(original.lstrip())
        sentence_number = len(sentences)
        sentences.append(text)
        tokens = list(sentence)
        index = 0
        while index < len(tokens):
            token_index = index
            token = tokens[index]
            end_index = index + 1
            surface, lemma, pos = token.text, token.lemma_, token.pos_
            begin, end = token.idx - start, token.idx + len(token.text) - start
            # Keep dictionary-recognized hyphenated lexical units intact. The
            # underlying tokenization/POS/lemmatization remain model predictions.
            candidate_end = end_index
            while candidate_end + 1 < len(tokens) and tokens[candidate_end].text in ('-', '‐', '‑'):
                hyphen, following = tokens[candidate_end], tokens[candidate_end + 1]
                previous = tokens[candidate_end - 1]
                if previous.idx + len(previous.text) != hyphen.idx or hyphen.idx + len(hyphen.text) != following.idx:
                    break
                candidate_end += 2
            if candidate_end > end_index:
                whole = doc.text[token.idx:tokens[candidate_end - 1].idx + len(tokens[candidate_end - 1].text)]
                normalized = canonical(whole).replace('‐', '-').replace('‑', '-')
                if is_word(normalized) and known(normalized):
                    surface = whole
                    lemma = normalized.lower()
                    end_index = candidate_end
                    end = tokens[candidate_end - 1].idx + len(tokens[candidate_end - 1].text) - start
            index = end_index
            if token.like_url or token.like_email or token.is_space or token.is_punct or pos in ('PUNCT', 'SPACE', 'SYM', 'X'):
                continue
            lemma = canonical(lemma)
            if canonical(surface).lower() in ('ca', 'wo') and lemma.lower() in ('ca', 'wo') and index < len(tokens) and canonical(tokens[index].text).lower() == "n't":
                lemma = 'can' if surface.lower() == 'ca' else 'will'
            if canonical(surface).lower() == "n't":
                lemma = 'not'
            # Possessive clitics are grammatical markers, not vocabulary entries.
            if pos == 'PART' and canonical(surface).lower() in ("'s", "'"):
                continue
            # English comparative exceptions depend on POS. In particular, the
            # bundled lookup can return well for the ADJ/JJR in "a better book".
            comparisons = {'ADJ': {'better': 'good', 'best': 'good', 'worse': 'bad', 'worst': 'bad'},
                           'ADV': {'better': 'well', 'best': 'well', 'worse': 'badly', 'worst': 'badly'}}
            lemma = comparisons.get(pos, {}).get(canonical(token.text).lower(), lemma)
            if not is_word(lemma):
                continue
            # Display a whole contraction, rather than misleading fragments such
            # as ca or n't. Lemmas/POS still come from each underlying NLP token.
            if end_index == token_index + 1:
                left, right = token_index, token_index + 1
                clitics = {"n't", "'s", "'re", "'ve", "'ll", "'d", "'m"}
                if canonical(token.text).lower() in clitics and left > 0 and tokens[left - 1].idx + len(tokens[left - 1].text) == token.idx:
                    left -= 1
                if right < len(tokens) and canonical(tokens[right].text).lower() in clitics and token.idx + len(token.text) == tokens[right].idx:
                    right += 1
                if left != token_index or right != token_index + 1:
                    surface = doc.text[tokens[left].idx:tokens[right - 1].idx + len(tokens[right - 1].text)]
                    begin = tokens[left].idx - start
                    end = tokens[right - 1].idx + len(tokens[right - 1].text) - start
            if pos != 'PROPN' and lemma != 'I':
                lemma = lemma.lower()
            key = lemma.casefold()
            group = groups.setdefault(key, {'word': lemma, 'forms': [], 'pos': [], 'occurrences': []})
            if surface not in group['forms']:
                group['forms'].append(surface)
            if pos not in group['pos']:
                group['pos'].append(pos)
            # Use source character offsets, never a substring search, so saw/see
            # and leaves/leaf can highlight precisely the token chosen by the model.
            if 0 <= begin < end <= len(text):
                group['occurrences'].append({'sentence': sentence_number, 'start': begin, 'end': end})
                token_count += 1
    return {'sentences': sentences, 'words': list(groups.values()), 'token_count': token_count}


def main():
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    request = json.load(sys.stdin)
    import torch
    import spacy
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    nlp = spacy.load('en_core_web_trf', exclude=['ner'])
    nlp.max_length = 100000
    @lru_cache(maxsize=2048)
    def known(word):
        path = Path(request['dictionary'])
        if not path.is_file():
            return False
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as conn:
            return conn.execute('SELECT 1 FROM stardict WHERE word=? COLLATE NOCASE LIMIT 1', (word,)).fetchone() is not None
    result = extract(nlp(request['text']), known)
    result['engine'] = {'name': 'spaCy en_core_web_trf', 'model_version': nlp.meta['version'], 'spacy_version': spacy.__version__}
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
