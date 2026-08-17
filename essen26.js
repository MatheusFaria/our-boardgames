const FUZZY_THRESHOLD = 0.5;

const NO_ONE_KEY = "__no_one__";

const PRIORITY_ORDER = ["1", "2", "3", "4", "unprioritized"];

const DEFAULT_PRIORITY_LABELS = {
  1: "Must Have",
  2: "Interested",
  3: "Not Decided",
  4: "Not Interested",
  unprioritized: "Unprioritized",
};

const SORT_OPTIONS = [
  { key: "priority", label: "Priority", defaultDirection: "asc" },
  { key: "interest", label: "Interest", defaultDirection: "desc" },
  { key: "name", label: "Name", defaultDirection: "asc" },
  { key: "price", label: "Price", defaultDirection: "asc" },
  { key: "yearPublished", label: "Year", defaultDirection: "desc" },
  { key: "playerCount", label: "Players", defaultDirection: "asc" },
  { key: "weight", label: "Weight", defaultDirection: "asc" },
  { key: "bggAverageRating", label: "BGG Rating", defaultDirection: "desc" },
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
  priorityLabels: DEFAULT_PRIORITY_LABELS,
  searchQuery: "",
  playerMin: null,
  playerMax: null,
  priorityFilters: [],
  defaultPriorityKeys: [],
  userFilters: [],
  availabilityFilters: [],
  sortKey: "priority",
  sortDirection: "asc",
  page: 1,
  pageSize: 24,
};

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

function formatPrice(price) {
  if (!price || price.amount === null || price.amount === undefined || price.amount === "") {
    return null;
  }
  const symbols = { EUR: "€", USD: "$", GBP: "£" };
  const symbol = symbols[price.currency] || "";
  const amount = Number(price.amount);
  const shown = Number.isInteger(amount) ? amount : amount.toFixed(2);
  return symbol ? `${symbol}${shown}` : `${shown} ${price.currency || ""}`.trim();
}

function priorityKey(entry) {
  const p = entry?.priority;
  return p === 1 || p === 2 || p === 3 || p === 4 ? String(p) : "unprioritized";
}

function priorityLabel(key) {
  return state.priorityLabels[key] || DEFAULT_PRIORITY_LABELS[key] || key;
}

function isPositiveWant(entry) {
  return entry.priority === 1 || entry.priority === 2 || entry.priority === 3;
}

function getPositiveWanters(item) {
  return (item.interested || []).filter(isPositiveWant);
}

function hasNoPositiveWanter(item) {
  return getPositiveWanters(item).length === 0;
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

function matchesPlayerRange(item) {
  if (state.playerMin === null && state.playerMax === null) return true;
  const gameMin = item.minPlayers;
  const gameMax = item.maxPlayers;
  if (gameMin === null || gameMin === undefined || gameMax === null || gameMax === undefined) {
    return false;
  }
  const selectedMin = state.playerMin ?? 1;
  const selectedMax = state.playerMax ?? Number.MAX_SAFE_INTEGER;
  return gameMax >= selectedMin && gameMin <= selectedMax;
}

function matchesPriorityFilter(item) {
  if (!state.priorityFilters.length) return true;
  const entries = item.interested || [];
  if (!entries.length) return true;
  return entries.some((entry) => state.priorityFilters.includes(priorityKey(entry)));
}

function matchesWantedByFilter(item) {
  if (!state.userFilters.length) return false;
  const noOneSelected = state.userFilters.includes(NO_ONE_KEY);
  if (noOneSelected && hasNoPositiveWanter(item)) return true;
  const positive = getPositiveWanters(item);
  return state.userFilters.some(
    (user) => user !== NO_ONE_KEY && positive.some((entry) => entry.user === user)
  );
}

function matchesInterestFilters(item) {
  if (hasNoPositiveWanter(item)) {
    return state.userFilters.includes(NO_ONE_KEY);
  }
  return matchesWantedByFilter(item) && matchesPriorityFilter(item);
}

function matchesAvailability(item) {
  if (!state.availabilityFilters.length) return true;
  return state.availabilityFilters.includes(item.availability);
}

function applyActiveFilters(items) {
  return items.filter(
    (item) =>
      matchesInterestFilters(item) &&
      matchesAvailability(item) &&
      matchesPlayerRange(item) &&
      matchesFuzzySearch(item)
  );
}

function bestPriority(item) {
  let best = 99;
  for (const entry of item.interested || []) {
    const key = priorityKey(entry);
    const rank = key === "unprioritized" ? 90 : Number(key);
    if (rank < best) best = rank;
  }
  return best;
}

function sortValueForItem(item, key) {
  switch (key) {
    case "name":
      return (item.name || "").toLowerCase();
    case "price":
      return item.price && item.price.amount != null ? Number(item.price.amount) : null;
    case "yearPublished":
      return item.yearPublished ?? null;
    case "playerCount":
      return item.maxPlayers ?? null;
    case "weight":
      return item.weight ?? null;
    case "bggAverageRating":
      return item.bggAverageRating ?? null;
    case "interest":
      return (item.interested || []).length;
    case "priority":
      return bestPriority(item);
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
  return [...items].sort((x, y) => {
    const primary = compareValues(
      sortValueForItem(x, state.sortKey),
      sortValueForItem(y, state.sortKey),
      state.sortDirection
    );
    if (primary !== 0) return primary;
    return String(x.name || "").localeCompare(String(y.name || ""));
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderInterest(item) {
  const entries = item.interested || [];
  if (!entries.length) {
    return '<span class="muted">No one interested yet</span>';
  }
  const sorted = [...entries].sort(
    (a, b) => PRIORITY_ORDER.indexOf(priorityKey(a)) - PRIORITY_ORDER.indexOf(priorityKey(b))
  );
  return `<div class="pill-list">${sorted
    .map((entry) => {
      const key = priorityKey(entry);
      const note = entry.notes
        ? ` title="${escapeHtml(entry.notes)}"`
        : "";
      return `<span class="pill prio-${key}"${note}>${escapeHtml(entry.user)} | ${escapeHtml(
        priorityLabel(key)
      )}</span>`;
    })
    .join("")}</div>`;
}

function renderCard(item) {
  const image = item.thumbnail
    ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.name)} cover" loading="lazy">`
    : '<div class="card-thumb placeholder">No image</div>';

  const yearLabel = item.yearPublished ? ` (${escapeHtml(item.yearPublished)})` : "";
  const price = formatPrice(item.price);

  const availabilityBadge = item.availability
    ? `<span class="avail-badge">${escapeHtml(item.availability)}</span>`
    : "";

  const priceLine = price
    ? `<div class="detail-line"><span class="detail-label">Price</span><span class="detail-value">${escapeHtml(
        price
      )}</span></div>`
    : "";

  const hallLine = item.location
    ? `<div class="detail-line"><span class="detail-label">Booth</span><span class="detail-value">${escapeHtml(
        item.location
      )}</span></div>`
    : "";

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
          ${availabilityBadge}
        </div>
        <div class="detail-list">
          <div class="detail-line"><span class="detail-label">Players</span><span class="detail-value">${escapeHtml(
            formatPlayerCount(item)
          )}</span></div>
          ${priceLine}
          ${hallLine}
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
          ${renderInterest(item)}
        </div>
      </div>
    </article>
  `;
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
  const atDefaultPriority =
    state.priorityFilters.length === state.defaultPriorityKeys.length &&
    state.defaultPriorityKeys.every((key) => state.priorityFilters.includes(key));
  if (!atDefaultPriority) {
    for (const key of state.priorityFilters) {
      chips.push({ label: `Priority: ${priorityLabel(key)}`, remove: () => togglePriorityFilter(key) });
    }
  }
  const defaultUsers = state.snapshot.users || [];
  const atDefaultUserFilters =
    state.userFilters.length === defaultUsers.length &&
    !state.userFilters.includes(NO_ONE_KEY) &&
    defaultUsers.every((user) => state.userFilters.includes(user));
  if (!atDefaultUserFilters) {
    for (const user of state.userFilters) {
      const label = user === NO_ONE_KEY ? "No one" : user;
      chips.push({ label: `Wanted by: ${label}`, remove: () => toggleUserFilter(user) });
    }
  }
  for (const avail of state.availabilityFilters) {
    chips.push({ label: avail, remove: () => toggleAvailabilityFilter(avail) });
  }
  if (state.playerMin !== null || state.playerMax !== null) {
    const min = state.playerMin ?? "1";
    const max = state.playerMax ?? "∞";
    chips.push({
      label: `Players: ${min}–${max}`,
      remove: () => {
        state.playerMin = null;
        state.playerMax = null;
        document.getElementById("player-min-filter").value = "";
        document.getElementById("player-max-filter").value = "";
        state.page = 1;
        syncFilterUI();
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

function togglePriorityFilter(key) {
  const i = state.priorityFilters.indexOf(key);
  if (i >= 0) state.priorityFilters.splice(i, 1);
  else state.priorityFilters.push(key);
  state.page = 1;
  syncFilterUI();
  renderContent();
}

function toggleUserFilter(user) {
  const i = state.userFilters.indexOf(user);
  if (i >= 0) state.userFilters.splice(i, 1);
  else state.userFilters.push(user);
  state.page = 1;
  syncFilterUI();
  renderContent();
}

function toggleAvailabilityFilter(avail) {
  const i = state.availabilityFilters.indexOf(avail);
  if (i >= 0) state.availabilityFilters.splice(i, 1);
  else state.availabilityFilters.push(avail);
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

function renderPriorityFilterGrid() {
  const grid = document.getElementById("priority-filter-grid");
  const counts = {};
  for (const item of state.snapshot.items) {
    for (const entry of item.interested || []) {
      const key = priorityKey(entry);
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  grid.innerHTML = "";
  for (const key of PRIORITY_ORDER) {
    if (!counts[key]) continue;
    const checked = state.priorityFilters.includes(key);
    grid.appendChild(
      buildCheckboxOption(
        "owner-filter-option",
        checked,
        `${priorityLabel(key)} (${counts[key]})`,
        () => togglePriorityFilter(key)
      )
    );
  }
}

function renderUserFilterGrid() {
  const grid = document.getElementById("user-filter-grid");
  grid.innerHTML = "";
  const wantedCounts = {};
  for (const item of state.snapshot.items) {
    for (const entry of getPositiveWanters(item)) {
      wantedCounts[entry.user] = (wantedCounts[entry.user] || 0) + 1;
    }
  }
  for (const user of state.snapshot.users || []) {
    const checked = state.userFilters.includes(user);
    grid.appendChild(
      buildCheckboxOption(
        "owner-filter-option",
        checked,
        `${user} (${wantedCounts[user] || 0})`,
        () => toggleUserFilter(user)
      )
    );
  }
  const noOneCount = state.snapshot.noOneCount ?? state.snapshot.items.filter(hasNoPositiveWanter).length;
  const noOneChecked = state.userFilters.includes(NO_ONE_KEY);
  grid.appendChild(
    buildCheckboxOption(
      "owner-filter-option owner-filter-option--noone",
      noOneChecked,
      `No one (${noOneCount})`,
      () => toggleUserFilter(NO_ONE_KEY)
    )
  );
}

function renderAvailabilityFilterGrid() {
  const grid = document.getElementById("availability-filter-grid");
  const values = [...new Set(state.snapshot.items.map((i) => i.availability).filter(Boolean))].sort();
  grid.innerHTML = "";
  for (const avail of values) {
    const checked = state.availabilityFilters.includes(avail);
    grid.appendChild(
      buildCheckboxOption("status-filter-option", checked, avail, () =>
        toggleAvailabilityFilter(avail)
      )
    );
  }
}

function syncFilterUI() {
  renderPriorityFilterGrid();
  renderUserFilterGrid();
  renderAvailabilityFilterGrid();
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
      localStorage.setItem("essenPageSize", String(option.value));
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

  const playerMin = document.getElementById("player-min-filter");
  const playerMax = document.getElementById("player-max-filter");
  const onPlayers = () => {
    let min = playerMin.value ? Number(playerMin.value) : null;
    let max = playerMax.value ? Number(playerMax.value) : null;
    if (min !== null && max !== null && min > max) {
      [min, max] = [max, min];
      playerMin.value = String(min);
      playerMax.value = String(max);
    }
    state.playerMin = min;
    state.playerMax = max;
    state.page = 1;
    renderContent();
  };
  playerMin.addEventListener("input", onPlayers);
  playerMax.addEventListener("input", onPlayers);

  document
    .getElementById("clear-priority-filters")
    .addEventListener("click", () => {
      state.priorityFilters = [];
      state.page = 1;
      syncFilterUI();
      renderContent();
    });
  document.getElementById("clear-user-filters").addEventListener("click", () => {
    state.userFilters = [...(state.snapshot.users || []), NO_ONE_KEY];
    state.page = 1;
    syncFilterUI();
    renderContent();
  });
  document
    .getElementById("clear-availability-filters")
    .addEventListener("click", () => {
      state.availabilityFilters = [];
      state.page = 1;
      syncFilterUI();
      renderContent();
    });

  const savedPageSize = localStorage.getItem("essenPageSize");
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
  document.getElementById("meta-users").textContent = (snap.users || []).join(", ") || "—";
  document.getElementById("meta-count").textContent = String(snap.itemCount ?? (snap.items || []).length);
  document.getElementById("meta-wanted").textContent = String(snap.interestedCount ?? "—");
  document.getElementById("meta-noone").textContent = String(snap.noOneCount ?? "—");
  document.getElementById("meta-generated").textContent = formatGeneratedAt(snap.generatedAt);
  const event = snap.event || {};
  document.getElementById("meta-event").textContent = event.location || event.title || "—";
}

async function loadSnapshot() {
  const statusPill = document.getElementById("status-pill");
  const content = document.getElementById("content");
  try {
    const response = await fetch("./data/essen26.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.snapshot = await response.json();
  } catch (error) {
    statusPill.className = "status error";
    statusPill.textContent = "Could not load snapshot";
    const hint =
      location.protocol === "file:"
        ? " Serve the site over http (e.g. <span class=\"code\">python3 -m http.server</span>) so the JSON can load."
        : "";
    content.innerHTML = `<div class="empty-state">Failed to load <span class="code">data/essen26.json</span>.${hint}</div>`;
    return;
  }

  if (state.snapshot.priorityLabels) {
    state.priorityLabels = state.snapshot.priorityLabels;
  }

  const presentPriorities = PRIORITY_ORDER.filter((key) =>
    (state.snapshot.items || []).some((item) =>
      (item.interested || []).some((entry) => priorityKey(entry) === key)
    )
  );
  state.defaultPriorityKeys = presentPriorities.filter((key) => key !== "4");
  state.priorityFilters = [...state.defaultPriorityKeys];
  state.userFilters = [...(state.snapshot.users || [])];

  renderMeta();
  syncFilterUI();
  renderSortOptions();
  renderPageSizeOptions();
  renderContent();
}

setupControls();
setupMobileNav();
setupThemeToggle();
loadSnapshot();
