"""Local word-book browser and read-only ECDICT adapter. Python 3.10+."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import unicodedata
import webbrowser
from contextlib import closing
from functools import lru_cache
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

BASE = Path(__file__).resolve().parent
BOOK_ROOT = BASE / "words"
DICT_PATH = Path(os.environ.get("WORDROOM_DICT", r"D:\My_Codes\MyEnglishApp\data\dict.db"))
STATIC = BASE / "static"
SUPPORTED = {".txt", ".csv", ".tsv", ".json"}
BOOK_LOCK = threading.RLock()


class UserError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def resolve_book(relative=""):
    path = (BOOK_ROOT / relative).resolve()
    if not path.is_relative_to(BOOK_ROOT.resolve()):
        raise UserError("只能访问单词本目录内的文件。", 403)
    if not path.exists():
        raise UserError("单词本已移动或不存在，请刷新目录。", 404)
    return path


def read_text(path):
    data = path.read_bytes()
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            pass
    raise UserError("文件编码无法识别，请保存为 UTF-8。")


def read_words(path):
    if path.suffix.lower() not in SUPPORTED or not path.is_file():
        raise UserError("请选择 TXT、CSV、TSV 或 JSON 单词本。")
    content = read_text(path)
    try:
        if path.suffix.lower() == ".json":
            items = json.loads(content)
            if isinstance(items, dict):
                items = items.get("words", []) + items.get("easy_words", [])
            if not isinstance(items, list):
                raise ValueError("JSON must contain a list")
            values = [item.get("word", "") if isinstance(item, dict) else item for item in items]
        elif path.suffix.lower() in {".csv", ".tsv"}:
            rows = list(csv.reader(io.StringIO(content), delimiter="\t" if path.suffix.lower() == ".tsv" else ","))
            column = 0
            if rows:
                header = [value.strip().lower() for value in rows[0]]
                if any(value in {"word", "单词"} for value in header):
                    column = next(i for i, value in enumerate(header) if value in {"word", "单词"})
                    rows = rows[1:]
            values = [row[column] for row in rows if len(row) > column]
        else:
            values = [line.split("\t", 1)[0] for line in content.splitlines() if not line.lstrip().startswith("#")]
        words, seen = [], set()
        for value in values:
            if not isinstance(value, str):
                continue
            word = value.strip()
            if word and word.casefold() not in seen:
                words.append(word)
                seen.add(word.casefold())
        return words
    except (ValueError, TypeError, csv.Error) as exc:
        raise UserError("单词本格式有误，请检查文件内容。") from exc


def natural_key(path):
    return tuple((1, int(part)) if part.isdigit() else (0, part.lower()) for part in re.split(r"(\d+)", path.name))


def word_key(word):
    return " ".join(unicodedata.normalize("NFKC", word).strip().replace("’", "'").replace("‘", "'").split()).casefold()


def word_list(values):
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise UserError("words 和 easy_words 必须是单词字符串数组。")
    result, seen = [], set()
    for value in values:
        word = value.strip()
        key = word_key(word)
        if key and key not in seen:
            result.append(word)
            seen.add(key)
    return result


def write_document(path, document):
    """Replace a complete JSON file atomically; never expose a partial write."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent, prefix="." + path.name + ".", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def read_document(path):
    try:
        document = json.loads(read_text(path))
    except ValueError as exc:
        raise UserError("单词本 JSON 格式有误，请检查文件。") from exc
    if not isinstance(document, dict) or "easy_words" not in document:
        raise UserError("请先将旧词表转换为包含 words 和 easy_words 的 JSON。")
    easy = word_list(document.get("easy_words"))
    easy_keys = {word_key(word) for word in easy}
    main_words = [word for word in word_list(document.get("words")) if word_key(word) not in easy_keys]
    return {**document, "version": 2, "words": main_words, "easy_words": easy,
            "progress": document.get("progress") if isinstance(document.get("progress"), dict) else {},
            "settings": document.get("settings") if isinstance(document.get("settings"), dict) else {},
            "revision": document.get("revision", 0)}


def ensure_json_book(relative):
    """Import legacy lists, retaining the originals in a local backup directory."""
    with BOOK_LOCK:
        requested = BOOK_ROOT / relative
        if not requested.exists() and requested.suffix.lower() in SUPPORTED:
            requested = requested.with_suffix(".json")
        path = resolve_book(str(requested))
        if path.suffix.lower() not in SUPPORTED or not path.is_file():
            raise UserError("请选择单词本文件。")
        if path.suffix.lower() == ".json":
            try:
                parsed = json.loads(read_text(path))
            except ValueError as exc:
                raise UserError("单词本 JSON 格式有误，请检查文件。") from exc
            if isinstance(parsed, dict) and "easy_words" in parsed:
                read_document(path)
                return path
        target = path.with_suffix(".json")
        if target != path and target.exists():
            raise UserError(f"{path.name} 与同名 JSON 同时存在，请先确认要保留的词表。", 409)
        words = read_words(path)
        backup = BOOK_ROOT.parent / ".runtime" / "wordbook-backup" / path.relative_to(BOOK_ROOT)
        backup.parent.mkdir(parents=True, exist_ok=True)
        if not backup.exists():
            shutil.copy2(path, backup)
        document = {"version": 2, "words": words, "easy_words": [], "progress": {}, "settings": {"batch_size": 1}, "revision": 0}
        write_document(target, document)
        if target != path:
            # resolve_book has already verified this exact path belongs to BOOK_ROOT.
            path.unlink()
        return target


def convert_wordbooks():
    for path in sorted(BOOK_ROOT.rglob("*")):
        if path.is_file() and path.suffix.lower() in SUPPORTED and not any(part.startswith(".") for part in path.relative_to(BOOK_ROOT).parts):
            try:
                ensure_json_book(path.relative_to(BOOK_ROOT).as_posix())
            except (UserError, OSError) as exc:
                print(f"Cannot import {path.name}: {getattr(exc, 'message', str(exc))}", flush=True)


def validate_progress(value, words):
    if not isinstance(value, dict):
        raise UserError("学习进度格式有误。")
    allowed = {word_key(word): word for word in words}
    def order(field, fallback):
        raw = value.get(field, fallback)
        if not isinstance(raw, list) or any(not isinstance(word, str) for word in raw):
            raise UserError("进度中的单词顺序格式有误。")
        return word_list(raw)
    saved_order = order("order", words)
    reading_order = order("read_order", saved_order)
    # Keep the previous identities, including recently moved words, so the client
    # can remap a cursor and checked answers rather than transferring their history.
    result = {"order": saved_order, "read_order": reading_order}
    for field, length in (("read", len(reading_order)), ("learn", len(saved_order))):
        cursor = value.get(field, 0)
        if type(cursor) is not int or cursor < 0 or cursor > length:
            raise UserError("学习位置超出单词本范围。")
        result[field] = cursor
    for field in ("correct", "attempted"):
        raw = value.get(field, [])
        if not isinstance(raw, list) or any(type(index) is not int or index < 0 or index >= len(saved_order) for index in raw):
            raise UserError("已检查单词的进度格式有误。")
        result[field] = list(dict.fromkeys(raw))
    batch = value.get("batch")
    if batch is not None:
        if not isinstance(batch, dict) or batch.get("size") not in (5, 10) or not isinstance(batch.get("rows"), list) or len(batch["rows"]) > 10:
            raise UserError("批量练习进度格式有误。")
        if not isinstance(batch.get("startWord"), str) or any(not isinstance(row, dict) or not isinstance(row.get("word"), str) or not isinstance(row.get("answer", ""), str) for row in batch["rows"]):
            raise UserError("批量练习中的单词格式有误。")
        result["batch"] = batch
    if any(len(word) > 500 for word in saved_order + reading_order) or len(saved_order) > max(100000, len(allowed) * 2):
        raise UserError("学习进度过大。")
    return result


def file_token(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_revision(document, expected, path, token=None):
    if type(expected) is not int or expected != document["revision"] or (token is not None and token != file_token(path)):
        raise UserError("词本已被其他页面或同步操作更新。请刷新后重试，避免覆盖新进度。", 409)


def update_book(payload, classify=False):
    with BOOK_LOCK:
        path = ensure_json_book(payload.get("path", ""))
        document = read_document(path)
        check_revision(document, payload.get("revision"), path, payload.get("etag"))
        if classify:
            word, collection = payload.get("word"), payload.get("collection")
            if not isinstance(word, str) or collection not in ("main", "easy"):
                raise UserError("请选择要移动的单词和目标词本。")
            key = word_key(word)
            all_words = document["words"] + document["easy_words"]
            actual = next((item for item in all_words if word_key(item) == key), None)
            if actual is None:
                raise UserError("这个单词已不在当前词本中，请刷新。", 404)
            target = "easy_words" if collection == "easy" else "words"
            if not any(word_key(item) == key for item in document[target]):
                document["words"] = [item for item in document["words"] if word_key(item) != key]
                document["easy_words"] = [item for item in document["easy_words"] if word_key(item) != key]
                document[target].append(actual)
        else:
            incoming = payload.get("progress")
            if not isinstance(incoming, dict) or any(key not in ("main", "easy") for key in incoming):
                raise UserError("学习进度格式有误。")
            for collection, value in incoming.items():
                words = document["words"] if collection == "main" else document["easy_words"]
                document["progress"][collection] = validate_progress(value, words)
            size = payload.get("batch_size", document["settings"].get("batch_size", 1))
            if type(size) is not int or size not in (1, 5, 10):
                raise UserError("每组单词数应为 1、5 或 10。")
            document["settings"]["batch_size"] = size
        document["revision"] += 1
        write_document(path, document)
        relative = path.relative_to(BOOK_ROOT).as_posix()
        return load_book(relative) if classify else {"path": relative, "revision": document["revision"], "etag": file_token(path)}


def migrate_legacy(payload):
    easy_map, progress_map = payload.get("easy_words", {}), payload.get("progress", {})
    if not isinstance(easy_map, dict) or not isinstance(progress_map, dict):
        raise UserError("旧版浏览器数据格式有误。")
    paths = set(easy_map)
    paths.update(key.rsplit(":", 2)[0] if key.endswith(":easy") else key.rsplit(":", 1)[0] for key in progress_map)
    imported, skipped = [], []
    with BOOK_LOCK:
        for relative in sorted(paths):
            try:
                path = ensure_json_book(relative)
            except UserError:
                skipped.append(relative)
                continue
            document = read_document(path)
            if document.get("legacy_imported") or document["revision"] > 0 or document["progress"] or document["easy_words"]:
                skipped.append(relative)
                continue
            aliases = {path.relative_to(BOOK_ROOT).with_suffix(suffix).as_posix() for suffix in SUPPORTED}
            all_words = document["words"] + document["easy_words"]
            saved_easy = [word for alias in aliases if isinstance(easy_map.get(alias), list) for word in easy_map[alias] if isinstance(word, str)]
            easy_keys = {word_key(word) for word in saved_easy}
            document["words"] = [word for word in all_words if word_key(word) not in easy_keys]
            document["easy_words"] = [word for word in all_words if word_key(word) in easy_keys]
            for collection in ("main", "easy"):
                candidates = [value for key, value in progress_map.items() if isinstance(value, dict) and any(key.startswith(alias + ":") for alias in aliases) and key.endswith(":easy") == (collection == "easy")]
                if candidates:
                    document["progress"][collection] = validate_progress(candidates[-1], all_words)
            size = payload.get("batch_size", 1)
            document["settings"]["batch_size"] = size if type(size) is int and size in (1, 5, 10) else 1
            document["legacy_imported"] = True
            document["revision"] += 1
            write_document(path, document)
            imported.append(path.relative_to(BOOK_ROOT).as_posix())
    return {"imported": imported, "skipped": skipped}


def browse(relative):
    directory = resolve_book(relative)
    if not directory.is_dir():
        raise UserError("请选择文件夹。")
    import_errors = {}
    with BOOK_LOCK:
        for candidate in list(directory.iterdir()):
            if candidate.is_file() and not candidate.name.startswith(".") and candidate.suffix.lower() in SUPPORTED:
                try:
                    ensure_json_book(candidate.relative_to(BOOK_ROOT).as_posix())
                except (UserError, OSError) as exc:
                    import_errors[candidate.name] = getattr(exc, 'message', '词本无法转换，请检查文件是否可写。')
    entries = []
    for path in sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), natural_key(p))):
        if path.name.startswith(".") or not path.resolve().is_relative_to(BOOK_ROOT.resolve()):
            continue
        if not path.is_dir() and path.suffix.lower() not in SUPPORTED:
            continue
        entry = {"name": path.name, "path": path.relative_to(BOOK_ROOT).as_posix(), "type": "folder" if path.is_dir() else "book"}
        if path.is_file():
            try:
                if path.name in import_errors:
                    raise UserError(import_errors[path.name])
                document = read_document(path) if path.suffix.lower() == ".json" else None
                entry["count"] = len(document["words"]) + len(document["easy_words"]) if document else len(read_words(path))
                entry["easy_count"] = len(document["easy_words"]) if document else 0
            except UserError as exc:
                entry["error"] = exc.message
        entries.append(entry)
    return {"path": "" if directory == BOOK_ROOT else directory.relative_to(BOOK_ROOT).as_posix(), "entries": entries}


@lru_cache(maxsize=8192)
def lookup(word):
    if not DICT_PATH.is_file():
        raise UserError("未找到词典数据库，请在启动时指定 --dict 路径。", 503)
    try:
        with closing(sqlite3.connect(DICT_PATH.resolve().as_uri() + "?mode=ro", uri=True)) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT word, phonetic, definition, translation, collins, tag, exchange FROM stardict WHERE word = ? COLLATE NOCASE LIMIT 1", (word,)).fetchone()
    except sqlite3.Error as exc:
        raise UserError("词典数据库无法读取，或不是支持的 ECDICT 格式。", 503) from exc
    if row is None:
        return {"word": word, "found": False, "translation": "词典中未找到这个词，请检查词表拼写。", "definition": "", "phonetic": "", "collins": 0, "tag": "", "exchange": ""}
    return {"found": True, **{key: row[key] or (0 if key == "collins" else "") for key in row.keys()}}


def load_book(relative):
    with BOOK_LOCK:
        path = ensure_json_book(relative)
        document = read_document(path)
        token = file_token(path)
    words = document["words"] + document["easy_words"]
    fingerprint = hashlib.sha256("\n".join(sorted(words, key=word_key)).encode()).hexdigest()[:16]
    return {"path": path.relative_to(BOOK_ROOT).as_posix(), "name": path.stem, "fingerprint": fingerprint,
            "words": [lookup(word) | {"word": word} for word in words], "easy_words": document["easy_words"],
            "progress": document["progress"], "settings": document["settings"], "revision": document["revision"], "etag": token}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            endpoint = urlsplit(self.path).path
            if endpoint not in ("/api/progress", "/api/classify", "/api/migrate"):
                raise UserError("接口不存在。", 404)
            origin = self.headers.get("Origin")
            if origin and origin != "http://" + self.headers.get("Host", ""):
                raise UserError("只允许本地学习页面修改词本。", 403)
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
                raise UserError("请使用 JSON 格式提交。", 415)
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2 * 1024 * 1024:
                raise UserError("保存内容为空或过大。", 413)
            try:
                payload = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeDecodeError) as exc:
                raise UserError("提交的 JSON 格式有误。") from exc
            if not isinstance(payload, dict) or (endpoint != "/api/migrate" and not isinstance(payload.get("path"), str)):
                raise UserError("保存内容格式有误。")
            result = migrate_legacy(payload) if endpoint == "/api/migrate" else update_book(payload, classify=endpoint == "/api/classify")
            self.send_json(result)
        except UserError as exc:
            self.send_json({"error": exc.message}, exc.status)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:
            print(f"Save error: {type(exc).__name__}: {exc}")
            self.send_json({"error": "保存失败，请检查词本 JSON 是否可写，然后重试。"}, 500)

    def do_GET(self):
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/browse":
                return self.send_json(browse(query.get("path", [""])[0]))
            if parsed.path == "/api/book":
                return self.send_json(load_book(query.get("path", [""])[0]))
            if parsed.path == "/api/status":
                return self.send_json({"dictionary": DICT_PATH.is_file(), "book_root": str(BOOK_ROOT), "dictionary_name": "ECDICT 英汉词典"})
            if parsed.path.startswith("/api/"):
                raise UserError("接口不存在。", 404)
            resource = "index.html" if parsed.path == "/" else unquote(parsed.path).lstrip("/")
            file = (STATIC / resource).resolve()
            if not file.is_relative_to(STATIC.resolve()) or not file.is_file():
                raise UserError("页面不存在。", 404)
            content_type = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml"}.get(file.suffix, "application/octet-stream")
            body = file.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
        except UserError as exc:
            self.send_json({"error": exc.message}, exc.status)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:
            print(f"Request error: {type(exc).__name__}: {exc}")
            self.send_json({"error": "读取失败，请检查文件后重试。"}, 500)


def main():
    global DICT_PATH, BOOK_ROOT
    parser = argparse.ArgumentParser(description="Wordroom local English learning website")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--dict", type=Path, default=DICT_PATH)
    parser.add_argument("--words", type=Path, default=BOOK_ROOT)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    DICT_PATH, BOOK_ROOT = args.dict.resolve(), args.words.resolve()
    if not BOOK_ROOT.is_dir():
        parser.error(f"Word-book folder does not exist: {BOOK_ROOT}")
    try:
        convert_wordbooks()
    except (UserError, OSError) as exc:
        parser.exit(1, f"Cannot convert word books: {getattr(exc, 'message', str(exc))}\n")
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        parser.exit(1, f"Cannot start on port {args.port}: {exc}\nTry --port 8766.\n")
    url = f"http://127.0.0.1:{args.port}"
    print(f"Wordroom is running: {url}\nKeep this process open. Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
