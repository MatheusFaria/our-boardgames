const SNAPSHOT_PATH = "./data/joyfulficus-collection.json";

const columns = [
  { key: "thumbnail", label: "Image", sortable: false },
  { key: "name", label: "Game", sortable: true, type: "text" },
  { key: "yearPublished", label: "Year", sortable: true, type: "number" },
  { key: "playerCount", label: "Players", sortable: true, type: "players" },
  { key: "weight", label: "Weight", sortable: true, type: "number" },
  { key: "userRating", label: "Your Rating", sortable: true, type: "number" },
  { key: "bggAverageRating", label: "BGG Rating", sortable: true, type: "number" },
  { key: "bggRank", label: "BGG Rank", sortable: true, type: "number" },
  { key: "statuses", label: "Statuses", sortable: true, type: "status" },
];

const statusFilterOptions = {
  all: () => true,
  owned: (item) => item.owned,
  previouslyOwned: (item) => item.previouslyOwned,
  forTrade: (item) => item.forTrade,
  wantInTrade: (item) => item.wantInTrade,
  wantToPlay: (item) => item.wantToPlay,
  wantToBuy: (item) => item.wantToBuy,
  wishlist: (item) => item.wishlist,
  preordered: (item) => item.preordered,
  expansion: (item) => item.itemType === "expansion",
};

const state = {
  snapshot: null,
  groupExpansions: false,
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

  return `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${escapeHtml(formatValue(name))}</a>`;
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

function getStatusList(item) {
  return [
    ["Owned", item.owned],
    ["Previously Owned", item.previouslyOwned],
    ["For Trade", item.forTrade],
    ["Want in Trade", item.wantInTrade],
    ["Want to Play", item.wantToPlay],
    ["Want to Buy", item.wantToBuy],
    ["Wishlist", item.wishlist],
    ["Preordered", item.preordered],
    ["Expansion", item.itemType === "expansion"],
  ];
}

function getStatusLabels(item) {
  return getStatusList(item)
    .filter(([, active]) => active)
    .map(([label]) => label);
}

function applyStatusFilter(items) {
  if (!state.statusFilters.length) {
    return items;
  }

  return items.filter((item) =>
    state.statusFilters.some((filterKey) => {
      const matcher = statusFilterOptions[filterKey];
      return matcher ? matcher(item) : false;
    })
  );
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
  return applyStatusFilter(items).filter(matchesPlayerRange);
}

function sortValueForItem(item, sortKey) {
  if (sortKey === "statuses") {
    return getStatusLabels(item).join(", ");
  }

  if (sortKey === "playerCount") {
    const min = item.minPlayers ?? 999;
    const max = item.maxPlayers ?? 999;
    const best = item.bestPlayers ?? "";
    return `${String(min).padStart(3, "0")}-${String(max).padStart(3, "0")}-${best}`;
  }

  if (sortKey === "userRating") {
    return item.userRating === 0 ? null : item.userRating;
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
  const column = columns.find((candidate) => candidate.key === state.sortKey);
  const type = column?.type || "text";
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
  const baseItems = allItems.filter((item) => !isExpansion(item));
  const expansionItems = allItems.filter((item) => isExpansion(item));
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
    rows.push({
      item: expansion,
      expansions: [],
    });
  }

  return rows;
}

function renderStatuses(item) {
  return getStatusList(item)
    .filter(([, active]) => active)
    .map(([label]) => `<span class="pill active">${escapeHtml(label)}</span>`)
    .join("");
}

function formatUserRating(value) {
  if (value === 0 || value === "0") {
    return "-";
  }

  return formatValue(value);
}

function formatBggRank(value) {
  if (value === 0 || value === "0") {
    return "No Rank";
  }

  return formatValue(value);
}

function formatWeight(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  return Number(value).toFixed(2);
}

function renderWeightBadge(value) {
  if (value === null || value === undefined || value === "") {
    return '<span class="muted">—</span>';
  }

  const numeric = Math.max(0, Math.min(5, Number(value)));
  const hue = 140 - (numeric / 5) * 140;
  const background = `hsl(${hue} 72% 78%)`;
  return `<span class="weight-badge" style="background:${background}">${escapeHtml(formatWeight(numeric))}</span>`;
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

function renderDataCells(item) {
  const statuses = renderStatuses(item) || '<span class="muted">—</span>';
  const image = item.thumbnail
    ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.name)} cover" loading="lazy">`
    : '<div class="muted">No image</div>';

  return `
    <td>${image}</td>
    <td>
      <div class="game-name">${renderLink(item.name, item.link)}</div>
      <div class="game-meta">
        #${escapeHtml(formatValue(item.objectId))}
      </div>
    </td>
    <td>${escapeHtml(formatValue(item.yearPublished))}</td>
    <td>${escapeHtml(formatPlayerCount(item))}</td>
    <td>${renderWeightBadge(item.weight)}</td>
    <td>${escapeHtml(formatUserRating(item.userRating))}</td>
    <td>${escapeHtml(formatValue(item.bggAverageRating))}</td>
    <td>${escapeHtml(formatBggRank(item.bggRank))}</td>
    <td><div class="pill-list">${statuses}</div></td>
  `;
}

function renderTableHeader() {
  return columns
    .map((column) => {
      if (!column.sortable) {
        return `<th>${escapeHtml(column.label)}</th>`;
      }

      const isActive = state.sortKey === column.key;
      const indicator = isActive ? (state.sortDirection === "asc" ? " ↑" : " ↓") : "";

      return `
        <th class="sortable">
          <button class="sort-button ${isActive ? "active" : ""}" type="button" data-sort-key="${escapeHtml(column.key)}">
            ${escapeHtml(column.label)}${indicator}
          </button>
        </th>
      `;
    })
    .join("");
}

function renderExpansionList(expansions) {
  if (!expansions.length) {
    return "";
  }

  const rows = expansions
    .map(
      (expansion) => `
        <tr>
          ${renderDataCells(expansion)}
        </tr>
      `
    )
    .join("");

  return `
    <details class="expansion-disclosure">
      <summary>${escapeHtml(expansions.length)} expansion${expansions.length === 1 ? "" : "s"}</summary>
      <div class="expansion-table-wrap">
        <table class="expansion-table">
          <thead>
            <tr>${renderTableHeader()}</tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>
  `;
}

function renderRow(item, expansions = []) {
  return `
    <tr>
      ${renderDataCells(item)}
    </tr>
    ${
      expansions.length
        ? `
          <tr>
            <td colspan="${columns.length}">
              ${renderExpansionList(expansions)}
            </td>
          </tr>
        `
        : ""
    }
  `;
}

function renderTable(items, groupExpansions) {
  const preparedItems = sortItems(applyActiveFilters(items));
  const rows = groupExpansions
    ? groupItems(items).map(({ item, expansions }) => renderRow(item, expansions)).join("")
    : preparedItems.map((item) => renderRow(item)).join("");

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>${renderTableHeader()}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderEmptyState(message) {
  return `
    <div class="empty-state">
      ${message}
    </div>
  `;
}

function updateMeta(snapshot) {
  document.getElementById("meta-username").textContent = formatValue(snapshot.username, "Unknown");
  document.getElementById("meta-count").textContent = formatValue(snapshot.itemCount, "0");
  document.getElementById("meta-generated").textContent = formatDate(snapshot.generatedAt);
  document.getElementById("meta-source").textContent = formatValue(
    snapshot.sourceLabel,
    "BGG collection CSV export"
  );
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

  if (state.statusFilters.length) {
    parts.push(`filtered: ${state.statusFilters.length} statuses`);
  }

  if (state.playerMin !== null || state.playerMax !== null) {
    parts.push(`players: ${state.playerMin ?? "any"}-${state.playerMax ?? "any"}`);
  }

  parts.push(`${itemCount} items shown`);
  return parts.join(" · ");
}

function setupTableInteractions() {
  document.querySelectorAll("[data-sort-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const sortKey = button.getAttribute("data-sort-key");
      if (!sortKey) {
        return;
      }

      if (state.sortKey === sortKey) {
        state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = sortKey;
        state.sortDirection = "asc";
      }

      renderSnapshot();
    });
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
        '<span class="code">python3 scripts/sync_bgg_collection.py --username JoyfulFicus --input collections/JoyfulFicus.csv</span> ' +
        "to generate the first dataset from your local CSV export."
    );
    return;
  }

  const filteredItems = applyActiveFilters(snapshot.items);
  content.innerHTML = renderTable(snapshot.items, state.groupExpansions);
  updateStatus(buildStatusMessage(filteredItems.length), "");
  setupTableInteractions();
}

function setupControls() {
  const toggle = document.getElementById("group-expansions-toggle");
  const filterSummary = document.getElementById("status-filter-summary");
  const filterInputs = Array.from(document.querySelectorAll('.filter-option input'));
  const clearButton = document.getElementById("clear-status-filters");
  const playerMinInput = document.getElementById("player-min-filter");
  const playerMaxInput = document.getElementById("player-max-filter");

  toggle.checked = state.groupExpansions;
  toggle.addEventListener("change", () => {
    state.groupExpansions = toggle.checked;
    renderSnapshot();
  });

  function syncFilterSummary() {
    if (!state.statusFilters.length) {
      filterSummary.textContent = "All statuses";
      return;
    }

    const labels = filterInputs
      .filter((input) => state.statusFilters.includes(input.value))
      .map((input) => input.parentElement.textContent.trim());

    filterSummary.textContent =
      labels.length <= 2 ? labels.join(" + ") : `${labels.length} statuses selected`;
  }

  for (const input of filterInputs) {
    input.checked = state.statusFilters.includes(input.value);
    input.addEventListener("change", () => {
      state.statusFilters = filterInputs.filter((candidate) => candidate.checked).map((candidate) => candidate.value);
      syncFilterSummary();
      renderSnapshot();
    });
  }

  clearButton.addEventListener("click", () => {
    state.statusFilters = [];
    for (const input of filterInputs) {
      input.checked = false;
    }
    syncFilterSummary();
    renderSnapshot();
  });

  function syncPlayerRangeState() {
    const minValue = playerMinInput.value.trim();
    const maxValue = playerMaxInput.value.trim();

    state.playerMin = minValue ? Number(minValue) : null;
    state.playerMax = maxValue ? Number(maxValue) : null;

    if (
      state.playerMin !== null &&
      state.playerMax !== null &&
      state.playerMin > state.playerMax
    ) {
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

  syncFilterSummary();
  syncPlayerRangeState();
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

setupControls();
loadSnapshot();
