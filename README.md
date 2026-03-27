# Our Boardgames

Static page that aggregates board game collections from local BoardGameGeek CSV exports.

## Local snapshot sync

This site renders a checked-in combined BGG collection snapshot from `data/collection.json`.
The snapshot is generated from every CSV export saved in `collections/`.
Each CSV filename is treated as the collection owner's username.

To refresh it from your local CSV exports:

```bash
python3 scripts/sync_bgg_collection.py
```

To preview the site locally with JSON loading enabled:

```bash
python3 -m http.server
```

## GitHub Actions sync

The repository includes a GitHub Actions workflow at `.github/workflows/sync-collection.yml`.
It regenerates `data/collection.json` and commits the updated snapshot when the CSV files or sync script change.
It can also be run manually from the Actions tab and runs on a daily schedule.
