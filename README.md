# Our Boardgames

Static page that crawls throug BGG to aggrate the board games of specific users.

## Local snapshot sync

This site renders a checked-in BGG collection snapshot from `data/joyfulficus-collection.json`.
The snapshot is generated from a manual CSV export saved in `collections/`.

To refresh it from your local BGG export:

```bash
python3 scripts/sync_bgg_collection.py --username JoyfulFicus --input collections/JoyfulFicus.csv
```

To preview the site locally with JSON loading enabled:

```bash
python3 -m http.server
```
