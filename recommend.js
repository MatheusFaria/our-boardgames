const FUZZY_THRESHOLD = 0.5;

const CATEGORIES = [
  { key: "designers", label: "Designer", noun: "designer" },
  { key: "mechanics", label: "Mechanics", noun: "mechanic" },
  { key: "publishers", label: "Publisher", noun: "publisher" },
  { key: "artists", label: "Artist", noun: "artist" },
];

const SORT_OPTIONS = [
  { key: "rare", label: "Rare finds" },
  { key: "match", label: "Best match" },
  { key: "bggRank", label: "BGG rank" },
  { key: "name", label: "Name" },
];

const RARE_RANK_CAP = 3000;
const RARE_PRICE_REF = 25;

const SOURCE_OPTIONS = [
  { key: "all", label: "All" },
  { key: "preview", label: "Preview" },
  { key: "auction", label: "Auction" },
];

const CONFIDENCE_OPTIONS = [
  { key: "all", label: "All" },
  { key: "medium", label: "Medium+" },
  { key: "strong", label: "Strong" },
];

const EXPANSION_OPTIONS = [
  { key: "hide", label: "Hidden" },
  { key: "show", label: "Shown" },
];

const DISLIKED_OPTIONS = [
  { key: "hide", label: "Hidden" },
  { key: "show", label: "Shown" },
];

const VOTED_OPTIONS = [
  { key: "all", label: "All" },
  { key: "hide", label: "Hide voted" },
  { key: "only", label: "Only voted" },
];

const SOLD_OPTIONS = [
  { key: "hide", label: "Hide sold" },
  { key: "show", label: "Show sold" },
];

const MYBIDS_OPTIONS = [
  { key: "all", label: "All" },
  { key: "only", label: "Only yours" },
  { key: "hide", label: "Hide yours" },
];

const TIER_RANK = { light: 0, medium: 1, strong: 2 };

const MATCH_PREPOSITIONS = {
  designers: "by",
  artists: "by",
  publishers: "from",
  mechanics: "with",
};

const CURRENCY_SYMBOLS = { EUR: "€", USD: "$", GBP: "£" };

const PAGE_SIZE_OPTIONS = [
  { value: 12, label: "12" },
  { value: 24, label: "24" },
  { value: 48, label: "48" },
  { value: 96, label: "96" },
  { value: Infinity, label: "All" },
];

const MECHANIC_OVERALL = "__overall__";

const state = {
  collection: null,
  essen: null,
  auction: null,
  users: [],
  user: null,
  category: "designers",
  selectedMechanic: MECHANIC_OVERALL,
  searchQuery: "",
  sortKey: "rare",
  sourceFilter: "all",
  confidenceFilter: "all",
  expansionFilter: "hide",
  playerMin: null,
  playerMax: null,
  page: 1,
  pageSize: 24,
  votes: {},
  dislikedFilter: "hide",
  votedFilter: "all",
  showSold: false,
  myBidsFilter: "all",
};

// ---------------------------------------------------------------------------
// Vote storage
// ---------------------------------------------------------------------------

function votesStorageKey(user) {
  return `obg:recVotes:v1:${user}`;
}
function loadVotes(user) {
  state.votes = {};
  if (!user) return;
  try {
    const raw = localStorage.getItem(votesStorageKey(user));
    if (raw) state.votes = JSON.parse(raw) || {};
  } catch (e) {
    state.votes = {};
  }
}
function saveVotes(user) {
  if (!user) return;
  try {
    localStorage.setItem(votesStorageKey(user), JSON.stringify(state.votes));
  } catch (e) {}
}
function getVote(objectId) {
  return state.votes[String(objectId)] || 0;
}
function setVote(objectId, vote) {
  const key = String(objectId);
  if (state.votes[key] === vote) delete state.votes[key];
  else state.votes[key] = vote;
  saveVotes(state.user);
  renderContent();
  renderDislikedOptions();
}

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

function matchesSharedGame(item) {
  return SHARED_GAME_ID === null || item.objectId === SHARED_GAME_ID;
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
  return Number(value).toFixed(2);
}

function renderWeightValue(value) {
  const numeric = Math.max(0, Math.min(5, Number(value)));
  const hue = 140 - (numeric / 5) * 140;
  const color = `hsl(${hue} 70% 38%)`;
  return `<span class="weight-value" style="color:${color}">${escapeHtml(
    formatWeight(numeric)
  )}</span><span class="weight-max">/5.00</span>`;
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
  return `${escapeHtml(formatValue(value))}${getRankBadge(value)}`;
}

function formatPlayerCount(item) {
  const min = item.minPlayers;
  const max = item.maxPlayers;
  return min === max ? `${min}` : `${min}-${max}`;
}

function formatMoney(price) {
  if (!price || price.amount == null) return "";
  const symbol = CURRENCY_SYMBOLS[price.currency] || "";
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
  return price && price.amount != null ? Number(price.amount) : null;
}

function sortOffersForDisplay(offers) {
  return [...offers].sort((a, b) => {
    const binCmp = compareValues(offerAmount(a, "bin"), offerAmount(b, "bin"));
    if (binCmp !== 0) return binCmp;
    return compareValues(offerAmount(a, "startingBid"), offerAmount(b, "startingBid"));
  });
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
  if (offer.auctionEnds) metaParts.push(`Ends ${escapeHtml(offer.auctionEnds)}`);
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

function offerHiddenBySold(offer) {
  return offer.bids?.status === "sold" && offer.bids?.ours?.state !== "won";
}

function renderOffers(match) {
  const visibleOffers = (match.offers || []).filter(
    (offer) => state.showSold || !offerHiddenBySold(offer)
  );
  const sorted = sortOffersForDisplay(visibleOffers);
  if (!sorted.length) return "";
  return `<div class="offer-list">${sorted.map(renderOfferRow).join("")}</div>`;
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

function matchesFuzzySearch(item) {
  if (!state.searchQuery) return true;
  return fuzzyScore(state.searchQuery, item.name || "") >= FUZZY_THRESHOLD;
}

function matchesPlayerRange(item) {
  if (state.playerMin === null && state.playerMax === null) {
    return true;
  }

  const gameMin = item.minPlayers;
  const gameMax = item.maxPlayers;
  if (gameMin === null || gameMin === undefined || gameMax === null || gameMax === undefined) {
    return false;
  }

  const selectedMin = state.playerMin ?? 1;
  const selectedMax = state.playerMax ?? Number.MAX_SAFE_INTEGER;
  return gameMax >= selectedMin && gameMin <= selectedMax;
}

// ---------------------------------------------------------------------------
// Taste model
// ---------------------------------------------------------------------------

function categoryLabel(key) {
  return CATEGORIES.find((c) => c.key === key)?.label || key;
}

function categoryNoun(key) {
  return CATEGORIES.find((c) => c.key === key)?.noun || key;
}

function isMechanicsSpecific() {
  return state.category === "mechanics" && state.selectedMechanic !== MECHANIC_OVERALL;
}

function getOwnedGames(user) {
  return (state.collection.items || []).filter((item) =>
    (item.ownerDetails || []).some(
      (detail) => detail.owner === user && (detail.statuses || []).includes("Owned")
    )
  );
}

function getOwnedIds(user) {
  return new Set(getOwnedGames(user).map((item) => item.objectId));
}

function hasRegisteredInterest(item, user) {
  const target = (user || "").toLowerCase();
  return (item.interested || []).some((entry) => (entry.user || "").toLowerCase() === target);
}

// value -> array of owned game names that carry that value in the given category
function getOwnedValueMap(user, categoryKey) {
  const map = new Map();
  for (const game of getOwnedGames(user)) {
    if (game.itemType === "expansion") continue;
    for (const value of game[categoryKey] || []) {
      if (!map.has(value)) map.set(value, []);
      map.get(value).push(game.name);
    }
  }
  return map;
}

function getOwnedMechanicCounts(user) {
  return getOwnedValueMap(user, "mechanics");
}

// ---------------------------------------------------------------------------
// Matching + ranking
// ---------------------------------------------------------------------------

function isEmptyValue(value) {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// Fallback expansion set from the collection, for candidates the Essen fetch
// scripts haven't backfilled an itemType for yet.
function buildExpansionIds() {
  const ids = new Set();
  for (const item of state.collection?.items || []) {
    if (item.itemType === "expansion") ids.add(item.objectId);
  }
  return ids;
}

function isExpansion(item, expansionIds) {
  return item.itemType === "expansion" || expansionIds.has(item.objectId);
}

// Unified pool of Essen preview + auction candidates, deduped by objectId.
function buildCandidates() {
  const candidates = new Map();
  for (const item of state.essen?.items || []) {
    candidates.set(item.objectId, { item, inPreview: true, inAuction: false, offers: null });
  }
  for (const auctionItem of state.auction?.items || []) {
    const existing = candidates.get(auctionItem.objectId);
    if (existing) {
      existing.inAuction = true;
      existing.offers = auctionItem.offers || [];
      for (const category of CATEGORIES) {
        if (isEmptyValue(existing.item[category.key]) && !isEmptyValue(auctionItem[category.key])) {
          existing.item[category.key] = auctionItem[category.key];
        }
      }
    } else {
      candidates.set(auctionItem.objectId, {
        item: auctionItem,
        inPreview: false,
        inAuction: true,
        offers: auctionItem.offers || [],
      });
    }
  }
  return candidates;
}

// Document frequency of each category value across the non-expansion candidate
// pool, used to dampen generic values (e.g. "Hand Management") in the affinity
// score. Expansions are excluded so they never influence the weighting.
function buildCandidateDf(candidates, categoryKey, expansionIds) {
  const df = new Map();
  let total = 0;
  for (const candidate of candidates.values()) {
    if (isExpansion(candidate.item, expansionIds)) continue;
    total += 1;
    const values = new Set(candidate.item[categoryKey] || []);
    for (const value of values) {
      df.set(value, (df.get(value) || 0) + 1);
    }
  }
  return { df, total };
}

function tierFor(maxOwned) {
  if (maxOwned >= 4) return "strong";
  if (maxOwned >= 2) return "medium";
  return "light";
}

function isBetterTopValue(candidate, current) {
  if (candidate.weight !== current.weight) return candidate.weight > current.weight;
  if (candidate.ownedCount !== current.ownedCount) return candidate.ownedCount > current.ownedCount;
  return candidate.value.localeCompare(current.value) < 0;
}

const VOTE_GAIN = 1.5;

function computeMatches() {
  const user = state.user;
  const categoryKey = state.category;
  if (!user) return [];

  const ownedIds = getOwnedIds(user);
  const specific = isMechanicsSpecific();
  const valueMap = getOwnedValueMap(user, categoryKey);
  const targetValues = specific ? [state.selectedMechanic] : [...valueMap.keys()];
  if (!targetValues.length) return [];

  const candidates = buildCandidates();
  const expansionIds = buildExpansionIds();
  const { df, total } = buildCandidateDf(candidates, categoryKey, expansionIds);
  const minTierRank = TIER_RANK[state.confidenceFilter] ?? 0;

  const voteWeights = new Map();
  for (const [objId, vote] of Object.entries(state.votes)) {
    const c = candidates.get(Number(objId));
    if (!c) continue;
    for (const value of c.item[categoryKey] || []) {
      voteWeights.set(value, (voteWeights.get(value) || 0) + vote);
    }
  }

  const results = [];
  for (const candidate of candidates.values()) {
    if (state.sourceFilter === "preview" && !candidate.inPreview) continue;
    if (state.sourceFilter === "auction" && !candidate.inAuction) continue;
    const item = candidate.item;
    if (!matchesSharedGame(item)) continue;
    if (ownedIds.has(item.objectId)) continue;
    if (hasRegisteredInterest(item, user)) continue;
    if (state.expansionFilter === "hide" && isExpansion(item, expansionIds)) continue;
    if (!matchesPlayerRange(item)) continue;
    if (state.dislikedFilter === "hide" && getVote(item.objectId) === -1) continue;
    const voteState = getVote(item.objectId);
    if (state.votedFilter === "hide" && voteState !== 0) continue;
    if (state.votedFilter === "only" && voteState === 0) continue;
    if (
      !state.showSold &&
      candidate.inAuction &&
      (item.offers || []).length &&
      (item.offers || []).every(offerHiddenBySold)
    )
      continue;
    const hasOurBids = (item.offers || []).some((o) => o.bids?.ours);
    if (state.myBidsFilter === "only" && !hasOurBids) continue;
    if (state.myBidsFilter === "hide" && hasOurBids) continue;
    const itemValues = item[categoryKey] || [];
    const overlap = targetValues.filter((value) => itemValues.includes(value));
    if (!overlap.length) continue;

    let score = 0;
    let maxOwned = 0;
    let top = null;
    for (const value of overlap) {
      const ownedCount = valueMap.get(value)?.length || 0;
      const idf = Math.log(total / Math.max(1, df.get(value) || 1));
      const weight = ownedCount * idf;
      score += weight;
      if (ownedCount > maxOwned) maxOwned = ownedCount;
      const contender = { value, weight, ownedCount };
      if (!top || isBetterTopValue(contender, top)) top = contender;
    }

    let voteBonus = 0;
    for (const value of item[categoryKey] || []) {
      const net = Math.max(-3, Math.min(3, voteWeights.get(value) || 0));
      if (net === 0) continue;
      const idf = Math.log(total / Math.max(1, df.get(value) || 1));
      voteBonus += net * idf * VOTE_GAIN;
    }
    score += voteBonus;

    const tier = tierFor(maxOwned);
    if (TIER_RANK[tier] < minTierRank) continue;

    results.push({
      item,
      overlap,
      valueMap,
      inPreview: candidate.inPreview,
      inAuction: candidate.inAuction,
      offers: candidate.offers,
      score,
      topValue: top.value,
      topValueOwned: top.ownedCount,
      maxOwned,
      tier,
    });
  }
  return results;
}

function cheapestOfferAmount(match) {
  if (!match.inAuction || !match.offers) return null;
  let min = null;
  for (const offer of match.offers) {
    const amounts = [offer.startingBid?.amount, offer.bin?.amount].filter(
      (amount) => amount != null
    );
    for (const amount of amounts) {
      const numeric = Number(amount);
      if (min === null || numeric < min) min = numeric;
    }
  }
  return min;
}

function rareScore(match, maxAffinity) {
  const item = match.item;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const rankScore =
    !match.inPreview && item.bggRank != null ? clamp(1 - item.bggRank / RARE_RANK_CAP) : null;
  const ratingScore =
    item.bggAverageRating != null ? clamp((Number(item.bggAverageRating) - 6) / 2.5) : 0;
  let pedigree;
  if (match.inAuction && rankScore != null) {
    pedigree = 0.65 * rankScore + 0.35 * ratingScore;
  } else {
    pedigree = ratingScore;
  }
  const price = cheapestOfferAmount(match);
  const deal = match.inAuction && price != null ? 0.5 + RARE_PRICE_REF / (price + RARE_PRICE_REF) : 1;
  const ratio = maxAffinity > 0 ? (match.score || 0) / maxAffinity : 0;
  const affinity = 1 + Math.max(-0.5, ratio);
  return pedigree * deal * affinity;
}

function compareValues(a, b, nullsLast = true) {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return nullsLast ? 1 : -1;
  if (bNull) return nullsLast ? -1 : 1;
  if (typeof a === "string" || typeof b === "string") {
    return String(a).localeCompare(String(b));
  }
  return a - b;
}

function sortMatches(matches) {
  const maxAffinity = matches.reduce((m, x) => Math.max(m, x.score || 0), 0);
  matches.forEach((m) => {
    m._rare = rareScore(m, maxAffinity);
  });
  return [...matches].sort((x, y) => {
    if (state.sortKey === "rare") {
      if (x._rare !== y._rare) return y._rare - x._rare;
      const rank = compareValues(x.item.bggRank, y.item.bggRank);
      if (rank !== 0) return rank;
      if (x.score !== y.score) return y.score - x.score;
      return String(x.item.name || "").localeCompare(String(y.item.name || ""));
    }
    if (state.sortKey === "bggRank") {
      const rank = compareValues(x.item.bggRank, y.item.bggRank);
      if (rank !== 0) return rank;
      return String(x.item.name || "").localeCompare(String(y.item.name || ""));
    }
    if (state.sortKey === "name") {
      return String(x.item.name || "").localeCompare(String(y.item.name || ""));
    }
    // Best match: affinity score desc, then BGG rank asc (nulls last), then name
    if (x.score !== y.score) {
      return y.score - x.score;
    }
    const rank = compareValues(x.item.bggRank, y.item.bggRank);
    if (rank !== 0) return rank;
    return String(x.item.name || "").localeCompare(String(y.item.name || ""));
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function tierDisplayLabel(tier) {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function matchExplanation(match) {
  const prep = MATCH_PREPOSITIONS[state.category] || "with";
  const count = match.topValueOwned;
  return `${tierDisplayLabel(match.tier)} match — you own ${count} game${
    count === 1 ? "" : "s"
  } ${prep} ${escapeHtml(match.topValue)}`;
}

function renderMatchBadges(match) {
  const label = isMechanicsSpecific() ? "Mechanic" : categoryLabel(state.category);
  const shown = match.overlap.slice(0, 6);
  const extra = match.overlap.length - shown.length;

  const rows = shown
    .map((value) => {
      const ownedGames = match.valueMap.get(value) || [];
      const names = ownedGames.slice(0, 3);
      const moreCount = ownedGames.length - names.length;
      const ownedLine = names.length
        ? `<span class="match-owned muted">you own: ${escapeHtml(names.join(", "))}${
            moreCount > 0 ? ` +${moreCount} more` : ""
          }</span>`
        : "";
      return `<div class="match-item"><span class="pill active">${escapeHtml(
        label
      )}: ${escapeHtml(value)}</span>${ownedLine}</div>`;
    })
    .join("");

  const moreBadge = extra > 0 ? `<div class="match-more muted">+${extra} more</div>` : "";

  const noun = categoryNoun(state.category);
  return `
    <div class="match-explanation">${matchExplanation(match)}</div>
    <div class="section-label">Matches ${match.overlap.length} of your ${escapeHtml(
      noun
    )}${match.overlap.length === 1 ? "" : "s"}</div>
    <div class="match-list">${rows}${moreBadge}</div>
  `;
}

function previewUrl(item) {
  const previewId = state.essen?.event?.previewId || 93;
  const base = `https://boardgamegeek.com/geekpreview/${previewId}`;
  return item?.itemid != null ? `${base}/item/${item.itemid}` : `${base}/spiel-essen-2026`;
}

function renderCard(match) {
  const item = match.item;
  const thumb = item.thumbnail
    ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.name)} cover" loading="lazy">`
    : '<div class="card-thumb placeholder">No image</div>';
  const image = item.link
    ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${thumb}</a>`
    : thumb;

  const yearLabel = item.yearPublished ? ` (${escapeHtml(item.yearPublished)})` : "";

  const badges = [];
  badges.push(
    `<span class="tier-badge tier-badge--${match.tier}">${escapeHtml(tierDisplayLabel(match.tier))}</span>`
  );
  if (match.inPreview) {
    badges.push(
      `<a class="source-badge source-badge--preview" href="${escapeHtml(
        previewUrl(item)
      )}" target="_blank" rel="noreferrer">Preview</a>`
    );
  }
  if (match.inAuction) badges.push('<span class="source-badge source-badge--auction">Auction</span>');
  const badgeHtml = badges.length ? `<div class="source-badges">${badges.join("")}</div>` : "";

  const offerHtml = match.inAuction ? renderOffers(match) : "";

  const vote = getVote(item.objectId);
  const voteRow = `
    <div class="vote-row">
      <button class="vote-btn vote-btn--like${vote === 1 ? " is-active" : ""}" data-object-id="${escapeHtml(
        String(item.objectId)
      )}" data-vote="1" type="button" aria-label="Like">👍</button>
      <button class="vote-btn vote-btn--dislike${vote === -1 ? " is-active" : ""}" data-object-id="${escapeHtml(
        String(item.objectId)
      )}" data-vote="-1" type="button" aria-label="Dislike">👎</button>
    </div>`;

  const lines = [];
  if (item.minPlayers != null && item.maxPlayers != null) {
    lines.push(
      `<div class="detail-line"><span class="detail-label">Players</span><span class="detail-value">${escapeHtml(
        formatPlayerCount(item)
      )}</span></div>`
    );
  }
  if (item.weight != null) {
    lines.push(
      `<div class="detail-line"><span class="detail-label">Weight</span><span class="detail-value">${renderWeightValue(
        item.weight
      )}</span></div>`
    );
  }
  if (item.bggAverageRating != null) {
    lines.push(
      `<div class="detail-line"><span class="detail-label">BGG Rating</span><span class="detail-value">${escapeHtml(
        formatValue(item.bggAverageRating)
      )}</span></div>`
    );
  }
  if (item.bggRank != null) {
    lines.push(
      `<div class="detail-line"><span class="detail-label">BGG Rank</span><span class="detail-value">${renderBggRank(
        item.bggRank
      )}</span></div>`
    );
  }

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
            ${badgeHtml}
          </div>
          <div class="card-heading-actions">${renderShareButton(item.objectId)}</div>
        </div>
        <div class="detail-list">
          ${lines.join("")}
        </div>
        ${renderCredits(item)}
        ${offerHtml}
        <div class="card-section">
          ${renderMatchBadges(match)}
        </div>
        ${voteRow}
      </div>
    </article>
  `;
}

function renderEmptyState(ownedValueCount) {
  const label = categoryNoun(state.category);
  if (!ownedValueCount) {
    return `<div class="empty-state">No matches — ${escapeHtml(
      state.user
    )} owns no ${escapeHtml(label)}s that appear in the Essen preview or auction.</div>`;
  }
  return `<div class="empty-state">No matches — ${escapeHtml(
    state.user
  )}'s owned ${escapeHtml(label)}s don't appear in the Essen preview or auction.</div>`;
}

function renderContent() {
  const content = document.getElementById("content");
  const pagination = document.getElementById("pagination");
  const statusPill = document.getElementById("status-pill");

  const rawMatches = computeMatches();
  const categoryKey = state.category;
  const ownedValueCount = isMechanicsSpecific()
    ? 1
    : getOwnedValueMap(state.user, categoryKey).size;

  const filtered = sortMatches(
    rawMatches.filter((match) => matchesFuzzySearch(match.item))
  );

  const totalPages =
    state.pageSize === Infinity ? 1 : Math.max(1, Math.ceil(filtered.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;

  const start = state.pageSize === Infinity ? 0 : (state.page - 1) * state.pageSize;
  const end = state.pageSize === Infinity ? filtered.length : start + state.pageSize;
  const pageItems = filtered.slice(start, end);

  if (!filtered.length) {
    content.innerHTML = renderEmptyState(ownedValueCount);
  } else {
    content.innerHTML = `<div class="card-list">${pageItems
      .map((match) => renderCard(match))
      .join("")}</div>`;
  }
  initShareButtons(content);

  content.querySelectorAll(".vote-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setVote(Number(btn.dataset.objectId), Number(btn.dataset.vote));
    });
  });

  const sortLabel = SORT_OPTIONS.find((o) => o.key === state.sortKey)?.label || state.sortKey;
  statusPill.className = "status";
  statusPill.textContent = `${filtered.length} game${
    filtered.length === 1 ? "" : "s"
  } shown · sorted by ${sortLabel}`;

  document.getElementById("meta-matches").textContent = String(filtered.length);

  renderPaginationControls(pagination, totalPages);
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

// ---------------------------------------------------------------------------
// Filter UI
// ---------------------------------------------------------------------------

function renderMeta() {
  document.getElementById("meta-for").textContent = state.user || "—";
  document.getElementById("meta-category").textContent = isMechanicsSpecific()
    ? `Mechanics: ${state.selectedMechanic}`
    : categoryLabel(state.category);
  document.getElementById("meta-generated").textContent = formatGeneratedAt(
    state.essen?.generatedAt
  );
}

function renderUserOptions() {
  const container = document.getElementById("user-options");
  container.innerHTML = "";
  for (const user of state.users) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    if (state.user === user) btn.classList.add("active");
    btn.textContent = user;
    btn.addEventListener("click", () => {
      state.user = user;
      loadVotes(state.user);
      state.page = 1;
      renderMechanicOptions();
      renderUserOptions();
      renderMeta();
      renderContent();
    });
    container.appendChild(btn);
  }
}

function renderCategoryOptions() {
  const container = document.getElementById("category-options");
  container.innerHTML = "";
  for (const category of CATEGORIES) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    if (state.category === category.key) btn.classList.add("active");
    btn.textContent = category.label;
    btn.addEventListener("click", () => {
      state.category = category.key;
      state.selectedMechanic = MECHANIC_OVERALL;
      state.page = 1;
      syncMechanicVisibility();
      renderMechanicOptions();
      renderCategoryOptions();
      renderMeta();
      renderContent();
    });
    container.appendChild(btn);
  }
}

function syncMechanicVisibility() {
  const group = document.getElementById("mechanic-filter-group");
  group.style.display = state.category === "mechanics" ? "" : "none";
}

function renderMechanicOptions() {
  const select = document.getElementById("mechanic-select");
  const counts = getOwnedMechanicCounts(state.user);
  const mechanics = [...counts.keys()].sort((a, b) => a.localeCompare(b));

  select.innerHTML = "";
  const overallOption = document.createElement("option");
  overallOption.value = MECHANIC_OVERALL;
  overallOption.textContent = "Overall";
  select.appendChild(overallOption);

  for (const mechanic of mechanics) {
    const option = document.createElement("option");
    option.value = mechanic;
    option.textContent = `${mechanic} (${counts.get(mechanic).length})`;
    select.appendChild(option);
  }

  if (!mechanics.includes(state.selectedMechanic)) {
    state.selectedMechanic = MECHANIC_OVERALL;
  }
  select.value = state.selectedMechanic;
}

function renderSortOptions() {
  const container = document.getElementById("sort-options");
  container.innerHTML = "";
  for (const option of SORT_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    if (state.sortKey === option.key) btn.classList.add("active");
    btn.textContent = option.label;
    btn.addEventListener("click", () => {
      state.sortKey = option.key;
      state.page = 1;
      renderSortOptions();
      renderContent();
    });
    container.appendChild(btn);
  }
}

function renderSourceOptions() {
  const container = document.getElementById("source-options");
  container.innerHTML = "";
  for (const option of SOURCE_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    if (state.sourceFilter === option.key) btn.classList.add("active");
    btn.textContent = option.label;
    btn.addEventListener("click", () => {
      state.sourceFilter = option.key;
      state.page = 1;
      renderSourceOptions();
      renderContent();
    });
    container.appendChild(btn);
  }
}

function renderConfidenceOptions() {
  const container = document.getElementById("confidence-options");
  container.innerHTML = "";
  for (const option of CONFIDENCE_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    if (state.confidenceFilter === option.key) btn.classList.add("active");
    btn.textContent = option.label;
    btn.addEventListener("click", () => {
      state.confidenceFilter = option.key;
      state.page = 1;
      renderConfidenceOptions();
      renderContent();
    });
    container.appendChild(btn);
  }
}

function renderExpansionOptions() {
  const container = document.getElementById("expansion-options");
  container.innerHTML = "";
  for (const option of EXPANSION_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    if (state.expansionFilter === option.key) btn.classList.add("active");
    btn.textContent = option.label;
    btn.addEventListener("click", () => {
      state.expansionFilter = option.key;
      state.page = 1;
      renderExpansionOptions();
      renderContent();
    });
    container.appendChild(btn);
  }
}

function renderDislikedOptions() {
  const container = document.getElementById("disliked-options");
  container.innerHTML = "";
  for (const option of DISLIKED_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    if (state.dislikedFilter === option.key) btn.classList.add("active");
    btn.textContent = option.label;
    btn.addEventListener("click", () => {
      state.dislikedFilter = option.key;
      state.page = 1;
      renderDislikedOptions();
      renderContent();
    });
    container.appendChild(btn);
  }

  const title = document.getElementById("disliked-title");
  if (title) {
    const count = Object.values(state.votes).filter((v) => v === -1).length;
    title.textContent = `Disliked (${count})`;
  }
}

function renderVotedOptions() {
  const container = document.getElementById("voted-options");
  container.innerHTML = "";
  for (const option of VOTED_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "sort-option";
    if (state.votedFilter === option.key) btn.classList.add("active");
    btn.textContent = option.label;
    btn.addEventListener("click", () => {
      state.votedFilter = option.key;
      state.page = 1;
      renderVotedOptions();
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
      localStorage.setItem("recommendPageSize", String(option.value));
      renderPageSizeOptions();
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

  document.getElementById("mechanic-select").addEventListener("change", (e) => {
    state.selectedMechanic = e.target.value;
    state.page = 1;
    renderMeta();
    renderContent();
  });

  const savedPageSize = localStorage.getItem("recommendPageSize");
  if (savedPageSize !== null) {
    state.pageSize = savedPageSize === "Infinity" ? Infinity : Number(savedPageSize);
  }
}

function setupPlayerFilter() {
  const playerMinInput = document.getElementById("player-min-filter");
  const playerMaxInput = document.getElementById("player-max-filter");
  if (!playerMinInput || !playerMaxInput) return;

  function syncPlayerRangeState() {
    const minValue = playerMinInput.value.trim();
    const maxValue = playerMaxInput.value.trim();

    state.playerMin = minValue ? Number(minValue) : null;
    state.playerMax = maxValue ? Number(maxValue) : null;

    if (state.playerMin !== null && state.playerMax !== null && state.playerMin > state.playerMax) {
      [state.playerMin, state.playerMax] = [state.playerMax, state.playerMin];
      playerMinInput.value = String(state.playerMin);
      playerMaxInput.value = String(state.playerMax);
    }
  }

  for (const input of [playerMinInput, playerMaxInput]) {
    input.addEventListener("input", () => {
      syncPlayerRangeState();
      state.page = 1;
      renderContent();
    });
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

async function loadSnapshots() {
  const statusPill = document.getElementById("status-pill");
  const content = document.getElementById("content");
  try {
    const [collectionResponse, essenResponse, auctionResult] = await Promise.all([
      fetch("./data/collection.json", { cache: "no-store" }),
      fetch("./data/essen26.json", { cache: "no-store" }),
      fetch("./data/essen26_auction.json", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ]);
    if (!collectionResponse.ok) throw new Error(`HTTP ${collectionResponse.status}`);
    if (!essenResponse.ok) throw new Error(`HTTP ${essenResponse.status}`);
    state.collection = await collectionResponse.json();
    state.essen = await essenResponse.json();
    state.auction = auctionResult && Array.isArray(auctionResult.items) ? auctionResult : { items: [] };
  } catch (error) {
    statusPill.className = "status error";
    statusPill.textContent = "Could not load snapshots";
    const hint =
      location.protocol === "file:"
        ? " Serve the site over http (e.g. <span class=\"code\">python3 -m http.server</span>) so the JSON can load."
        : "";
    content.innerHTML = `<div class="empty-state">Failed to load <span class="code">data/collection.json</span> or <span class="code">data/essen26.json</span>.${hint}</div>`;
    return;
  }

  state.users = [...(state.collection.owners || [])].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  state.user = state.users[0] || null;
  loadVotes(state.user);

  renderMeta();
  renderUserOptions();
  renderCategoryOptions();
  syncMechanicVisibility();
  renderMechanicOptions();
  renderSortOptions();
  renderSourceOptions();
  renderConfidenceOptions();
  renderExpansionOptions();
  renderDislikedOptions();
  renderVotedOptions();
  renderSoldOptions();
  renderMyBidsOptions();
  renderPageSizeOptions();
  setupPlayerFilter();
  renderContent();
}

setupControls();
setupMobileNav();
setupThemeToggle();
loadSnapshots();
