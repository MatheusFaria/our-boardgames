#!/usr/bin/env python3
"""Fetch BGG GeekPreview data for the Essen Spiel 2026 preview and write
data/essen26.json.

Crawls the full public GeekPreview catalog (all items, paginated) and
overlays each user's share-key-based picks from the userinfo API on top of
it, so every catalog game is kept — including games no one has picked.
Game details (name, stats, credits) come from the XML API2 /thing endpoint.

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

DEFAULT_SOURCES = Path("essen26/sources.json")
DEFAULT_OUTPUT = Path("data/essen26.json")
DEFAULT_PREVIEWID = 93

BGG_SITE_BASE = "https://boardgamegeek.com/api"
GEEKDO_API_BASE = "https://api.geekdo.com/api"
BGG_XML_BASE = "https://boardgamegeek.com/xmlapi2"

USER_AGENT = "our-boardgames-essen-preview/1.0"

QUEUE_RETRY_DELAY = 5   # seconds between retries
QUEUE_MAX_RETRIES = 12

CATALOG_PAGE_SIZE = 10

THING_BATCH_SIZE = 10
THING_BATCH_DELAY = 2.0  # seconds

THING_CACHE_DAYS = 30

PRIORITY_LABELS = {
    1: "Must Have",
    2: "Interested",
    3: "Not Decided",
    4: "Not Interested",
}
UNPRIORITIZED_LABEL = "Unprioritized"

DEFAULT_EVENT = {
    "title": "SPIEL Essen 2026",
    "location": "Essen, Germany",
    "startDate": "2026-10-22",
    "endDate": "2026-10-25",
    "url": "https://www.spiel-essen.de/en/",
}


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

_bearer_token: str | None = None


def _get(url: str, headers: dict[str, str] | None = None, bearer: bool = False) -> tuple[int, bytes]:
    req = Request(url)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    if bearer and _bearer_token:
        req.add_header("Authorization", f"Bearer {_bearer_token}")
    try:
        with urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except HTTPError as exc:
        return exc.code, exc.read() or b""


def _retry_loop(url: str, description: str, fetch_body):
    """Shared 202-queued / 429-rate-limited retry loop used by both the JSON
    and XML fetchers."""
    print(f"  {description}...", end=" ", flush=True)
    for attempt in range(QUEUE_MAX_RETRIES):
        status, body = fetch_body()
        if status == 200:
            print("OK")
            return body
        if status == 202:
            wait = QUEUE_RETRY_DELAY * (attempt + 1)
            print(f"queued, retry in {wait}s...", end=" ", flush=True)
            time.sleep(wait)
            continue
        if status == 429:
            wait = 30 * (attempt + 1)
            print(f"rate limited, retry in {wait}s...", end=" ", flush=True)
            time.sleep(wait)
            continue
        raise RuntimeError(f"request returned HTTP {status} for: {url}")
    raise RuntimeError(f"Still queued/rate-limited after {QUEUE_MAX_RETRIES} retries: {url}")


def fetch_json(url: str, description: str, headers: dict[str, str] | None = None):
    body = _retry_loop(url, description, lambda: _get(url, headers=headers))
    return json.loads(body)


def fetch_xml(url: str, description: str) -> ET.Element:
    body = _retry_loop(url, description, lambda: _get(url, bearer=True))
    return ET.fromstring(body)


# ---------------------------------------------------------------------------
# Type-coercion helpers
# ---------------------------------------------------------------------------

def _int(value) -> int | None:
    if value is None or value in ("", "N/A", "0"):
        return None
    try:
        return int(float(value))
    except (ValueError, TypeError):
        return None


def _int_keep_zero(value) -> int | None:
    if value is None or value == "" or value == "N/A":
        return None
    try:
        return int(float(value))
    except (ValueError, TypeError):
        return None


def _float(value) -> float | None:
    if value is None or value in ("", "N/A", "0"):
        return None
    try:
        v = round(float(value), 2)
        return v if v != 0.0 else None
    except (ValueError, TypeError):
        return None


def _text(value) -> str | None:
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _priority_int(value) -> int | None:
    p = _int_keep_zero(value)
    return p if p in PRIORITY_LABELS else None


def _priority_label(priority: int | None) -> str:
    return PRIORITY_LABELS.get(priority, UNPRIORITIZED_LABEL)


# ---------------------------------------------------------------------------
# GeekPreview userinfo (saved picks per share key)
# ---------------------------------------------------------------------------

def fetch_saved_items(sources: list[dict], previewid: int) -> dict[str, dict[int, dict]]:
    """Return username -> {itemid: {"priority", "notes"}}."""
    print("=== Fetching saved picks ===")
    saved_by_user: dict[str, dict[int, dict]] = {}
    for source in sources:
        username = source["username"]
        sharekey = source["sharekey"]
        url = f"{BGG_SITE_BASE}/geekpreviewitems/userinfo?previewid={previewid}&sharekey={sharekey}"
        data = fetch_json(url, f"userinfo for {username}", headers={"User-Agent": USER_AGENT})
        items = data.get("items") or {}
        saved: dict[int, dict] = {}
        for itemid_str, item in items.items():
            saved[int(itemid_str)] = {
                "priority": _priority_int(item.get("priority")),
                "notes": _text(item.get("notes")),
            }
        saved_by_user[username] = saved
        print(f"    -> {len(saved)} saved items for {username}")
    return saved_by_user


# ---------------------------------------------------------------------------
# GeekPreview full catalog (all items, paginated)
# ---------------------------------------------------------------------------

def parse_catalog_entry(entry: dict) -> dict | None:
    """Parse one geekpreviewitems catalog entry into our itemid-keyed shape."""
    itemid = _int_keep_zero(entry.get("itemid"))
    objectid = _int_keep_zero(entry.get("objectid"))
    if itemid is None or objectid is None:
        return None

    item = ((entry.get("geekitem") or {}).get("item")) or {}
    primaryname = item.get("primaryname") or {}
    images = item.get("images") or {}

    thumbnail = entry.get("thumbnail")
    if isinstance(thumbnail, dict):
        thumbnail = thumbnail.get("src")
    thumbnail = _text(thumbnail) or _text(images.get("thumb"))

    showprice = _float(entry.get("showprice"))
    price = (
        {"amount": showprice, "currency": _text(entry.get("showprice_currency"))}
        if showprice
        else None
    )

    return {
        "itemid": itemid,
        "objectid": objectid,
        "name": _text(primaryname.get("name")),
        "yearPublished": _int(item.get("yearpublished")),
        "image": _text(images.get("original")),
        "thumbnail": thumbnail,
        "price": price,
        "location": _text(entry.get("location")),
        "availability": _text(entry.get("pretty_availability_status")),
        "dateUpdated": _text(entry.get("date_updated")),
    }


def fetch_catalog(previewid: int, max_pages: int | None = None) -> dict[int, dict]:
    """Page through the full public GeekPreview catalog.

    10 items/page, ordered by itemid ascending; stops on the first empty
    page (or after max_pages pages if given)."""
    print(f"=== Fetching full catalog (previewid={previewid}) ===")
    catalog: dict[int, dict] = {}
    page = 1
    pages_fetched = 0
    while max_pages is None or page <= max_pages:
        url = f"{GEEKDO_API_BASE}/geekpreviewitems?previewid={previewid}&pageid={page}"
        data = fetch_json(url, f"catalog page {page}", headers={"User-Agent": USER_AGENT})
        pages_fetched += 1
        if not data:
            break
        for entry in data:
            parsed = parse_catalog_entry(entry)
            if parsed is not None:
                catalog[parsed["itemid"]] = parsed
        if len(data) < CATALOG_PAGE_SIZE:
            break
        page += 1
    print(f"    -> {len(catalog)} catalog items across {pages_fetched} page(s)")
    return catalog


# ---------------------------------------------------------------------------
# GeekPreview event info (title, dates, location)
# ---------------------------------------------------------------------------

def fetch_event_info(previewid: int) -> dict:
    event = {"previewId": previewid, **DEFAULT_EVENT}
    url = f"{GEEKDO_API_BASE}/geekpreviews/{previewid}"
    try:
        data = fetch_json(url, "event info", headers={"User-Agent": USER_AGENT})
    except RuntimeError as exc:
        print(f"  WARNING: {exc} — using default event info")
        return event

    event["title"] = _text(data.get("title")) or event["title"]
    event["location"] = _text(data.get("location")) or event["location"]
    event["startDate"] = _text(data.get("start_date")) or event["startDate"]
    event["endDate"] = _text(data.get("end_date")) or event["endDate"]
    event["url"] = _text(data.get("url")) or event["url"]
    return event


# ---------------------------------------------------------------------------
# XML API2 /thing (game name + stats)
# ---------------------------------------------------------------------------

def _parse_link_values(item_el: ET.Element, link_type: str) -> list[str]:
    return [el.get("value") for el in item_el.findall(f"./link[@type='{link_type}']") if el.get("value")]


def _item_type_from_subtype(subtype: str | None) -> str | None:
    if subtype == "boardgameexpansion":
        return "expansion"
    if subtype == "boardgame":
        return "standalone"
    return None


def parse_thing_item(item_el: ET.Element) -> dict:
    name_el = next(
        (el for el in item_el.findall("name") if el.get("type") == "primary"), None
    )
    name = _text(name_el.get("value")) if name_el is not None else None

    year_el = item_el.find("yearpublished")
    year = _int(year_el.get("value") if year_el is not None else None)

    image_el = item_el.find("image")
    image = _text(image_el.text) if image_el is not None else None

    thumb_el = item_el.find("thumbnail")
    thumbnail = _text(thumb_el.text) if thumb_el is not None else None

    minplayers_el = item_el.find("minplayers")
    min_players = _int(minplayers_el.get("value") if minplayers_el is not None else None)
    maxplayers_el = item_el.find("maxplayers")
    max_players = _int(maxplayers_el.get("value") if maxplayers_el is not None else None)
    playingtime_el = item_el.find("playingtime")
    playing_time = _int(playingtime_el.get("value") if playingtime_el is not None else None)
    minage_el = item_el.find("minage")
    min_age = _int(minage_el.get("value") if minage_el is not None else None)

    weight = bgg_avg = bgg_bayes = bgg_rank = None
    stats_el = item_el.find("statistics")
    if stats_el is not None:
        ratings_el = stats_el.find("ratings")
        if ratings_el is not None:
            avg_el = ratings_el.find("average")
            bgg_avg = _float(avg_el.get("value") if avg_el is not None else None)
            bayes_el = ratings_el.find("bayesaverage")
            bgg_bayes = _float(bayes_el.get("value") if bayes_el is not None else None)
            aw_el = ratings_el.find("averageweight")
            weight = _float(aw_el.get("value") if aw_el is not None else None)
            ranks_el = ratings_el.find("ranks")
            for rank_el in (ranks_el.findall("rank") if ranks_el is not None else []):
                if rank_el.get("name") == "boardgame":
                    bgg_rank = _int_keep_zero(rank_el.get("value"))
                    break

    return {
        "name": name,
        "yearPublished": year,
        "image": image,
        "thumbnail": thumbnail,
        "minPlayers": min_players,
        "maxPlayers": max_players,
        "playingTime": playing_time,
        "recommendedAge": f"{min_age}+" if min_age else None,
        "weight": weight,
        "bggAverageRating": bgg_avg,
        "bggBayesAverageRating": bgg_bayes,
        "bggRank": bgg_rank,
        "mechanics": _parse_link_values(item_el, "boardgamemechanic"),
        "designers": _parse_link_values(item_el, "boardgamedesigner"),
        "artists": _parse_link_values(item_el, "boardgameartist"),
        "publishers": _parse_link_values(item_el, "boardgamepublisher"),
        "subtype": item_el.get("type"),
        "itemType": _item_type_from_subtype(item_el.get("type")),
    }


def fetch_thing_details(object_ids: list[int], batch_delay: float = THING_BATCH_DELAY) -> dict[int, dict]:
    details: dict[int, dict] = {}
    total = len(object_ids)
    for i in range(0, total, THING_BATCH_SIZE):
        batch = object_ids[i : i + THING_BATCH_SIZE]
        ids_str = ",".join(str(oid) for oid in batch)
        url = f"{BGG_XML_BASE}/thing?id={ids_str}&stats=1"
        desc = f"thing details {i + 1}–{i + len(batch)} of {total}"
        try:
            root = fetch_xml(url, desc)
        except RuntimeError as exc:
            print(f"    WARNING: {exc} — skipping batch")
            continue
        for item_el in root.findall("item"):
            oid = _int_keep_zero(item_el.get("id"))
            if oid is not None:
                details[oid] = parse_thing_item(item_el)
        if i + THING_BATCH_SIZE < total:
            time.sleep(batch_delay)
    return details


# ---------------------------------------------------------------------------
# Thing-data cache helpers
# ---------------------------------------------------------------------------

THING_FIELDS = (
    "name", "yearPublished", "image", "thumbnail",
    "minPlayers", "maxPlayers", "playingTime", "recommendedAge",
    "weight", "bggAverageRating", "bggBayesAverageRating", "bggRank",
    "mechanics", "designers", "artists", "publishers",
    "subtype", "itemType",
)


def _is_fresh(item: dict, cache_days: int) -> bool:
    fetched_at = item.get("thingFetchedAt")
    if not fetched_at:
        return False
    try:
        fetched = datetime.fromisoformat(fetched_at)
        return (datetime.now(timezone.utc) - fetched).days < cache_days
    except (ValueError, TypeError):
        return False


def _has_credits(item: dict) -> bool:
    """Return True if the item already has designers/artists/publishers (empty list counts)."""
    return "designers" in item and "artists" in item and "publishers" in item


def _has_type(item: dict) -> bool:
    """Return True if the item already has an itemType (fetched, even if the value is None)."""
    return "itemType" in item


def load_existing_items(output_path: Path) -> dict[int, dict]:
    if not output_path.exists():
        return {}
    try:
        data = json.loads(output_path.read_text(encoding="utf-8"))
        return {
            item["objectId"]: item
            for item in data.get("items", [])
            if item.get("objectId") is not None
        }
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Main snapshot builder
# ---------------------------------------------------------------------------

def build_snapshot(
    sources: list[dict],
    previewid: int,
    existing_items: dict[int, dict],
    cache_days: int,
    max_pages: int | None = None,
    max_fetch: int | None = None,
    thing_batch_delay: float = THING_BATCH_DELAY,
) -> dict:
    catalog = fetch_catalog(previewid, max_pages)
    saved_by_user = fetch_saved_items(sources, previewid)

    catalog_by_oid: dict[int, dict] = {entry["objectid"]: entry for entry in catalog.values()}
    object_ids = sorted(catalog_by_oid)

    interested_by_oid: dict[int, dict[str, dict]] = {}
    for username, saved in saved_by_user.items():
        for itemid, pick in saved.items():
            entry = catalog.get(itemid)
            if entry is None:
                continue
            oid = entry["objectid"]
            interested_by_oid.setdefault(oid, {})[username] = {
                "user": username,
                "priority": pick["priority"],
                "priorityLabel": _priority_label(pick["priority"]),
                "notes": pick["notes"],
            }

    stale_ids: list[int] = []
    fresh_things: dict[int, dict] = {}
    for oid in object_ids:
        cached = existing_items.get(oid)
        if cached and _is_fresh(cached, cache_days) and _has_credits(cached) and _has_type(cached):
            fresh_things[oid] = {field: cached.get(field) for field in THING_FIELDS}
            fresh_things[oid]["thingFetchedAt"] = cached.get("thingFetchedAt")
        else:
            stale_ids.append(oid)

    print(f"\n=== Fetching game details: {len(stale_ids)} stale, {len(fresh_things)} cached (threshold: {cache_days}d) ===")

    if max_fetch is not None and len(stale_ids) > max_fetch:
        to_fetch, deferred_ids = stale_ids[:max_fetch], stale_ids[max_fetch:]
    else:
        to_fetch, deferred_ids = stale_ids, []

    for oid in deferred_ids:
        cached = existing_items.get(oid)
        if cached:
            fresh_things[oid] = {field: cached.get(field) for field in THING_FIELDS}
            fresh_things[oid]["thingFetchedAt"] = cached.get("thingFetchedAt")
    if deferred_ids:
        print(f"  {len(to_fetch)} fetched this run, {len(deferred_ids)} deferred to a later run")

    fetched_things: dict[int, dict] = {}
    if to_fetch:
        now = datetime.now(timezone.utc).isoformat()
        details = fetch_thing_details(to_fetch, batch_delay=thing_batch_delay)
        for oid in to_fetch:
            thing = details.get(oid)
            if thing is None:
                cached = existing_items.get(oid)
                if cached:
                    print(f"    WARNING: no /thing data for objectid {oid} — restoring cached details")
                    thing = {field: cached.get(field) for field in THING_FIELDS}
                    thing["thingFetchedAt"] = cached.get("thingFetchedAt")
                else:
                    print(f"    WARNING: no /thing data for objectid {oid} — leaving game details empty")
                    thing = {field: None for field in THING_FIELDS}
                    thing["thingFetchedAt"] = None
            else:
                thing["thumbnail"] = thing.get("thumbnail") or catalog_by_oid[oid].get("thumbnail")
                thing["thingFetchedAt"] = now
            fetched_things[oid] = thing
    else:
        print("  All games are fresh — skipping /thing requests.")

    items = []
    for oid in object_ids:
        thing = fresh_things.get(oid) or fetched_things.get(oid) or {field: None for field in THING_FIELDS}
        entry = catalog_by_oid[oid]
        interested = sorted(
            interested_by_oid.get(oid, {}).values(),
            key=lambda pick: (pick["priority"] is None, pick["priority"] or 0),
        )
        items.append({
            "objectId": oid,
            "name": thing.get("name") or entry.get("name"),
            "yearPublished": thing.get("yearPublished") or entry.get("yearPublished"),
            "image": thing.get("image") or entry.get("image"),
            "thumbnail": thing.get("thumbnail") or entry.get("thumbnail"),
            "link": f"https://boardgamegeek.com/boardgame/{oid}",
            "minPlayers": thing.get("minPlayers"),
            "maxPlayers": thing.get("maxPlayers"),
            "playingTime": thing.get("playingTime"),
            "recommendedAge": thing.get("recommendedAge"),
            "weight": thing.get("weight"),
            "bggAverageRating": thing.get("bggAverageRating"),
            "bggBayesAverageRating": thing.get("bggBayesAverageRating"),
            "bggRank": thing.get("bggRank"),
            "mechanics": thing.get("mechanics"),
            "designers": thing.get("designers"),
            "artists": thing.get("artists"),
            "publishers": thing.get("publishers"),
            "subtype": thing.get("subtype"),
            "itemType": thing.get("itemType"),
            "price": entry.get("price"),
            "location": entry.get("location"),
            "availability": entry.get("availability"),
            "interested": interested,
            "thingFetchedAt": thing.get("thingFetchedAt"),
        })

    items.sort(key=lambda item: (item.get("name") or "").lower())

    interested_count = sum(
        1 for item in items
        if any(pick.get("priority") in (1, 2, 3) for pick in item["interested"])
    )

    event = fetch_event_info(previewid)
    priority_labels = {str(k): v for k, v in PRIORITY_LABELS.items()}
    priority_labels["unprioritized"] = UNPRIORITIZED_LABEL

    return {
        "event": event,
        "priorityLabels": priority_labels,
        "users": sorted(saved_by_user, key=str.lower),
        "sourceLabel": "BGG GeekPreview 93 full catalog + userinfo overlay + XML API2",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "itemCount": len(items),
        "interestedCount": interested_count,
        "noOneCount": len(items) - interested_count,
        "items": items,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fetch BGG GeekPreview data for Essen Spiel 2026 and write data/essen26.json."
    )
    parser.add_argument(
        "--sources",
        default=str(DEFAULT_SOURCES),
        help=f"Path to the sources JSON file (default: {DEFAULT_SOURCES})",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help=f"Output path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--previewid",
        type=int,
        default=DEFAULT_PREVIEWID,
        help=f"GeekPreview id to fetch (default: {DEFAULT_PREVIEWID})",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("BGG_TOKEN"),
        metavar="TOKEN",
        help="BGG Bearer token for authenticated XML API2 requests (or set BGG_TOKEN env var).",
    )
    parser.add_argument(
        "--cache-days",
        type=int,
        default=THING_CACHE_DAYS,
        metavar="N",
        help=f"Re-fetch /thing data for games older than N days (default: {THING_CACHE_DAYS}).",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Ignore cached /thing data and re-fetch everything.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=None,
        metavar="N",
        help="Cap the number of catalog pages fetched (10 items/page). Default: crawl the full catalog.",
    )
    parser.add_argument(
        "--max-fetch",
        type=int,
        default=None,
        metavar="N",
        help="Cap the number of stale games fetched via /thing this run; the rest are deferred to a later run.",
    )
    parser.add_argument(
        "--thing-batch-delay",
        type=float,
        default=THING_BATCH_DELAY,
        metavar="SECONDS",
        help=f"Delay between /thing batch requests (default: {THING_BATCH_DELAY}).",
    )
    return parser


def main() -> int:
    global _bearer_token
    parser = build_parser()
    args = parser.parse_args()
    _bearer_token = args.token

    sources_path = Path(args.sources)
    if not sources_path.exists():
        parser.error(f"sources file not found: {sources_path}")
    sources = json.loads(sources_path.read_text(encoding="utf-8"))

    output_path = Path(args.output)
    cache_days = 0 if args.no_cache else args.cache_days
    existing_items = (
        load_existing_items(output_path)
        if (cache_days > 0 or args.max_fetch is not None)
        else {}
    )
    if existing_items:
        print(f"Loaded {len(existing_items)} cached games from {output_path}\n")

    snapshot = build_snapshot(
        sources,
        args.previewid,
        existing_items,
        cache_days,
        max_pages=args.max_pages,
        max_fetch=args.max_fetch,
        thing_batch_delay=args.thing_batch_delay,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )

    print(f"\nWrote {snapshot['itemCount']} items to {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
