"""Install the optional English transformer pipeline without changing global Python."""
from pathlib import Path
import argparse
import hashlib
import os
import subprocess
import sys
import venv


def main():
    parser = argparse.ArgumentParser(description='Install the optional local English transformer pipeline')
    parser.add_argument('--wheel', type=Path, help='Use an already downloaded official en_core_web_trf 3.8.0 wheel')
    args = parser.parse_args()
    if args.wheel and hashlib.sha256(args.wheel.read_bytes()).hexdigest() != '272a31e9d8530d1e075351d30a462d7e80e31da23574f1b274e200f3fff35bf5':
        parser.error('The wheel does not match the pinned official en_core_web_trf 3.8.0 release.')
    root = Path(__file__).resolve().parents[1]
    environment = root / '.runtime' / 'article-env'
    environment.parent.mkdir(exist_ok=True)
    venv.EnvBuilder(with_pip=True, system_site_packages=True).create(environment)
    python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    requirements = ['spacy==3.8.16', str(args.wheel.resolve())] if args.wheel else ['-r', str(root / 'requirements-article.txt')]
    subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '--index-url', 'https://pypi.org/simple', *requirements], check=True)
    subprocess.run([str(python), '-c', "import spacy; nlp=spacy.load('en_core_web_trf',exclude=['ner']); print('Article NLP ready:', nlp.meta['name'], nlp.meta['version'])"], check=True)
    print('Installed locally. Reading and spelling still run with your normal Python.')


if __name__ == '__main__':
    main()
