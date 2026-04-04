#!/usr/bin/env python3
"""Fetch BGG collections via the XML API2 and produce the same static JSON snapshot
as sync_bgg_collection.py.

Usernames are discovered automatically from CSV filenames in the collections/
directory (same convention as the CSV script), or passed explicitly via
--usernames.

No third-party dependencies — uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

DEFAULT_COLLECTIONS_DIR = Path("collections")
DEFAULT_OUTPUT = Path("data/collection.json")
BGG_API_BASE = "https://boardgamegeek.com/xmlapi2"

# BGG queues large collection requests asynchronously; we retry until ready.
QUEUE_RETRY_DELAY = 5   # seconds between retries
QUEUE_MAX_RETRIES = 12

# How many game IDs to include in a single /thing batch request.
THING_BATCH_SIZE = 10

# Polite delay between thing-API batch requests.
THING_BATCH_DELAY = 1.5  # seconds


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

_bearer_token: str | None = None


def _get(url: str) -> tuple[int, bytes]:
    req = Request(url)
    if _bearer_token:
        req.add_header("Authorization", f"Bearer {_bearer_token}")
    try:
        with urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except HTTPError as exc:
        return exc.code, exc.read() or b""


def fetch_xml(url: str, description: str) -> ET.Element:
    """GET *url*, handle BGG's 202-queued pattern, return parsed XML root."""
    print(f"  {description}...", end=" ", flush=True)
    for attempt in range(QUEUE_MAX_RETRIES):
        status, body = _get(url)
        if status == 200:
            print("OK")
            return ET.fromstring(body)
        if status == 202:
            wait = QUEUE_RETRY_DELAY * (attempt + 1)
            print(f"queued, retry in {wait}s...", end=" ", flush=True)
            time.sleep(wait)
            continue
        raise RuntimeError(f"BGG API returned HTTP {status} for: {url}")
    raise RuntimeError(f"Still queued after {QUEUE_MAX_RETRIES} retries: {url}")


# ---------------------------------------------------------------------------
# Type-coercion helpers
# ---------------------------------------------------------------------------

def _int(value: str | None) -> int | None:
    if not value or value in ("N/A", "0"):
        return None
    try:
        return int(float(value))
    except (ValueError, TypeError):
        return None


def _int_keep_zero(value: str | None) -> int | None:
    """Like _int but preserves explicit 0 (e.g. bggRank = 0 means unranked)."""
    if not value or value == "N/A":
        return None
    try:
        return int(float(value))
    except (ValueError, TypeError):
        return None


def _float(value: str | None) -> float | None:
    if not value or value in ("N/A", "0"):
        return None
    try:
        v = round(float(value), 2)
        return v if v != 0.0 else None
    except (ValueError, TypeError):
        return None


def _text(value: str | None) -> str | None:
    return value.strip() or None if value else None


# ---------------------------------------------------------------------------
# Collection API parsing
# ---------------------------------------------------------------------------

_STATUS_ATTRS: list[tuple[str, str]] = [
    ("own", "Owned"),
    ("prevowned", "Previously Owned"),
    ("fortrade", "For Trade"),
    ("want", "Want in Trade"),
    ("wanttoplay", "Want to Play"),
    ("wanttobuy", "Want to Buy"),
    ("wishlist", "Wishlist"),
    ("preordered", "Preordered"),
]


def _parse_statuses(item_el: ET.Element) -> list[str]:
    status_el = item_el.find("status")
    if status_el is None:
        return []
    return [label for attr, label in _STATUS_ATTRS if status_el.get(attr) == "1"]


def _item_type_from_subtype(subtype: str | None) -> str | None:
    if subtype == "boardgame":
        return "standalone"
    if subtype == "boardgameexpansion":
        return "expansion"
    return None


def parse_collection_item(item_el: ET.Element) -> dict:
    object_id = _int_keep_zero(item_el.get("objectid"))
    subtype = item_el.get("subtype", "thing")

    name_el = item_el.find("name")
    name = _text(name_el.text) if name_el is not None else None

    year_el = item_el.find("yearpublished")
    year = _int(year_el.text) if year_el is not None else None

    image_el = item_el.find("image")
    image = _text(image_el.text) if image_el is not None else None

    thumb_el = item_el.find("thumbnail")
    thumbnail = _text(thumb_el.text) if thumb_el is not None else None

    stats_el = item_el.find("stats")
    min_players = _int(stats_el.get("minplayers")) if stats_el is not None else None
    max_players = _int(stats_el.get("maxplayers")) if stats_el is not None else None
    playing_time = _int(stats_el.get("playingtime")) if stats_el is not None else None

    bgg_avg = bgg_bayes = bgg_rank = None
    if stats_el is not None:
        rating_el = stats_el.find("rating")
        if rating_el is not None:
            bgg_avg = _float((rating_el.find("average") or ET.Element("x")).get("value"))
            bgg_bayes = _float((rating_el.find("bayesaverage") or ET.Element("x")).get("value"))
            for rank_el in (rating_el.find("ranks") or ET.Element("x")).findall("rank"):
                if rank_el.get("name") == "boardgame":
                    bgg_rank = _int_keep_zero(rank_el.get("value"))
                    break

    return {
        "objectId": object_id,
        "subtype": subtype,
        "collId": _int_keep_zero(item_el.get("collid")),
        "name": name,
        "yearPublished": year,
        "image": image,
        "thumbnail": thumbnail,
        "link": f"https://boardgamegeek.com/boardgame/{object_id}" if object_id else None,
        "bggAverageRating": bgg_avg,
        "bggBayesAverageRating": bgg_bayes,
        "bggRank": bgg_rank,
        "weight": None,          # filled in later from /thing
        "minPlayers": min_players,
        "maxPlayers": max_players,
        "playingTime": playing_time,
        "languageDependence": None,  # filled in later from /thing
        "bestPlayers": None,         # filled in later from /thing
        "recommendedPlayers": None,  # filled in later from /thing
        "recommendedAge": None,      # filled in later from /thing
        "itemType": _item_type_from_subtype(subtype),
        "versionNickname": None,
        "ownerStatuses": _parse_statuses(item_el),
    }


def fetch_user_collection(username: str) -> list[dict]:
    url = f"{BGG_API_BASE}/collection?username={username}&stats=1&subtype=boardgame&brief=0"
    root = fetch_xml(url, f"collection/{username}")
    items = []
    for item_el in root.findall("item"):
        item = parse_collection_item(item_el)
        if item["objectId"] is not None:
            items.append(item)
    print(f"    -> {len(items)} items")
    return items


# ---------------------------------------------------------------------------
# Thing API parsing (weight + polls)
# ---------------------------------------------------------------------------

def _parse_language_dependence(poll_el: ET.Element) -> str | None:
    best_votes, best_label = -1, None
    for results_el in poll_el.findall("results"):
        for result_el in results_el.findall("result"):
            votes = int(result_el.get("numvotes", "0") or "0")
            if votes > best_votes:
                best_votes, best_label = votes, result_el.get("value")
    return best_label


def _parse_suggested_players(poll_el: ET.Element) -> tuple[str | None, str | None]:
    best: list[str] = []
    rec: list[str] = []
    for results_el in poll_el.findall("results"):
        numplayers = results_el.get("numplayers", "")
        votes: dict[str, int] = {}
        for r in results_el.findall("result"):
            votes[r.get("value", "")] = int(r.get("numvotes", "0") or "0")
        b = votes.get("Best", 0)
        r_votes = votes.get("Recommended", 0)
        nr = votes.get("Not Recommended", 0)
        if b + r_votes + nr == 0:
            continue
        if b > 0 and b >= r_votes and b >= nr:
            best.append(numplayers)
        if b + r_votes > nr:
            rec.append(numplayers)
    return (
        ",".join(best) if best else None,
        ",".join(rec) if rec else None,
    )


def _parse_suggested_age(poll_el: ET.Element) -> str | None:
    best_votes, best_age = -1, None
    for results_el in poll_el.findall("results"):
        for result_el in results_el.findall("result"):
            votes = int(result_el.get("numvotes", "0") or "0")
            if votes > best_votes:
                best_votes, best_age = votes, result_el.get("value")
    return f"{best_age}+" if best_age else None


def parse_thing_extra(item_el: ET.Element) -> dict:
    weight = None
    stats_el = item_el.find("statistics")
    if stats_el is not None:
        ratings_el = stats_el.find("ratings")
        if ratings_el is not None:
            aw_el = ratings_el.find("averageweight")
            if aw_el is not None:
                weight = _float(aw_el.get("value"))

    lang_dep = best_players = rec_players = rec_age = None
    for poll_el in item_el.findall("poll"):
        name = poll_el.get("name")
        if name == "language_dependence":
            lang_dep = _parse_language_dependence(poll_el)
        elif name == "suggested_numplayers":
            best_players, rec_players = _parse_suggested_players(poll_el)
        elif name == "suggested_playerage":
            rec_age = _parse_suggested_age(poll_el)

    return {
        "weight": weight,
        "languageDependence": lang_dep,
        "bestPlayers": best_players,
        "recommendedPlayers": rec_players,
        "recommendedAge": rec_age,
    }


def fetch_thing_extras(object_ids: list[int]) -> dict[int, dict]:
    extras: dict[int, dict] = {}
    total = len(object_ids)
    for i in range(0, total, THING_BATCH_SIZE):
        batch = object_ids[i : i + THING_BATCH_SIZE]
        ids_str = ",".join(str(oid) for oid in batch)
        url = f"{BGG_API_BASE}/thing?id={ids_str}&stats=1"
        desc = f"thing details {i + 1}–{i + len(batch)} of {total}"
        try:
            root = fetch_xml(url, desc)
        except RuntimeError as exc:
            print(f"    WARNING: {exc} — skipping batch")
            continue
        for item_el in root.findall("item"):
            oid = _int_keep_zero(item_el.get("id"))
            if oid is not None:
                extras[oid] = parse_thing_extra(item_el)
        if i + THING_BATCH_SIZE < total:
            time.sleep(THING_BATCH_DELAY)
    return extras


# ---------------------------------------------------------------------------
# Merging
# ---------------------------------------------------------------------------

def _choose(current, candidate):
    if current in (None, "", 0):
        return candidate
    return current


def _merge_into(existing: dict, candidate: dict, owner: str) -> None:
    for field in (
        "name", "yearPublished", "image", "thumbnail", "link",
        "bggAverageRating", "bggBayesAverageRating", "bggRank",
        "weight", "minPlayers", "maxPlayers", "playingTime",
        "languageDependence", "bestPlayers", "recommendedPlayers", "recommendedAge",
        "itemType", "versionNickname", "subtype",
    ):
        existing[field] = _choose(existing.get(field), candidate.get(field))

    owners: list[str] = existing.setdefault("owners", [])
    if owner not in owners:
        owners.append(owner)
        owners.sort(key=str.lower)

    owner_details: list[dict] = existing.setdefault("ownerDetails", [])
    owner_details.append({"owner": owner, "statuses": candidate.get("ownerStatuses", [])})
    owner_details.sort(key=lambda d: str(d["owner"]).lower())


# ---------------------------------------------------------------------------
# Main snapshot builder
# ---------------------------------------------------------------------------

def build_snapshot(usernames: list[str]) -> dict:
    # 1. Fetch each user's collection
    print("=== Fetching collections ===")
    collections: dict[str, list[dict]] = {}
    for username in usernames:
        collections[username] = fetch_user_collection(username)

    # 2. Merge into one dict keyed by objectId
    merged: dict[int, dict] = {}
    for username, items in collections.items():
        for item in items:
            oid: int = item["objectId"]
            existing = merged.get(oid)
            if existing is None:
                merged[oid] = {
                    **item,
                    "owners": [username],
                    "ownerDetails": [{"owner": username, "statuses": item["ownerStatuses"]}],
                }
            else:
                _merge_into(existing, item, username)

    # 3. Batch-fetch extra fields from the thing API
    all_ids = list(merged.keys())
    print(f"\n=== Fetching game details for {len(all_ids)} unique games ===")
    extras = fetch_thing_extras(all_ids)

    for oid, item in merged.items():
        extra = extras.get(oid, {})
        for field in ("weight", "languageDependence", "bestPlayers", "recommendedPlayers", "recommendedAge"):
            item[field] = _choose(item.get(field), extra.get(field))

    # 4. Sort and clean up
    items = sorted(
        merged.values(),
        key=lambda item: ((item.get("name") or "").lower(), item.get("objectId") or 0),
    )
    for item in items:
        item.pop("ownerStatuses", None)

    return {
        "owners": sorted(usernames, key=str.lower),
        "sourceLabel": "BGG XML API2",
        "sourceFiles": [],
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "itemCount": len(items),
        "items": items,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch BoardGameGeek collections via the XML API2 and write "
            "data/collection.json (same format as sync_bgg_collection.py)."
        )
    )
    parser.add_argument(
        "--usernames",
        nargs="+",
        metavar="USERNAME",
        help="BGG usernames to fetch. Defaults to CSV filenames in --collections-dir.",
    )
    parser.add_argument(
        "--collections-dir",
        default=str(DEFAULT_COLLECTIONS_DIR),
        help=f"Directory to scan for CSV filenames (default: {DEFAULT_COLLECTIONS_DIR})",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help=f"Output path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("BGG_TOKEN"),
        metavar="TOKEN",
        help="BGG Bearer token for authenticated requests (or set BGG_TOKEN env var).",
    )
    return parser


def main() -> int:
    global _bearer_token
    parser = build_parser()
    args = parser.parse_args()
    _bearer_token = args.token

    usernames: list[str] = args.usernames or []
    if not usernames:
        collections_dir = Path(args.collections_dir)
        if not collections_dir.exists():
            parser.error(f"collections directory not found: {collections_dir}")
        csv_files = sorted(collections_dir.glob("*.csv"), key=lambda p: p.name.lower())
        usernames = [p.stem for p in csv_files]
        if not usernames:
            parser.error(f"no CSV files found in {collections_dir} — pass --usernames explicitly")
        print(f"Discovered usernames from {collections_dir}: {', '.join(usernames)}\n")

    snapshot = build_snapshot(usernames)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )

    print(f"\nWrote {snapshot['itemCount']} merged items from {len(usernames)} user(s) to {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
