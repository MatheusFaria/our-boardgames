const FUZZY_THRESHOLD = 0.5;

const SORT_OPTIONS = [
  { key: "wishlist", label: "Wishlist first", defaultDirection: "asc" },
  { key: "startingBid", label: "Starting bid", defaultDirection: "asc" },
  { key: "bin", label: "BIN", defaultDirection: "asc" },
  { key: "name", label: "Name", defaultDirection: "asc" },
  { key: "offerCount", label: "Most offers", defaultDirection: "desc" },
];

const PAGE_SIZE_OPTIONS = [
  { value: 12, label: "12" },
  { value: 24, label: "24" },
  { value: 48, label: "48" },
  { value: 96, label: "96" },
  { value: Infinity, label: "All" },
];

const state = {
  snapshot: null,
  searchQuery: "",
  wishlistOnly: true,
  ownerFilters: [],
  statusFilters: [],
  hasBinOnly: false,
  maxStartingBid: null,
  showSold: false,
  myBidsFilter: "all",
  sortKey: "wishlist",
  sortDirection: "asc",
  page: 1,
  pageSize: 24,
};

const SOLD_OPTIONS = [
  { key: "hide", label: "Hide sold" },
  { key: "show", label: "Show sold" },
];

const MYBIDS_OPTIONS = [
  { key: "all", label: "All" },
  { key: "only", label: "Only yours" },
  { key: "hide", label: "Hide yours" },
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatValue(value, fallback = "—") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return String(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const AUCTION_END_MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  okt: 9,
};

function parseAuctionEndDate(raw) {
  if (!raw) return null;
  const match = raw.match(/(\d{1,2})\s+([A-Za-z]{3,9})/);
  if (!match) return null;
  const month = AUCTION_END_MONTHS[match[2].slice(0, 3).toLowerCase()];
  const day = Number(match[1]);
  if (month === undefined || day < 1 || day > 31) return null;
  return new Date(2026, month, day);
}

function ordinal(n) {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return `${n}st`;
  if (j === 2 && k !== 12) return `${n}nd`;
  if (j === 3 && k !== 13) return `${n}rd`;
  return `${n}th`;
}

function formatAuctionEndLabel(raw) {
  const date = parseAuctionEndDate(raw);
  if (!date) return escapeHtml(raw);
  const dateLabel = `${date.toLocaleDateString("en-US", { month: "short" })} ${ordinal(date.getDate())}`;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = Math.round((date - startOfToday) / 86400000);
  if (daysLeft >= 0 && daysLeft < 21) {
    const weeksLeft = Math.ceil(daysLeft / 7);
    const weekLabel = weeksLeft === 0 ? "this week" : `${weeksLeft} week${weeksLeft === 1 ? "" : "s"} left`;
    return `${escapeHtml(dateLabel)} (${escapeHtml(weekLabel)})`;
  }
  return escapeHtml(dateLabel);
}

function renderCreditGroup(label, names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const shown = names.slice(0, 4);
  const more = names.length > shown.length ? ` +${names.length - shown.length} more` : "";
  return `${label}: ${shown.map(escapeHtml).join(", ")}${more}`;
}

function renderCredits(item) {
  const groups = [
    renderCreditGroup("Designers", item.designers),
    renderCreditGroup("Artists", item.artists),
  ].filter(Boolean);
  if (!groups.length) return "";
  return `<div class="card-credits">${groups.map((g) => `<div>${g}</div>`).join("")}</div>`;
}

function renderLink(name, link) {
  if (!link) {
    return escapeHtml(formatValue(name));
  }
  return `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${escapeHtml(
    formatValue(name)
  )}</a>`;
}

function formatWeight(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return Number(value).toFixed(2);
}

function renderWeightValue(value) {
  if (value === null || value === undefined || value === "") {
    return '<span class="muted">—</span>';
  }
  const numeric = Math.max(0, Math.min(5, Number(value)));
  const hue = 140 - (numeric / 5) * 140;
  const color = `hsl(${hue} 70% 38%)`;
  return `<span class="weight-value" style="color:${color}">${escapeHtml(
    formatWeight(numeric)
  )}</span><span class="weight-max">/5.00</span>`;
}

function formatBggRank(value) {
  if (value === 0 || value === "0") {
    return "No Rank";
  }
  return formatValue(value);
}

function getRankBadge(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  if (numeric === 1) return " 🏆";
  if (numeric <= 100) return " 🥇";
  if (numeric <= 500) return " 🥈";
  if (numeric <= 1000) return " 🥉";
  return "";
}

function renderBggRank(value) {
  const formatted = formatBggRank(value);
  if (formatted === "No Rank") {
    return escapeHtml(formatted);
  }
  return `${escapeHtml(formatted)}${getRankBadge(value)}`;
}

function formatPlayerCount(item) {
  const min = item.minPlayers;
  const max = item.maxPlayers;
  if (min === null || min === undefined || max === null || max === undefined) {
    return "—";
  }
  return min === max ? `${min}` : `${min}-${max}`;
}

function formatMoney(price) {
  if (!price || price.amount === null || price.amount === undefined || price.amount === "") {
    return null;
  }
  const symbols = { EUR: "€", USD: "$", GBP: "£" };
  const symbol = symbols[price.currency] || "";
  const amount = Number(price.amount);
  const shown = Number.isInteger(amount) ? amount : amount.toFixed(2);
  return symbol ? `${symbol}${shown}` : `${shown} ${price.currency || ""}`.trim();
}

function renderStars(stars) {
  if (stars === null || stars === undefined) return "";
  const n = Math.max(0, Math.min(5, Number(stars)));
  return `<span class="offer-stars">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>`;
}

function offerAmount(offer, field) {
  const price = offer[field];
  return price && price.amount !== null && price.amount !== undefined ? Number(price.amount) : null;
}

// ---------------------------------------------------------------------------
// Fuzzy search
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = temp;
    }
  }
  return row[b.length];
}

function tokenScore(queryToken, nameToken) {
  if (nameToken.includes(queryToken)) return 1;
  const dist = levenshtein(queryToken, nameToken);
  return 1 - dist / Math.max(queryToken.length, nameToken.length);
}

function fuzzyScore(query, name) {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const n = name.toLowerCase();
  if (n.includes(q)) return 1;
  const queryWords = q.split(/\s+/).filter(Boolean);
  const nameWords = n.split(/\s+/).filter(Boolean);
  let total = 0;
  for (const qw of queryWords) {
    let best = 0;
    for (const nw of nameWords) {
      best = Math.max(best, tokenScore(qw, nw));
      if (best === 1) break;
    }
    total += best;
  }
  return total / queryWords.length;
}

// ---------------------------------------------------------------------------
// Filtering + sorting
// ---------------------------------------------------------------------------

function matchesFuzzySearch(item) {
  if (!state.searchQuery) return true;
  return fuzzyScore(state.searchQuery, item.name || "") >= FUZZY_THRESHOLD;
}

function matchesWishlistOnly(item) {
  if (state.myBidsFilter === "only") return true;
  if (SHARED_GAME_ID !== null) return true;
  return !state.wishlistOnly || item.onWishlist === true;
}

function getVisibleWishedBy(item) {
  return (item.wishedBy || []).filter((entry) => {
    const ownerMatches = !state.ownerFilters.length || state.ownerFilters.includes(entry.owner);
    const statusMatches = !state.statusFilters.length || state.statusFilters.includes(entry.status);
    return ownerMatches && statusMatches;
  });
}

function itemBidByOwner(item, owner) {
  const target = owner.toLowerCase();
  return (item.offers || []).some(
    (offer) => (offer.bids?.ours?.user || "").toLowerCase() === target
  );
}

function matchesOwnerStatus(item) {
  if (!state.ownerFilters.length && !state.statusFilters.length) return true;
  if (getVisibleWishedBy(item).length > 0) return true;
  return state.ownerFilters.some((owner) => itemBidByOwner(item, owner));
}

function matchesHasBin(item) {
  if (!state.hasBinOnly) return true;
  return (item.offers || []).some((offer) => offer.bin);
}

function matchesMaxStartingBid(item) {
  if (state.maxStartingBid === null) return true;
  return (item.offers || []).some((offer) => {
    const amount = offerAmount(offer, "startingBid");
    return amount !== null && amount <= state.maxStartingBid;
  });
}

function offerHiddenBySold(offer) {
  return offer.bids?.status === "sold" && offer.bids?.ours?.state !== "won";
}

function matchesSold(item) {
  return state.showSold || (item.offers || []).some((offer) => !offerHiddenBySold(offer));
}

function itemHasOurBids(item) {
  if (state.ownerFilters.length) {
    return state.ownerFilters.some((owner) => itemBidByOwner(item, owner));
  }
  return (item.offers || []).some((offer) => offer.bids?.ours);
}

function matchesMyBids(item) {
  if (state.myBidsFilter === "only") return itemHasOurBids(item);
  if (state.myBidsFilter === "hide") return !itemHasOurBids(item);
  return true;
}

function matchesSharedGame(item) {
  return SHARED_GAME_ID === null || item.objectId === SHARED_GAME_ID;
}

function applyActiveFilters(items) {
  return items.filter(
    (item) =>
      matchesWishlistOnly(item) &&
      matchesOwnerStatus(item) &&
      matchesHasBin(item) &&
      matchesMaxStartingBid(item) &&
      matchesSold(item) &&
      matchesMyBids(item) &&
      matchesSharedGame(item) &&
      matchesFuzzySearch(item)
  );
}

function cheapestOfferValue(item, field) {
  let best = null;
  for (const offer of item.offers || []) {
    const amount = offerAmount(offer, field);
    if (amount === null) continue;
    if (best === null || amount < best) best = amount;
  }
  return best;
}

function sortValueForItem(item, key) {
  switch (key) {
    case "wishlist":
      return item.onWishlist ? 0 : 1;
    case "startingBid":
      return cheapestOfferValue(item, "startingBid");
    case "bin":
      return cheapestOfferValue(item, "bin");
    case "name":
      return (item.name || "").toLowerCase();
    case "offerCount":
      return item.offerCount ?? (item.offers || []).length;
    default:
      return null;
  }
}

function compareValues(a, b, direction) {
  const dir = direction === "desc" ? -1 : 1;
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1; // nulls always last
  if (bNull) return -1;
  if (typeof a === "string" || typeof b === "string") {
    return String(a).localeCompare(String(b)) * dir;
  }
  return (a - b) * dir;
}

function sortItems(items) {
  const scores = state.searchQuery
    ? new Map(items.map((item) => [item, fuzzyScore(state.searchQuery, item.name || "")]))
    : null;
  return [...items].sort((x, y) => {
    if (scores) {
      const scoreDiff = scores.get(y) - scores.get(x);
      if (scoreDiff !== 0) return scoreDiff;
    }
    const primary = compareValues(
      sortValueForItem(x, state.sortKey),
      sortValueForItem(y, state.sortKey),
      state.sortDirection
    );
    if (primary !== 0) return primary;
    return String(x.name || "").localeCompare(String(y.name || ""));
  });
}

function sortOffersForDisplay(offers) {
  return [...offers].sort((a, b) => {
    const binCompare = compareValues(offerAmount(a, "bin"), offerAmount(b, "bin"), "asc");
    if (binCompare !== 0) return binCompare;
    return compareValues(offerAmount(a, "startingBid"), offerAmount(b, "startingBid"), "asc");
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderWishedByBadges(item) {
  const visible = getVisibleWishedBy(item);
  const entries = visible.length ? visible : item.wishedBy || [];
  if (!entries.length) return "";
  return `<div class="pill-list">${entries
    .map(
      (entry) =>
        `<span class="pill prio-2">${escapeHtml(entry.owner)} · ${escapeHtml(entry.status)}</span>`
    )
    .join("")}</div>`;
}

function renderBidState(offer) {
  const b = offer.bids;
  if (!b) return "";

  let statusHtml = "";
  if (b.status === "live") {
    const amount = formatMoney(b.currentBid);
    statusHtml = `<span class="bid-status bid-status--live">Current bid ${
      amount ? escapeHtml(amount) : "—"
    } · ${b.bidCount} bid${b.bidCount === 1 ? "" : "s"}</span>`;
  } else if (b.status === "open") {
    statusHtml = `<span class="bid-status bid-status--open">No bids yet</span>`;
  } else if (b.status === "sold") {
    statusHtml = `<span class="bid-status bid-status--sold">Sold (BIN)</span>`;
  }

  let yoursHtml = "";
  if (b.ours) {
    const labels = {
      leading: "Winning",
      outbid: "Outbid",
      won: "Won (BIN)",
      lost: "Missed — BIN'd",
    };
    const label = labels[b.ours.state];
    if (label) {
      const who = b.ours.user ? ` · ${escapeHtml(b.ours.user)}` : "";
      const amount = formatMoney({ amount: b.ours.amount, currency: "EUR" });
      const amt = amount ? ` · ${escapeHtml(amount)}` : "";
      yoursHtml = `<span class="bid-you bid-you--${b.ours.state}">${label}${who}${amt}</span>`;
    }
  }

  if (!statusHtml && !yoursHtml) return "";
  return `<div class="offer-bids">${statusHtml}${yoursHtml}</div>`;
}

function renderOfferRow(offer) {
  const stars = renderStars(offer.conditionStars);
  const condition = offer.condition ? escapeHtml(offer.condition) : "";
  const bid = formatMoney(offer.startingBid);
  const bin = formatMoney(offer.bin);
  const metaParts = [];
  if (offer.version) metaParts.push(escapeHtml(offer.version));
  if (offer.languageDependency) metaParts.push(escapeHtml(offer.languageDependency));
  if (offer.auctionEnds) metaParts.push(`Ends ${formatAuctionEndLabel(offer.auctionEnds)}`);

  return `
    <div class="offer-row">
      <a class="offer-seller" href="https://boardgamegeek.com/user/${encodeURIComponent(
        offer.seller
      )}" target="_blank" rel="noreferrer">${escapeHtml(formatValue(offer.seller))}</a>
      <span class="detail-value">${condition}${stars ? ` ${stars}` : ""}</span>
      <span class="detail-line"><span class="detail-label">Starting bid</span><span class="detail-value">${
        bid ? escapeHtml(bid) : '<span class="muted">—</span>'
      }</span></span>
      <span class="detail-line"><span class="detail-label">BIN</span><span class="detail-value">${
        bin ? escapeHtml(bin) : '<span class="muted">—</span>'
      }</span></span>
      ${renderBidState(offer)}
      ${metaParts.length ? `<div class="offer-meta muted">${metaParts.join(" · ")}</div>` : ""}
      <a class="offer-bid-link" href="${escapeHtml(offer.listingUrl)}" target="_blank" rel="noreferrer">Place bid ↗</a>
    </div>
  `;
}

function visibleOffers(item) {
  return (item.offers || []).filter((offer) => state.showSold || !offerHiddenBySold(offer));
}

function renderOffers(item) {
  const sorted = sortOffersForDisplay(visibleOffers(item));
  if (!sorted.length) {
    return '<span class="muted">No offers</span>';
  }
  return `<div class="offer-list">${sorted.map(renderOfferRow).join("")}</div>`;
}

function renderCard(item) {
  const thumb = item.thumbnail
    ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.name)} cover" loading="lazy">`
    : '<div class="card-thumb placeholder">No image</div>';
  const image = item.link
    ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${thumb}</a>`
    : thumb;

  const yearLabel = item.yearPublished ? ` (${escapeHtml(item.yearPublished)})` : "";
  const offerCount = visibleOffers(item).length;
  const offerBadge = `<span class="avail-badge">${offerCount} offer${offerCount === 1 ? "" : "s"}</span>`;

  const detailLines = [];
  if (item.minPlayers != null && item.maxPlayers != null) {
    detailLines.push(
      `<div class="detail-line"><span class="detail-label">Players</span><span class="detail-value">${escapeHtml(
        formatPlayerCount(item)
      )}</span></div>`
    );
  }
  if (item.weight != null) {
    detailLines.push(
      `<div class="detail-line"><span class="detail-label">Weight</span><span class="detail-value">${renderWeightValue(
        item.weight
      )}</span></div>`
    );
  }
  if (item.bggAverageRating != null) {
    detailLines.push(
      `<div class="detail-line"><span class="detail-label">BGG Rating</span><span class="detail-value">${escapeHtml(
        formatValue(item.bggAverageRating)
      )}</span></div>`
    );
  }
  if (item.bggRank != null) {
    detailLines.push(
      `<div class="detail-line"><span class="detail-label">BGG Rank</span><span class="detail-value">${renderBggRank(
        item.bggRank
      )}</span></div>`
    );
  }

  const wishedBy = renderWishedByBadges(item);

  return `
    <article class="game-card">
      <div class="card-thumb-wrap">
        ${image}
      </div>
      <div class="card-body">
        <div class="card-heading">
          <div>
            <h3 class="game-name">${renderLink(item.name, item.link)}${yearLabel}</h3>
            <div class="game-meta">#${escapeHtml(formatValue(item.objectId))}</div>
          </div>
          <div class="card-heading-actions">${offerBadge}${renderShareButton(item.objectId)}</div>
        </div>
        ${detailLines.length ? `<div class="detail-list">${detailLines.join("")}</div>` : ""}
        ${renderCredits(item)}
        ${wishedBy ? `<div class="card-section">${wishedBy}</div>` : ""}
        <div class="card-section">
          ${renderOffers(item)}
        </div>
      </div>
    </article>
  `;
}

function csvField(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function exportFilteredToCsv() {
  const items = state.snapshot?.items || [];
  const filtered = sortItems(applyActiveFilters(items));

  const headers = [
    "Game",
    "Year",
    "BGG Link",
    "Seller",
    "Condition",
    "Condition Stars",
    "Starting Bid",
    "BIN",
    "Current Bid",
    "Current Bidder",
    "Version",
    "Language",
    "Auction Ends",
    "Listing URL",
  ];
  const rows = [headers];

  for (const item of filtered) {
    const offers = visibleOffers(item);
    if (!offers.length) {
      rows.push([item.name, item.yearPublished, item.link, "", "", "", "", "", "", "", "", "", "", ""]);
      continue;
    }
    for (const offer of offers) {
      rows.push([
        item.name,
        item.yearPublished,
        item.link,
        offer.seller,
        offer.condition,
        offer.conditionStars,
        formatMoney(offer.startingBid),
        formatMoney(offer.bin),
        formatMoney(offer.bids?.currentBid),
        offer.bids?.currentBidder,
        offer.version,
        offer.language,
        offer.auctionEnds,
        offer.listingUrl,
      ]);
    }
  }

  const csv = rows.map((row) => row.map(csvField).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "essen26-auction.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderContent() {
  const content = document.getElementById("content");
  const pagination = document.getElementById("pagination");
  const statusPill = document.getElementById("status-pill");

  const items = state.snapshot?.items || [];
  const filtered = sortItems(applyActiveFilters(items));

  const totalPages =
    state.pageSize === Infinity ? 1 : Math.max(1, Math.ceil(filtered.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;

  const start = state.pageSize === Infinity ? 0 : (state.page - 1) * state.pageSize;
  const end = state.pageSize === Infinity ? filtered.length : start + state.pageSize;
  const pageItems = filtered.slice(start, end);

  if (!filtered.length) {
    content.innerHTML =
      '<div class="empty-state">No games match the current filters.</div>';
  } else {
    content.innerHTML = `<div class="card-list">${pageItems
      .map((item) => renderCard(item))
      .join("")}</div>`;
  }
  initShareButtons(content);

  const sortLabel = SORT_OPTIONS.find((o) => o.key === state.sortKey)?.label || state.sortKey;
  const arrow = state.sortDirection === "asc" ? "↑" : "↓";
  statusPill.className = "status";
  statusPill.textContent = `${filtered.length} game${
    filtered.length === 1 ? "" : "s"
  } shown · sorted by ${sortLabel} ${arrow}`;

  renderPaginationControls(pagination, totalPages);
  renderActiveFilterChips();
}

function renderPaginationControls(container, totalPages) {
  if (state.pageSize === Infinity || totalPages <= 1) {
    container.innerHTML = "";
    return;
  }
  const pages = [];
  const add = (p) => pages.push(p);
  const windowSize = 1;
  for (let p = 1; p <= totalPages; p++) {
    if (
      p === 1 ||
      p === totalPages ||
      (p >= state.page - windowSize && p <= state.page + windowSize)
    ) {
      add(p);
    } else if (pages[pages.length - 1] !== "…") {
      add("…");
    }
  }
  const btn = (label, page, opts = {}) => {
    const disabled = opts.disabled ? " disabled" : "";
    const active = opts.active ? " active" : "";
    if (label === "…") return `<span class="page-ellipsis">…</span>`;
    return `<button class="page-btn${active}"${disabled} data-page="${page}">${label}</button>`;
  };
  container.innerHTML = [
    btn("‹ Prev", state.page - 1, { disabled: state.page === 1 }),
    ...pages.map((p) => (p === "…" ? btn("…") : btn(p, p, { active: p === state.page }))),
    btn("Next ›", state.page + 1, { disabled: state.page === totalPages }),
  ].join("");
  container.querySelectorAll("button[data-page]").forEach((el) => {
    el.addEventListener("click", () => {
      state.page = Number(el.dataset.page);
      renderContent();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function renderActiveFilterChips() {
  const container = document.getElementById("active-filters");
  const chips = [];
  if (state.wishlistOnly && SHARED_GAME_ID === null) {
    chips.push({
      label: "Wishlist only",
      remove: () => {
        state.wishlistOnly = false;
        document.getElementById("wishlist-only-toggle").checked = false;
        state.page = 1;
        renderContent();
      },
    });
  }
  for (const owner of state.ownerFilters) {
    chips.push({ label: `Wanted by: ${owner}`, remove: () => toggleOwnerFilter(owner) });
  }
  for (const status of state.statusFilters) {
    chips.push({ label: `Status: ${status}`, remove: () => toggleStatusFilter(status) });
  }
  if (state.hasBinOnly) {
    chips.push({
      label: "Has Buy-It-Now",
      remove: () => {
        state.hasBinOnly = false;
        document.getElementById("has-bin-toggle").checked = false;
        state.page = 1;
        renderContent();
      },
    });
  }
  if (state.maxStartingBid !== null) {
    chips.push({
      label: `Max bid: €${state.maxStartingBid}`,
      remove: () => {
        state.maxStartingBid = null;
        document.getElementById("max-starting-bid-filter").value = "";
        state.page = 1;
        renderContent();
      },
    });
  }
  if (state.myBidsFilter !== "all") {
    chips.push({
      label: state.myBidsFilter === "only" ? "Your bids: Only yours" : "Your bids: Hidden",
      remove: () => {
        state.myBidsFilter = "all";
        renderMyBidsOptions();
        state.page = 1;
        renderContent();
      },
    });
  }
  container.innerHTML = chips
    .map((_, i) => `<button class="filter-chip" data-chip="${i}"></button>`)
    .join("");
  container.querySelectorAll("button[data-chip]").forEach((el, i) => {
    el.textContent = `${chips[i].label} ✕`;
    el.addEventListener("click", chips[i].remove);
  });
}

// ---------------------------------------------------------------------------
// Filter UI
// ---------------------------------------------------------------------------

function toggleOwnerFilter(owner) {
  const i = state.ownerFilters.indexOf(owner);
  if (i >= 0) state.ownerFilters.splice(i, 1);
  else state.ownerFilters.push(owner);
  state.page = 1;
  syncFilterUI();
  renderContent();
}

function toggleStatusFilter(status) {
  const i = state.statusFilters.indexOf(status);
  if (i >= 0) state.statusFilters.splice(i, 1);
  else state.statusFilters.push(status);
  state.page = 1;
  syncFilterUI();
  renderContent();
}

function buildCheckboxOption(cls, checked, label, onChange) {
  const wrap = document.createElement("label");
  wrap.className = cls;
  if (checked) wrap.classList.add("active");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", onChange);
  wrap.appendChild(input);
  wrap.appendChild(document.createTextNode(label));
  return wrap;
}

function renderOwnerFilterGrid() {
  const grid = document.getElementById("owner-filter-grid");
  const counts = {};
  for (const item of state.snapshot.items) {
    for (const entry of item.wishedBy || []) {
      counts[entry.owner] = (counts[entry.owner] || 0) + 1;
    }
  }
  grid.innerHTML = "";
  for (const owner of state.snapshot.owners || []) {
    const checked = state.ownerFilters.includes(owner);
    grid.appendChild(
      buildCheckboxOption(
        "owner-filter-option",
        checked,
        `${owner} (${counts[owner] || 0})`,
        () => toggleOwnerFilter(owner)
      )
    );
  }
}

function renderStatusFilterGrid() {
  const grid = document.getElementById("status-filter-grid");
  const counts = {};
  for (const item of state.snapshot.items) {
    for (const entry of item.wishedBy || []) {
      counts[entry.status] = (counts[entry.status] || 0) + 1;
    }
  }
  grid.innerHTML = "";
  for (const status of state.snapshot.statuses || []) {
    const checked = state.statusFilters.includes(status);
    grid.appendChild(
      buildCheckboxOption(
        "status-filter-option",
        checked,
        `${status} (${counts[status] || 0})`,
        () => toggleStatusFilter(status)
      )
    );
  }
}

function syncFilterUI() {
  renderOwnerFilterGrid();
  renderStatusFilterGrid();
}

function renderSortOptions() {
  const container = document.getElementById("sort-options");
  container.innerHTML = "";
  for (const option of SORT_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    const isActive = state.sortKey === option.key;
    if (isActive) btn.classList.add("active");
    const arrow = isActive ? (state.sortDirection === "asc" ? " ↑" : " ↓") : "";
    btn.textContent = option.label + arrow;
    btn.addEventListener("click", () => {
      if (state.sortKey === option.key) {
        state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = option.key;
        state.sortDirection = option.defaultDirection;
      }
      state.page = 1;
      renderSortOptions();
      renderContent();
    });
    container.appendChild(btn);
  }
}

function renderPageSizeOptions() {
  const container = document.getElementById("page-size-options");
  container.innerHTML = "";
  for (const option of PAGE_SIZE_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    if (state.pageSize === option.value) btn.classList.add("active");
    btn.textContent = option.label;
    btn.addEventListener("click", () => {
      state.pageSize = option.value;
      state.page = 1;
      localStorage.setItem("essenAuctionPageSize", String(option.value));
      renderPageSizeOptions();
      renderContent();
    });
    container.appendChild(btn);
  }
}

function renderSoldOptions() {
  const container = document.getElementById("sold-options");
  container.innerHTML = "";
  for (const option of SOLD_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    const isActive = (state.showSold ? "show" : "hide") === option.key;
    if (isActive) btn.classList.add("active");
    btn.textContent = option.label;
    btn.addEventListener("click", () => {
      state.showSold = option.key === "show";
      state.page = 1;
      renderSoldOptions();
      renderContent();
    });
    container.appendChild(btn);
  }
}

function renderMyBidsOptions() {
  const container = document.getElementById("mybids-options");
  container.innerHTML = "";
  for (const option of MYBIDS_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    if (state.myBidsFilter === option.key) btn.classList.add("active");
    btn.textContent = option.label;
    btn.addEventListener("click", () => {
      state.myBidsFilter = option.key;
      state.page = 1;
      renderMyBidsOptions();
      renderContent();
    });
    container.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Controls + boot
// ---------------------------------------------------------------------------

function setupControls() {
  const searchDesktop = document.getElementById("search-input");
  const searchMobile = document.getElementById("search-input-mobile");
  const onSearch = (value) => {
    state.searchQuery = value;
    state.page = 1;
    if (searchDesktop.value !== value) searchDesktop.value = value;
    if (searchMobile.value !== value) searchMobile.value = value;
    renderContent();
  };
  searchDesktop.addEventListener("input", (e) => onSearch(e.target.value));
  searchMobile.addEventListener("input", (e) => onSearch(e.target.value));

  document.getElementById("wishlist-only-toggle").addEventListener("change", (e) => {
    state.wishlistOnly = e.target.checked;
    state.page = 1;
    renderContent();
  });

  document.getElementById("has-bin-toggle").addEventListener("change", (e) => {
    state.hasBinOnly = e.target.checked;
    state.page = 1;
    renderContent();
  });

  document.getElementById("max-starting-bid-filter").addEventListener("input", (e) => {
    state.maxStartingBid = e.target.value ? Number(e.target.value) : null;
    state.page = 1;
    renderContent();
  });

  document.getElementById("clear-owner-filters").addEventListener("click", () => {
    state.ownerFilters = [];
    state.page = 1;
    syncFilterUI();
    renderContent();
  });
  document.getElementById("clear-status-filters").addEventListener("click", () => {
    state.statusFilters = [];
    state.page = 1;
    syncFilterUI();
    renderContent();
  });

  document.getElementById("export-csv-btn").addEventListener("click", exportFilteredToCsv);

  const savedPageSize = localStorage.getItem("essenAuctionPageSize");
  if (savedPageSize !== null) {
    state.pageSize = savedPageSize === "Infinity" ? Infinity : Number(savedPageSize);
  }
}

function setupMobileNav() {
  const toggleBtn = document.getElementById("filter-toggle-btn");
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("drawer-backdrop");
  const closeBtn = document.getElementById("sidebar-close-btn");
  if (!toggleBtn || !sidebar) return;
  const open = () => {
    sidebar.classList.add("sidebar--open");
    backdrop.classList.add("drawer-backdrop--visible");
  };
  const close = () => {
    sidebar.classList.remove("sidebar--open");
    backdrop.classList.remove("drawer-backdrop--visible");
  };
  toggleBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
}

function setupThemeToggle() {
  const lightBtn = document.getElementById("theme-light-btn");
  const darkBtn = document.getElementById("theme-dark-btn");
  if (!lightBtn || !darkBtn) return;

  function getEffectiveTheme() {
    const saved = localStorage.getItem("theme");
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
    lightBtn.classList.toggle("active", theme === "light");
    darkBtn.classList.toggle("active", theme === "dark");
  }
  applyTheme(getEffectiveTheme());
  lightBtn.addEventListener("click", () => applyTheme("light"));
  darkBtn.addEventListener("click", () => applyTheme("dark"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem("theme")) applyTheme(e.matches ? "dark" : "light");
  });
}

function formatGeneratedAt(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderMeta() {
  const snap = state.snapshot;
  document.getElementById("meta-matches").textContent = String(snap.matchedGameCount ?? "—");
  document.getElementById("meta-listings").textContent = String(snap.listingCount ?? "—");
  document.getElementById("meta-games").textContent = String(snap.gameCount ?? "—");
  document.getElementById("meta-synced").textContent = formatGeneratedAt(snap.generatedAt);
}

async function loadSnapshot() {
  const statusPill = document.getElementById("status-pill");
  const content = document.getElementById("content");
  try {
    const response = await fetch("./data/essen26_auction.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.snapshot = await response.json();
  } catch (error) {
    statusPill.className = "status error";
    statusPill.textContent = "Could not load snapshot";
    const hint =
      location.protocol === "file:"
        ? " Serve the site over http (e.g. <span class=\"code\">python3 -m http.server</span>) so the JSON can load."
        : "";
    content.innerHTML = `<div class="empty-state">Failed to load <span class="code">data/essen26_auction.json</span>.${hint}</div>`;
    return;
  }

  renderMeta();
  syncFilterUI();
  renderSortOptions();
  renderSoldOptions();
  renderMyBidsOptions();
  renderPageSizeOptions();
  renderContent();
}

setupControls();
setupMobileNav();
setupThemeToggle();
loadSnapshot();
