#!/usr/bin/env python3
"""Normalize local BGG collection CSV exports into one static JSON snapshot."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_INPUT_DIR = Path("collections")
DEFAULT_OUTPUT = Path("data/collection.json")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Sync local BoardGameGeek collection CSV exports into one static JSON snapshot."
    )
    parser.add_argument("--input-dir", default=str(DEFAULT_INPUT_DIR))
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


def extract_statuses(row: dict[str, str]) -> list[str]:
    wishlist = bool_from_export(row.get("wishlist"))
    want = bool_from_export(row.get("want"))

    status_pairs = [
        ("Owned", bool_from_export(row.get("own"))),
        ("Previously Owned", bool_from_export(row.get("prevowned"))),
        ("For Trade", bool_from_export(row.get("fortrade"))),
        ("Want in Trade", want),
        ("Want to Play", bool_from_export(row.get("wanttoplay"))),
        ("Want to Buy", bool_from_export(row.get("wanttobuy"))),
        ("Wishlist", wishlist),
        ("Preordered", bool_from_export(row.get("preordered"))),
    ]
    return [label for label, active in status_pairs if active]


def normalize_row(row: dict[str, str]) -> dict[str, object]:
    object_id = int_or_none(row.get("objectid"))
    return {
        "objectId": object_id,
        "subtype": text_or_none(row.get("objecttype")) or "thing",
        "collId": int_or_none(row.get("collid")),
        "name": text_or_none(row.get("objectname")),
        "yearPublished": int_or_none(row.get("yearpublished")),
        "image": None,
        "thumbnail": None,
        "link": build_bgg_link(object_id),
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
        "ownerStatuses": extract_statuses(row),
    }


def choose_value(current: object, candidate: object) -> object:
    if current in (None, "", 0):
        return candidate
    return current


def merge_item(existing: dict[str, object], candidate: dict[str, object], owner: str) -> None:
    for field in (
        "name",
        "yearPublished",
        "image",
        "thumbnail",
        "link",
        "bggAverageRating",
        "bggBayesAverageRating",
        "bggRank",
        "weight",
        "minPlayers",
        "maxPlayers",
        "playingTime",
        "languageDependence",
        "bestPlayers",
        "recommendedPlayers",
        "recommendedAge",
        "itemType",
        "versionNickname",
        "subtype",
    ):
        existing[field] = choose_value(existing.get(field), candidate.get(field))

    owners = existing.setdefault("owners", [])
    if owner not in owners:
        owners.append(owner)
        owners.sort(key=str.lower)

    owner_details = existing.setdefault("ownerDetails", [])
    owner_details.append(
        {
            "owner": owner,
            "statuses": candidate.get("ownerStatuses", []),
        }
    )
    owner_details.sort(key=lambda detail: str(detail["owner"]).lower())


def load_collection(csv_path: Path) -> list[dict[str, object]]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [normalize_row(row) for row in csv.DictReader(handle)]


def build_snapshot(input_dir: Path) -> dict[str, object]:
    csv_files = sorted(input_dir.glob("*.csv"), key=lambda path: path.name.lower())
    if not csv_files:
        raise FileNotFoundError(f"no CSV files found in {input_dir}")

    merged_by_id: dict[int, dict[str, object]] = {}
    owners: list[str] = []
    source_files: list[str] = []

    for csv_path in csv_files:
        owner = csv_path.stem
        owners.append(owner)
        source_files.append(str(csv_path))

        for item in load_collection(csv_path):
            object_id = item.get("objectId")
            if object_id is None:
                continue

            existing = merged_by_id.get(object_id)
            if existing is None:
                merged_by_id[object_id] = {
                    **item,
                    "owners": [owner],
                    "ownerDetails": [
                        {
                            "owner": owner,
                            "statuses": item.get("ownerStatuses", []),
                        }
                    ],
                }
                continue

            merge_item(existing, item, owner)

    items = sorted(
        merged_by_id.values(),
        key=lambda item: ((item.get("name") or "").lower(), item.get("objectId") or 0),
    )
    for item in items:
        item.pop("ownerStatuses", None)

    return {
        "owners": sorted(owners, key=str.lower),
        "sourceLabel": "BGG collection CSV exports",
        "sourceFiles": source_files,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "itemCount": len(items),
        "items": items,
    }


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    if not input_dir.exists():
        parser.error(f"input directory not found: {input_dir}")

    snapshot = build_snapshot(input_dir)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )

    print(
        "Wrote "
        f"{snapshot['itemCount']} merged items from {len(snapshot['sourceFiles'])} files to {output_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
