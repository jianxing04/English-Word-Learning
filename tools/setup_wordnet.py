"""Download and index the pinned Open English WordNet release locally."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wordnet_dictionary import DEFAULT_PATH, DOWNLOAD_SHA256, DOWNLOAD_URL, build_database


def main():
    parser = argparse.ArgumentParser(description="Install Open English WordNet 2025+ for offline lookup")
    parser.add_argument("--output", type=Path, default=DEFAULT_PATH)
    parser.add_argument("--source", type=Path, help="Use an already downloaded official .xml.gz file")
    parser.add_argument("--force", action="store_true", help="Replace an existing local WordNet database")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() and not args.force:
        parser.exit(0, f"Already installed: {output}\nUse --force to rebuild.\n")
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(dir=output.parent, prefix=".wordnet-setup-") as folder:
            source = args.source or Path(folder) / "english-wordnet-2025-plus.xml.gz"
            if not args.source:
                print(f"Downloading {DOWNLOAD_URL}", flush=True)
                with urllib.request.urlopen(DOWNLOAD_URL, timeout=60) as response, source.open("wb") as stream:
                    while chunk := response.read(1024 * 1024):
                        stream.write(chunk)
            if hashlib.sha256(source.read_bytes()).hexdigest() != DOWNLOAD_SHA256:
                raise ValueError("Download checksum mismatch. Existing database has not been changed.")
            result = build_database(source, output)
            license_source = Path(__file__).resolve().parents[1] / "third_party" / "wordnet"
            license_target = output.parent / "wordnet-licenses"
            license_target.mkdir(exist_ok=True)
            for notice in license_source.iterdir():
                if notice.is_file():
                    shutil.copy2(notice, license_target / notice.name)
            print(json.dumps({"installed": str(output), **result}, ensure_ascii=True))
    except (OSError, ValueError) as exc:
        parser.exit(1, f"WordNet installation failed: {exc}\n")


if __name__ == "__main__":
    main()
