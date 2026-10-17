import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import wordnet_dictionary as wordnet


FIXTURE = '''<?xml version="1.0" encoding="UTF-8"?>
<LexicalResource><Lexicon id="oewn" language="en" label="Open English Wordnet" version="2025+" license="https://creativecommons.org/licenses/by/4.0/">
  <LexicalEntry id="minor-n"><Lemma writtenForm="minor" partOfSpeech="n"/><Form writtenForm="minors"/><Sense synset="child-n"/></LexicalEntry>
  <LexicalEntry id="child-n"><Lemma writtenForm="child" partOfSpeech="n"/><Sense synset="child-n"/></LexicalEntry>
  <LexicalEntry id="minor-a"><Lemma writtenForm="minor" partOfSpeech="a"/><Sense synset="small-a"/><Sense synset="young-a"/></LexicalEntry>
  <LexicalEntry id="small-a"><Lemma writtenForm="lesser" partOfSpeech="a"/><Sense synset="small-a"/></LexicalEntry>
  <LexicalEntry id="take-off-v"><Lemma writtenForm="take off" partOfSpeech="v"/><Sense synset="depart-v"/></LexicalEntry>
  <Synset id="child-n"><Definition>a young person</Definition><Example>This is a child.</Example></Synset>
  <Synset id="small-a"><Definition>of lesser importance</Definition></Synset>
  <Synset id="young-a"><Definition>not of legal age</Definition></Synset>
  <Synset id="depart-v"><Definition>leave the ground</Definition></Synset>
</Lexicon></LexicalResource>'''


class WordnetTests(unittest.TestCase):
    def setUp(self):
        runtime = Path(__file__).resolve().parents[1] / '.runtime'
        runtime.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=runtime)
        self.root = Path(self.temp.name)
        self.xml = self.root / 'wordnet.xml'
        self.xml.write_text(FIXTURE, encoding='utf-8')
        self.db = self.root / 'wordnet.db'
        wordnet.build_database(self.xml, self.db)

    def tearDown(self):
        wordnet._lookup.cache_clear()
        self.temp.cleanup()

    def test_all_senses_and_parts_of_speech_are_retained_with_synonyms(self):
        result = wordnet.lookup('MINOR', self.db)
        self.assertTrue(result['available'])
        self.assertTrue(result['found'])
        self.assertEqual(result['version'], '2025+')
        self.assertEqual([row['pos'] for row in result['senses']], ['n', 'a', 'a'])
        self.assertEqual(result['senses'][0]['synonyms'], ['child'])
        self.assertEqual(result['senses'][1]['synonyms'], ['lesser'])
        self.assertNotIn('examples', json.dumps(result))

    def test_inflections_and_phrases_match_without_fuzzy_substitution(self):
        inflected = wordnet.lookup('minors', self.db)
        self.assertEqual(len(inflected['senses']), 1)
        self.assertEqual(inflected['senses'][0]['lemma'], 'minor')
        self.assertTrue(wordnet.lookup(' ＴＡＫＥ   ＯＦＦ ', self.db)['found'])
        missing = wordnet.lookup('minorrrrr', self.db)
        self.assertTrue(missing['available'])
        self.assertFalse(missing['found'])
        self.assertEqual(missing['senses'], [])

    def test_reading_never_modifies_the_database(self):
        before = self.db.read_bytes()
        wordnet.lookup('minor', self.db)
        self.assertEqual(self.db.read_bytes(), before)
        self.assertFalse(Path(str(self.db) + '-journal').exists())

    def test_missing_and_corrupt_optional_databases_do_not_break_ecdict(self):
        missing = self.root / 'not-installed.db'
        self.assertFalse(wordnet.lookup('minor', missing)['available'])
        self.assertFalse(missing.exists())
        corrupt = self.root / 'corrupt.db'
        corrupt.write_text('not sqlite', encoding='utf-8')
        self.assertFalse(wordnet.lookup('minor', corrupt)['available'])

    def test_reinstall_refreshes_cached_definitions(self):
        self.assertEqual(wordnet.lookup('minor', self.db)['senses'][0]['definition'], 'a young person')
        self.xml.write_text(FIXTURE.replace('a young person', 'a person below the legal age'), encoding='utf-8')
        wordnet.build_database(self.xml, self.db)
        self.assertEqual(wordnet.lookup('minor', self.db)['senses'][0]['definition'], 'a person below the legal age')

    def test_a_failed_build_preserves_the_existing_dictionary(self):
        before = self.db.read_bytes()
        self.xml.write_text(FIXTURE.replace('synset="child-n"', 'synset="missing-n"'), encoding='utf-8')
        with self.assertRaises(ValueError):
            wordnet.build_database(self.xml, self.db)
        self.assertEqual(self.db.read_bytes(), before)
        self.assertEqual(list(self.root.glob('.wordnet-*.tmp')), [])

    def test_load_book_combines_sources_without_persisting_dictionary_data_in_progress(self):
        books = self.root / 'words'
        books.mkdir()
        original = {'version': 2, 'words': ['minor'], 'easy_words': [], 'progress': {}, 'revision': 0}
        book_path = books / 'WL1.json'
        book_path.write_text(json.dumps(original), encoding='utf-8')
        with patch.object(app, 'BOOK_ROOT', books), patch.object(app, 'WORDNET_PATH', self.db), patch.object(app, 'lookup', return_value={'translation': '较小的', 'definition': 'old definition'}):
            entry = app.load_book('WL1.json')['words'][0]
        self.assertEqual(entry['translation'], '较小的')
        self.assertEqual(len(entry['wordnet']['senses']), 3)
        self.assertEqual(json.loads(book_path.read_text(encoding='utf-8')), original)


if __name__ == '__main__':
    unittest.main()
