"""Small, read-only Open English WordNet adapter; no third-party dependencies."""
from __future__ import annotations

import gzip
import hashlib
import os
import sqlite3
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
from contextlib import closing
from functools import lru_cache
from pathlib import Path

SOURCE_URL = "https://en-word.net/"
DOWNLOAD_URL = "https://en-word.net/static/english-wordnet-2025-plus.xml.gz"
DOWNLOAD_SHA256 = "31f4af16c54b532fd5484d4cc33aee588a31bb5b70683ae8197842fde5b586bc"
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"
DEFAULT_PATH = Path(__file__).resolve().parent / "data" / "wordnet.db"


def normalize_word(word):
    return " ".join(unicodedata.normalize("NFKC", word).replace("’", "'").replace("‘", "'").strip().split()).casefold()


def build_database(source, destination):
    """Index official GWN-LMF XML, retaining definitions and synonyms, not examples."""
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".wordnet-", suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
    entries = senses = synsets = 0
    metadata = {}
    try:
        with closing(sqlite3.connect(temporary)) as conn:
            conn.executescript("""
                PRAGMA journal_mode=OFF;
                PRAGMA synchronous=OFF;
                CREATE TABLE entries(id INTEGER PRIMARY KEY, lemma TEXT NOT NULL, pos TEXT NOT NULL);
                CREATE TABLE forms(word_key TEXT NOT NULL, entry_id INTEGER NOT NULL,
                    PRIMARY KEY(word_key, entry_id)) WITHOUT ROWID;
                CREATE TABLE senses(entry_id INTEGER NOT NULL, synset_id TEXT NOT NULL, rank INTEGER NOT NULL,
                    PRIMARY KEY(entry_id, synset_id)) WITHOUT ROWID;
                CREATE TABLE synsets(id TEXT PRIMARY KEY, definition TEXT NOT NULL) WITHOUT ROWID;
                CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
            """)
            conn.execute("BEGIN")
            opener = gzip.open if source.suffix == ".gz" else open
            with opener(source, "rb") as stream:
                for _, node in ET.iterparse(stream, events=("end",)):
                    if node.tag == "LexicalEntry":
                        lemma = node.find("Lemma")
                        if lemma is None or not lemma.get("writtenForm"):
                            raise ValueError("Missing WordNet lemma")
                        entries += 1
                        conn.execute("INSERT INTO entries VALUES (?, ?, ?)", (entries, lemma.get("writtenForm"), lemma.get("partOfSpeech", "")))
                        forms = {normalize_word(form.get("writtenForm", "")) for form in [lemma, *node.findall("Form")]}
                        conn.executemany("INSERT OR IGNORE INTO forms VALUES (?, ?)", [(form, entries) for form in forms if form])
                        rows = [(entries, sense.get("synset"), rank) for rank, sense in enumerate(node.findall("Sense"))]
                        conn.executemany("INSERT OR IGNORE INTO senses VALUES (?, ?, ?)", rows)
                        senses += len(rows)
                        node.clear()
                    elif node.tag == "Synset":
                        definition = " ".join(" ".join(node.find("Definition").itertext()).split()) if node.find("Definition") is not None else ""
                        conn.execute("INSERT INTO synsets VALUES (?, ?)", (node.get("id"), definition))
                        synsets += 1
                        node.clear()
                    elif node.tag == "Lexicon":
                        metadata = dict(node.attrib)
            if not entries or not synsets or metadata.get("id") != "oewn":
                raise ValueError("Not an Open English WordNet GWN-LMF lexicon")
            if conn.execute("SELECT COUNT(*) FROM senses LEFT JOIN synsets ON senses.synset_id=synsets.id WHERE synsets.id IS NULL").fetchone()[0]:
                raise ValueError("WordNet contains unresolved sense references")
            conn.execute("CREATE INDEX sense_synset ON senses(synset_id)")
            metadata.update(schema_version="1", source=DOWNLOAD_URL, source_sha256=hashlib.sha256(source.read_bytes()).hexdigest())
            conn.executemany("INSERT INTO metadata VALUES (?, ?)", metadata.items())
            conn.commit()
            if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("WordNet database integrity check failed")
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {"entries": entries, "senses": senses, "synsets": synsets, "version": metadata.get("version"), "bytes": destination.stat().st_size}


def lookup(word, database=DEFAULT_PATH):
    path = Path(database)
    try:
        stamp = path.stat()
    except OSError:
        return {"available": False, "found": False, "senses": [], "message": "未安装补充词库，当前仅显示 ECDICT。"}
    try:
        return _lookup(path.resolve().as_uri(), stamp.st_mtime_ns, stamp.st_size, normalize_word(word))
    except sqlite3.Error:
        return {"available": False, "found": False, "senses": [], "message": "补充词库无法读取，请重新安装 Open English WordNet。"}


@lru_cache(maxsize=8192)
def _lookup(uri, modified, size, key):
    with closing(sqlite3.connect(uri + "?mode=ro", uri=True)) as conn:
        rows = conn.execute("""
            SELECT synsets.id, synsets.definition, entries.lemma, entries.pos
            FROM forms JOIN entries ON forms.entry_id=entries.id
            JOIN senses ON entries.id=senses.entry_id JOIN synsets ON senses.synset_id=synsets.id
            WHERE forms.word_key=?
            ORDER BY CASE entries.pos WHEN 'n' THEN 0 WHEN 'v' THEN 1 WHEN 'a' THEN 2 WHEN 's' THEN 2 ELSE 3 END,
                entries.id, senses.rank
        """, (key,)).fetchall()
        meanings, seen = [], set()
        for identity, definition, lemma, pos in rows:
            if identity in seen:
                continue
            seen.add(identity)
            synonyms = conn.execute("SELECT DISTINCT lemma FROM senses JOIN entries ON senses.entry_id=entries.id WHERE synset_id=? ORDER BY lemma", (identity,)).fetchall()
            meanings.append({"id": identity, "pos": pos, "definition": definition, "lemma": lemma,
                             "synonyms": [row[0] for row in synonyms if normalize_word(row[0]) not in {key, normalize_word(lemma)}]})
        version = conn.execute("SELECT value FROM metadata WHERE key='version'").fetchone()
    return {"available": True, "found": bool(meanings), "source": "Open English WordNet", "version": version[0] if version else "",
            "url": SOURCE_URL, "license": LICENSE_URL, "senses": meanings}
