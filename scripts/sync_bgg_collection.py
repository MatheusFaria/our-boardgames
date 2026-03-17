#!/usr/bin/env python3
"""Normalize a local BGG collection CSV export into a static JSON snapshot."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_USERNAME = "JoyfulFicus"
DEFAULT_INPUT = Path("collections/JoyfulFicus.csv")
DEFAULT_OUTPUT = Path("data/joyfulficus-collection.json")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Sync a local BoardGameGeek collection CSV export into static JSON."
    )
    parser.add_argument("--username", default=DEFAULT_USERNAME)
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    return parser


def text_or_none(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def int_or_none(value: str | None) -> int | None:
    value = text_or_none(value)
    if value in (None, "N/A"):
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def float_or_none(value: str | None) -> float | None:
    value = text_or_none(value)
    if value in (None, "N/A"):
        return None
    try:
        return round(float(value), 2)
    except ValueError:
        return None


def bool_from_export(value: str | None) -> bool:
    return text_or_none(value) == "1"


def build_bgg_link(object_id: int | None) -> str | None:
    if object_id is None:
        return None
    return f"https://boardgamegeek.com/boardgame/{object_id}"


def normalize_row(row: dict[str, str]) -> dict[str, object]:
    object_id = int_or_none(row.get("objectid"))
    wishlist = bool_from_export(row.get("wishlist"))
    want = bool_from_export(row.get("want"))
    want_to_buy = bool_from_export(row.get("wanttobuy"))
    want_to_play = bool_from_export(row.get("wanttoplay"))

    return {
        "objectId": object_id,
        "subtype": text_or_none(row.get("objecttype")) or "thing",
        "collId": int_or_none(row.get("collid")),
        "name": text_or_none(row.get("objectname")),
        "yearPublished": int_or_none(row.get("yearpublished")),
        "image": None,
        "thumbnail": None,
        "link": build_bgg_link(object_id),
        "numPlays": int_or_none(row.get("numplays")),
        "comment": text_or_none(row.get("comment")),
        "owned": bool_from_export(row.get("own")),
        "previouslyOwned": bool_from_export(row.get("prevowned")),
        "forTrade": bool_from_export(row.get("fortrade")),
        "want": want,
        "wantInTrade": want,
        "wantToPlay": want_to_play,
        "wantToBuy": want_to_buy,
        "wishlist": wishlist,
        "preordered": bool_from_export(row.get("preordered")),
        "wishlistPriority": int_or_none(row.get("wishlistpriority")),
        "userRating": float_or_none(row.get("rating")),
        "bggAverageRating": float_or_none(row.get("average")),
        "bggBayesAverageRating": float_or_none(row.get("baverage")),
        "bggRank": int_or_none(row.get("rank")),
        "weight": float_or_none(row.get("avgweight")),
        "minPlayers": int_or_none(row.get("minplayers")),
        "maxPlayers": int_or_none(row.get("maxplayers")),
        "playingTime": int_or_none(row.get("playingtime")),
        "languageDependence": text_or_none(row.get("bgglanguagedependence")),
        "bestPlayers": text_or_none(row.get("bggbestplayers")),
        "recommendedPlayers": text_or_none(row.get("bggrecplayers")),
        "recommendedAge": text_or_none(row.get("bggrecagerange")),
        "itemType": text_or_none(row.get("itemtype")),
        "versionNickname": text_or_none(row.get("version_nickname")),
    }


def normalize_collection(username: str, csv_path: Path) -> dict[str, object]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    items = [normalize_row(row) for row in rows]
    items.sort(key=lambda item: ((item["name"] or "").lower(), item["objectId"] or 0))

    return {
        "username": username,
        "sourceLabel": "BGG collection CSV export",
        "sourceUrl": str(csv_path),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "itemCount": len(items),
        "items": items,
    }


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        parser.error(f"input CSV not found: {input_path}")

    snapshot = normalize_collection(args.username, input_path)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )

    print(f"Wrote {snapshot['itemCount']} items to {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
