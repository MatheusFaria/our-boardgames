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

## BGG API sync

As an alternative to the CSV exports, you can fetch collections directly from the BGG XML API2. This also populates image and thumbnail URLs that the CSV export leaves empty.

You'll need a BGG API Bearer token (register your application at https://boardgamegeek.com/applications). Save it to a `.env` file:

```bash
echo "BGG_TOKEN=your-token-here" > .env
```

Then run:

```bash
source .env && python3 scripts/fetch_bgg_collections.py
```

Usernames are discovered automatically from the CSV filenames in `collections/`. You can also pass them explicitly (no CSV files needed):

```bash
source .env && python3 scripts/fetch_bgg_collections.py --usernames alice bob carol
```

## GitHub Actions sync

The repository includes a GitHub Actions workflow at `.github/workflows/sync-collection.yml`.
It regenerates `data/collection.json` and commits the updated snapshot when the CSV files or sync script change.
It can also be run manually from the Actions tab and runs on a daily schedule.
