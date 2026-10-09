(() => {
  "use strict";

  const CONFIG = {
    DATA_URL: "https://script.google.com/macros/s/AKfycby2xeJeM81Pk5lky5tscZnXgj0KuP6iN9H6Q7TbZtMXMsJWWFi0k9DPlhF03x2S_T78/exec",
    REFRESH_INTERVAL_MS: 60000,
    DEFAULT_PAGE_SIZE: 50,
    DONUT_COLORS: ["#52d6b3", "#74aaf7", "#f3bd63", "#cb8ce5", "#f07c76", "#5fc5d8", "#98c66d", "#e39964", "#8291f3", "#d96c9b"]
  };

  const SOURCE_HEADERS = ["Shipping Package ID", "Shipping Provider Code", "Store Code", "Bin Code"];
  const FIELD_KEYS = ["shippingPackageId", "shippingProviderCode", "storeCode", "binCode"];
  const BIN_RANGE_GROUPS = [
    { label: "NDD1-NDD175", prefix: "NDD", min: 1, max: 175 },
    { label: "NDD176-NDD355", prefix: "NDD", min: 176, max: 355 },
    { label: "NDD356-NDD525", prefix: "NDD", min: 356, max: 525 },
    { label: "NDD526-NDD698", prefix: "NDD", min: 526, max: 698 },
    { label: "NDD699-NDD868", prefix: "NDD", min: 699, max: 868 },
    { label: "NDD869-NDD1008", prefix: "NDD", min: 869, max: 1008 },
    { label: "NDD1009-NDD1188", prefix: "NDD", min: 1009, max: 1188 },
    { label: "NDD1189-NDD END", prefix: "NDD", min: 1189, max: Infinity },
    { label: "P1-P195", prefix: "P", min: 1, max: 195 },
    { label: "P196-PEND", prefix: "P", min: 196, max: Infinity },
    { label: "GP1-GP263", prefix: "GP", min: 1, max: 263 },
    { label: "GP264-GP END", prefix: "GP", min: 264, max: Infinity }
  ];
  const FILTERS = [
    { key: "bin", label: "BIN", element: "bin-filter", field: "binCode" },
    { key: "store", label: "STORE", element: "store-filter", field: "storeCode" },
    { key: "provider", label: "PROVIDER", element: "provider-filter", field: "shippingProviderCode" }
  ];
  const state = {
    rows: [],
    filteredRows: [],
    metadata: null,
    loadedAt: null,
    connection: "loading",
    error: "",
    filters: { bin: "", binPrefix: "", binGroup: "", store: "", provider: "", search: "", quality: "" },
    sort: { field: "", direction: 1 },
    page: 1,
    pageSize: CONFIG.DEFAULT_PAGE_SIZE,
    selected: new Set(),
    refreshing: false,
    timer: null,
    countdownTimer: null,
    secondsUntilRefresh: Math.ceil(CONFIG.REFRESH_INTERVAL_MS / 1000)
  };

  const $ = (id) => document.getElementById(id);
  const formatter = new Intl.NumberFormat("en-US");
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const displayValue = (value) => value || "Missing";

  function getBinPrefix(binCode) {
    if (!binCode) return "Missing bin";
    const match = binCode.match(/^[A-Za-z]+/);
    return match ? match[0].toUpperCase() : "Other / numeric";
  }

  function getBinGroup(binCode) {
    if (!binCode) return "Missing bin";
    const normalized = binCode.toUpperCase().replace(/\s+/g, "");
    for (const prefix of ["NDD", "GP", "P"]) {
      const match = normalized.match(new RegExp(`^${prefix}(\\d+)$`));
      if (!match) continue;
      const number = Number(match[1]);
      const range = BIN_RANGE_GROUPS.find((group) =>
        group.prefix === prefix && number >= group.min && number <= group.max);
      return range ? range.label : `Other ${prefix} bin`;
    }
    const prefix = getBinPrefix(binCode);
    if (["S", "V", "D"].includes(prefix)) return `${prefix} whole`;
    if (prefix === "Missing bin" || prefix === "Other / numeric") return prefix;
    return `Other prefix: ${prefix}`;
  }

  function readField(record, index, key) {
    if (Array.isArray(record)) return record[index];
    if (record && typeof record === "object") {
      if (Object.prototype.hasOwnProperty.call(record, SOURCE_HEADERS[index])) return record[SOURCE_HEADERS[index]];
      if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
    }
    return "";
  }

  function normalizeRows(rawRows) {
    let invalidCount = 0;
    const rows = rawRows.map((raw, index) => {
      const supported = Array.isArray(raw) || (raw && typeof raw === "object");
      if (!supported) {
        invalidCount += 1;
        return {
          rowId: index,
          shippingPackageId: "",
          shippingProviderCode: "",
          storeCode: "",
          binCode: "",
          binPrefix: "Missing bin",
          binGroup: "Missing bin",
          invalid: true
        };
      }
      const hasExpectedShape = Array.isArray(raw)
        ? raw.length >= FIELD_KEYS.length
        : FIELD_KEYS.every((key, fieldIndex) =>
          Object.prototype.hasOwnProperty.call(raw, SOURCE_HEADERS[fieldIndex]) ||
          Object.prototype.hasOwnProperty.call(raw, key));
      const values = FIELD_KEYS.map((key, fieldIndex) => {
        const value = readField(raw, fieldIndex, key);
        return value === null || value === undefined ? "" : String(value).trim();
      });
      const invalid = !hasExpectedShape || values.every((value) => !value);
      if (invalid) invalidCount += 1;
      return {
        rowId: index,
        shippingPackageId: values[0],
        shippingProviderCode: values[1],
        storeCode: values[2],
        binCode: values[3],
        binPrefix: getBinPrefix(values[3]),
        binGroup: getBinGroup(values[3]),
        invalid
      };
    });
    const packageIdCounts = countValues(rows, "shippingPackageId");
    for (const row of rows) {
      row.duplicatePackageId = Boolean(row.shippingPackageId && packageIdCounts.get(row.shippingPackageId) > 1);
    }
    return { rows, invalidCount };
  }

  function formatTimestamp(value) {
    if (value === null || value === undefined || value === "") return "";
    const raw = String(value).trim();
    if (/\bIST$/i.test(raw)) return raw;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return raw;
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(date) + " IST";
  }

  function validatePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("The Apps Script response is not a JSON object.");
    }
    if (payload.error) throw new Error(`Google Sheet returned: ${String(payload.error)}`);
    if (!Array.isArray(payload.rows)) throw new Error("The response does not contain a rows array. Check the Web App deployment and includeRows setting.");
    if (payload.rowCount !== undefined && !Number.isFinite(Number(payload.rowCount))) {
      throw new Error("The response contains an invalid rowCount value.");
    }
    return payload;
  }

  async function fetchSnapshot() {
    const url = new URL(CONFIG.DATA_URL);
    url.searchParams.set("type", "packingPrintList");
    url.searchParams.set("includeRows", "true");
    url.searchParams.set("_", String(Date.now()));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(url.toString(), { method: "GET", cache: "no-store", redirect: "follow" });
      if (!response.ok) throw new Error(`Web App request failed with HTTP ${response.status}.`);
      let payload;
      try {
        payload = validatePayload(await response.json());
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error("The Web App returned a response that could not be parsed as JSON.");
        throw error;
      }
      const expectedRows = payload.rowCount === undefined ? null : Number(payload.rowCount);
      if (expectedRows === null || expectedRows === payload.rows.length) return payload;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 900));
    }
    throw new Error("The source snapshot changed while rows were being read. The incomplete response was not loaded; retrying on the next refresh.");
  }

  function setConnection(connection) {
    state.connection = connection;
    const pill = $("connection-pill");
    pill.dataset.state = connection;
    $("connection-label").textContent = connection === "live" ? "LIVE" : connection === "offline" ? "OFFLINE" : "CONNECTING";
  }

  function showNotice(title, message) {
    $("notice-title").textContent = title;
    $("notice-message").textContent = message;
    $("notice-bar").hidden = false;
  }

  function hideNotice() {
    $("notice-bar").hidden = true;
  }

  function showInitialError(message) {
    $("state-card").hidden = false;
    $("state-card").dataset.state = "error";
    $("state-title").textContent = "Live data unavailable";
    $("state-message").textContent = message;
    $("state-retry").hidden = false;
    $("dashboard-content").setAttribute("aria-busy", "false");
  }

  function countValues(rows, field) {
    const counts = new Map();
    for (const row of rows) {
      const value = row[field];
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
  }

  function descendingEntries(counts) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function getQuality() {
    return {
      missingBin: state.rows.filter((row) => !row.binCode).length,
      missingStore: state.rows.filter((row) => !row.storeCode).length,
      missingProvider: state.rows.filter((row) => !row.shippingProviderCode).length,
      duplicateIds: state.rows.filter((row) => row.duplicatePackageId).length,
      invalid: state.rows.filter((row) => row.invalid).length
    };
  }

  function applyFilters() {
    const { bin, binPrefix, binGroup, store, provider, search, quality } = state.filters;
    const needle = search.trim().toLowerCase();
    const qualityMatches = {
      missingBin: (row) => !row.binCode,
      missingStore: (row) => !row.storeCode,
      missingProvider: (row) => !row.shippingProviderCode,
      duplicateIds: (row) => row.duplicatePackageId,
      invalid: (row) => row.invalid
    };
    const rows = state.rows.filter((row) =>
      (!bin || row.binCode === bin) &&
      (!binPrefix || row.binPrefix === binPrefix) &&
      (!binGroup || row.binGroup === binGroup) &&
      (!store || row.storeCode === store) &&
      (!provider || row.shippingProviderCode === provider) &&
      (!quality || qualityMatches[quality](row)) &&
      (!needle || row.shippingPackageId.toLowerCase().includes(needle))
    );
    if (state.sort.field) {
      const field = state.sort.field;
      const direction = state.sort.direction;
      rows.sort((a, b) => {
        const left = a[field] || "";
        const right = b[field] || "";
        if (!left && right) return 1;
        if (left && !right) return -1;
        return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }) * direction || a.rowId - b.rowId;
      });
    }
    state.filteredRows = rows;
    const lastPage = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.page = Math.min(state.page, lastPage);
    return rows;
  }

  function renderFilterOptions() {
    const options = [
      ["bin-filter", "All bins", "binCode"],
      ["store-filter", "All stores", "storeCode"],
      ["provider-filter", "All providers", "shippingProviderCode"]
    ];
    for (const [id, placeholder, field] of options) {
      const select = $(id);
      const selected = state.filters[id === "bin-filter" ? "bin" : id === "store-filter" ? "store" : "provider"];
      const values = [...new Set(state.rows.map((row) => row[field]).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
      select.innerHTML = `<option value="">${placeholder}</option>${values.map((value) =>
        `<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;
      select.value = selected;
    }
  }

  function renderActiveFilters() {
    const chips = FILTERS.filter(({ key }) => state.filters[key]).map(({ key, label }) =>
      `<span class="filter-chip">${label}: ${esc(state.filters[key])}<button type="button" data-remove-filter="${key}" aria-label="Remove ${label.toLowerCase()} filter">×</button></span>`);
    if (state.filters.binPrefix) {
      chips.push(`<span class="filter-chip">BIN PREFIX: ${esc(state.filters.binPrefix)}<button type="button" data-remove-filter="binPrefix" aria-label="Remove bin prefix filter">×</button></span>`);
    }
    if (state.filters.binGroup) {
      chips.push(`<span class="filter-chip">BIN RANGE: ${esc(state.filters.binGroup)}<button type="button" data-remove-filter="binGroup" aria-label="Remove bin range filter">×</button></span>`);
    }
    if (state.filters.quality) {
      const qualityLabels = {
        missingBin: "Missing bin",
        missingStore: "Missing store",
        missingProvider: "Missing provider",
        duplicateIds: "Duplicate package IDs",
        invalid: "Invalid rows"
      };
      chips.push(`<span class="filter-chip">DATA QUALITY: ${esc(qualityLabels[state.filters.quality] || state.filters.quality)}<button type="button" data-remove-filter="quality" aria-label="Remove data quality filter">×</button></span>`);
    }
    if (state.filters.search) {
      chips.push(`<span class="filter-chip">SEARCH: ${esc(state.filters.search)}<button type="button" data-remove-filter="search" aria-label="Remove shipment search">×</button></span>`);
    }
    $("active-filters").innerHTML = chips.join("");
  }

  function renderKpis(rows) {
    const bins = descendingEntries(countValues(rows, "binCode"));
    const binGroups = descendingEntries(countValues(rows.filter((row) => row.binCode), "binGroup"));
    $("kpi-shipments").textContent = formatter.format(rows.length);
    $("kpi-shipments-foot").textContent = rows.length === state.rows.length
      ? "In current source snapshot"
      : `Filtered from ${formatter.format(state.rows.length)} source rows`;
    $("kpi-bins").textContent = formatter.format(countValues(rows, "binCode").size);
    $("kpi-stores").textContent = formatter.format(countValues(rows, "storeCode").size);
    $("kpi-providers").textContent = formatter.format(countValues(rows, "shippingProviderCode").size);
    $("kpi-top-bin").textContent = bins.length ? bins[0][0] : "—";
    $("kpi-top-bin-count").textContent = bins.length ? formatter.format(bins[0][1]) : "—";
    $("kpi-top-bin").dataset.value = bins.length ? bins[0][0] : "";
    $("kpi-top-bin").disabled = !bins.length;
    $("kpi-top-group").textContent = binGroups.length ? binGroups[0][0] : "—";
    $("kpi-top-group-count").textContent = binGroups.length ? formatter.format(binGroups[0][1]) : "—";
    $("kpi-top-group").dataset.value = binGroups.length ? binGroups[0][0] : "";
    $("kpi-top-group").disabled = !binGroups.length;
  }

  function renderPrefixSection(rows) {
    const groups = new Map();
    for (const row of rows) {
      let group = groups.get(row.binPrefix);
      if (!group) {
        group = { shipments: 0, bins: new Map() };
        groups.set(row.binPrefix, group);
      }
      group.shipments += 1;
      if (row.binCode) group.bins.set(row.binCode, (group.bins.get(row.binCode) || 0) + 1);
    }
    const entries = [...groups.entries()].sort((a, b) =>
      b[1].shipments - a[1].shipments || a[0].localeCompare(b[0], undefined, { numeric: true }));
    $("prefix-rows").innerHTML = entries.length ? entries.map(([prefix, group]) => {
      const busiest = descendingEntries(group.bins)[0];
      const share = rows.length ? group.shipments / rows.length * 100 : 0;
      return `<tr class="${state.filters.binPrefix === prefix ? "is-selected" : ""}">
        <td><button class="prefix-filter-button" type="button" data-chart-filter="prefix" data-value="${esc(prefix)}" aria-label="Filter by bin prefix ${esc(prefix)}">${esc(prefix)}</button></td>
        <td class="prefix-number">${formatter.format(group.shipments)}</td>
        <td class="prefix-share"><span class="prefix-share-track"><i style="width:${share.toFixed(2)}%"></i></span><span>${share.toFixed(1)}%</span></td>
        <td>${formatter.format(group.bins.size)}</td>
        <td>${busiest ? `<button class="prefix-busiest-button" type="button" data-chart-filter="bin" data-value="${esc(busiest[0])}" title="Filter by ${esc(busiest[0])}">${esc(busiest[0])} <span>${formatter.format(busiest[1])}</span></button>` : '<span class="missing-prefix-value">—</span>'}</td>
      </tr>`;
    }).join("") : '<tr><td class="prefix-empty" colspan="5">No bin workload matches the current filters.</td></tr>';
    $("prefix-summary").textContent = `${formatter.format(entries.length)} prefix groups · ${formatter.format(rows.length)} shipments in this selection`;
  }

  function renderBinRangeSection(rows) {
    const groups = new Map();
    for (const { label } of BIN_RANGE_GROUPS) {
      groups.set(label, { shipments: 0, bins: new Map() });
    }
    for (const row of rows) {
      let group = groups.get(row.binGroup);
      if (!group) {
        group = { shipments: 0, bins: new Map() };
        groups.set(row.binGroup, group);
      }
      group.shipments += 1;
      if (row.binCode) group.bins.set(row.binCode, (group.bins.get(row.binCode) || 0) + 1);
    }
    const entries = [...groups.entries()].sort((a, b) => {
      const aIndex = BIN_RANGE_GROUPS.findIndex((group) => group.label === a[0]);
      const bIndex = BIN_RANGE_GROUPS.findIndex((group) => group.label === b[0]);
      if (aIndex !== -1 || bIndex !== -1) {
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
      }
      return b[1].shipments - a[1].shipments || a[0].localeCompare(b[0]);
    });
    $("bin-range-rows").innerHTML = entries.map(([label, group]) => {
      const busiest = descendingEntries(group.bins)[0];
      const share = rows.length ? group.shipments / rows.length * 100 : 0;
      return `<tr class="${state.filters.binGroup === label ? "is-selected" : ""}">
        <td><button class="prefix-filter-button" type="button" data-chart-filter="binGroup" data-value="${esc(label)}" aria-label="Filter by bin range ${esc(label)}">${esc(label)}</button></td>
        <td class="prefix-number">${formatter.format(group.shipments)}</td>
        <td class="prefix-share"><span class="prefix-share-track"><i style="width:${share.toFixed(2)}%"></i></span><span>${share.toFixed(1)}%</span></td>
        <td>${formatter.format(group.bins.size)}</td>
        <td>${busiest ? `<button class="prefix-busiest-button" type="button" data-chart-filter="bin" data-value="${esc(busiest[0])}" title="Filter by ${esc(busiest[0])}">${esc(busiest[0])} <span>${formatter.format(busiest[1])}</span></button>` : '<span class="missing-prefix-value">—</span>'}</td>
      </tr>`;
    }).join("");
    $("bin-range-summary").textContent = `${formatter.format(entries.length)} bin range groups · ${formatter.format(rows.length)} shipments in this selection`;
  }

  function renderProviderSection(rows) {
    const entries = descendingEntries(countValues(rows, "shippingProviderCode"));
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    const donutEntries = entries.slice(0, CONFIG.DONUT_COLORS.length);
    const otherCount = entries.slice(CONFIG.DONUT_COLORS.length).reduce((sum, [, count]) => sum + count, 0);
    if (otherCount) donutEntries.push(["Other providers", otherCount]);
    let offset = 0;
    const stops = donutEntries.map(([, count], index) => {
      const start = offset;
      offset += total ? count / total * 360 : 0;
      return `${CONFIG.DONUT_COLORS[index % CONFIG.DONUT_COLORS.length]} ${start.toFixed(2)}deg ${offset.toFixed(2)}deg`;
    });
    $("provider-donut").style.background = stops.length ? `conic-gradient(${stops.join(",")})` : "conic-gradient(#233447 0deg 360deg)";
    $("provider-donut").setAttribute("aria-label", entries.map(([name, count]) =>
      `${name}: ${total ? (count / total * 100).toFixed(1) : "0.0"} percent`).join(", ") || "No provider data");
    $("provider-donut").innerHTML = `<div class="donut-center"><strong>${formatter.format(total)}</strong><span>SHIPMENTS</span></div>`;
    $("provider-legend").innerHTML = donutEntries.slice(0, 5).map(([name, count], index) =>
      `<div class="provider-legend-item"><i style="background:${CONFIG.DONUT_COLORS[index % CONFIG.DONUT_COLORS.length]}"></i><span>${esc(name)}</span><strong>${total ? (count / total * 100).toFixed(1) : "0.0"}%</strong></div>`).join("") ||
      '<div class="empty-chart">No provider data</div>';
    $("provider-table").innerHTML = entries.slice(0, 5).map(([name, count], index) =>
      `<div class="mini-ranking-row"><span>${String(index + 1).padStart(2, "0")}</span><button type="button" data-chart-filter="provider" data-value="${esc(name)}" title="Filter by ${esc(name)}">${esc(name)}</button><strong>${formatter.format(count)}</strong><em>${total ? (count / total * 100).toFixed(1) : "0.0"}%</em></div>`).join("") ||
      '<div class="empty-chart">No providers in this selection</div>';
  }

  function renderQuality() {
    const quality = getQuality();
    $("quality-total").textContent = `${formatter.format(state.rows.length)} rows`;
    const metrics = [
      ["quality-missing-bin", "missingBin", quality.missingBin],
      ["quality-missing-store", "missingStore", quality.missingStore],
      ["quality-missing-provider", "missingProvider", quality.missingProvider],
      ["quality-duplicates", "duplicateIds", quality.duplicateIds],
      ["quality-invalid", "invalid", quality.invalid]
    ];
    for (const [id, filter, value] of metrics) {
      $(id).textContent = formatter.format(value);
      $(id).classList.toggle("has-issues", value > 0);
      const button = $(id).closest("button");
      button.disabled = value === 0;
      button.setAttribute("aria-pressed", String(state.filters.quality === filter));
    }
  }

  function renderTable() {
    const rows = state.filteredRows;
    const pageCount = Math.max(1, Math.ceil(rows.length / state.pageSize));
    const start = (state.page - 1) * state.pageSize;
    const visible = rows.slice(start, start + state.pageSize);
    $("table-summary").textContent = rows.length
      ? `Showing ${formatter.format(start + 1)}–${formatter.format(start + visible.length)} of ${formatter.format(rows.length)} filtered rows`
      : "No shipment rows match the current filters";
    $("page-indicator").textContent = `Page ${formatter.format(state.page)} of ${formatter.format(pageCount)}`;
    $("previous-page").disabled = state.page <= 1;
    $("next-page").disabled = state.page >= pageCount;
    for (const button of document.querySelectorAll(".sort-button")) {
      const field = button.dataset.sort;
      button.querySelector("span").textContent = state.sort.field === field ? (state.sort.direction > 0 ? "↑" : "↓") : "";
      button.setAttribute("aria-sort", state.sort.field === field ? (state.sort.direction > 0 ? "ascending" : "descending") : "none");
    }
    if (!visible.length) {
      $("shipment-rows").innerHTML = '<tr><td class="table-empty" colspan="5">No rows to display. Try clearing one or more filters.</td></tr>';
    } else {
      $("shipment-rows").innerHTML = visible.map((row) => {
        const fields = FIELD_KEYS.map((key) => {
          const value = row[key];
          return `<td class="${value ? "" : "missing-cell"}">${esc(displayValue(value))}</td>`;
        });
        return `<tr><td><input type="checkbox" data-select-row="${row.rowId}" aria-label="Select shipment ${esc(row.shippingPackageId || `source row ${row.rowId + 1}`)}" ${state.selected.has(row.rowId) ? "checked" : ""}></td>${fields.join("")}</tr>`;
      }).join("");
    }
    const selectedCount = state.selected.size;
    $("selected-summary").textContent = selectedCount ? `${formatter.format(selectedCount)} row${selectedCount === 1 ? "" : "s"} selected` : "No rows selected";
    $("copy-selected").disabled = selectedCount === 0;
  }

  function render() {
    const rows = applyFilters();
    renderActiveFilters();
    renderKpis(rows);
    renderPrefixSection(rows);
    renderBinRangeSection(rows);
    renderProviderSection(rows);
    renderQuality();
    renderTable();
    $("dashboard-content").setAttribute("aria-busy", "false");
  }

  function updateLastUpdated() {
    const sourceTimestamp = state.metadata && formatTimestamp(state.metadata.timestamp);
    const fallbackTimestamp = state.loadedAt ? formatTimestamp(state.loadedAt) : "";
    $("last-updated").textContent = sourceTimestamp || fallbackTimestamp || "Not available";
    $("last-updated").title = state.metadata && state.metadata.runId ? `Source run: ${state.metadata.runId}` : "";
  }

  function startRefreshCountdown() {
    clearInterval(state.countdownTimer);
    state.secondsUntilRefresh = Math.ceil(CONFIG.REFRESH_INTERVAL_MS / 1000);
    $("countdown").textContent = `${state.secondsUntilRefresh}s`;
    state.countdownTimer = setInterval(() => {
      state.secondsUntilRefresh = Math.max(0, state.secondsUntilRefresh - 1);
      $("countdown").textContent = `${state.secondsUntilRefresh}s`;
    }, 1000);
  }

  async function refreshData() {
    if (state.refreshing) return;
    state.refreshing = true;
    $("refresh-button").disabled = true;
    $("refresh-button").querySelector(".refresh-icon").classList.add("is-spinning");
    $("dashboard-content").setAttribute("aria-busy", "true");
    if (!state.rows.length) {
      $("state-card").hidden = false;
      $("state-card").dataset.state = "loading";
      $("state-title").textContent = "Connecting to the live sheet";
      $("state-message").textContent = "Loading the latest PackingPrintList snapshot.";
      $("state-retry").hidden = true;
    }
    try {
      const payload = await fetchSnapshot();
      const normalized = normalizeRows(payload.rows);
      state.rows = normalized.rows;
      state.metadata = payload;
      state.loadedAt = new Date();
      state.error = "";
      setConnection("live");
      $("state-card").hidden = true;
      hideNotice();
      renderFilterOptions();
      render();
      updateLastUpdated();
      const expectedRows = payload.rowCount === undefined ? null : Number(payload.rowCount);
      if (expectedRows !== null && expectedRows !== state.rows.length) {
        showNotice("Row count differs from the source metadata", `The Web App reported ${formatter.format(expectedRows)} rows but returned ${formatter.format(state.rows.length)}. Displaying all rows returned.`);
      } else if (normalized.invalidCount) {
        showNotice("Some source rows are malformed", `${formatter.format(normalized.invalidCount)} row${normalized.invalidCount === 1 ? " was" : "s were"} empty or unsupported and remain visible in data quality checks.`);
      } else if (!state.rows.length) {
        showNotice("The source snapshot is empty", "The dashboard is connected, but no PackingPrintList rows are currently available.");
      }
      startRefreshCountdown();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      setConnection("offline");
      const message = `${state.error} Check that the Apps Script Web App is deployed for anyone and that this URL is current.`;
      if (state.loadedAt) {
        showNotice("Refresh failed · showing last successful data", `${message} Last successful update: ${formatTimestamp(state.metadata && state.metadata.timestamp) || formatTimestamp(state.loadedAt)}.`);
        $("dashboard-content").setAttribute("aria-busy", "false");
      } else {
        showInitialError(message);
      }
    } finally {
      state.refreshing = false;
      $("refresh-button").disabled = false;
      $("refresh-button").querySelector(".refresh-icon").classList.remove("is-spinning");
      startRefreshCountdown();
    }
  }

  function setFilter(key, value) {
    state.filters[key] = value;
    state.page = 1;
    render();
  }

  function clearFilters() {
    state.filters = { bin: "", binPrefix: "", binGroup: "", store: "", provider: "", search: "", quality: "" };
    $("bin-filter").value = "";
    $("store-filter").value = "";
    $("provider-filter").value = "";
    $("search-filter").value = "";
    state.page = 1;
    render();
  }

  function rowToCsv(row) {
    return FIELD_KEYS.map((key) => `"${String(row[key] ?? "").replace(/"/g, '""')}"`).join(",");
  }

  function downloadCsv(filename, rows) {
    const contents = [SOURCE_HEADERS.map((header) => `"${header}"`).join(","), ...rows.map(rowToCsv)].join("\r\n");
    const blob = new Blob(["\uFEFF", contents], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }

  function dateSuffix() {
    return new Date().toISOString().slice(0, 10);
  }

  async function copySelectedRows() {
    const selected = state.rows.filter((row) => state.selected.has(row.rowId));
    if (!selected.length) return;
    const text = [SOURCE_HEADERS.join("\t"), ...selected.map((row) => FIELD_KEYS.map((key) => row[key]).join("\t"))].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      $("selected-summary").textContent = `${formatter.format(selected.length)} selected row${selected.length === 1 ? "" : "s"} copied`;
    } catch (error) {
      showNotice("Clipboard access was blocked", "Allow clipboard access in the browser or select and copy the row values directly.");
    }
  }

  function changePage(direction) {
    const pageCount = Math.max(1, Math.ceil(state.filteredRows.length / state.pageSize));
    state.page = Math.max(1, Math.min(pageCount, state.page + direction));
    renderTable();
  }

  function bindEvents() {
    $("bin-filter").addEventListener("change", (event) => setFilter("bin", event.target.value));
    $("store-filter").addEventListener("change", (event) => setFilter("store", event.target.value));
    $("provider-filter").addEventListener("change", (event) => setFilter("provider", event.target.value));
    $("search-filter").addEventListener("input", (event) => {
      state.filters.search = event.target.value;
      state.page = 1;
      render();
    });
    $("clear-filters").addEventListener("click", clearFilters);
    $("active-filters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-filter]");
      if (!button) return;
      const key = button.dataset.removeFilter;
      if (key === "search") $("search-filter").value = "";
      else {
        const filter = FILTERS.find((item) => item.key === key);
        if (filter) $(filter.element).value = "";
      }
      setFilter(key, "");
    });
    $("dashboard-content").addEventListener("click", (event) => {
      const qualityButton = event.target.closest("[data-quality-filter]");
      if (!qualityButton) return;
      const filter = qualityButton.dataset.qualityFilter;
      setFilter("quality", state.filters.quality === filter ? "" : filter);
    });
    $("dashboard-content").addEventListener("click", (event) => {
      const filterButton = event.target.closest("[data-chart-filter]");
      if (filterButton) {
        const kind = filterButton.dataset.chartFilter;
        const key = kind === "bin" ? "bin" : kind === "store" ? "store" : kind === "prefix" ? "binPrefix" : kind === "binGroup" ? "binGroup" : "provider";
        const element = key === "bin" ? "bin-filter" : key === "store" ? "store-filter" : key === "provider" ? "provider-filter" : null;
        const value = state.filters[key] === filterButton.dataset.value ? "" : filterButton.dataset.value;
        if (element) $(element).value = value;
        setFilter(key, value);
        return;
      }
    });
    $("page-size").value = String(state.pageSize);
    $("page-size").addEventListener("change", (event) => {
      state.pageSize = Number(event.target.value);
      state.page = 1;
      renderTable();
    });
    $("shipment-rows").addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-select-row]");
      if (!checkbox) return;
      const rowId = Number(checkbox.dataset.selectRow);
      if (checkbox.checked) state.selected.add(rowId);
      else state.selected.delete(rowId);
      $("selected-summary").textContent = `${formatter.format(state.selected.size)} row${state.selected.size === 1 ? "" : "s"} selected`;
      $("copy-selected").disabled = state.selected.size === 0;
    });
    document.querySelector(".data-table thead").addEventListener("click", (event) => {
      const button = event.target.closest("[data-sort]");
      if (!button) return;
      const field = button.dataset.sort;
      state.sort = { field, direction: state.sort.field === field ? -state.sort.direction : 1 };
      state.page = 1;
      render();
    });
    $("previous-page").addEventListener("click", () => changePage(-1));
    $("next-page").addEventListener("click", () => changePage(1));
    $("refresh-button").addEventListener("click", refreshData);
    $("retry-button").addEventListener("click", refreshData);
    $("state-retry").addEventListener("click", refreshData);
    $("download-all").addEventListener("click", () => downloadCsv(`packing-print-list-${dateSuffix()}.csv`, state.rows));
    $("download-filtered").addEventListener("click", () => downloadCsv(`packing-print-list-filtered-${dateSuffix()}.csv`, state.filteredRows));
    $("download-view").addEventListener("click", () => {
      const start = (state.page - 1) * state.pageSize;
      downloadCsv(`packing-print-list-page-${state.page}-${dateSuffix()}.csv`, state.filteredRows.slice(start, start + state.pageSize));
    });
    $("copy-selected").addEventListener("click", copySelectedRows);
    $("theme-toggle").addEventListener("click", () => {
      setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
    });
  }

  function setTheme(theme) {
    const selectedTheme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = selectedTheme;
    const light = selectedTheme === "light";
    $("theme-toggle").setAttribute("aria-pressed", String(light));
    $("theme-toggle").title = `Switch to ${light ? "dark" : "light"} theme`;
    $("theme-toggle").setAttribute("aria-label", `Switch to ${light ? "dark" : "light"} theme`);
    $("theme-icon").textContent = light ? "☾" : "☀";
    $("theme-label").textContent = `${light ? "Dark" : "Light"} theme`;
    document.querySelector('meta[name="theme-color"]').content = light ? "#f2f5f8" : "#101c2d";
    try {
      localStorage.setItem("dispatch-pendency-theme", selectedTheme);
    } catch (error) {
      console.warn("Theme preference could not be saved; the selected theme remains active for this page.", error);
    }
  }

  function initializeTheme() {
    let preferredTheme = "dark";
    try {
      const savedTheme = localStorage.getItem("dispatch-pendency-theme");
      if (savedTheme === "light" || savedTheme === "dark") preferredTheme = savedTheme;
    } catch (error) {
      console.warn("Saved theme preference could not be read; using the default dark theme.", error);
    }
    setTheme(preferredTheme);
  }

  initializeTheme();
  bindEvents();
  refreshData();
  state.timer = setInterval(refreshData, CONFIG.REFRESH_INTERVAL_MS);
})();
