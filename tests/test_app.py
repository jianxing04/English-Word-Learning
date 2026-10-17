import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import app


class AppTests(unittest.TestCase):
    def setUp(self):
        runtime = Path(__file__).resolve().parents[1] / '.runtime'
        runtime.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=runtime)
        self.root = Path(self.temp.name)
        self.books = self.root / "words"
        self.books.mkdir()
        self.db = self.root / "dict.db"
        with closing(sqlite3.connect(self.db)) as conn:
            conn.execute("CREATE TABLE stardict (word TEXT COLLATE NOCASE, phonetic TEXT, definition TEXT, translation TEXT, collins INTEGER, tag TEXT, exchange TEXT)")
            conn.execute("INSERT INTO stardict VALUES ('minor', 'test', 'small', '较小的', 3, 'ky', '')")
            conn.commit()
        self.book_patch = patch.object(app, 'BOOK_ROOT', self.books)
        self.db_patch = patch.object(app, 'DICT_PATH', self.db)
        self.wordnet_patch = patch.object(app, 'WORDNET_PATH', self.root / 'not-installed-wordnet.db')
        self.book_patch.start()
        self.db_patch.start()
        self.wordnet_patch.start()
        app.lookup.cache_clear()

    def tearDown(self):
        self.book_patch.stop()
        self.db_patch.stop()
        self.wordnet_patch.stop()
        app.lookup.cache_clear()
        self.assertTrue(self.root.resolve().is_relative_to((Path(__file__).resolve().parents[1] / '.runtime').resolve()))
        self.temp.cleanup()

    def test_real_directory_navigation_natural_sort_and_counts(self):
        folder = self.books / 'exam'
        folder.mkdir()
        for name in ['WL10.txt', 'WL2.txt', 'WL1.txt']:
            (folder / name).write_text('minor\nMINOR\n\n# note\nmissing\n', encoding='utf-8')
        self.assertEqual(app.browse('')['entries'][0]['type'], 'folder')
        entries = app.browse('exam')['entries']
        self.assertEqual([item['name'] for item in entries], ['WL1.json', 'WL2.json', 'WL10.json'])
        self.assertTrue(all(item['count'] == 2 for item in entries))

    def test_book_dictionary_missing_words_and_fingerprint(self):
        path = self.books / 'sample.txt'
        path.write_text('minor\nmissing\n', encoding='utf-8')
        result = app.load_book('sample.txt')
        self.assertEqual(result['words'][0]['translation'], '较小的')
        self.assertFalse(result['words'][1]['found'])
        original = result['fingerprint']
        converted = path.with_suffix('.json')
        document = json.loads(converted.read_text(encoding='utf-8'))
        document['words'] = ['minor']
        converted.write_text(json.dumps(document), encoding='utf-8')
        self.assertNotEqual(app.load_book('sample.json')['fingerprint'], original)

    def test_no_directory_traversal_or_arbitrary_file_access(self):
        (self.root / 'outside.txt').write_text('secret', encoding='utf-8')
        for relative in ['../outside.txt', str(self.root / 'outside.txt')]:
            with self.assertRaises(app.UserError) as caught:
                app.resolve_book(relative)
            self.assertEqual(caught.exception.status, 403)

    def test_csv_json_and_phrase_preservation(self):
        (self.books / 'words.csv').write_text('meaning,word\n小的,minor\n起飞,take off\n', encoding='utf-8-sig')
        self.assertEqual(app.read_words(self.books / 'words.csv'), ['minor', 'take off'])
        (self.books / 'words.json').write_text(json.dumps({'words': [{'word': 'minor'}, 'up-to-date']}), encoding='utf-8')
        self.assertEqual(app.read_words(self.books / 'words.json'), ['minor', 'up-to-date'])

    def test_dictionary_is_not_modified(self):
        before = self.db.read_bytes()
        app.lookup('minor')
        self.assertEqual(self.db.read_bytes(), before)
        self.assertFalse(Path(str(self.db) + '-journal').exists())

    def make_book(self):
        path = self.books / 'WL1.txt'
        path.write_text('minor\nfaithful\ncontagious\n', encoding='utf-8')
        return app.load_book('WL1.txt')

    def test_conversion_keeps_original_backup_and_supports_legacy_path(self):
        self.make_book()
        document = json.loads((self.books / 'WL1.json').read_text(encoding='utf-8'))
        self.assertEqual(document['words'], ['minor', 'faithful', 'contagious'])
        self.assertEqual(document['easy_words'], [])
        self.assertFalse((self.books / 'WL1.txt').exists())
        self.assertEqual((self.root / '.runtime/wordbook-backup/WL1.txt').read_text(encoding='utf-8'), 'minor\nfaithful\ncontagious\n')
        self.assertEqual(app.load_book('WL1.txt')['path'], 'WL1.json')

    def test_moving_and_restoring_update_the_corresponding_json(self):
        book = self.make_book()
        moved = app.update_book({'path': 'WL1.json', 'word': 'MINOR', 'collection': 'easy', 'revision': 0}, classify=True)
        document = json.loads((self.books / 'WL1.json').read_text(encoding='utf-8'))
        self.assertEqual(document['words'], ['faithful', 'contagious'])
        self.assertEqual(document['easy_words'], ['minor'])
        self.assertEqual(moved['fingerprint'], book['fingerprint'])
        self.assertEqual(app.browse('')['entries'][0]['easy_count'], 1)
        restored = app.update_book({'path': 'WL1.json', 'word': 'minor', 'collection': 'main', 'revision': moved['revision']}, classify=True)
        self.assertEqual(restored['easy_words'], [])
        self.assertEqual(set(app.read_words(self.books / 'WL1.json')), {'minor', 'faithful', 'contagious'})

    def test_progress_and_batch_draft_survive_a_new_load(self):
        self.make_book()
        progress = {'read': 1, 'read_order': ['faithful', 'minor', 'contagious'], 'learn': 0,
                    'order': ['minor', 'faithful', 'contagious'], 'correct': [0], 'attempted': [0],
                    'batch': {'size': 5, 'startWord': 'minor', 'rows': [{'word': 'minor', 'answer': 'min', 'status': None}]}}
        app.update_book({'path': 'WL1.json', 'revision': 0, 'progress': {'main': progress}, 'batch_size': 5})
        reloaded = app.load_book('WL1.json')
        self.assertEqual(reloaded['progress']['main'], progress)
        self.assertEqual(reloaded['settings']['batch_size'], 5)

    def test_stale_writes_do_not_overwrite_new_membership_or_progress(self):
        self.make_book()
        app.update_book({'path': 'WL1.json', 'word': 'minor', 'collection': 'easy', 'revision': 0}, classify=True)
        before = (self.books / 'WL1.json').read_bytes()
        for classify, extra in [(False, {'progress': {}}), (True, {'word': 'faithful', 'collection': 'easy'})]:
            with self.assertRaises(app.UserError) as caught:
                app.update_book({'path': 'WL1.json', 'revision': 0, **extra}, classify=classify)
            self.assertEqual(caught.exception.status, 409)
            self.assertEqual((self.books / 'WL1.json').read_bytes(), before)

    def test_external_edits_are_detected_even_when_revision_was_not_incremented(self):
        book = self.make_book()
        document = json.loads((self.books / 'WL1.json').read_text(encoding='utf-8'))
        document['note'] = 'edited outside the server'
        (self.books / 'WL1.json').write_text(json.dumps(document), encoding='utf-8')
        before = (self.books / 'WL1.json').read_bytes()
        with self.assertRaises(app.UserError) as caught:
            app.update_book({'path': 'WL1.json', 'revision': 0, 'etag': book['etag'], 'progress': {}})
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual((self.books / 'WL1.json').read_bytes(), before)

    def test_a_broken_import_does_not_prevent_other_books_from_loading(self):
        (self.books / 'broken.json').write_text('{unmerged conflict', encoding='utf-8')
        (self.books / 'WL1.txt').write_text('minor\n', encoding='utf-8')
        app.convert_wordbooks()
        entries = {entry['name']: entry for entry in app.browse('')['entries']}
        self.assertIn('error', entries['broken.json'])
        self.assertEqual(entries['WL1.json']['count'], 1)

    def test_failed_atomic_write_leaves_json_and_classification_intact(self):
        self.make_book()
        before = (self.books / 'WL1.json').read_bytes()
        with patch.object(app.os, 'replace', side_effect=PermissionError('not writable')):
            with self.assertRaises(PermissionError):
                app.update_book({'path': 'WL1.json', 'word': 'minor', 'collection': 'easy', 'revision': 0}, classify=True)
        self.assertEqual((self.books / 'WL1.json').read_bytes(), before)
        self.assertEqual(list(self.books.glob('*.tmp')), [])

    def test_migration_imports_old_browser_data_once_and_never_reapplies_it(self):
        self.make_book()
        old = {'order': ['faithful', 'contagious'], 'read': 1, 'learn': 0, 'correct': [0], 'attempted': [0]}
        payload = {'easy_words': {'WL1.txt': ['minor']}, 'progress': {'WL1.txt:oldhash': old}, 'batch_size': 10}
        self.assertEqual(app.migrate_legacy(payload)['imported'], ['WL1.json'])
        migrated = app.load_book('WL1.json')
        self.assertEqual(migrated['easy_words'], ['minor'])
        self.assertEqual(migrated['progress']['main']['read'], 1)
        self.assertEqual(migrated['settings']['batch_size'], 10)
        app.update_book({'path': 'WL1.json', 'word': 'minor', 'collection': 'main', 'revision': migrated['revision']}, classify=True)
        self.assertEqual(app.migrate_legacy(payload)['imported'], [])
        self.assertEqual(app.load_book('WL1.json')['easy_words'], [])

    def test_invalid_updates_and_traversal_leave_files_unchanged(self):
        self.make_book()
        before = (self.books / 'WL1.json').read_bytes()
        for payload in [
            {'path': '../outside.json', 'progress': {}},
            {'path': 'WL1.json', 'progress': {'main': {'read': -1}}},
            {'path': 'WL1.json', 'progress': {}, 'batch_size': 7},
        ]:
            with self.assertRaises(app.UserError):
                app.update_book({'revision': 0, **payload})
        self.assertEqual((self.books / 'WL1.json').read_bytes(), before)

    def test_memory_contexts_follow_the_word_through_moves_and_progress_saves(self):
        self.make_book()
        file = self.books / 'WL1.json'
        document = json.loads(file.read_text(encoding='utf-8'))
        detail = {'contexts': [
            {'pos': 'adj.', 'meaning': '轻微的', 'english': 'a minor mistake', 'chinese': '一个小错误'},
            {'pos': 'n.', 'meaning': '未成年人', 'english': 'protect minors', 'chinese': '保护未成年人'},
        ], 'note': '按常见义项练习'}
        document['word_details'] = {'minor': detail}
        file.write_text(json.dumps(document, ensure_ascii=False), encoding='utf-8')
        loaded = app.load_book('WL1.json')
        entry = next(entry for entry in loaded['words'] if entry['word'] == 'minor')
        self.assertEqual(entry['contexts'], detail['contexts'])
        self.assertEqual(entry['context_note'], detail['note'])
        app.update_book({'path': 'WL1.json', 'revision': 0, 'progress': {}})
        moved = app.update_book({'path': 'WL1.json', 'revision': 1, 'word': 'minor', 'collection': 'easy'}, classify=True)
        self.assertEqual(next(entry for entry in moved['words'] if entry['word'] == 'minor')['contexts'], detail['contexts'])
        app.update_book({'path': 'WL1.json', 'revision': 2, 'word': 'minor', 'collection': 'main'}, classify=True)
        self.assertEqual(json.loads(file.read_text(encoding='utf-8'))['word_details']['minor'], detail)

    def test_memory_contexts_are_optional_and_support_a_spelling_display_note(self):
        self.make_book()
        file = self.books / 'WL1.json'
        document = json.loads(file.read_text(encoding='utf-8'))
        document['word_details'] = {'minor': {'display_word': 'MINOR', 'contexts': [
            {'pos': 'adj.', 'meaning': '较小的', 'english': 'a MINOR problem', 'chinese': '一个小问题'},
        ]}}
        file.write_text(json.dumps(document), encoding='utf-8')
        entries = {entry['word']: entry for entry in app.load_book('WL1.json')['words']}
        self.assertEqual(entries['minor']['word'], 'minor')
        self.assertEqual(entries['minor']['context_headword'], 'MINOR')
        self.assertEqual(entries['faithful']['contexts'], [])
        self.assertEqual(entries['faithful']['context_note'], '')

    def test_invalid_memory_contexts_report_the_field_without_overwriting_the_file(self):
        self.make_book()
        file = self.books / 'WL1.json'
        document = json.loads(file.read_text(encoding='utf-8'))
        document['word_details'] = {'minor': {'contexts': [{'english': 'a minor mistake'}]}}
        file.write_text(json.dumps(document), encoding='utf-8')
        before = file.read_bytes()
        with self.assertRaises(app.UserError) as caught:
            app.load_book('WL1.json')
        self.assertIn('chinese', caught.exception.message)
        self.assertEqual(file.read_bytes(), before)

    def test_global_search_deduplicates_all_collections_without_rewriting_books(self):
        folder = self.books / 'exam'
        folder.mkdir()
        for name, words, easy in [('WL10', [], ['ＭＩＮＯＲ']), ('WL2', ['minor', 'inference'], [])]:
            app.write_document(folder / (name + '.json'), {'words': words, 'easy_words': easy, 'progress': {'main': {'read': 1}}, 'revision': 3})
        before = {path: path.read_bytes() for path in self.books.rglob('*.json')}
        result = app.search_wordbooks(' Minor ')
        self.assertEqual((result['books'], result['occurrences'], result['unique_words'], result['total']), (2, 3, 2, 1))
        self.assertEqual(result['results'][0]['word'], 'minor')
        self.assertEqual([(source['path'], source['collection']) for source in result['results'][0]['sources']],
                         [('exam/WL2.json', 'main'), ('exam/WL10.json', 'easy')])
        self.assertEqual(result['results'][0]['translation'], '较小的')
        self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_global_search_ranks_exact_then_prefix_then_other_substrings(self):
        (self.books / 'sample.txt').write_text('stake\nundertake\ntakeoff\nTAKE\ntaken\novertake\n', encoding='utf-8')
        result = app.search_wordbooks('TaKe')
        self.assertEqual([entry['word'] for entry in result['results']], ['TAKE', 'taken', 'takeoff', 'overtake', 'stake', 'undertake'])
        self.assertEqual([entry['match'] for entry in result['results']], ['exact', 'prefix', 'prefix', 'contains', 'contains', 'contains'])
        self.assertTrue((self.books / 'sample.txt').exists())
        self.assertFalse((self.books / 'sample.json').exists())

    def test_global_search_matches_related_words_and_literal_fragments(self):
        (self.books / 'sample.txt').write_text('infer\ninference\ntechnology\ntechnical\npolytechnic\npetition\ncompetition\n', encoding='utf-8')
        self.assertEqual([entry['word'] for entry in app.search_wordbooks('infer')['results']], ['infer', 'inference'])
        self.assertEqual([entry['word'] for entry in app.search_wordbooks('TECH')['results']], ['technical', 'technology', 'polytechnic'])
        self.assertEqual([entry['word'] for entry in app.search_wordbooks('petition')['results']], ['petition', 'competition'])
        self.assertEqual(app.search_wordbooks('.*')['total'], 0)

    def test_global_search_lists_all_words_and_paginates_after_deduplication(self):
        self.make_book()
        (self.books / 'WL2.txt').write_text('MINOR\ninfer\n', encoding='utf-8')
        first, second = app.search_wordbooks('', limit=2), app.search_wordbooks('', offset=2, limit=2)
        self.assertEqual(first['total'], 4)
        self.assertEqual([entry['word'] for entry in first['results'] + second['results']], ['contagious', 'faithful', 'infer', 'minor'])
        self.assertEqual(app.search_wordbooks('', offset=10)['results'], [])
        for arguments in ({'offset': -1}, {'limit': 0}, {'limit': 101}, {'query': 'a' * 201}):
            with self.assertRaises(app.UserError):
                app.search_wordbooks(**arguments)

    def test_global_search_refreshes_sources_and_external_file_changes(self):
        self.make_book()
        self.assertEqual(app.search_wordbooks('minor')['results'][0]['sources'][0]['collection'], 'main')
        app.update_book({'path': 'WL1.json', 'word': 'minor', 'collection': 'easy', 'revision': 0}, classify=True)
        self.assertEqual(app.search_wordbooks('minor')['results'][0]['sources'][0]['collection'], 'easy')
        (self.books / 'new.txt').write_text('newword\n', encoding='utf-8')
        self.assertEqual(app.search_wordbooks('newword')['total'], 1)
        (self.books / 'new.txt').unlink()
        self.assertEqual(app.search_wordbooks('newword')['total'], 0)

    def test_global_search_skips_hidden_and_broken_books_and_works_without_dictionary(self):
        (self.books / 'valid.txt').write_text('infer\n', encoding='utf-8')
        (self.books / '.backup.txt').write_text('privateword\n', encoding='utf-8')
        hidden = self.books / '.backup'
        hidden.mkdir()
        (hidden / 'old.txt').write_text('privateword\n', encoding='utf-8')
        (self.books / 'broken.json').write_text('{', encoding='utf-8')
        with patch.object(app, 'DICT_PATH', self.root / 'missing.db'):
            result = app.search_wordbooks('infer')
        self.assertEqual((result['books'], result['unique_words'], result['total']), (1, 1, 1))
        self.assertEqual(result['errors'][0]['path'], 'broken.json')
        self.assertEqual(app.search_wordbooks('privateword')['total'], 0)


if __name__ == '__main__':
    unittest.main()
