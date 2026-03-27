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

const state = {
  snapshot: null,
  groupExpansions: false,
  ownerFilters: [],
  statusFilters: [],
  playerMin: null,
  playerMax: null,
  sortKey: "name",
  sortDirection: "asc",
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

function findBaseGame(expansion, candidates) {
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

function applyActiveFilters(items) {
  return items.filter((item) => getVisibleOwnerDetails(item).length > 0 && matchesPlayerRange(item));
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

  for (const baseItem of baseItems) {
    groupsByBaseId.set(baseItem.objectId, []);
  }

  for (const expansion of expansionItems) {
    if (!matchedIds.has(expansion.objectId)) {
      continue;
    }

    const baseGame = findBaseGame(expansion, baseItems);
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
        : [`<span class="pill subtle">${escapeHtml(detail.owner)} | No status</span>`]
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
          <div class="section-label">Owners</div>
          ${renderOwners(item)}
        </div>
        ${expansionsMarkup}
      </div>
    </article>
  `;
}

function renderCollection(items, groupExpansions) {
  const rows = groupExpansions
    ? groupItems(items).map(({ item, expansions }) => renderCard(item, expansions)).join("")
    : sortItems(applyActiveFilters(items)).map((item) => renderCard(item)).join("");

  return `<div class="card-list">${rows}</div>`;
}

function renderEmptyState(message) {
  return `<div class="empty-state">${message}</div>`;
}

function updateMeta(snapshot) {
  const owners = snapshot.owners || [];
  const sourceFiles = snapshot.sourceFiles || [];

  document.getElementById("hero-title").textContent = "Shared BoardGameGeek Collections";
  document.getElementById("meta-owners").textContent = owners.length ? owners.join(", ") : "No owners found";
  document.getElementById("meta-count").textContent = formatValue(snapshot.itemCount, "0");
  document.getElementById("meta-generated").textContent = formatDate(snapshot.generatedAt);
  document.getElementById("meta-source").textContent = `${sourceFiles.length} CSV file${
    sourceFiles.length === 1 ? "" : "s"
  }`;
  document.getElementById("snapshot-path").textContent = SNAPSHOT_PATH;
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

  const filteredItems = applyActiveFilters(snapshot.items);
  content.innerHTML = renderCollection(snapshot.items, state.groupExpansions);
  updateStatus(buildStatusMessage(filteredItems.length), "");
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

      renderSortOptions();
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

  if (
    !toggle ||
    !playerMinInput ||
    !playerMaxInput ||
    !clearOwnerFiltersButton ||
    !clearStatusFiltersButton ||
    !sortOptions
  ) {
    throw new Error("Missing one or more filter controls in index.html");
  }

  toggle.checked = state.groupExpansions;
  toggle.addEventListener("change", () => {
    state.groupExpansions = toggle.checked;
    renderSnapshot();
  });
  renderSortOptions();

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
      renderSnapshot();
    });
  }

  clearOwnerFiltersButton.addEventListener("click", () => {
    state.ownerFilters = [];
    document.querySelectorAll(".owner-filter-option input").forEach((input) => {
      input.checked = false;
    });
    renderSnapshot();
  });

  clearStatusFiltersButton.addEventListener("click", () => {
    state.statusFilters = [];
    document.querySelectorAll(".status-filter-option input").forEach((input) => {
      input.checked = false;
    });
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

function setupOwnerFilters(snapshot) {
  renderOwnerFilterOptions(snapshot);

  const ownerInputs = Array.from(document.querySelectorAll(".owner-filter-option input"));
  for (const input of ownerInputs) {
    input.checked = state.ownerFilters.includes(input.value);
    input.addEventListener("change", () => {
      state.ownerFilters = ownerInputs
        .filter((candidate) => candidate.checked)
        .map((candidate) => candidate.value);
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

try {
  setupControls();
  loadSnapshot();
} catch (error) {
  showStartupError(error instanceof Error ? error.message : String(error));
}
