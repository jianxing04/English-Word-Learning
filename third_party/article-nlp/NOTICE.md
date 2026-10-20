# Optional English article pipeline

Article processing uses spaCy 3.8.16 with the official `en_core_web_trf` 3.8.0
English transformer pipeline. The model uses a RoBERTa encoder for its
contextual tagger and parser; lemmatization uses spaCy's English POS-dependent
rules and lookup tables. Wordroom adds POS-dependent comparative exceptions,
dictionary-checked hyphen handling, and source-span storage.

- Software: https://github.com/explosion/spaCy (MIT)
- Model release: https://github.com/explosion/spacy-models/releases/tag/en_core_web_trf-3.8.0 (MIT)
- Model documentation: https://spacy.io/models/en#en_core_web_trf
- Wheel SHA-256: `272a31e9d8530d1e075351d30a462d7e80e31da23574f1b274e200f3fff35bf5`

The setup script installs packages and weights into an ignored local environment.
They are not bundled in this repository. Upstream LICENSE and LICENSES_SOURCES
remain in the installed model package. The package's source notices describe
its training resources. User-pasted articles and their sentences are stored
in the user's vocabulary JSON files; the application does not provide a corpus.
