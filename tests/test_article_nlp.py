"""Real model regression checks; optional NLP installation is required for these."""
import pathlib
import sqlite3
import tempfile
import unittest
from contextlib import closing

import article_nlp


@unittest.skipUnless(article_nlp.status()['available'], 'Install article NLP with python tools/setup_article_nlp.py')
class EnglishTransformerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=pathlib.Path(__file__).resolve().parents[1] / '.runtime')
        database = pathlib.Path(cls.temp.name) / 'dictionary.db'
        with closing(sqlite3.connect(database)) as connection:
            connection.execute('CREATE TABLE stardict(word TEXT)')
            connection.executemany('INSERT INTO stardict VALUES (?)', [('well-known',), ('state-of-the-art',)])
            connection.commit()
        cls.text = ("Dr. Smith saw three children in the U.S. on Jan. 3, 2025. "
                    "The children were running when he ran past them. A child runs every day. "
                    "The leaves fell as she leaves home. She bought two mice and a better book. "
                    "The news was good. I saw the saw on the bench. "
                    "We can't buy a well-known brand with state-of-the-art tools. "
                    "Don't visit https://example.com or email test@example.com. 🔎 They went home.")
        cls.result = article_nlp.analyze(cls.text, database)
        cls.words = {word['word'].casefold(): word for word in cls.result['words']}

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_regular_and_irregular_forms_share_contextual_lemmas(self):
        self.assertTrue({'running', 'ran', 'runs'} <= set(self.words['run']['forms']))
        self.assertTrue({'children', 'child'} <= set(self.words['child']['forms']))
        for lemma, form in [('mouse', 'mice'), ('buy', 'bought'), ('good', 'better'), ('go', 'went')]:
            self.assertIn(form, self.words[lemma]['forms'])
        self.assertNotIn('running', self.words)
        self.assertNotIn('children', self.words)

    def test_ambiguous_forms_use_part_of_speech_in_context(self):
        self.assertIn('leaves', self.words['leaf']['forms'])
        self.assertIn('leaves', self.words['leave']['forms'])
        self.assertIn('saw', self.words['see']['forms'])
        self.assertIn('saw', self.words['saw']['forms'])
        self.assertIn('news', self.words)
        self.assertNotIn('new', self.words)

    def test_abbreviations_contractions_compounds_links_and_exact_source_spans(self):
        self.assertTrue(any(sentence.startswith('Dr. Smith') and 'U.S.' in sentence and '2025.' in sentence for sentence in self.result['sentences']))
        for lemma in ['can', 'not', 'well-known', 'state-of-the-art']:
            self.assertIn(lemma, self.words)
        for bad in ['ca', "n't", 'https', 'https://example.com', 'test@example.com', '2025', '3']:
            self.assertNotIn(bad, self.words)
        for word in self.result['words']:
            for occurrence in word['occurrences']:
                sentence = self.result['sentences'][occurrence['sentence']]
                self.assertIn(sentence[occurrence['start']:occurrence['end']], word['forms'])
