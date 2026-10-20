"""Optional local transformer inference, isolated from the lightweight web server."""
from __future__ import annotations

import json
import os
import subprocess
import threading
from functools import lru_cache
from pathlib import Path

BASE = Path(__file__).resolve().parent
ENVIRONMENT = BASE / '.runtime' / 'article-env'
MAX_CHARACTERS = 60000
ANALYSIS_LOCK = threading.Lock()


class ArticleError(Exception):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


def environment_python():
    return ENVIRONMENT / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def status():
    packages = ENVIRONMENT / ('Lib/site-packages' if os.name == 'nt' else f'lib/python{os.sys.version_info.major}.{os.sys.version_info.minor}/site-packages')
    ready = environment_python().is_file() and any(packages.glob('en_core_web_trf/*/meta.json'))
    return {'available': ready, 'engine': 'spaCy en_core_web_trf', 'model_version': '3.8.0',
            'max_characters': MAX_CHARACTERS, 'setup': 'python tools/setup_article_nlp.py'}


def analyze(text, dictionary_path):
    if not isinstance(text, str) or not text.strip():
        raise ArticleError('请先粘贴英文文章。')
    if len(text) > MAX_CHARACTERS:
        raise ArticleError('每次最多添加 60,000 个字符，请将长文章分批添加。')
    if not status()['available']:
        raise ArticleError('尚未安装文章解析模型，请在项目目录运行 python tools/setup_article_nlp.py。')
    # Model loading/inference happens only on article import, never on ordinary study.
    with ANALYSIS_LOCK:
        return _analyze(text, str(dictionary_path))


@lru_cache(maxsize=4)
def _analyze(text, dictionary_path):
    try:
        completed = subprocess.run([str(environment_python()), str(BASE / 'tools' / 'article_worker.py')],
                                   input=json.dumps({'text': text, 'dictionary': dictionary_path}),
                                   capture_output=True, text=True, encoding='utf-8', timeout=180,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if completed.returncode:
            (BASE / '.runtime' / 'article-model-error.log').write_text(completed.stderr[-12000:], encoding='utf-8')
            raise ArticleError('文章解析失败，请检查模型安装或将文章分段后重试。')
        result = json.loads(completed.stdout)
        if not result.get('words'):
            raise ArticleError('文章中未识别到英文词汇，请检查粘贴的内容。', 400)
        return result
    except subprocess.TimeoutExpired as exc:
        raise ArticleError('文章解析超时，请将文章分段后重试。') from exc
    except (OSError, ValueError) as exc:
        raise ArticleError('文章解析模型无法运行，请重新运行 python tools/setup_article_nlp.py。') from exc
