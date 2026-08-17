#!/usr/bin/env python3
"""Fetch the BGG GeekList Essen auction and join it to our collection wishlist,
writing data/essen26_auction.json.

Reads listings (one per <item>) from the BGG GeekList XML API, parses each
item's freeform BBCode body for condition/price/version/logistics fields, and
joins the resulting games to data/collection.json to flag which ones our
group has wishlisted.

No third-party dependencies — uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

DEFAULT_GEEKLIST_ID = 382717
DEFAULT_COLLECTION = Path("data/collection.json")
DEFAULT_OUTPUT = Path("data/essen26_auction.json")

BGG_XMLAPI_BASE = "https://boardgamegeek.com/xmlapi"

USER_AGENT = "our-boardgames-essen-auction/1.0"

QUEUE_RETRY_DELAY = 5   # seconds between retries
QUEUE_MAX_RETRIES = 12

WISHLIST_STATUSES = ["Wishlist", "Want to Play", "Want to Buy"]

DETAIL_FIELDS = (
    "name", "thumbnail", "image", "yearPublished", "bggRank",
    "bggAverageRating", "weight", "minPlayers", "maxPlayers",
    "playingTime", "link",
)

CURRENCY_SYMBOLS = {"€": "EUR", "$": "USD", "£": "GBP"}


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
    """Shared 202-queued / 429-rate-limited retry loop used by the XML fetch."""
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


def fetch_xml(url: str, description: str) -> ET.Element:
    body = _retry_loop(url, description, lambda: _get(url, headers={"User-Agent": USER_AGENT}, bearer=True))
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


def _text(value) -> str | None:
    if value is None:
        return None
    value = str(value).strip()
    return value or None


# ---------------------------------------------------------------------------
# BBCode body parsing
# ---------------------------------------------------------------------------

_EMOJI_TOKEN_RE = re.compile(r":[a-zA-Z]+:")
_STAR_TOKEN_RE = re.compile(r":(?:no)?star:")
_LABEL_LINE_RE = re.compile(r"^\s*([A-Za-z][A-Za-z /]{1,40}?)\s*:\s*(.*)$")
_VERSION_ID_RE = re.compile(r"boardgameversion/(\d+)")
_PRICE_RE = re.compile(
    r"(?P<presym>[€$£]|\b[A-Z]{3}\b)?\s*(?P<num>\d+)(?P<dec>,-|[.,]\d{1,2})?\s*(?P<postsym>[€$£]|\b[A-Z]{3}\b)?"
)


def _strip_bbcode(text: str) -> str:
    text = re.sub(r"\[[^\]]*\]", "", text)
    return html.unescape(text)


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = _EMOJI_TOKEN_RE.sub("", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value or None


def _extract_labels(lines: list[str]) -> dict[str, tuple[int, str]]:
    labels: dict[str, tuple[int, str]] = {}
    for i, line in enumerate(lines):
        m = _LABEL_LINE_RE.match(line)
        if m:
            key = m.group(1).strip().lower()
            if key not in labels:
                labels[key] = (i, m.group(2).strip())
    return labels


def _parse_condition(value: str | None) -> tuple[str | None, int | None, str | None]:
    if not value:
        return None, None, None
    tokens = list(_STAR_TOKEN_RE.finditer(value))
    if tokens:
        label = value[: tokens[0].start()]
        stars = sum(1 for t in tokens if t.group() == ":star:")
        remainder = value[tokens[-1].end():]
    else:
        label = value
        stars = None
        remainder = ""
    note_m = re.search(r"\(([^()]*)\)", remainder)
    note = note_m.group(1).strip() if note_m else None
    return _clean(label), stars, _clean(note)


def _parse_price(raw: str | None) -> dict | None:
    if not raw:
        return None
    m = _PRICE_RE.search(raw)
    if not m or not m.group("num"):
        return None
    symbol = m.group("presym") or m.group("postsym")
    if symbol is None:
        return None
    currency = CURRENCY_SYMBOLS.get(symbol, symbol if len(symbol) == 3 else None)
    if currency is None:
        return None
    amount = float(m.group("num"))
    dec = m.group("dec")
    if dec and dec != ",-":
        amount = float(f"{m.group('num')}.{dec[1:]}")
    return {"amount": amount, "currency": currency}


def _collect_handover(lines: list[str], idx: int, first_value: str) -> str | None:
    collected = [first_value] if first_value else []
    i = idx + 1
    while i < len(lines):
        line = lines[i].strip()
        if not line or _LABEL_LINE_RE.match(line):
            break
        collected.append(line)
        i += 1
    joined = " · ".join(c for c in collected if c)
    return _clean(joined) if joined else None


def parse_offer_body(bbcode: str | None) -> dict:
    fields = {
        "condition": None, "conditionStars": None, "conditionNote": None,
        "version": None, "versionId": None,
        "language": None, "languageDependency": None,
        "startingBid": None, "bin": None,
        "payment": None, "presence": None, "handover": None, "auctionEnds": None,
    }
    if not bbcode:
        return fields

    version_id_m = _VERSION_ID_RE.search(bbcode)
    if version_id_m:
        fields["versionId"] = _int(version_id_m.group(1))

    plain = _strip_bbcode(bbcode)
    lines = plain.split("\n")
    labels = _extract_labels(lines)

    _, cond_val = labels.get("condition", (None, None))
    fields["condition"], fields["conditionStars"], fields["conditionNote"] = _parse_condition(cond_val)

    _, version_val = labels.get("version", (None, None))
    fields["version"] = _clean(version_val)

    _, lang_val = labels.get("language", labels.get("languages", (None, None)))
    fields["language"] = _clean(lang_val)

    _, lang_dep_val = labels.get("language dependency", (None, None))
    fields["languageDependency"] = _clean(lang_dep_val)

    _, bid_val = labels.get("starting bid", (None, None))
    fields["startingBid"] = _parse_price(bid_val)

    _, bin_val = labels.get("bin", (None, None))
    fields["bin"] = _parse_price(bin_val)

    _, payment_val = labels.get("payment", (None, None))
    fields["payment"] = _clean(payment_val)

    _, presence_val = labels.get("presence at essen spiel", (None, None))
    fields["presence"] = _clean(presence_val)

    handover_idx, handover_val = labels.get("preferred handover", (None, None))
    if handover_idx is not None:
        fields["handover"] = _collect_handover(lines, handover_idx, handover_val)

    _, ends_val = labels.get("auction ends", (None, None))
    fields["auctionEnds"] = _clean(ends_val)

    return fields


# ---------------------------------------------------------------------------
# GeekList item parsing
# ---------------------------------------------------------------------------

def parse_listing(item_el: ET.Element, geeklist_id: int) -> dict:
    itemid = _text(item_el.get("id"))
    objectid = _int(item_el.get("objectid"))
    body_el = item_el.find("body")
    offer = parse_offer_body(body_el.text if body_el is not None else None)
    offer.update({
        "seller": _text(item_el.get("username")),
        "sellerName": None,
        "geeklistItemId": itemid,
        "postDate": _text(item_el.get("postdate")),
        "editDate": _text(item_el.get("editdate")),
        "listingUrl": f"https://boardgamegeek.com/geeklist/{geeklist_id}/item/{itemid}",
    })
    return {
        "objectId": objectid,
        "objectName": _text(item_el.get("objectname")),
        "offer": offer,
    }


# ---------------------------------------------------------------------------
# Collection join
# ---------------------------------------------------------------------------

def load_collection(collection_path: Path) -> tuple[dict[int, list[dict]], dict[int, dict]]:
    data = json.loads(collection_path.read_text(encoding="utf-8"))
    wishers: dict[int, list[dict]] = {}
    details: dict[int, dict] = {}
    for item in data.get("items", []):
        oid = item.get("objectId")
        if oid is None:
            continue
        details[oid] = {field: item.get(field) for field in DETAIL_FIELDS}
        for owner_detail in item.get("ownerDetails") or []:
            owner = owner_detail.get("owner")
            for status in owner_detail.get("statuses") or []:
                if status in WISHLIST_STATUSES:
                    wishers.setdefault(oid, []).append({"owner": owner, "status": status})
    return wishers, details


def _offer_sort_key(offer: dict) -> tuple:
    bin_amount = offer["bin"]["amount"] if offer.get("bin") else None
    bid_amount = offer["startingBid"]["amount"] if offer.get("startingBid") else None
    return (bin_amount is None, bin_amount or 0.0, bid_amount is None, bid_amount or 0.0)


def build_snapshot(geeklist_id: int, root: ET.Element, wishers: dict[int, list[dict]], details: dict[int, dict]) -> dict:
    title = _text(root.findtext("title"))

    listings_by_oid: dict[int, list[dict]] = {}
    object_names: dict[int, str] = {}
    for item_el in root.findall("item"):
        listing = parse_listing(item_el, geeklist_id)
        oid = listing["objectId"]
        if oid is None:
            continue
        listings_by_oid.setdefault(oid, []).append(listing["offer"])
        if oid not in object_names and listing["objectName"]:
            object_names[oid] = listing["objectName"]

    items = []
    for oid, offers in listings_by_oid.items():
        offers.sort(key=_offer_sort_key)
        detail = details.get(oid, {})
        wished_by = wishers.get(oid, [])
        items.append({
            "objectId": oid,
            "name": detail.get("name") or object_names.get(oid),
            "link": detail.get("link") or f"https://boardgamegeek.com/boardgame/{oid}",
            "thumbnail": detail.get("thumbnail"),
            "image": detail.get("image"),
            "yearPublished": detail.get("yearPublished"),
            "bggRank": detail.get("bggRank"),
            "bggAverageRating": detail.get("bggAverageRating"),
            "weight": detail.get("weight"),
            "minPlayers": detail.get("minPlayers"),
            "maxPlayers": detail.get("maxPlayers"),
            "playingTime": detail.get("playingTime"),
            "onWishlist": bool(wished_by),
            "wishedBy": wished_by,
            "offers": offers,
            "offerCount": len(offers),
        })

    items.sort(key=lambda item: (not item["onWishlist"], (item.get("name") or "").lower()))

    owners = sorted({entry["owner"] for item in items for entry in item["wishedBy"]}, key=str.lower)
    listing_count = sum(item["offerCount"] for item in items)
    matched_game_count = sum(1 for item in items if item["onWishlist"])

    return {
        "geeklistId": geeklist_id,
        "title": title,
        "sourceLabel": f"BGG GeekList {geeklist_id}",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "statuses": WISHLIST_STATUSES,
        "owners": owners,
        "listingCount": listing_count,
        "gameCount": len(items),
        "matchedGameCount": matched_game_count,
        "items": items,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fetch the BGG GeekList Essen auction and join it to data/collection.json's wishlist."
    )
    parser.add_argument(
        "--geeklist-id",
        type=int,
        default=DEFAULT_GEEKLIST_ID,
        help=f"GeekList id to fetch (default: {DEFAULT_GEEKLIST_ID})",
    )
    parser.add_argument(
        "--collection",
        default=str(DEFAULT_COLLECTION),
        help=f"Path to the collection JSON file (default: {DEFAULT_COLLECTION})",
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
    parser.add_argument(
        "--input-xml",
        metavar="PATH",
        help="Read GeekList XML from this file instead of fetching it live (for offline tests).",
    )
    return parser


def main() -> int:
    global _bearer_token
    parser = build_parser()
    args = parser.parse_args()
    _bearer_token = args.token

    collection_path = Path(args.collection)
    if not collection_path.exists():
        parser.error(f"collection file not found: {collection_path}")
    wishers, details = load_collection(collection_path)

    if args.input_xml:
        input_path = Path(args.input_xml)
        if not input_path.exists():
            parser.error(f"input XML file not found: {input_path}")
        print(f"=== Reading GeekList {args.geeklist_id} from {input_path} ===")
        root = ET.fromstring(input_path.read_bytes())
    else:
        print(f"=== Fetching GeekList {args.geeklist_id} ===")
        url = f"{BGG_XMLAPI_BASE}/geeklist/{args.geeklist_id}"
        root = fetch_xml(url, f"geeklist {args.geeklist_id}")

    snapshot = build_snapshot(args.geeklist_id, root, wishers, details)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )

    print(
        f"\nWrote {snapshot['gameCount']} games "
        f"({snapshot['matchedGameCount']} on wishlist, {snapshot['listingCount']} listings) "
        f"to {output_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
