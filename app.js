const SNAPSHOT_PATH = "./data/collection.json";

const SORT_OPTIONS = [
  { key: "name", label: "Game", type: "text", defaultDirection: "asc" },
  { key: "owners", label: "Owners", type: "owners", defaultDirection: "asc" },
  { key: "yearPublished", label: "Year", type: "number", defaultDirection: "desc" },
  { key: "playerCount", label: "Players", type: "players", defaultDirection: "asc" },
  { key: "weight", label: "Weight", type: "number", defaultDirection: "desc" },
  { key: "bggAverageRating", label: "BGG Rating", type: "number", defaultDirection: "desc" },
  { key: "bggRank", label: "BGG Rank", type: "number", defaultDirection: "asc" },
];

const STATUS_FILTER_OPTIONS = [
  "Owned",
  "Previously Owned",
  "For Trade",
  "Want in Trade",
  "Want to Play",
  "Want to Buy",
  "Wishlist",
  "Preordered",
];

const PAGE_SIZE_OPTIONS = [12, 24, 48, 96, Infinity];
const PAGE_SIZE_LABELS = { [Infinity]: "All" };
const DEFAULT_PAGE_SIZE = 24;

const FUZZY_THRESHOLD = 0.5;

const state = {
  snapshot: null,
  groupExpansions: false,
  ownerFilters: [],
  statusFilters: [],
  playerMin: null,
  playerMax: null,
  sortKey: "name",
  sortDirection: "asc",
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  searchQuery: "",
};

function formatDate(value) {
  if (!value) {
    return "Not yet synced";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

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

function renderLink(name, link) {
  if (!link) {
    return escapeHtml(formatValue(name));
  }

  return `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${escapeHtml(
    formatValue(name)
  )}</a>`;
}

function normalizeForMatch(value) {
  return value
    .toLowerCase()
    .replaceAll("–", "-")
    .replaceAll("—", "-")
    .replace(/\s+/g, " ")
    .trim();
}

function isExpansion(item) {
  return item.itemType === "expansion";
}

function findBaseGame(expansion, candidates, candidatesById) {
  // Try BGG's own expansion relationship data first
  if (expansion.expansionOf?.length) {
    for (const id of expansion.expansionOf) {
      const base = candidatesById.get(id);
      if (base) return base;
    }
  }

  // Fall back to name-prefix heuristic
  const normalizedName = normalizeForMatch(expansion.name || "");

  for (const candidate of candidates) {
    const baseName = normalizeForMatch(candidate.name || "");
    if (!baseName) {
      continue;
    }

    const separators = [": ", " - ", " – ", " — "];
    if (
      separators.some((separator) =>
        normalizedName.startsWith(baseName + normalizeForMatch(separator))
      )
    ) {
      return candidate;
    }
  }

  return null;
}

function getVisibleOwnerDetails(item) {
  return (item.ownerDetails || []).filter((detail) => {
    const ownerMatches = !state.ownerFilters.length || state.ownerFilters.includes(detail.owner);
    const statusMatches =
      !state.statusFilters.length ||
      detail.statuses?.some((status) => state.statusFilters.includes(status));
    return ownerMatches && statusMatches;
  });
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

// Levenshtein distance (space-optimised, single-row DP)
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

// Score one query token against one name token (0–1)
function tokenScore(queryToken, nameToken) {
  if (nameToken.includes(queryToken)) return 1;
  const dist = levenshtein(queryToken, nameToken);
  return 1 - dist / Math.max(queryToken.length, nameToken.length);
}

// Overall fuzzy score: each query word must match its best name word (0–1)
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

function applyActiveFilters(items) {
  const hasOwnerOrStatusFilter = state.ownerFilters.length > 0 || state.statusFilters.length > 0;
  return items.filter(
    (item) =>
      (!hasOwnerOrStatusFilter || getVisibleOwnerDetails(item).length > 0) &&
      matchesPlayerRange(item) &&
      matchesFuzzySearch(item)
  );
}

function sortValueForItem(item, sortKey) {
  if (sortKey === "owners") {
    return (item.owners || []).join(", ");
  }

  if (sortKey === "playerCount") {
    const min = item.minPlayers ?? 999;
    const max = item.maxPlayers ?? 999;
    const best = item.bestPlayers ?? "";
    return `${String(min).padStart(3, "0")}-${String(max).padStart(3, "0")}-${best}`;
  }

  if (sortKey === "bggRank") {
    return item.bggRank === 0 ? null : item.bggRank;
  }

  return item[sortKey];
}

function compareValues(left, right, type) {
  if (left === null || left === undefined || left === "") {
    return right === null || right === undefined || right === "" ? 0 : 1;
  }

  if (right === null || right === undefined || right === "") {
    return -1;
  }

  if (type === "number") {
    return Number(left) - Number(right);
  }

  return String(left).localeCompare(String(right), undefined, { sensitivity: "base" });
}

function sortItems(items) {
  const option = SORT_OPTIONS.find((candidate) => candidate.key === state.sortKey);
  const type = option?.type || "text";
  const direction = state.sortDirection === "asc" ? 1 : -1;

  return [...items].sort((left, right) => {
    const result = compareValues(
      sortValueForItem(left, state.sortKey),
      sortValueForItem(right, state.sortKey),
      type
    );

    if (result !== 0) {
      return result * direction;
    }

    return String(left.name || "").localeCompare(String(right.name || ""), undefined, {
      sensitivity: "base",
    });
  });
}

function groupItems(allItems) {
  const matchedItems = applyActiveFilters(allItems);
  const matchedIds = new Set(matchedItems.map((item) => item.objectId));
  const baseItems = matchedItems.filter((item) => !isExpansion(item));
  const expansionItems = matchedItems.filter((item) => isExpansion(item));
  const groupsByBaseId = new Map();
  const visibleBaseItems = new Map();
  const unmatchedExpansions = [];

  const baseItemsById = new Map(baseItems.map((item) => [item.objectId, item]));

  for (const baseItem of baseItems) {
    groupsByBaseId.set(baseItem.objectId, []);
  }

  for (const expansion of expansionItems) {
    if (!matchedIds.has(expansion.objectId)) {
      continue;
    }

    const baseGame = findBaseGame(expansion, baseItems, baseItemsById);
    if (!baseGame || !groupsByBaseId.has(baseGame.objectId)) {
      unmatchedExpansions.push(expansion);
      continue;
    }

    groupsByBaseId.get(baseGame.objectId).push(expansion);
    visibleBaseItems.set(baseGame.objectId, baseGame);
  }

  for (const baseItem of baseItems) {
    if (matchedIds.has(baseItem.objectId)) {
      visibleBaseItems.set(baseItem.objectId, baseItem);
    }
  }

  const rows = sortItems(Array.from(visibleBaseItems.values())).map((item) => ({
    item,
    expansions: sortItems(groupsByBaseId.get(item.objectId) || []),
  }));

  for (const expansion of sortItems(unmatchedExpansions)) {
    rows.push({ item: expansion, expansions: [] });
  }

  return rows;
}

function formatBggRank(value) {
  if (value === 0 || value === "0") {
    return "No Rank";
  }

  return formatValue(value);
}

function getRankBadge(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }

  if (numeric === 1) {
    return " 🏆";
  }

  if (numeric <= 100) {
    return " 🥇";
  }

  if (numeric <= 500) {
    return " 🥈";
  }

  if (numeric <= 1000) {
    return " 🥉";
  }

  return "";
}

function renderBggRank(value) {
  const formatted = formatBggRank(value);
  if (formatted === "No Rank") {
    return escapeHtml(formatted);
  }

  return `${escapeHtml(formatted)}${getRankBadge(value)}`;
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

function formatBestPlayers(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parts = String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return null;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  if (parts.length === 2) {
    return `${parts[0]} or ${parts[1]}`;
  }

  return `${parts.slice(0, -1).join(", ")} or ${parts.at(-1)}`;
}

function formatPlayerCount(item) {
  const min = item.minPlayers;
  const max = item.maxPlayers;
  const best = formatBestPlayers(item.bestPlayers);

  if (min === null || min === undefined || max === null || max === undefined) {
    return "—";
  }

  const range = min === max ? `${min}` : `${min}-${max}`;
  return best ? `${range} (Best ${best})` : range;
}

function renderOwners(item) {
  const visibleOwnerDetails = getVisibleOwnerDetails(item);
  const ownerDetails = visibleOwnerDetails.length ? visibleOwnerDetails : item.ownerDetails || [];

  if (!ownerDetails.length) {
    return '<span class="muted">—</span>';
  }

  return `<div class="pill-list">${ownerDetails
    .flatMap((detail) =>
      detail.statuses?.length
        ? detail.statuses.map(
            (status) =>
              `<span class="pill active">${escapeHtml(detail.owner)} | ${escapeHtml(status)}</span>`
          )
        : [`<span class="pill subtle" title="This user added the game to their collection without setting a status">${escapeHtml(detail.owner)} | No status</span>`]
    )
    .join("")}</div>`;
}

function renderCard(item, expansions = [], compact = false) {
  const image = item.thumbnail
    ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.name)} cover" loading="lazy">`
    : '<div class="card-thumb placeholder">No image</div>';

  const yearLabel = item.yearPublished ? ` (${escapeHtml(item.yearPublished)})` : "";

  const expansionsMarkup = expansions.length
    ? `
      <details class="expansion-disclosure">
        <summary>${escapeHtml(expansions.length)} expansion${expansions.length === 1 ? "" : "s"}</summary>
        <div class="expansion-card-list">
          ${expansions.map((expansion) => renderCard(expansion, [], true)).join("")}
        </div>
      </details>
    `
    : "";

  return `
    <article class="game-card ${compact ? "compact" : ""}">
      <div class="card-thumb-wrap">
        ${image}
      </div>
      <div class="card-body">
        <div class="card-heading">
          <div>
            <h3 class="game-name">${renderLink(item.name, item.link)}${yearLabel}</h3>
            <div class="game-meta">#${escapeHtml(formatValue(item.objectId))}</div>
          </div>
        </div>
        <div class="detail-list">
          <div class="detail-line"><span class="detail-label">Players</span><span class="detail-value">${escapeHtml(
            formatPlayerCount(item)
          )}</span></div>
          <div class="detail-line"><span class="detail-label">Weight</span><span class="detail-value">${renderWeightValue(
            item.weight
          )}</span></div>
          <div class="detail-line"><span class="detail-label">BGG Rating</span><span class="detail-value">${escapeHtml(
            formatValue(item.bggAverageRating)
          )}</span></div>
          <div class="detail-line"><span class="detail-label">BGG Rank</span><span class="detail-value">${renderBggRank(
            item.bggRank
          )}</span></div>
        </div>
        <div class="card-section">
          ${renderOwners(item)}
        </div>
        ${expansionsMarkup}
      </div>
    </article>
  `;
}

function getRows(items, groupExpansions) {
  if (groupExpansions) {
    return groupItems(items);
  }
  return sortItems(applyActiveFilters(items)).map((item) => ({ item, expansions: [] }));
}

function renderPaginationControls(totalRows) {
  const container = document.getElementById("pagination");
  if (!container) return;

  const totalPages = Math.ceil(totalRows / state.pageSize);
  if (totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  const current = state.page;

  function pageBtn(page, label, disabled = false, active = false) {
    return `<button class="page-btn${active ? " active" : ""}" data-page="${page}" ${disabled ? "disabled" : ""}>${escapeHtml(String(label))}</button>`;
  }

  const buttons = [];
  buttons.push(pageBtn(current - 1, "←", current === 1));

  const pageNums = new Set([1, totalPages]);
  for (let i = Math.max(1, current - 1); i <= Math.min(totalPages, current + 1); i++) {
    pageNums.add(i);
  }
  let prev = 0;
  for (const n of Array.from(pageNums).sort((a, b) => a - b)) {
    if (n - prev > 1) buttons.push('<span class="page-ellipsis">…</span>');
    buttons.push(pageBtn(n, n, n === current, n === current));
    prev = n;
  }

  buttons.push(pageBtn(current + 1, "→", current === totalPages));

  container.innerHTML = `<div class="pagination">${buttons.join("")}</div>`;

  container.querySelectorAll("[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = Number(btn.getAttribute("data-page"));
      if (page < 1 || page > totalPages) return;
      state.page = page;
      renderSnapshot();
      document.getElementById("content").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderCollection(items, groupExpansions) {
  const allRows = getRows(items, groupExpansions);
  const start = (state.page - 1) * state.pageSize;
  const pageRows = state.pageSize === Infinity ? allRows : allRows.slice(start, start + state.pageSize);
  const cards = pageRows.map(({ item, expansions }) => renderCard(item, expansions)).join("");
  return { html: `<div class="card-list">${cards}</div>`, totalRows: allRows.length };
}

function renderEmptyState(message) {
  return `<div class="empty-state">${message}</div>`;
}

function updateMeta(snapshot) {
  const owners = snapshot.owners || [];

  document.getElementById("meta-owners").textContent = owners.length ? owners.join(", ") : "No owners found";
  document.getElementById("meta-count").textContent = formatValue(snapshot.itemCount, "0");
  document.getElementById("meta-generated").textContent = formatDate(snapshot.generatedAt);
  document.getElementById("meta-source").textContent = snapshot.sourceLabel || "—";
}

function updateStatus(text, stateClass) {
  const pill = document.getElementById("status-pill");
  pill.textContent = text;
  pill.className = `status ${stateClass}`.trim();
}

function buildStatusMessage(itemCount) {
  const parts = ["Snapshot loaded"];

  if (state.groupExpansions) {
    parts.push("expansions grouped");
  }

  if (state.ownerFilters.length) {
    parts.push(`owners: ${state.ownerFilters.length} selected`);
  }

  if (state.statusFilters.length) {
    parts.push(`statuses: ${state.statusFilters.length} selected`);
  }

  if (state.playerMin !== null || state.playerMax !== null) {
    parts.push(`players: ${state.playerMin ?? "any"}-${state.playerMax ?? "any"}`);
  }

  parts.push(
    `sorted by ${
      SORT_OPTIONS.find((option) => option.key === state.sortKey)?.label || "Game"
    } ${state.sortDirection === "asc" ? "↑" : "↓"}`
  );
  parts.push(`${itemCount} games shown`);
  return parts.join(" · ");
}

function renderActiveFilterChips() {
  const container = document.getElementById("active-filters");
  if (!container) return;

  const chips = [];

  for (const owner of state.ownerFilters) {
    chips.push({
      label: owner,
      remove() {
        state.ownerFilters = state.ownerFilters.filter((o) => o !== owner);
        saveOwnerFilters();
        document.querySelectorAll(".owner-filter-option input").forEach((input) => {
          if (input.value === owner) input.checked = false;
        });
        state.page = 1;
        renderSnapshot();
      },
    });
  }

  for (const status of state.statusFilters) {
    chips.push({
      label: status,
      remove() {
        state.statusFilters = state.statusFilters.filter((s) => s !== status);
        document.querySelectorAll(".status-filter-option input").forEach((input) => {
          if (input.value === status) input.checked = false;
        });
        state.page = 1;
        renderSnapshot();
      },
    });
  }

  if (state.playerMin !== null || state.playerMax !== null) {
    const min = state.playerMin ?? "any";
    const max = state.playerMax ?? "any";
    chips.push({
      label: `Players: ${min}–${max}`,
      remove() {
        state.playerMin = null;
        state.playerMax = null;
        const minInput = document.getElementById("player-min-filter");
        const maxInput = document.getElementById("player-max-filter");
        if (minInput) minInput.value = "";
        if (maxInput) maxInput.value = "";
        state.page = 1;
        renderSnapshot();
      },
    });
  }

  container.innerHTML = chips
    .map(
      (_, i) =>
        `<span class="filter-chip" data-chip="${i}">${escapeHtml(chips[i].label)}<button class="chip-remove" type="button" aria-label="Remove ${escapeHtml(chips[i].label)} filter">×</button></span>`
    )
    .join("");

  container.querySelectorAll(".filter-chip").forEach((el) => {
    const i = Number(el.getAttribute("data-chip"));
    el.querySelector(".chip-remove").addEventListener("click", chips[i].remove);
  });
}

function renderSnapshot() {
  const content = document.getElementById("content");
  const snapshot = state.snapshot;

  if (!snapshot) {
    return;
  }

  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    updateStatus("Snapshot ready, no items yet", "loading");
    content.innerHTML = renderEmptyState(
      "The collection snapshot file is present, but it does not contain any games yet. Run " +
        '<span class="code">python3 scripts/sync_bgg_collection.py</span> ' +
        "to generate the combined dataset from the CSV files in " +
        '<span class="code">collections/</span>.'
    );
    return;
  }

  const { html, totalRows } = renderCollection(snapshot.items, state.groupExpansions);
  content.innerHTML = html;
  renderPaginationControls(totalRows);
  updateStatus(buildStatusMessage(totalRows), "");
  renderActiveFilterChips();
}

function renderOwnerFilterOptions(snapshot) {
  const container = document.getElementById("owner-filter-grid");
  const owners = snapshot.owners || [];

  container.innerHTML = owners
    .map(
      (owner) => `
        <label class="owner-filter-option">
          <input type="checkbox" value="${escapeHtml(owner)}" />
          ${escapeHtml(owner)}
        </label>
      `
    )
    .join("");
}

function renderStatusFilterOptions() {
  const container = document.getElementById("status-filter-grid");
  if (!container) {
    return;
  }

  container.innerHTML = STATUS_FILTER_OPTIONS.map(
    (status) => `
      <label class="status-filter-option">
        <input type="checkbox" value="${escapeHtml(status)}" />
        ${escapeHtml(status)}
      </label>
    `
  ).join("");
}

function renderSortOptions() {
  const container = document.getElementById("sort-options");
  if (!container) {
    return;
  }

  container.innerHTML = SORT_OPTIONS.map((option) => {
    const isActive = option.key === state.sortKey;
    const direction = isActive ? (state.sortDirection === "asc" ? " ↑" : " ↓") : "";
    return `
      <button
        class="sort-option ${isActive ? "active" : ""}"
        type="button"
        data-sort-key="${escapeHtml(option.key)}"
      >
        ${escapeHtml(option.label)}${direction}
      </button>
    `;
  }).join("");

  container.querySelectorAll("[data-sort-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const sortKey = button.getAttribute("data-sort-key");
      if (!sortKey) {
        return;
      }

      if (state.sortKey === sortKey) {
        state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = sortKey;
        state.sortDirection =
          SORT_OPTIONS.find((option) => option.key === sortKey)?.defaultDirection || "asc";
      }

      state.page = 1;
      renderSortOptions();
      renderSnapshot();
    });
  });
}

function savePageSize() {
  localStorage.setItem("pageSize", String(state.pageSize));
}

function loadPageSize() {
  const saved = Number(localStorage.getItem("pageSize"));
  if (PAGE_SIZE_OPTIONS.includes(saved)) {
    state.pageSize = saved;
  }
}

function renderPageSizeOptions() {
  const container = document.getElementById("page-size-options");
  if (!container) return;

  container.innerHTML = PAGE_SIZE_OPTIONS.map((size) => {
    const isActive = size === state.pageSize;
    const label = PAGE_SIZE_LABELS[size] ?? String(size);
    return `
      <button
        class="sort-option ${isActive ? "active" : ""}"
        type="button"
        data-page-size="${size}"
      >
        ${escapeHtml(label)}
      </button>
    `;
  }).join("");

  container.querySelectorAll("[data-page-size]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const size = Number(btn.getAttribute("data-page-size"));
      if (!PAGE_SIZE_OPTIONS.includes(size)) return;
      state.pageSize = size;
      state.page = 1;
      savePageSize();
      renderPageSizeOptions();
      renderSnapshot();
    });
  });
}

function setupControls() {
  const toggle = document.getElementById("group-expansions-toggle");
  const playerMinInput = document.getElementById("player-min-filter");
  const playerMaxInput = document.getElementById("player-max-filter");
  const clearOwnerFiltersButton = document.getElementById("clear-owner-filters");
  const clearStatusFiltersButton = document.getElementById("clear-status-filters");
  const sortOptions = document.getElementById("sort-options");
  const searchInput = document.getElementById("search-input");
  const searchInputMobile = document.getElementById("search-input-mobile");

  if (
    !toggle ||
    !playerMinInput ||
    !playerMaxInput ||
    !clearOwnerFiltersButton ||
    !clearStatusFiltersButton ||
    !sortOptions ||
    !searchInput
  ) {
    throw new Error("Missing one or more filter controls in index.html");
  }

  function onSearch(value) {
    state.searchQuery = value;
    state.page = 1;
    // Keep both inputs in sync
    searchInput.value = value;
    if (searchInputMobile) searchInputMobile.value = value;
    renderSnapshot();
  }

  searchInput.addEventListener("input", () => onSearch(searchInput.value));
  if (searchInputMobile) {
    searchInputMobile.addEventListener("input", () => onSearch(searchInputMobile.value));
  }

  loadPageSize();
  toggle.checked = state.groupExpansions;
  toggle.addEventListener("change", () => {
    state.groupExpansions = toggle.checked;
    state.page = 1;
    renderSnapshot();
  });
  renderSortOptions();
  renderPageSizeOptions();

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
      renderSnapshot();
    });
  }

  clearOwnerFiltersButton.addEventListener("click", () => {
    state.ownerFilters = [];
    saveOwnerFilters();
    document.querySelectorAll(".owner-filter-option input").forEach((input) => {
      input.checked = false;
    });
    state.page = 1;
    renderSnapshot();
  });

  clearStatusFiltersButton.addEventListener("click", () => {
    state.statusFilters = [];
    document.querySelectorAll(".status-filter-option input").forEach((input) => {
      input.checked = false;
    });
    state.page = 1;
    renderSnapshot();
  });

  syncPlayerRangeState();
  renderStatusFilterOptions();

  const statusInputs = Array.from(document.querySelectorAll(".status-filter-option input"));
  for (const input of statusInputs) {
    input.checked = state.statusFilters.includes(input.value);
    input.addEventListener("change", () => {
      state.statusFilters = statusInputs
        .filter((candidate) => candidate.checked)
        .map((candidate) => candidate.value);
      state.page = 1;
      renderSnapshot();
    });
  }
}

function showStartupError(message) {
  const content = document.getElementById("content");
  updateStatus("Snapshot unavailable", "error");
  if (content) {
    content.innerHTML = renderEmptyState(
      `The page could not start correctly. Details: <span class="code">${escapeHtml(message)}</span>`
    );
  }
}

function saveOwnerFilters() {
  localStorage.setItem("ownerFilters", JSON.stringify(state.ownerFilters));
}

function loadOwnerFilters(availableOwners) {
  try {
    const saved = JSON.parse(localStorage.getItem("ownerFilters") || "[]");
    // Only restore owners that still exist in the snapshot
    state.ownerFilters = saved.filter((owner) => availableOwners.includes(owner));
  } catch {
    state.ownerFilters = [];
  }
}

function setupOwnerFilters(snapshot) {
  loadOwnerFilters(snapshot.owners || []);
  renderOwnerFilterOptions(snapshot);

  const ownerInputs = Array.from(document.querySelectorAll(".owner-filter-option input"));
  for (const input of ownerInputs) {
    input.checked = state.ownerFilters.includes(input.value);
    input.addEventListener("change", () => {
      state.ownerFilters = ownerInputs
        .filter((candidate) => candidate.checked)
        .map((candidate) => candidate.value);
      saveOwnerFilters();
      state.page = 1;
      renderSnapshot();
    });
  }
}

async function loadSnapshot() {
  const content = document.getElementById("content");

  try {
    const response = await fetch(SNAPSHOT_PATH, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    state.snapshot = await response.json();
    updateMeta(state.snapshot);
    setupOwnerFilters(state.snapshot);
    renderSnapshot();
  } catch (error) {
    updateStatus("Snapshot unavailable", "error");

    const isFileProtocol = window.location.protocol === "file:";
    const localHint = isFileProtocol
      ? 'This page was opened from the filesystem, so the browser cannot fetch local JSON. Serve the folder with <span class="code">python3 -m http.server</span> and reopen it over <span class="code">http://localhost:8000</span>.'
      : "Check that the snapshot file exists and is valid JSON.";

    content.innerHTML = renderEmptyState(
      "The snapshot could not be loaded. " +
        `${localHint} ` +
        `Details: <span class="code">${escapeHtml(error.message)}</span>`
    );
  }
}

function setupMobileNav() {
  const topBar = document.getElementById("top-bar");
  const filterToggleBtn = document.getElementById("filter-toggle-btn");
  const sidebar = document.getElementById("sidebar");
  const sidebarCloseBtn = document.getElementById("sidebar-close-btn");
  const backdrop = document.getElementById("drawer-backdrop");

  if (!topBar || !filterToggleBtn || !sidebar || !sidebarCloseBtn || !backdrop) return;

  // Smart show/hide top bar on scroll
  let lastScrollY = window.scrollY;
  window.addEventListener("scroll", () => {
    const current = window.scrollY;
    if (current < 8) {
      topBar.classList.remove("top-bar--hidden");
    } else if (current < lastScrollY) {
      topBar.classList.remove("top-bar--hidden");
    } else if (current > lastScrollY + 4) {
      topBar.classList.add("top-bar--hidden");
    }
    lastScrollY = current;
  }, { passive: true });

  function openSidebar() {
    sidebar.classList.add("sidebar--open");
    backdrop.classList.add("drawer-backdrop--visible");
    document.body.style.overflow = "hidden";
  }

  function closeSidebar() {
    sidebar.classList.remove("sidebar--open");
    backdrop.classList.remove("drawer-backdrop--visible");
    document.body.style.overflow = "";
  }

  filterToggleBtn.addEventListener("click", openSidebar);
  sidebarCloseBtn.addEventListener("click", closeSidebar);
  backdrop.addEventListener("click", closeSidebar);
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

  // Sync toggle to current effective theme
  applyTheme(getEffectiveTheme());

  lightBtn.addEventListener("click", () => applyTheme("light"));
  darkBtn.addEventListener("click", () => applyTheme("dark"));

  // Keep in sync if system preference changes and no explicit override... actually
  // once the user clicks, we always have an explicit preference. Only sync if no saved pref.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem("theme")) {
      applyTheme(e.matches ? "dark" : "light");
    }
  });
}

try {
  setupControls();
  setupMobileNav();
  setupThemeToggle();
  loadSnapshot();
} catch (error) {
  showStartupError(error instanceof Error ? error.message : String(error));
}
