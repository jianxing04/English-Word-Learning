# Open English WordNet data attribution

This application uses **Open English WordNet 2025+**, developed by the Open
English WordNet team and derived from **Princeton University WordNet**.

- Resource: https://en-word.net/
- Source: https://github.com/globalwordnet/english-wordnet/tree/2025-edition
- Download: https://en-word.net/static/english-wordnet-2025-plus.xml.gz
- License: Creative Commons Attribution 4.0 International, with the underlying
  Princeton WordNet notices retained; see the license texts in this directory.

The setup script converts the GWN-LMF XML distribution into a local SQLite
index. It retains English definitions, word forms, part-of-speech information,
and synonym membership; examples and other lexical relations are omitted.
Definition text is not rewritten or translated by this application.

The dictionary database and downloaded archive are local installation data and
are not included in this Git repository. The original license texts are bundled
with the application and copied beside the installed dictionary.
