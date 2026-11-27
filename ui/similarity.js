(() => {
  // The VS Code webview API, or a host object { postMessage(message) } provided by
  // the embedding page as window.msentityViewerHost (see ui/README.md).
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : window.msentityViewerHost;
  const app = document.getElementById("app");
  const saved = vscode.getState() || {};
  const toolbarIcon = (name) => `<svg class="toolbar-icon icon-${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${({
    reload: '<path d="M20 4v6h-6M20 10a8 8 0 1 0 .2 5"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    metadata: '<path d="M14 3H5v18h14V8l-5-5v5h5M8 12h8M8 16h8"/>',
    columns: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M11 3v18M3 10h18M6 6h2m6 0h4M6 14h2m6 0h4"/>',
    filter: '<path d="M3 4h18l-7 9v6l-4 2v-8L3 4Z"/>',
    export: '<path d="M12 16V3m-5 5 5-5 5 5M5 12H3v9h18v-9h-2"/>',
    similarity: '<path d="M5 20V13m7 7V4m7 16V9" stroke-width="3"/>',
    settings: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M4.9 4.9l2.8 2.8m8.6 8.6 2.8 2.8M19.1 4.9l-2.8 2.8m-8.6 8.6-2.8 2.8"/>',
    spectrum: '<path d="M2 20h20M5 20v-7m4 7V8m4 12V4m4 16v-8m4 8v-4"/>',
  })[name]}</svg>`;

  // Image settings shared by the chart on screen (plot colors, grid) and the saved image.
  // cov*: axis ranges of the coverage plot (coverage, similarity).
  const IMAGE_DEFAULTS = Object.freeze({ format: "png", width: 1200, height: 720, grid: true,
    color: "#3794ff", boxColor: "#d18616", textColor: "#000000", xMin: "", xMax: "", yMin: "", yMax: "",
    covXMin: "", covXMax: "", covYMin: "", covYMax: "" });
  // "methods": the frequency of every score column as lines, to compare methods.
  const CHART_TYPES = [["histogram", "Histogram"], ["line", "Line"], ["box", "Box plot"], ["methods", "All methods"]];
  // Line colors of the score columns in the "All methods" plot.
  const METHOD_COLORS = { cosine: "#3794ff", reverse_cosine: "#d18616", modified_cosine: "#2e9e4f", bonanza: "#b04fc4",
    entropy: "#008b8b", unweighted_entropy: "#c44762", similarity: "#3794ff" };
  // Views of the distribution section: the score distribution, or intensity
  // coverage against similarity (needs the peak_intensity_coverage1/2 columns).
  const VIEWS = [["distribution", "Similarity distribution"], ["coverage", "Coverage vs similarity"]];
  const COVERAGE_PLOTS = [["density", "Density"], ["scatter", "Scatter"]];
  // Coverage plot: density (2D histogram, xBins columns; yBins "" = square
  // cells) or scatter (at most MAX_POINTS points), optional marginal densities.
  // bound: draw the √coverage line where it holds.
  const COVERAGE_DEFAULTS = Object.freeze({ plot: "density", side: 1, xBins: 20, yBins: "", scale: "log", marginals: true, bound: true });
  const MAX_POINTS = 20000;
  let value = null;
  // Similarity range filter: a lower and an upper bound, each optional.
  const RANGE_DEFAULTS = Object.freeze({ min: "", minOperator: ">=", max: "", maxOperator: "<=" });
  let range = { ...RANGE_DEFAULTS, ...saved.range };
  let draftRange = { ...range };
  let referenceIndex = typeof saved.referenceIndex === "string" ? saved.referenceIndex : "";
  const normalizeSort = (savedSort) => Array.isArray(savedSort) ? savedSort : savedSort ? [savedSort] : [];
  let sort = normalizeSort(saved.sort);
  let scoreColumnOrder = [];
  let columnOrder = Array.isArray(saved.columnOrder) ? saved.columnOrder : [];
  let hiddenColumns = Array.isArray(saved.hiddenColumns) ? saved.hiddenColumns : ["data_index1", "data_index2"];
  let columnsOpen = false;
  let moreOpen = false;
  let actionDialog = "";
  let metadataDraft = null;
  let metadataPending = false;
  let metadataError = "";
  let tableExport = null;
  let pageSize = Number.isInteger(saved.pageSize) ? saved.pageSize : undefined;
  let columnFilters = Array.isArray(saved.columnFilters) ? saved.columnFilters : [];
  let draftColumnFilters = [];
  const filterOperators = [["text_eq", "Text equals"], ["contains", "Contains"], ["!=", "Text differs"],
    ["numeric_eq", "="], [">=", "≥"], ["<=", "≤"], [">", ">"], ["<", "<"]];
  let bins = saved.bins || 20;
  let chartType = CHART_TYPES.some(([type]) => type === saved.chartType) ? saved.chartType : "histogram";
  let countScale = saved.countScale === "log" ? "log" : "linear";
  let image = { ...IMAGE_DEFAULTS, ...saved.image };
  let view = VIEWS.some(([type]) => type === saved.view) ? saved.view : "distribution";
  let coverage = { ...COVERAGE_DEFAULTS, ...saved.coverage };
  // Backend answers of the coverage request, by request key (see coverageRequest).
  const coverageCache = new Map();
  let coverageKey = "";       // the on-screen plot's request
  let coverageImageKey = "";  // the image dialog's request
  let coverageTimer = null;
  let coverageGeneration = 0;  // increases when cached answers become stale
  let exportOpen = false;
  let imageSaving = false;
  let showFilters = false;
  let busy = true;
  let error = "";
  let notice = "";
  let chartGeometry = null;
  let svgSequence = 0;
  let observer;
  const esc = (text) => String(text ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const number = (n) => n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 5 });
  const option = (optionValue, label, selected) =>
    `<option value="${esc(optionValue)}" ${selected ? "selected" : ""}>${esc(label)}</option>`;

  // Score columns of a result (one per calculated method) and their labels.
  const SCORE_LABELS = { cosine: "Cosine", reverse_cosine: "Reverse cosine",
    modified_cosine: "Modified cosine", bonanza: "BONANZA",
    entropy: "Weighted entropy", unweighted_entropy: "Unweighted entropy" };
  const scoreLabel = (name) => SCORE_LABELS[name] || name;
  function orderColumns(preferred, available) {
    return [...new Set([...preferred.filter((name) => available.includes(name)), ...available])];
  }
  const scoreColumns = () => orderColumns(scoreColumnOrder, value?.score_columns || []);
  const sideColumns = () => value?.metadata_columns || [];
  const filterColumnNames = () => [...comparisonColumns(), ...sideColumns().map(({ key }) => key)];
  function filterColumnOptions(selected) {
    return [
      ["Result", comparisonColumns().map((name) => [name, scoreLabel(name)])],
      ["Query", sideColumns().filter(({ side }) => side === 1).map(({ key, column }) => [key, column])],
      ["Reference", sideColumns().filter(({ side }) => side === 2).map(({ key, column }) => [key, column])],
    ].filter(([, columns]) => columns.length).map(([group, columns]) =>
      `<optgroup label="${group}">${columns.map(([name, label]) => option(name, label, name === selected)).join("")}</optgroup>`).join("");
  }
  const isIndex = (name) => /^(data_)?index[12]$/.test(name);
  function comparisonColumns() {
    const columns = value?.columns || [];
    const scores = scoreColumns();
    const defaults = [
      ...columns.filter((name) => !isIndex(name) && !scores.includes(name)),
      ...columns.filter(isIndex),
    ];
    const firstScore = columns.findIndex((name) => scores.includes(name));
    if (firstScore >= 0) {
      const precedingColumns = columns.slice(0, firstScore).filter((name) => !isIndex(name));
      defaults.splice(precedingColumns.length, 0, ...scores);
    }
    return orderColumns(columnOrder, defaults);
  }
  // The score column shown (statistics, distribution, filter, coverage plot):
  // the chosen one when the result has it, else the result's first.
  let score = typeof saved.score === "string" ? saved.score : "";
  const activeScore = () => value?.score_columns?.includes(score) ? score
    : scoreColumns()[0] || score || "cosine";
  // One filter set for the table, plots, and export.
  const resultFilters = (includeScore = true) => [
    referenceIndex !== "" ? { column: "index2", operator: "numeric_eq", value: referenceIndex } : null,
    includeScore && range.min !== "" ? { column: activeScore(), operator: range.minOperator, value: String(range.min) } : null,
    ...(includeScore ? columnFilters : []),
    includeScore && range.max !== "" ? { column: activeScore(), operator: range.maxOperator, value: String(range.max) } : null,
  ].filter(Boolean);
  const rangeLabelText = (r) => [
    r.min !== "" ? `${r.minOperator === ">" ? ">" : "≥"} ${r.min}` : "",
    r.max !== "" ? `${r.maxOperator === "<" ? "<" : "≤"} ${r.max}` : "",
  ].filter(Boolean).join(", ");

  function saveState() {
    vscode.setState({ range, referenceIndex, sort, bins, chartType, countScale, image, view, coverage, score, columnOrder, hiddenColumns, pageSize, columnFilters });
  }

  let coverageFilters = null;   // the filters of the cached coverage answers
  let sentFilters = "";         // the filters of the last page request
  let sentSort = null;
  function request(type = "page-request", page = 0, options = {}) {
    busy = true; error = ""; notice = "";
    if (type === "reload") coverageFilters = null;
    saveState();
    render();
    const knownScores = Boolean(value) && type !== "reload";
    const filters = resultFilters(knownScores);
    sentFilters = JSON.stringify(filters);
    sentSort = knownScores ? sort : null;
    vscode.postMessage({ type, page, filters, sort: sentSort, bins, page_size: pageSize, score: knownScores ? activeScore() : undefined, ...options });
  }

  function render() {
    observer?.disconnect();
    const disabled = busy ? "disabled" : "";
    const mode = value?.metadata?.mode;
    const parameters = value?.metadata?.parameters || {};
    // Calculated methods: parameters.methods, or the one method of older results.
    const methods = (Array.isArray(parameters.methods) ? parameters.methods : [parameters.method || "cosine"]).map(scoreLabel);
    const method = `${methods.join(", ")} similarity`;
    // Peak matching: "0.01 Da", "10 ppm", "0.01 Da or 10 ppm".
    const tolerance = [
      parameters.mz_tolerance_da > 0 ? `${number(parameters.mz_tolerance_da)} Da` : "",
      parameters.mz_tolerance_ppm > 0 ? `${number(parameters.mz_tolerance_ppm)} ppm` : "",
    ].filter(Boolean).join(" or ");
    const matching = tolerance ? ` · m/z ${tolerance}` : "";
    // Metadata columns that paired the spectra of a by-key result: "SpecID = SourceSpecID".
    // A name used on both sides is qualified as in SQL (a: first dataset, b: second).
    const sharedKey = parameters.key1 && parameters.key1 === parameters.key2 ? parameters.key1 : null;
    const keyMatch = sharedKey ? `a.${sharedKey} = b.${sharedKey}`
      : parameters.key1 && parameters.key2 ? `${parameters.key1} = ${parameters.key2}` : "";
    const sourceName = (side) => String(value?.metadata?.sources?.[side]?.path || "").split(/[\\/]/).pop()
      || (side ? "second dataset" : "first dataset");
    const subtitle = mode === "library_search"
      ? `${method} library search · ${parameters.match_precursor_mz ? "equal precursor m/z pairs" : "all query/reference pairs"} · threshold ${number(parameters.threshold)}${matching}`
      : `${method} for unique metadata keys shared by both datasets${keyMatch ? ` · ${keyMatch}` : ""}${matching}`;
    const columnLabel = (column) => sharedKey && column === sharedKey ? keyMatch : column;
    const availableColumns = comparisonColumns();
    const columns = availableColumns.filter((name) => !hiddenColumns.includes(name));
    const heading = (column) => {
      const priority = sort.findIndex((entry) => entry.column === column);
      const entry = sort[priority];
      const direction = entry ? (entry.direction === "asc" ? "ascending" : "descending") : "none";
      const badge = entry ? `${entry.mode === "numeric" ? "123 · " : ""}${priority + 1}${entry.direction === "asc" ? "▲" : "▼"}` : "";
      return `<th aria-sort="${direction}"><button data-sort="${esc(column)}" title="Click: text ascending → descending → remove sort. Right-click for sort options." ${disabled}>${esc(columnLabel(column))}<span class="sort-badge">${badge}</span></button></th>`;
    };
    const filterText = rangeLabelText(range);
    const referenceScope = referenceIndex === "" ? "" : ` · Reference index ${esc(referenceIndex)}`;
    const chartTypes = CHART_TYPES.filter(([type]) => type !== "methods" || (value?.score_columns?.length || 0) > 1);
    if (value && !chartTypes.some(([type]) => type === chartType)) chartType = "line";
    const countChart = chartType !== "box";
    const methodsChart = chartType === "methods";
    const hasCoverage = hasCoverageColumns();
    const showCoverage = view === "coverage" && hasCoverage;
    app.innerHTML = `
      <header class="result-toolbar"><div class="result-heading"><h1>${toolbarIcon("similarity")}<span>${esc(app.dataset.filename)}</span>${value?.metadata_modified ? '<small title="Metadata changes have not been saved">Modified</small>' : ""}</h1>
        <p>${esc(subtitle)}</p>${sharedKey ? `<p class="key-sides">a: ${esc(sourceName(0))} · b: ${esc(sourceName(1))}</p>` : ""}</div>
        <nav class="result-toolbar-actions" aria-label="Result actions">${value ? `<label class="score-control">Score <select id="score-column" ${disabled}>${scoreColumns().map((name) => option(name, scoreLabel(name), name === activeScore())).join("")}</select></label>` : ""}
        <button class="toolbar-action" id="reload" ${disabled}>${toolbarIcon("reload")}<span>Reload</span></button>
        <button class="toolbar-action" id="filter" aria-expanded="${showFilters}" ${disabled}>${toolbarIcon("filter")}<span>Filter${filterText ? ` (${esc(scoreLabel(activeScore()))} ${esc(filterText)})` : ""}${columnFilters.length ? ` · ${columnFilters.length}` : ""}</span></button>
        <button class="toolbar-action" id="export" ${disabled || !value ? "disabled" : ""}>${toolbarIcon("export")}<span>Export…</span></button>
        <div class="result-more"><button class="toolbar-action" id="result-more-button" aria-haspopup="menu" aria-expanded="${moreOpen}" aria-controls="result-more-actions" ${disabled || !value ? "disabled" : ""}>${toolbarIcon("more")}<span>More …</span></button>
          <div id="result-more-actions" role="menu" aria-label="Result actions" ${moreOpen ? "" : "hidden"}>
            <button id="result-metadata" role="menuitem">${toolbarIcon("metadata")}<span>Metadata</span></button>
            <button id="result-columns-button" role="menuitem" aria-expanded="${columnsOpen}" aria-controls="result-columns">${toolbarIcon("columns")}<span>Columns</span></button>
            <button id="result-load-options" role="menuitem">${toolbarIcon("reload")}<span>Loading options and reload</span></button>
            <button id="result-settings" role="menuitem">${toolbarIcon("settings")}<span>Settings</span></button>
          </div>
        </div></nav></header>
      <div role="status" class="message">${busy ? "Processing…" : esc(notice)}</div>
      ${error ? `<div role="alert" class="error">${esc(error)}</div>` : ""}
      ${showFilters && value ? `<section class="filter-panel"><h2>Filter by ${esc(scoreLabel(activeScore()))}</h2>
        <p>Leave a bound blank to leave that side open. All conditions must match. Filters apply to the table, distribution, statistics, and export.</p>
        <div class="filter-range">
          <input id="range-min" type="number" min="0" max="1" step="0.01" placeholder="0" value="${esc(draftRange.min)}" aria-label="Lower bound">
          <select id="range-min-operator" aria-label="Lower bound comparison">${option(">=", "≤", draftRange.minOperator === ">=")}${option(">", "<", draftRange.minOperator === ">")}</select>
          <span>${esc(scoreLabel(activeScore()))}</span>
          <select id="range-max-operator" aria-label="Upper bound comparison">${option("<=", "≤", draftRange.maxOperator === "<=")}${option("<", "<", draftRange.maxOperator === "<")}</select>
          <input id="range-max" type="number" min="0" max="1" step="0.01" placeholder="1" value="${esc(draftRange.max)}" aria-label="Upper bound">
        </div>
        <div class="result-filter-fields">${draftColumnFilters.map((condition, index) => `<div class="result-filter-row" data-filter-index="${index}">
          <select data-filter-field="column" aria-label="Filter column">${filterColumnOptions(condition.column)}</select>
          <select data-filter-field="operator" aria-label="Filter comparison">${filterOperators.map(([name, label]) => option(name, label, name === condition.operator)).join("")}</select>
          <input data-filter-field="value" aria-label="Filter value" value="${esc(condition.value)}">
          <button data-remove-filter="${index}" aria-label="Remove filter">×</button>
        </div>`).join("")}</div>
        <div class="actions"><button id="add-result-filter">Add column filter</button><button id="apply" class="primary">Apply</button><button id="clear">Clear</button></div>
      </section>` : ""}
      ${value ? `
        <section class="stats" aria-label="Filtered result statistics">
          <div><span>Matched rows</span><strong>${number(value.total_rows)} <small>/ ${number(value.unfiltered_rows)}${value.scored_rows != null && value.scored_rows < value.total_rows ? ` · ${number(value.scored_rows)} with ${esc(scoreLabel(activeScore()))}` : ""}</small></strong></div>
          <div><span>Stored data</span><strong>${value.has_matched_data ? `${number(value.matched_data_rows[0])} + ${number(value.matched_data_rows[1])}` : "Lightweight"}</strong></div>
          ${Object.entries(value.statistics).map(([key, n]) => `<div><span>${esc(key)}</span><strong>${number(n)}</strong></div>`).join("")}
        </section>
        <section class="distribution"><div class="section-title"><div><h2>${showCoverage ? `Peak intensity coverage and ${esc(scoreLabel(activeScore()).toLowerCase())}` : methodsChart ? "Score distribution of every method" : `${esc(scoreLabel(activeScore()))} distribution`}${referenceScope}</h2>
          <p>${showCoverage ? `${coverage.plot === "density" ? "Number of filtered rows per cell" : "One point per filtered row"}${boundApplies() ? (coverage.bound ? `; the dotted line is the largest possible ${esc(scoreLabel(activeScore()).toLowerCase())}, √coverage${activeScore() === "modified_cosine" ? " of its own pairing (direct and precursor-shifted peaks)" : ""}` : "")
              : `; no √coverage bound for ${esc(scoreLabel(activeScore()))}${activeScore() === "reverse_cosine" ? " against the query's coverage (it bounds the reference's)" : activeScore() === "modified_cosine" ? " in this result (recalculate it to get the coverage of the modified-cosine pairing)" : ""}`}.`
            : chartType === "box" ? "Box plot across all filtered rows, showing minimum, Q1, median, Q3, and maximum."
            : methodsChart ? `Frequency of each method's scores across all ${number(value.total_rows)} filtered rows, one point per bin; rows without a score for a method are left out of its line. The filter applies to ${esc(scoreLabel(activeScore()))}.`
            : `Frequency across all ${number(value.total_rows)} filtered rows${chartType === "line" ? ", one point per bin" : ""}.`}</p></div>
          <div class="chart-controls">${value.columns.includes("index2") ? `<label>Reference index <input id="reference-index" type="number" min="0" step="1" placeholder="All" value="${esc(referenceIndex)}" title="Zero-based position in the reference dataset. Leave blank for all saved matches." ${disabled}></label>` : ""}
          <label>View <select id="chart-view" ${disabled}>${VIEWS.map(([type, label]) => `<option value="${type}" ${view === type ? "selected" : ""} ${type === "coverage" && !hasCoverage ? "disabled" : ""}>${esc(label)}</option>`).join("")}</select></label>
          ${showCoverage ? coverageControls(disabled) : `<label>Plot <select id="chart-type" ${disabled}>${chartTypes.map(([type, label]) => option(type, label, chartType === type)).join("")}</select></label>
          <label>Count <select id="count-scale" ${disabled || !countChart ? "disabled" : ""}>${option("linear", "Linear", countScale === "linear")}${option("log", "Log₁₀", countScale === "log")}</select></label>
          <label>Bins <input id="bins" type="number" min="1" max="200" step="1" value="${bins}" ${disabled || !countChart ? "disabled" : ""} /></label>`}
          <button class="toolbar-action" id="save-image" ${disabled || (showCoverage && !coverageCache.get(coverageKey)) ? "disabled" : ""}>${toolbarIcon("export")}<span>Save image…</span></button></div></div>
          ${view === "coverage" && !hasCoverage ? `<p class="hint">This result has no peak intensity coverage columns (peak_intensity_coverage1, peak_intensity_coverage2). Recalculate it to plot coverage.</p>` : ""}
          <div id="chart" class="${showCoverage ? "coverage-chart" : ""}" role="img" aria-label="${showCoverage ? "Peak intensity coverage against similarity" : chartType === "box" ? "Similarity score box plot" : "Similarity score distribution"}"></div>
          <div id="chart-hint" class="hint" aria-live="polite">${showCoverage ? coverageHint() : chartHint()}</div>
          ${showCoverage ? "" : methodsChart ? methodTables() : `<details><summary>Frequency table</summary><div class="frequency-table"><table><thead><tr><th>Similarity range</th><th>Count</th></tr></thead>
          <tbody>${value.histogram.counts.map((count, i) => `<tr><td>${rangeLabel(i)}</td><td>${number(count)}</td></tr>`).join("")}</tbody></table></div></details>`}
        </section>
        <section><div class="section-title"><h2>Comparison results</h2></div>
        ${columnsOpen ? `<div id="result-columns" class="result-columns" aria-label="Result columns">
          <div class="actions"><button data-column-action="show">Show all</button><button data-column-action="hide">Hide all</button><button data-column-action="reset">Reset columns</button><button id="close-result-columns">Close</button></div>
          <ul>${availableColumns.map((name, index) => `<li><label><input type="checkbox" data-result-column="${esc(name)}" ${hiddenColumns.includes(name) ? "" : "checked"}> ${esc(columnLabel(name))}</label>
            <button data-move-column="${esc(name)}" data-offset="-1" aria-label="Move ${esc(columnLabel(name))} left" ${index === 0 ? "disabled" : ""}>↑</button>
            <button data-move-column="${esc(name)}" data-offset="1" aria-label="Move ${esc(columnLabel(name))} right" ${index === availableColumns.length - 1 ? "disabled" : ""}>↓</button></li>`).join("")}</ul>
        </div>` : ""}
        ${columns.some((column) => /^index[12]$/.test(column)) ? '<p class="index-note">index1 and index2 are zero-based input positions.</p>' : ""}
        ${columns.length || value.has_matched_data ? "" : '<p>No columns selected.</p>'}
        <div class="table-scroll" ${columns.length || value.has_matched_data ? "" : "hidden"}><table><thead><tr>${value.has_matched_data ? "<th>Match</th>" : ""}${columns.map(heading).join("")}</tr></thead>
        <tbody>${value.rows.length ? value.rows.map((row, index) => `<tr>${value.has_matched_data ? `<td><button class="toolbar-action" data-open-match="${Number(value.result_indices[index])}" ${disabled}>${toolbarIcon("spectrum")}<span>Open spectra</span></button></td>` : ""}${columns.map((column) => `<td>${(value.score_columns.includes(column) || /^(modified_)?peak_intensity_coverage[12]$/.test(column)) ? number(row[column]) : esc(typeof row[column] === "object" && row[column] !== null ? JSON.stringify(row[column]) : row[column])}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${columns.length + (value.has_matched_data ? 1 : 0)}" class="empty">No matching rows</td></tr>`}</tbody></table></div>
        <footer><button id="previous" ${busy || value.page === 0 ? "disabled" : ""}>Previous</button><span>Page ${value.page + 1} / ${value.total_pages}</span><button id="next" ${busy || value.page + 1 >= value.total_pages ? "disabled" : ""}>Next</button></footer></section>

      ` : "<p>Opening similarity results…</p>"}
      ${exportOpen && value ? (showCoverage ? coverageImageDialog() : imageDialog()) : ""}
      ${actionDialog && value ? resultDialog() : ""}`;

    const moreButton = document.getElementById("result-more-button");
    const focusMore = () => document.getElementById("result-more-button")?.focus({ preventScroll: true });
    moreButton?.addEventListener("click", () => {
      moreOpen = !moreOpen;
      render();
      if (moreOpen) document.querySelector("#result-more-actions button")?.focus({ preventScroll: true });
      else focusMore();
    });
    moreButton?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      moreOpen = true; render();
      const items = [...document.querySelectorAll("#result-more-actions button")];
      items.at(event.key === "ArrowUp" ? -1 : 0)?.focus({ preventScroll: true });
    });
    const moreMenu = document.getElementById("result-more-actions");
    moreMenu?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault(); moreOpen = false; render(); focusMore(); return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...moreMenu.querySelectorAll("button")];
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(items.indexOf(document.activeElement) + step + items.length) % items.length]?.focus();
    });
    document.getElementById("result-columns-button")?.addEventListener("click", () => {
      columnsOpen = true; moreOpen = false; render();
      document.getElementById("result-columns")?.querySelector("button")?.focus();
    });
    document.getElementById("close-result-columns")?.addEventListener("click", () => {
      columnsOpen = false; render();
      document.getElementById("result-more-button")?.focus();
    });
    document.getElementById("result-metadata")?.addEventListener("click", () => {
      const annotations = value.metadata.annotations || {};
      metadataDraft = {
        description: typeof annotations.description === "string" ? annotations.description : "",
        tags: Array.isArray(annotations.tags) ? annotations.tags.join("\n") : "",
        attributes: Object.entries(annotations.attributes || {}).map(([name, text]) => ({ name, text })),
      };
      moreOpen = false; actionDialog = "metadata"; metadataError = ""; render();
    });
    document.getElementById("result-load-options")?.addEventListener("click", () => {
      moreOpen = false; actionDialog = "loading"; render();
    });
    document.getElementById("result-settings")?.addEventListener("click", () => {
      moreOpen = false; render(); vscode.postMessage({ type: "open-settings" });
    });
    document.querySelectorAll("[data-result-column]").forEach((input) => input.addEventListener("change", () => {
      const name = input.dataset.resultColumn;
      hiddenColumns = input.checked ? hiddenColumns.filter((column) => column !== name) : [...hiddenColumns, name];
      updateColumns(input, "resultColumn");
    }));
    document.querySelectorAll("[data-move-column]").forEach((button) => button.addEventListener("click", () => {
      const index = availableColumns.indexOf(button.dataset.moveColumn);
      const target = index + Number(button.dataset.offset);
      [availableColumns[index], availableColumns[target]] = [availableColumns[target], availableColumns[index]];
      columnOrder = availableColumns;
      updateColumns(button, "moveColumn");
    }));
    document.querySelectorAll("[data-column-action]").forEach((button) => button.addEventListener("click", () => {
      const action = button.dataset.columnAction;
      hiddenColumns = action === "hide" ? availableColumns : action === "reset" ? ["data_index1", "data_index2"] : [];
      if (action === "reset") columnOrder = [];
      updateColumns(button, "columnAction");
    }));
    document.getElementById("score-column")?.addEventListener("change", (e) => { score = e.target.value; request("page-request", value.page); });
    document.getElementById("filter")?.addEventListener("click", () => {
      showFilters = !showFilters; draftRange = { ...range };
      draftColumnFilters = columnFilters.map((condition) => ({ ...condition }));
      render();
    });
    document.getElementById("reload")?.addEventListener("click", () => request("reload"));
    document.getElementById("export")?.addEventListener("click", () => {
      tableExport = { format: "tsv", columns: [...columns], peakSides: [] };
      actionDialog = "export"; render();
    });
    document.getElementById("add-result-filter")?.addEventListener("click", () => {
      draftColumnFilters.push({ column: filterColumnNames()[0], operator: "text_eq", value: "" });
      render();
      [...document.querySelectorAll('[data-filter-field="column"]')].at(-1)?.focus();
    });
    document.querySelectorAll("[data-filter-field]").forEach((input) => input.addEventListener("input", () => {
      draftColumnFilters[Number(input.closest("[data-filter-index]").dataset.filterIndex)][input.dataset.filterField] = input.value;
    }));
    document.querySelectorAll("[data-remove-filter]").forEach((button) => button.addEventListener("click", () => {
      draftColumnFilters.splice(Number(button.dataset.removeFilter), 1); render();
      document.getElementById("add-result-filter")?.focus();
    }));
    for (const [id, field] of [["range-min", "min"], ["range-max", "max"], ["range-min-operator", "minOperator"], ["range-max-operator", "maxOperator"]]) {
      document.getElementById(id)?.addEventListener("change", (e) => { draftRange[field] = e.target.value.trim(); });
    }
    document.getElementById("apply")?.addEventListener("click", applyRange);
    document.getElementById("clear")?.addEventListener("click", () => { range = { ...RANGE_DEFAULTS }; draftRange = { ...range }; columnFilters = []; draftColumnFilters = []; request(); });
    document.getElementById("reference-index")?.addEventListener("change", (e) => {
      const input = e.target;
      if (!input.validity.valid || (input.value !== "" && !Number.isSafeInteger(Number(input.value)))) {
        error = "Reference index must be a nonnegative whole number."; render(); return;
      }
      referenceIndex = input.value === "" ? "" : String(Number(input.value));
      request();
    });
    document.getElementById("bins")?.addEventListener("change", (e) => {
      const count = Number(e.target.value);
      if (!Number.isInteger(count) || count < 1 || count > 200) {
        error = "Histogram bins must be an integer between 1 and 200."; render(); return;
      }
      bins = count; request("page-request", value.page);
    });
    document.getElementById("chart-type")?.addEventListener("change", (e) => { chartType = e.target.value; saveState(); render(); });
    document.getElementById("chart-view")?.addEventListener("change", (e) => {
      view = e.target.value; saveState(); render();
      if (view === "coverage") requestCoverage();
    });
    if (showCoverage) bindCoverageControls();
    document.getElementById("count-scale")?.addEventListener("change", (e) => { countScale = e.target.value; saveState(); render(); });
    document.getElementById("save-image")?.addEventListener("click", () => { exportOpen = true; render(); });
    document.querySelectorAll("[data-sort]").forEach((button) => {
      button.addEventListener("click", () => setColumnSort(button.dataset.sort, "text"));
      button.closest("th").addEventListener("contextmenu", (event) => openSortMenu(event, button));
      button.addEventListener("keydown", (event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openSortMenu(event, button);
      });
    });
    document.querySelectorAll("[data-open-match]").forEach((button) => button.addEventListener("click", () => {
      vscode.postMessage({ type: "open-similarity-match", resultIndex: Number(button.dataset.openMatch), score: activeScore() });
    }));
    document.getElementById("previous")?.addEventListener("click", () => request("page-request", value.page - 1));
    document.getElementById("next")?.addEventListener("click", () => request("page-request", value.page + 1));
    const chart = document.getElementById("chart");
    if (chart && showCoverage) {
      observer = new ResizeObserver(drawCoverageChart); observer.observe(chart);
      chart.addEventListener("mousemove", (event) => {
        document.getElementById("chart-hint").textContent = coverageCellAt(event) ?? coverageHint();
      });
      chart.addEventListener("mouseleave", () => { document.getElementById("chart-hint").textContent = coverageHint(); });
      drawCoverageChart();
    } else if (chart) {
      observer = new ResizeObserver(drawChart); observer.observe(chart);
      chart.addEventListener("mousemove", (event) => {
        const i = binAt(event);
        document.getElementById("chart-hint").textContent = i === null ? chartHint() : chartType === "methods"
          ? `${rangeLabel(i)}: ${scoreSeries().map(([name, counts]) => `${scoreLabel(name)} ${number(counts[i])}`).join(" · ")}`
          : `${rangeLabel(i)}: ${number(value.histogram.counts[i])} rows`;
      });
      chart.addEventListener("mouseleave", () => { document.getElementById("chart-hint").textContent = chartHint(); });
      drawChart();
    }
    if (exportOpen && value && showCoverage) bindCoverageImageDialog();
    else if (exportOpen && value) bindImageDialog();
    else if (actionDialog && value) bindResultDialog();
    else document.body.classList.remove("modal-open");
  }

  function setColumnSort(column, mode, direction) {
    const index = sort.findIndex((entry) => entry.column === column);
    if (!direction) {
      const current = sort[index];
      direction = current?.mode === mode ? (current.direction === "asc" ? "desc" : null) : "asc";
    }
    if (!direction) sort.splice(index, 1);
    else if (index === -1) sort.push({ column, mode, direction });
    else sort[index] = { column, mode, direction };
    request();
  }

  function openSortMenu(event, trigger) {
    if (busy) return;
    event.preventDefault();
    document.querySelector(".result-sort-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "result-sort-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Sort options");
    for (const [mode, label] of [["text", "text"], ["numeric", "number"]]) {
      for (const [direction, description] of [["asc", "ascending"], ["desc", "descending"]]) {
        const action = document.createElement("button");
        action.setAttribute("role", "menuitem");
        action.textContent = `Sort as ${label} (${description})`;
        action.addEventListener("click", () => setColumnSort(trigger.dataset.sort, mode, direction));
        menu.append(action);
      }
    }
    app.append(menu);
    const bounds = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX || bounds.left, window.innerWidth - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY || bounds.bottom, window.innerHeight - menu.offsetHeight))}px`;
    const actions = [...menu.children];
    menu.addEventListener("focusout", (e) => { if (!menu.contains(e.relatedTarget)) menu.remove(); });
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        trigger.focus({ preventScroll: true });
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        actions[(actions.indexOf(document.activeElement) + step + actions.length) % actions.length].focus();
      }
    });
    actions[0].focus({ preventScroll: true });
  }

  function resultDialog() {
    const title = { export: "Export results", metadata: "Metadata", loading: "Loading options and reload" }[actionDialog];
    let body;
    if (actionDialog === "metadata") {
      const { annotations, ...calculation } = value.metadata;
      const disabled = metadataPending ? "disabled" : "";
      body = `<fieldset class="result-annotations" ${disabled}>
        <legend>Result annotations</legend>
        <label>Description<textarea id="result-description" rows="4">${esc(metadataDraft.description)}</textarea></label>
        <label>Tags (one per line)<textarea id="result-tags" rows="2">${esc(metadataDraft.tags)}</textarea></label>
        <div>Attributes</div>
        ${metadataDraft.attributes.map(({ name, text }, index) => `<div class="result-attribute" data-attribute-index="${index}">
          <input data-attribute-field="name" aria-label="Attribute name" placeholder="Name" value="${esc(name)}">
          <input data-attribute-field="text" aria-label="Attribute value" placeholder="Value" value="${esc(text)}">
          <button type="button" data-remove-attribute="${index}" aria-label="Remove attribute">×</button>
        </div>`).join("")}
        <button id="add-result-attribute" type="button">Add attribute</button>
      </fieldset>
      <p>Apply updates the open result. Export as MSSIM to save annotations. Reload discards edits.</p>
      ${metadataError ? `<p role="alert" class="error">${esc(metadataError)}</p>` : ""}
      <details class="result-calculation"><summary>Calculation metadata (read-only)</summary>
        <pre class="result-metadata">${esc(JSON.stringify(calculation, null, 2))}</pre>
      </details>
      <div class="actions"><button id="apply-result-annotations" class="primary" type="submit" ${disabled}>Apply</button></div>`;
    } else if (actionDialog === "loading") {
      body = `<label>Rows per page <input id="result-page-size" type="number" min="1" max="500" step="1" required value="${value.page_size}"></label>
        <p>Reload reads the saved .mssim file.</p>
        <div class="actions"><button class="primary" type="submit">Reload</button></div>`;
    } else {
      const text = ["tsv", "csv"].includes(tableExport.format);
      const exportColumns = [...comparisonColumns(), ...sideColumns().map(({ key }) => key)];
      body = `<label>Format <select id="table-export-format">${["tsv", "csv", "mssim", "parquet"].map((format) => option(format, format.toUpperCase(), tableExport.format === format)).join("")}</select></label>
        <p>${number(value.total_rows)} rows in the current filtered and sorted view.</p>
        ${text ? `<div class="actions"><button id="export-visible-columns" type="button">Use visible columns</button><button id="export-all-columns" type="button">Select all</button><button id="export-clear-columns" type="button">Clear selection</button></div>
          <fieldset class="export-column-list"><legend>Columns</legend>${exportColumns.map((name) => `<label><input type="checkbox" data-export-column="${esc(name)}" ${tableExport.columns.includes(name) ? "checked" : ""}> ${esc(name)}</label>`).join("")}</fieldset>
          ${value.has_matched_data ? `<fieldset><legend>Spectrum peaks</legend>
            ${[[1, "Query"], [2, "Reference"]].map(([side, label]) => `<label><input type="checkbox" data-export-peaks="${side}" ${tableExport.peakSides.includes(side) ? "checked" : ""}> ${label}</label>`).join(" ")}
            <p>Peak cells use the MSDataset TSV/CSV format.</p></fieldset>` : "<p>This file has no embedded spectra or spectrum metadata.</p>"}` : ""}
        <div class="actions"><button id="confirm-table-export" class="primary" type="submit" ${text && !tableExport.columns.length && !tableExport.peakSides.length ? "disabled" : ""}>Save…</button></div>`;
    }
    return `<dialog id="result-dialog" class="chart-dialog" aria-labelledby="result-dialog-title"><form>
      <div class="dialog-title"><h2 id="result-dialog-title">${title}</h2><button id="close-result-dialog" type="button" aria-label="Close">×</button></div>${body}</form></dialog>`;
  }

  function bindResultDialog() {
    const dialog = document.getElementById("result-dialog");
    const close = () => { if (!metadataPending) { actionDialog = ""; render(); } };
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    document.getElementById("close-result-dialog").addEventListener("click", close);
    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (actionDialog === "loading") {
        pageSize = Number(document.getElementById("result-page-size").value);
        actionDialog = ""; request("reload"); return;
      }
      if (actionDialog === "metadata") {
        const pairs = metadataDraft.attributes.map(({ name, text }) => [name.trim(), text])
          .filter(([name, text]) => name || text);
        if (pairs.some(([name]) => !name) || new Set(pairs.map(([name]) => name)).size !== pairs.length) {
          metadataError = "Enter a unique name for each attribute."; render(); return;
        }
        metadataPending = true; metadataError = ""; render();
        vscode.postMessage({ type: "set-similarity-annotations", description: metadataDraft.description,
          tags: metadataDraft.tags.split("\n").map((tag) => tag.trim()).filter(Boolean),
          attributes: Object.fromEntries(pairs) });
        return;
      }
      if (actionDialog !== "export") return;
      const { format, columns, peakSides } = tableExport;
      const text = ["tsv", "csv"].includes(format);
      if (text && !columns.length && !peakSides.length) return;
      actionDialog = "";
      request("export-similarity", 0, { format, ...(text ? { columns, peak_sides: peakSides } : {}) });
    });
    if (actionDialog === "metadata") {
      for (const [id, field] of [["result-description", "description"], ["result-tags", "tags"]]) {
        dialog.querySelector(`#${id}`).addEventListener("input", (e) => { metadataDraft[field] = e.target.value; });
      }
      dialog.querySelectorAll("[data-attribute-field]").forEach((input) => input.addEventListener("input", () => {
        const index = Number(input.closest("[data-attribute-index]").dataset.attributeIndex);
        metadataDraft.attributes[index][input.dataset.attributeField] = input.value;
      }));
      dialog.querySelectorAll("[data-remove-attribute]").forEach((button) => button.addEventListener("click", () => {
        metadataDraft.attributes.splice(Number(button.dataset.removeAttribute), 1); render();
        document.getElementById("add-result-attribute")?.focus();
      }));
      dialog.querySelector("#add-result-attribute").addEventListener("click", () => {
        metadataDraft.attributes.push({ name: "", text: "" }); render();
        [...document.querySelectorAll('[data-attribute-field="name"]')].at(-1)?.focus();
      });
    }
    if (actionDialog === "export") {
      const format = document.getElementById("table-export-format");
      format.addEventListener("change", () => { tableExport.format = format.value; render(); });
      const fields = [...dialog.querySelectorAll("[data-export-column]")];
      const peaks = [...dialog.querySelectorAll("[data-export-peaks]")];
      const sync = () => {
        tableExport.columns = fields.filter(({ checked }) => checked).map(({ dataset }) => dataset.exportColumn);
        tableExport.peakSides = peaks.filter(({ checked }) => checked).map(({ dataset }) => Number(dataset.exportPeaks));
        document.getElementById("confirm-table-export").disabled = !tableExport.columns.length && !tableExport.peakSides.length;
      };
      [...fields, ...peaks].forEach((input) => input.addEventListener("change", sync));
      for (const [id, selected] of [
        ["export-visible-columns", comparisonColumns().filter((name) => !hiddenColumns.includes(name))],
        ["export-all-columns", fields.map(({ dataset }) => dataset.exportColumn)], ["export-clear-columns", []],
      ]) {
        document.getElementById(id)?.addEventListener("click", () => {
          fields.forEach((input) => { input.checked = selected.includes(input.dataset.exportColumn); });
          sync();
        });
      }
    }
    dialog.showModal();
    document.body.classList.add("modal-open");
  }

  function updateColumns(control, key) {
    saveState();
    render();
    const controls = [...document.querySelectorAll("#result-columns input, #result-columns button")];
    const matches = controls.filter((item) => item.dataset[key] === control.dataset[key] && !item.disabled);
    (matches.find((item) => item.dataset.offset === control.dataset.offset) || matches[0])?.focus();
  }

  function applyRange() {
    const bound = (text) => text === "" ? "" : Number(text);
    const min = bound(draftRange.min), max = bound(draftRange.max);
    if ([min, max].some((n) => n !== "" && !Number.isFinite(n))) { error = "Similarity bounds must be numbers."; render(); return; }
    if (min !== "" && max !== "" && min > max) { error = "The lower bound must not exceed the upper bound."; render(); return; }
    if (draftColumnFilters.some(({ operator, value }) =>
      !["text_eq", "contains", "!="].includes(operator) && (String(value).trim() === "" || !Number.isFinite(Number(value))))) {
      error = "Enter a numeric value for each numeric column filter."; render(); return;
    }
    range = { ...draftRange };
    columnFilters = draftColumnFilters.map((condition) => ({ ...condition }));
    showFilters = false;
    request();
  }

  // [score column, counts] of every method (one series for results without histograms).
  function scoreSeries() {
    const histograms = value?.histograms;
    return histograms && Object.keys(histograms).length
      ? orderColumns(scoreColumns(), Object.keys(histograms)).map((name) => [name, histograms[name]])
      : [[activeScore(), value.histogram.counts]];
  }
  // Statistics and frequency of every method, under the "All methods" plot.
  function methodTables() {
    const series = scoreSeries();
    const stats = value.statistics_by_score || {};
    return `<div class="method-statistics"><table><thead><tr><th>Method</th>${["count", "mean", "q1", "median", "q3", "min", "max"].map((key) => `<th>${esc(key)}</th>`).join("")}</tr></thead>
      <tbody>${series.map(([name]) => `<tr><td><svg class="swatch" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="${METHOD_COLORS[name] || "#888"}"/></svg>${esc(scoreLabel(name))}</td>${["count", "mean", "q1", "median", "q3", "min", "max"].map((key) => `<td>${number(stats[name]?.[key])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <details><summary>Frequency table</summary><div class="frequency-table"><table><thead><tr><th>Similarity range</th>${series.map(([name]) => `<th>${esc(scoreLabel(name))}</th>`).join("")}</tr></thead>
      <tbody>${value.histogram.counts.map((_, i) => `<tr><td>${rangeLabel(i)}</td>${series.map(([, counts]) => `<td>${number(counts[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
  }
  function chartHint() {
    if (chartType === "box") return "Whiskers show the observed minimum and maximum";
    return `Similarity range 0–1 · vertical axis: ${countScale === "log" ? "count, log₁₀(count + 1) scale" : "count"}`;
  }
  function rangeLabel(i) {
    const { edges, counts } = value.histogram;
    return `[${number(edges[i])}, ${number(edges[i + 1])}${i === counts.length - 1 ? "]" : ")"}`;
  }
  function binAt(event) {
    if (!chartGeometry || chartType === "box") return null;
    const { left, top, width, height, x0, x1 } = chartGeometry;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (x < left || x > left + width || y < top || y > top + height) return null;
    const score = x0 + (x - left) / width * (x1 - x0);
    const { edges, counts } = value.histogram;
    for (let i = 0; i < counts.length; i++) {
      if (score >= edges[i] && (score < edges[i + 1] || i === counts.length - 1)) return i;
    }
    return null;
  }

  // Tick values from `start` to `stop` with a step of 1, 2, or 5 × 10^n.
  function niceStep(span, count) {
    const raw = span / Math.max(1, count);
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= raw) || raw;
  }
  function ticks(start, stop, count) {
    if (!(stop > start)) return [start];
    const step = niceStep(stop - start, count);
    const values = [];
    for (let v = Math.ceil(start / step - 1e-9) * step; v <= stop + step * 1e-9; v += step) values.push(Number(v.toPrecision(12)));
    return values;
  }
  // [minimum, maximum] of an axis: the entered values, or `auto` for a blank one.
  function axisRange(min, max, auto) {
    const read = (text, fallback) => String(text ?? "").trim() === "" || !Number.isFinite(Number(text)) ? fallback : Number(text);
    const low = read(min, auto[0]), high = read(max, auto[1]);
    if (!(high > low)) throw new Error("Each axis maximum must be greater than its minimum.");
    return [low, high];
  }

  // The distribution as SVG markup. options: type ("histogram", "line", "box"),
  // scale ("linear", "log"), grid, color, boxColor, textColor, and the axis
  // ranges xMin, xMax (similarity) and yMin, yMax (count); blank means automatic.
  function chartSvg(width, height, options) {
    const id = `chart-clip-${++svgSequence}`;
    const left = 72, top = 18, right = 22, bottom = 48;
    const plotWidth = Math.max(1, width - left - right), plotHeight = Math.max(1, height - top - bottom);
    const [x0, x1] = axisRange(options.xMin, options.xMax, [0, 1]);
    const x = (v) => left + (v - x0) / (x1 - x0) * plotWidth;
    const text = options.textColor;
    const parts = [];
    const gridLine = (x1_, y1_, x2_, y2_) => options.grid
      ? parts.push(`<line x1="${x1_}" y1="${y1_}" x2="${x2_}" y2="${y2_}" stroke="${text}" stroke-opacity="0.15"/>`) : 0;
    for (const tick of ticks(x0, x1, 5)) {
      gridLine(x(tick), top, x(tick), top + plotHeight);
      parts.push(`<text x="${x(tick)}" y="${top + plotHeight + 20}" text-anchor="middle">${number(tick)}</text>`);
    }
    parts.push(`<text x="${left + plotWidth / 2}" y="${height - 6}" text-anchor="middle">Similarity score</text>`);
    const plot = [], legend = [];
    let yAxis = false;
    if (options.type === "box") {
      const stats = value.statistics;
      const y = top + plotHeight / 2, boxHeight = Math.min(100, plotHeight * 0.5);
      if (stats.min != null) {
        const [min, q1, median, q3, max] = [stats.min, stats.q1, stats.median, stats.q3, stats.max].map((v) => x(Number(v)));
        plot.push(`<g stroke="${text}" stroke-width="2" fill="none"><path d="M${min} ${y}H${q1}M${q3} ${y}H${max}M${min} ${y - 20}V${y + 20}M${max} ${y - 20}V${y + 20}"/>`,
          `<rect x="${q1}" y="${y - boxHeight / 2}" width="${Math.max(1, q3 - q1)}" height="${boxHeight}" fill="${options.boxColor}" fill-opacity="0.72"/>`,
          `<path d="M${median} ${y - boxHeight / 2}V${y + boxHeight / 2}"/></g>`);
      }
    } else {
      yAxis = true;
      const { counts, edges } = value.histogram;
      const series = options.type === "methods" ? scoreSeries() : [[activeScore(), counts]];
      const log = options.scale === "log";
      const transform = (count) => log ? Math.log10(count + 1) : count;
      const observed = Math.max(1, ...series.flatMap(([, c]) => c));
      // Automatic maximum: the next power of ten (log) or tick step (linear) at or above the largest count.
      const autoMax = log ? Math.pow(10, Math.ceil(Math.log10(observed)))
        : Math.ceil(observed / niceStep(observed, 4)) * niceStep(observed, 4);
      const [c0, c1] = axisRange(options.yMin, options.yMax, [0, autoMax]);
      if (log && c0 < 0) throw new Error("A log₁₀ count axis cannot start below 0.");
      const [t0, t1] = [transform(c0), transform(c1)];
      const y = (count) => top + plotHeight - (transform(count) - t0) / (t1 - t0) * plotHeight;
      const countTicks = log
        ? [0, ...Array.from({ length: 16 }, (_, k) => Math.pow(10, k))].filter((v) => v >= c0 && v <= c1)
        : ticks(c0, c1, 4);
      for (const tick of countTicks) {
        gridLine(left, y(tick), left + plotWidth, y(tick));
        parts.push(`<text x="${left - 8}" y="${y(tick) + 4}" text-anchor="end">${number(tick)}</text>`);
      }
      parts.push(`<text transform="translate(16 ${top + plotHeight / 2}) rotate(-90)" text-anchor="middle">${log ? "Count (log₁₀ scale)" : "Count"}</text>`);
      if (options.type === "methods") {
        series.forEach(([name, c], k) => {
          const color = METHOD_COLORS[name] || "#888";
          const points = c.map((count, i) => [x((edges[i] + edges[i + 1]) / 2), y(count)]);
          plot.push(`<polyline points="${points.map(([px, py]) => `${px},${py}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" data-method="${esc(name)}"/>`,
            ...points.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="2.5" fill="${color}"/>`));
          // Legend at the top, in the middle (scores rarely pile up there).
          const lx = left + plotWidth * 0.45;
          legend.push(`<g font-size="11"><line x1="${lx}" y1="${top + 14 + k * 16}" x2="${lx + 20}" y2="${top + 14 + k * 16}" stroke="${color}" stroke-width="2.5"/><text x="${lx + 26}" y="${top + 18 + k * 16}">${esc(scoreLabel(name))}</text></g>`);
        });
      } else if (options.type === "line") {
        const points = counts.map((count, i) => [x((edges[i] + edges[i + 1]) / 2), y(count)]);
        plot.push(`<polyline points="${points.map(([px, py]) => `${px},${py}`).join(" ")}" fill="none" stroke="${options.color}" stroke-width="2" stroke-linejoin="round"/>`,
          ...points.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="3" fill="${options.color}"/>`));
      } else {
        counts.forEach((count, i) => {
          if (count <= c0) return;
          const a = x(edges[i]), b = x(edges[i + 1]), h = top + plotHeight - y(count);
          plot.push(`<rect x="${a + 1}" y="${y(count)}" width="${Math.max(1, b - a - 2)}" height="${h}" fill="${options.color}"/>`);
        });
      }
    }
    parts.push(`<clipPath id="${id}"><rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/></clipPath>`,
      `<g clip-path="url(#${id})">${plot.join("")}</g>`,
      `<path d="M${left} ${yAxis ? `${top}V${top + plotHeight}` : top + plotHeight}H${left + plotWidth}" fill="none" stroke="${text}"/>`,
      ...legend);
    return {
      markup: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="12" fill="${text}">${parts.join("")}</svg>`,
      geometry: { left, top, width: plotWidth, height: plotHeight, x0, x1 },
    };
  }

  function drawChart() {
    const chart = document.getElementById("chart");
    if (!chart || !value) return;
    const foreground = getComputedStyle(document.body).getPropertyValue("--vscode-foreground").trim() || "#ddd";
    const { markup, geometry } = chartSvg(Math.max(200, chart.clientWidth), 260,
      { ...image, xMin: "", xMax: "", yMin: "", yMax: "", type: chartType, scale: countScale, textColor: foreground });
    chart.innerHTML = markup;
    chartGeometry = geometry;
  }

  function imageDialog() {
    const countAxis = chartType !== "box";
    return `<dialog id="image-dialog" class="chart-dialog"><form method="dialog"><div class="dialog-title"><h2>Save distribution image</h2><button id="cancel-image" type="button" aria-label="Close">×</button></div>
      <div class="export-options">
        <label>Plot <select id="image-type">${CHART_TYPES.map(([type, label]) => option(type, label, chartType === type)).join("")}</select></label>
        <label>Count scale <select id="image-scale" ${countAxis ? "" : "disabled"}>${option("linear", "Linear", countScale === "linear")}${option("log", "Log₁₀", countScale === "log")}</select></label>
        <label>Width <input id="image-width" type="number" min="200" max="16384" step="1" value="${esc(image.width)}"> px</label>
        <label>Height <input id="image-height" type="number" min="200" max="16384" step="1" value="${esc(image.height)}"> px</label>
        <label>Format <select id="image-format">${option("png", "PNG", image.format === "png")}${option("svg", "SVG", image.format === "svg")}</select></label>
      </div>
      <div class="export-options">
        <label><input id="image-grid" type="checkbox" ${image.grid ? "checked" : ""}> Grid</label>
        <label>Plot color <input id="image-color" type="color" value="${esc(image.color)}"></label>
        <label>Box color <input id="image-box-color" type="color" value="${esc(image.boxColor)}"></label>
        <label>Text and axes <input id="image-text-color" type="color" value="${esc(image.textColor)}"></label>
      </div>
      <div class="export-options axis-ranges">
        <label>Similarity <input id="image-x-min" type="number" step="any" placeholder="0" value="${esc(image.xMin)}" aria-label="Similarity axis minimum"> – <input id="image-x-max" type="number" step="any" placeholder="1" value="${esc(image.xMax)}" aria-label="Similarity axis maximum"></label>
        <label>Count <input id="image-y-min" type="number" min="0" step="any" placeholder="Auto" value="${esc(image.yMin)}" aria-label="Count axis minimum" ${countAxis ? "" : "disabled"}> – <input id="image-y-max" type="number" min="0" step="any" placeholder="Auto" value="${esc(image.yMax)}" aria-label="Count axis maximum" ${countAxis ? "" : "disabled"}></label>
        <button id="reset-image" type="button">Reset</button>
      </div>
      <p class="resize-help">Drag an edge to change width or height, or the corner to change both.</p>
      <div class="distribution-image-preview image-preview" aria-label="Image preview">
        <div id="image-preview-frame">
          <div id="image-preview"></div>
          <span class="image-resize-handle" data-image-resize="x" aria-hidden="true"></span>
          <span class="image-resize-handle" data-image-resize="y" aria-hidden="true"></span>
          <span class="image-resize-handle" data-image-resize="xy" aria-hidden="true"></span>
        </div>
      </div>
      <div id="image-status" class="hint" role="status"></div>
      <div class="actions"><button id="cancel-image-bottom" type="button">Cancel</button><button id="confirm-image" type="button" class="primary" ${imageSaving ? "disabled" : ""}>${imageSaving ? "Preparing image…" : "Save…"}</button></div></form></dialog>`;
  }

  // The dialog's choices: chart type and count scale, and the image settings.
  function readImageDialog() {
    const field = (id) => document.getElementById(id);
    const dimension = (id, fallback) => Math.min(16384, Math.max(200, Math.round(Number(field(id)?.value)) || fallback));
    return {
      type: field("image-type").value, scale: field("image-scale").value,
      image: { format: field("image-format").value, width: dimension("image-width", IMAGE_DEFAULTS.width),
        height: dimension("image-height", IMAGE_DEFAULTS.height), grid: field("image-grid").checked,
        color: field("image-color").value, boxColor: field("image-box-color").value, textColor: field("image-text-color").value,
        xMin: field("image-x-min").value.trim(), xMax: field("image-x-max").value.trim(),
        yMin: field("image-y-min").value.trim(), yMax: field("image-y-max").value.trim() },
    };
  }
  function imageMarkup(choice) {
    return chartSvg(choice.image.width, choice.image.height, { ...choice.image, type: choice.type, scale: choice.scale }).markup;
  }

  function bindImagePreviewResize(frame, update) {
    const widthInput = document.getElementById("image-width");
    const heightInput = document.getElementById("image-height");
    for (const handle of frame.querySelectorAll("[data-image-resize]")) {
      const axes = handle.dataset.imageResize;
      let drag = null;
      handle.addEventListener("pointerdown", (event) => {
        if (!event.isPrimary || event.button !== 0 || drag || imageSaving) return;
        const { width, height } = readImageDialog().image;
        const scale = frame.getBoundingClientRect().width / width;
        if (!(scale > 0)) return;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width, height, scale };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      handle.addEventListener("pointermove", (event) => {
        if (drag?.id !== event.pointerId) return;
        const resize = (input, size, delta) => {
          input.value = Math.min(Number(input.max), Math.max(Number(input.min), Math.round(size + delta / drag.scale)));
        };
        if (axes.includes("x")) resize(widthInput, drag.width, event.clientX - drag.x);
        if (axes.includes("y")) resize(heightInput, drag.height, event.clientY - drag.y);
        update(false);
      });
      handle.addEventListener("lostpointercapture", (event) => {
        if (drag?.id !== event.pointerId) return;
        drag = null;
        update();
      });
    }
  }

  function bindImageDialog() {
    const dialog = document.getElementById("image-dialog");
    const status = document.getElementById("image-status");
    const frame = document.getElementById("image-preview-frame");
    const preview = document.getElementById("image-preview");
    const update = (persist = true) => {
      const choice = readImageDialog();
      const countAxis = choice.type !== "box";
      for (const id of ["image-scale", "image-y-min", "image-y-max"]) document.getElementById(id).disabled = !countAxis;
      image = choice.image;
      if (persist) {
        saveState();
        drawChart();
      }
      try {
        preview.innerHTML = imageMarkup(choice);
        frame.style.setProperty("--image-width", image.width);
        frame.classList.add("has-preview");
        status.textContent = `${image.width} × ${image.height} px ${image.format.toUpperCase()}`;
        document.getElementById("confirm-image").disabled = imageSaving;
      } catch (cause) {
        preview.innerHTML = "";
        frame.classList.remove("has-preview");
        status.textContent = cause.message;
        document.getElementById("confirm-image").disabled = true;
      }
    };
    dialog.querySelectorAll("input, select").forEach((input) => {
      input.addEventListener("input", update);
      input.addEventListener("change", update);
    });
    document.getElementById("reset-image").addEventListener("click", () => {
      image = { ...IMAGE_DEFAULTS, format: image.format, width: image.width, height: image.height };
      saveState(); render();
    });
    const close = () => { exportOpen = false; render(); };
    // A modal over the page; Escape closes it like Cancel.
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    dialog.showModal();
    document.body.classList.add("modal-open");
    document.getElementById("cancel-image").addEventListener("click", close);
    document.getElementById("cancel-image-bottom").addEventListener("click", close);
    document.getElementById("confirm-image").addEventListener("click", saveImage);
    bindImagePreviewResize(frame, update);
    update();
  }

  // ---- peak intensity coverage plot ---------------------------------------------------------------

  function hasCoverageColumns() {
    return Boolean(value?.columns?.includes("peak_intensity_coverage1") && value.columns.includes("peak_intensity_coverage2"));
  }
  // "query" / "reference" (library search) or "first (a)" / "second (b)" (by key).
  function sideLabel(side) {
    if (value?.metadata?.mode === "library_search") return side === 1 ? "query" : "reference";
    return side === 1 ? "first dataset (a)" : "second dataset (b)";
  }
  function exponentText() {
    const exponent = value?.metadata?.parameters?.intensity_exponent;
    return exponent == null ? "" : ` (α = ${number(exponent)})`;
  }
  // similarity <= √coverage holds for cosine (either side) and for reverse
  // cosine against the reference's coverage (side 2) only.
  // Modified cosine is plotted against the coverage of its own pairing
  // (modified_peak_intensity_coverage1/2), when the result has it.
  const modifiedCoverage = () => Boolean(value?.columns?.includes("modified_peak_intensity_coverage1"));
  function boundApplies(side = coverage.side, name = activeScore()) {
    return name === "cosine" || (name === "reverse_cosine" && side === 2) || (name === "modified_cosine" && modifiedCoverage());
  }
  // The coverage on the x axis, in words: modified cosine and BONANZA use the
  // coverage of their pairing, which includes precursor-shifted peaks.
  const coverageName = (side, score = activeScore()) =>
    `peak intensity coverage${["modified_cosine", "bonanza"].includes(score) && modifiedCoverage() ? " with shifted peaks" : ""} of the ${sideLabel(side)}`;
  const positiveInteger = (text, maximum) => {
    const n = Number(text);
    return Number.isInteger(n) && n >= 1 && n <= maximum ? n : null;
  };

  function coverageControls(disabled) {
    const density = coverage.plot === "density";
    return `<label>Plot <select id="coverage-plot" ${disabled}>${COVERAGE_PLOTS.map(([type, label]) => option(type, label, coverage.plot === type)).join("")}</select></label>
      <label>Coverage of <select id="coverage-side" ${disabled}>${option("1", sideLabel(1), coverage.side === 1)}${option("2", sideLabel(2), coverage.side === 2)}</select></label>
      <label>Color <select id="coverage-scale" ${disabled || !density ? "disabled" : ""}>${option("linear", "Linear", coverage.scale === "linear")}${option("log", "Log₁₀", coverage.scale === "log")}</select></label>
      <label>X bins <input id="coverage-x-bins" type="number" min="1" max="200" step="1" value="${esc(coverage.xBins)}" ${disabled || !density ? "disabled" : ""}></label>
      <label>Y bins <input id="coverage-y-bins" type="number" min="1" max="200" step="1" placeholder="Auto" value="${esc(coverage.yBins)}" ${disabled || !density ? "disabled" : ""} title="Blank: square cells"></label>
      <label><input id="coverage-marginals" type="checkbox" ${coverage.marginals ? "checked" : ""} ${disabled}> Marginal densities</label>
      <label title="${boundApplies() ? "The largest possible score at each coverage" : `No √coverage bound for ${esc(scoreLabel(activeScore()))} here`}"><input id="coverage-bound" type="checkbox" ${coverage.bound ? "checked" : ""} ${disabled || !boundApplies() ? "disabled" : ""}> √coverage line</label>`;
  }

  function bindCoverageControls() {
    const change = (id, apply) => document.getElementById(id)?.addEventListener("change", (e) => {
      if (apply(e.target) === false) { render(); return; }
      saveState(); render(); requestCoverage();
    });
    change("coverage-plot", (input) => { coverage.plot = input.value; });
    change("coverage-side", (input) => { coverage.side = Number(input.value) === 2 ? 2 : 1; });
    change("coverage-scale", (input) => { coverage.scale = input.value === "log" ? "log" : "linear"; });
    change("coverage-marginals", (input) => { coverage.marginals = input.checked; });
    change("coverage-bound", (input) => { coverage.bound = input.checked; });
    change("coverage-x-bins", (input) => {
      const n = positiveInteger(input.value, 200);
      if (n === null) { error = "Coverage bins must be an integer between 1 and 200."; return false; }
      coverage.xBins = n; error = "";
    });
    change("coverage-y-bins", (input) => {
      const text = input.value.trim();
      if (text !== "" && positiveInteger(text, 200) === null) { error = "Coverage bins must be an integer between 1 and 200, or blank for square cells."; return false; }
      coverage.yBins = text === "" ? "" : Number(text); error = "";
    });
  }

  // Layout of a coverage chart of width × height px: the main plot area
  // (left, top, width, height) and the marginal and color bar areas.
  function coverageLayout(width, height, options) {
    const marginal = options.marginals ? 80 : 0, gap = options.marginals ? 8 : 0;
    const colorBar = options.plot === "density" ? 64 : 0;
    const left = 72, bottom = 48, right = 16 + colorBar + marginal + gap, top = 14 + marginal + gap;
    return { left, top, right, bottom, marginal, gap, colorBar,
      width: Math.max(1, width - left - right), height: Math.max(1, height - top - bottom) };
  }
  // The chart size on screen: a square main plot as wide as the section allows (at most 520 px).
  function screenCoverageSize(available) {
    const probe = coverageLayout(available, 100, coverage);
    const size = Math.max(160, Math.min(520, probe.width));
    return { width: probe.left + size + probe.right, height: probe.top + size + probe.bottom };
  }
  // Bins of a plot area: X bins as chosen; Y bins as chosen, or blank for square cells.
  function coverageBins(layout, options) {
    const xBins = options.xBins;
    const yBins = options.yBins === "" ? Math.max(1, Math.min(500, Math.round(xBins * layout.height / layout.width))) : options.yBins;
    return [xBins, yBins];
  }

  // The backend request for a plot (axis ranges [x0, x1], [y0, y1]), and its cache key.
  function coverageRequest(options, layout, xRange, yRange) {
    const [xBins, yBins] = coverageBins(layout, options);
    const fields = { score: activeScore(), side: options.side, x_bins: xBins, y_bins: yBins, x_range: xRange, y_range: yRange, max_points: MAX_POINTS };
    return { fields, key: JSON.stringify(fields) };
  }
  function sendCoverage({ fields, key }) {
    if (coverageCache.has(key)) return;
    coverageCache.set(key, null);   // pending
    vscode.postMessage({ type: "coverage-request", filters: resultFilters(), request_id: [coverageGeneration, key], ...fields });
  }
  function screenLayout() {
    const { width, height } = screenCoverageSize(Math.max(320, document.getElementById("chart")?.clientWidth || 800));
    return coverageLayout(width, height, coverage);
  }
  function requestCoverage() {
    if (!value || !hasCoverageColumns()) return;
    const request = coverageRequest(coverage, screenLayout(), [0, 1], [0, 1]);
    coverageKey = request.key;
    sendCoverage(request);
    refreshCoverage();
  }
  // The on-screen plot, hint, and Save image button for the current answer.
  function refreshCoverage() {
    const button = document.getElementById("save-image");
    if (button) button.disabled = busy || !coverageCache.get(coverageKey);
    const hint = document.getElementById("chart-hint");
    if (hint) hint.textContent = coverageHint();
    drawCoverageChart();
  }
  function receiveCoverage(data) {
    const [generation, key] = Array.isArray(data?.request_id) ? data.request_id : [];
    // An answer for earlier filters, or one no longer wanted.
    if (generation !== coverageGeneration || !coverageCache.has(key)) return;
    coverageCache.set(key, data);
    if (key === coverageKey) refreshCoverage();
    if (key === coverageImageKey && exportOpen) updateCoverageImage?.();
  }

  function coverageHint() {
    const data = coverageCache.get(coverageKey);
    if (!data) return "Calculating coverage…";
    const parts = [`${number(data.plotted_rows)} rows`];
    if (coverage.plot === "density") parts.push(`${data.x_bins} × ${data.y_bins} cells`, `color: ${coverage.scale === "log" ? "log₁₀(count + 1)" : "count"}`);
    else if (data.sampled) parts.push(`showing a random sample of ${number(data.points.x.length)} points; use Density to see every row`);
    parts.push(`x: ${coverageName(data.side, data.score)}`);
    if (data.above_bound_rows && boundApplies(data.side, data.score)) parts.push(`${number(data.above_bound_rows)} rows above √coverage`);
    return parts.join(" · ");
  }

  let coverageGeometry = null;
  function coverageCellAt(event) {
    const data = coverageCache.get(coverageKey);
    if (!coverageGeometry || !data) return null;
    const { left, top, width, height } = coverageGeometry;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    if (px < left || px > left + width || py < top || py > top + height) return null;
    const [x0, x1] = data.x_range, [y0, y1] = data.y_range;
    const x = x0 + (px - left) / width * (x1 - x0), y = y1 - (py - top) / height * (y1 - y0);
    const scoreText = scoreLabel(data.score || activeScore()).toLowerCase();
    if (coverage.plot !== "density") {
      return `coverage ${number(x)} · ${scoreText} ${number(y)}${boundApplies(data.side, data.score) ? ` · largest possible ${number(Math.sqrt(Math.max(0, x)))}` : ""}`;
    }
    const i = Math.min(data.x_bins - 1, Math.floor((x - x0) / (x1 - x0) * data.x_bins));
    const j = Math.min(data.y_bins - 1, Math.floor((y - y0) / (y1 - y0) * data.y_bins));
    const edge = (low, high, bins, k) => [low + (high - low) * k / bins, low + (high - low) * (k + 1) / bins];
    const [a, b] = edge(x0, x1, data.x_bins, i), [c, d] = edge(y0, y1, data.y_bins, j);
    const close = (k, bins) => k === bins - 1 ? "]" : ")";
    return `coverage [${number(a)}, ${number(b)}${close(i, data.x_bins)} · ${scoreText} [${number(c)}, ${number(d)}${close(j, data.y_bins)}: ${number(data.counts[j * data.x_bins + i])} rows`;
  }

  // The coverage plot as SVG markup. options: plot ("density", "scatter"),
  // scale ("linear", "log"), marginals, grid, color, textColor, and the axis
  // ranges xRange, yRange ([minimum, maximum]; default those of the data).
  // Density cells are those of the data, binned over its ranges.
  function coverageSvg(width, height, options, data) {
    const id = `coverage-clip-${++svgSequence}`;
    const L = coverageLayout(width, height, options);
    const { left, top, width: plotWidth, height: plotHeight } = L;
    const [x0, x1] = options.xRange || data.x_range, [y0, y1] = options.yRange || data.y_range;
    const x = (v) => left + (v - x0) / (x1 - x0) * plotWidth;
    const y = (v) => top + plotHeight - (v - y0) / (y1 - y0) * plotHeight;
    const text = options.textColor, color = options.color;
    const parts = [], plot = [];
    const gridLine = (a, b, c, d) => options.grid
      ? parts.push(`<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="${text}" stroke-opacity="0.15"/>`) : 0;
    for (const tick of ticks(x0, x1, 5)) {
      gridLine(x(tick), top, x(tick), top + plotHeight);
      parts.push(`<text x="${x(tick)}" y="${top + plotHeight + 20}" text-anchor="middle">${number(tick)}</text>`);
    }
    for (const tick of ticks(y0, y1, 5)) {
      gridLine(left, y(tick), left + plotWidth, y(tick));
      parts.push(`<text x="${left - 8}" y="${y(tick) + 4}" text-anchor="end">${number(tick)}</text>`);
    }
    parts.push(`<text x="${left + plotWidth / 2}" y="${height - 6}" text-anchor="middle">${esc(`${coverageName(data.side, data.score).replace(/^./, (c) => c.toUpperCase())}${exponentText()}`)}</text>`,
      `<text transform="translate(16 ${top + plotHeight / 2}) rotate(-90)" text-anchor="middle">${esc(`${scoreLabel(data.score || activeScore())} similarity${exponentText()}`)}</text>`);

    if (options.plot === "density") {
      const log = options.scale === "log";
      const level = (count) => log ? Math.log10(count + 1) : count;
      const top_ = level(Math.max(1, ...data.counts));
      const [cx0, cx1] = data.x_range, [cy0, cy1] = data.y_range;
      const cellWidth = (x(cx1) - x(cx0)) / data.x_bins, cellHeight = (y(cy0) - y(cy1)) / data.y_bins;
      data.counts.forEach((count, k) => {
        if (!count) return;
        const i = k % data.x_bins, j = Math.floor(k / data.x_bins);
        const opacity = 0.12 + 0.88 * level(count) / top_;
        plot.push(`<rect x="${(x(cx0) + i * cellWidth).toFixed(2)}" y="${(y(cy0) - (j + 1) * cellHeight).toFixed(2)}" width="${cellWidth.toFixed(2)}" height="${cellHeight.toFixed(2)}" fill-opacity="${opacity.toFixed(3)}"/>`);
      });
      plot.unshift(`<g fill="${color}" shape-rendering="crispEdges">`);
      plot.push("</g>");
      // Color bar: count (or log count) from the faintest to the full color.
      const barX = left + plotWidth + (options.marginals ? L.gap + L.marginal : 0) + 18, barWidth = 12;
      const gradient = `${id}-bar`;
      parts.push(`<linearGradient id="${gradient}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${color}" stop-opacity="0.12"/><stop offset="1" stop-color="${color}" stop-opacity="1"/></linearGradient>`,
        `<rect x="${barX}" y="${top}" width="${barWidth}" height="${plotHeight}" fill="url(#${gradient})" stroke="${text}" stroke-opacity="0.3"/>`,
        `<text x="${barX}" y="${top - 10}" font-size="11">${log ? "Rows (log)" : "Rows"}</text>`);
      const maximum = Math.max(1, ...data.counts);
      const barTicks = log ? [1, ...Array.from({ length: 16 }, (_, k) => Math.pow(10, k))].filter((v, k, all) => v <= maximum && all.indexOf(v) === k)
        : ticks(0, maximum, 4).filter((v) => Number.isInteger(v) && v >= 1 && v <= maximum * 0.9);
      for (const tick of new Set([...barTicks, maximum])) {
        const ty = top + plotHeight - level(tick) / top_ * plotHeight;
        parts.push(`<line x1="${barX + barWidth}" y1="${ty}" x2="${barX + barWidth + 4}" y2="${ty}" stroke="${text}"/>`,
          `<text x="${barX + barWidth + 6}" y="${ty + 4}" font-size="11">${number(tick)}</text>`);
      }
    } else {
      const { x: xs, y: ys } = data.points;
      const r = xs.length > 5000 ? 1.6 : 2.4;
      for (let k = 0; k < xs.length; k++) {
        plot.push(`<circle cx="${x(xs[k]).toFixed(1)}" cy="${y(ys[k]).toFixed(1)}" r="${r}"/>`);
      }
      plot.unshift(`<g fill="${color}" fill-opacity="${xs.length > 5000 ? 0.35 : 0.6}">`);
      plot.push("</g>");
    }
    // The bound similarity <= sqrt(coverage), for the scores it holds for.
    const showBound = options.bound !== false && boundApplies(data.side, data.score || activeScore());
    const bound = [];
    for (let k = 0; showBound && k <= 200; k++) {
      const v = Math.max(0, x0) + (Math.min(1, x1) - Math.max(0, x0)) * k / 200;
      if (v >= x0 && v <= x1) bound.push(`${x(v).toFixed(2)},${y(Math.sqrt(v)).toFixed(2)}`);
    }
    if (bound.length > 1) plot.push(`<polyline points="${bound.join(" ")}" fill="none" stroke="${text}" stroke-width="2" stroke-dasharray="2 3" stroke-linecap="round"/>`);
    parts.push(`<clipPath id="${id}"><rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"/></clipPath>`,
      `<g clip-path="url(#${id})">${plot.join("")}</g>`,
      `<path d="M${left} ${top}V${top + plotHeight}H${left + plotWidth}" fill="none" stroke="${text}"/>`,
      showBound ? `<g font-size="11"><line x1="${left + 10}" y1="${top + 12}" x2="${left + 34}" y2="${top + 12}" stroke="${text}" stroke-width="2" stroke-dasharray="2 3" stroke-linecap="round"/><text x="${left + 40}" y="${top + 16}">max = √coverage</text></g>` : "");

    // Marginal densities: coverage above the plot, similarity to its right.
    if (options.marginals && data.marginals) {
      const m = L.marginal;
      const marginalPath = (curve, toPoint) => curve.grid.map((g, k) => toPoint([g, curve.density[k]]));
      // Each curve is scaled to its own highest value within the axis range.
      const peak = (curve, low, high) => Math.max(1e-12, ...curve.grid.map((g, k) => g >= low && g <= high ? curve.density[k] : 0));
      const peakX = peak(data.marginals.x, x0, x1), peakY = peak(data.marginals.y, y0, y1);
      const mTop = top - L.gap - m, mRight = left + plotWidth + L.gap;
      const topPoints = marginalPath(data.marginals.x, ([g, d]) => [x(g), mTop + m - d / peakX * (m - 4)]).filter(([px]) => px >= left - 0.01 && px <= left + plotWidth + 0.01);
      const rightPoints = marginalPath(data.marginals.y, ([g, d]) => [mRight + d / peakY * (m - 4), y(g)]).filter(([, py]) => py >= top - 0.01 && py <= top + plotHeight + 0.01);
      const line = (points) => points.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(" ");
      if (topPoints.length > 1) {
        parts.push(`<polygon points="${line([[topPoints[0][0], mTop + m], ...topPoints, [topPoints.at(-1)[0], mTop + m]])}" fill="${color}" fill-opacity="0.18"/>`,
          `<polyline points="${line(topPoints)}" fill="none" stroke="${color}" stroke-width="1.6"/>`);
      }
      if (rightPoints.length > 1) {
        parts.push(`<polygon points="${line([[mRight, rightPoints[0][1]], ...rightPoints, [mRight, rightPoints.at(-1)[1]]])}" fill="${color}" fill-opacity="0.18"/>`,
          `<polyline points="${line(rightPoints)}" fill="none" stroke="${color}" stroke-width="1.6"/>`);
      }
      parts.push(`<path d="M${left} ${mTop + m}H${left + plotWidth}M${mRight} ${top}V${top + plotHeight}" stroke="${text}" stroke-opacity="0.5"/>`,
        `<text x="${left - 8}" y="${mTop + m / 2 + 4}" text-anchor="end" font-size="11">Density</text>`);
    }
    return {
      markup: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="12" fill="${text}">${parts.join("")}</svg>`,
      geometry: { left, top, width: plotWidth, height: plotHeight },
    };
  }

  function drawCoverageChart() {
    const chart = document.getElementById("chart");
    if (!chart || !value || view !== "coverage") return;
    const data = coverageCache.get(coverageKey);
    const { width, height } = screenCoverageSize(Math.max(320, chart.clientWidth));
    chart.style.height = `${height}px`;
    if (!data) { chart.innerHTML = ""; coverageGeometry = null; return; }
    const foreground = getComputedStyle(document.body).getPropertyValue("--vscode-foreground").trim() || "#ddd";
    const { markup, geometry } = coverageSvg(width, height, { ...image, ...coverage, textColor: foreground }, data);
    chart.innerHTML = markup;
    coverageGeometry = geometry;
  }

  function coverageImageDialog() {
    const density = coverage.plot === "density";
    return `<dialog id="image-dialog" class="chart-dialog"><form method="dialog"><div class="dialog-title"><h2>Save coverage image</h2><button id="cancel-image" type="button" aria-label="Close">×</button></div>
      <div class="export-options">
        <label>Plot <select id="image-type">${COVERAGE_PLOTS.map(([type, label]) => option(type, label, coverage.plot === type)).join("")}</select></label>
        <label>Color scale <select id="image-scale" ${density ? "" : "disabled"}>${option("linear", "Linear", coverage.scale === "linear")}${option("log", "Log₁₀", coverage.scale === "log")}</select></label>
        <label>Width <input id="image-width" type="number" min="200" max="16384" step="1" value="${esc(image.width)}"> px</label>
        <label>Height <input id="image-height" type="number" min="200" max="16384" step="1" value="${esc(image.height)}"> px</label>
        <label>Format <select id="image-format">${option("png", "PNG", image.format === "png")}${option("svg", "SVG", image.format === "svg")}</select></label>
      </div>
      <div class="export-options">
        <label><input id="image-grid" type="checkbox" ${image.grid ? "checked" : ""}> Grid</label>
        <label><input id="image-marginals" type="checkbox" ${coverage.marginals ? "checked" : ""}> Marginal densities</label>
        <label><input id="image-bound" type="checkbox" ${coverage.bound ? "checked" : ""} ${boundApplies() ? "" : "disabled"}> √coverage line</label>
        <label>Plot color <input id="image-color" type="color" value="${esc(image.color)}"></label>
        <label>Text and axes <input id="image-text-color" type="color" value="${esc(image.textColor)}"></label>
      </div>
      <div class="export-options axis-ranges">
        <label>Coverage <input id="image-x-min" type="number" step="any" placeholder="0" value="${esc(image.covXMin)}" aria-label="Coverage axis minimum"> – <input id="image-x-max" type="number" step="any" placeholder="1" value="${esc(image.covXMax)}" aria-label="Coverage axis maximum"></label>
        <label>Similarity <input id="image-y-min" type="number" step="any" placeholder="0" value="${esc(image.covYMin)}" aria-label="Similarity axis minimum"> – <input id="image-y-max" type="number" step="any" placeholder="1" value="${esc(image.covYMax)}" aria-label="Similarity axis maximum"></label>
        <label>X bins <input id="image-x-bins" type="number" min="1" max="200" step="1" value="${esc(coverage.xBins)}" ${density ? "" : "disabled"}></label>
        <label>Y bins <input id="image-y-bins" type="number" min="1" max="200" step="1" placeholder="Auto" value="${esc(coverage.yBins)}" ${density ? "" : "disabled"}></label>
        <button id="reset-image" type="button">Reset</button>
      </div>
      <div id="image-preview" class="image-preview" aria-label="Image preview"></div>
      <div id="image-status" class="hint" role="status"></div>
      <div class="actions"><button id="cancel-image-bottom" type="button">Cancel</button><button id="confirm-image" type="button" class="primary" ${imageSaving ? "disabled" : ""}>${imageSaving ? "Preparing image…" : "Save…"}</button></div></form></dialog>`;
  }

  // The dialog's plot options and image settings; throws on invalid input.
  function readCoverageImageDialog() {
    const field = (id) => document.getElementById(id);
    const dimension = (id, fallback) => Math.min(16384, Math.max(200, Math.round(Number(field(id)?.value)) || fallback));
    const xBins = positiveInteger(field("image-x-bins").value, 200);
    const yText = field("image-y-bins").value.trim();
    const yBins = yText === "" ? "" : positiveInteger(yText, 200);
    const choice = {
      options: { ...coverage, plot: field("image-type").value, scale: field("image-scale").value,
        marginals: field("image-marginals").checked, bound: field("image-bound").checked, xBins: xBins ?? coverage.xBins, yBins: yBins ?? coverage.yBins },
      image: { ...image, format: field("image-format").value, width: dimension("image-width", IMAGE_DEFAULTS.width),
        height: dimension("image-height", IMAGE_DEFAULTS.height), grid: field("image-grid").checked,
        color: field("image-color").value, textColor: field("image-text-color").value,
        covXMin: field("image-x-min").value.trim(), covXMax: field("image-x-max").value.trim(),
        covYMin: field("image-y-min").value.trim(), covYMax: field("image-y-max").value.trim() },
    };
    if (xBins === null || yBins === null) throw new Error("Bins must be integers between 1 and 200 (Y bins: blank for square cells).");
    const options = { ...choice.image, ...choice.options };
    const layout = coverageLayout(choice.image.width, choice.image.height, options);
    const xRange = axisRange(choice.image.covXMin, choice.image.covXMax, [0, 1]);
    const yRange = axisRange(choice.image.covYMin, choice.image.covYMax, [0, 1]);
    // Points and marginal densities depend on neither bins nor ranges: a
    // scatter image reuses the answer of the plot on screen.
    const request = options.plot === "density" ? coverageRequest(options, layout, xRange, yRange)
      : coverageRequest(coverage, screenLayout(), [0, 1], [0, 1]);
    return { ...choice, renderOptions: { ...options, xRange, yRange }, request };
  }

  let updateCoverageImage = null;
  function bindCoverageImageDialog() {
    const dialog = document.getElementById("image-dialog");
    const status = document.getElementById("image-status");
    const preview = document.getElementById("image-preview");
    const confirm = document.getElementById("confirm-image");
    const update = () => {
      let choice;
      try {
        choice = readCoverageImageDialog();
      } catch (cause) {
        preview.innerHTML = ""; status.textContent = cause.message; confirm.disabled = true; return;
      }
      for (const id of ["image-scale", "image-x-bins", "image-y-bins"]) document.getElementById(id).disabled = choice.options.plot !== "density";
      image = choice.image;
      saveState();
      coverageImageKey = choice.request.key;
      const data = coverageCache.get(coverageImageKey);
      if (!data) {
        clearTimeout(coverageTimer);
        coverageTimer = setTimeout(() => sendCoverage(choice.request), 200);
        preview.innerHTML = ""; status.textContent = "Calculating coverage…"; confirm.disabled = true;
        return;
      }
      preview.innerHTML = coverageSvg(image.width, image.height, choice.renderOptions, data).markup;
      preview.style.aspectRatio = `${image.width} / ${image.height}`;
      const bins = choice.options.plot === "density" ? ` · ${data.x_bins} × ${data.y_bins} cells` : "";
      status.textContent = `${image.width} × ${image.height} px ${image.format.toUpperCase()}${bins}`;
      confirm.disabled = imageSaving;
    };
    updateCoverageImage = update;
    dialog.querySelectorAll("input, select").forEach((input) => {
      input.addEventListener("input", update);
      input.addEventListener("change", update);
    });
    document.getElementById("reset-image").addEventListener("click", () => {
      image = { ...image, grid: IMAGE_DEFAULTS.grid, color: IMAGE_DEFAULTS.color, textColor: IMAGE_DEFAULTS.textColor,
        covXMin: "", covXMax: "", covYMin: "", covYMax: "" };
      saveState(); render();
    });
    const close = () => { exportOpen = false; updateCoverageImage = null; render(); };
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    dialog.showModal();
    document.body.classList.add("modal-open");
    document.getElementById("cancel-image").addEventListener("click", close);
    document.getElementById("cancel-image-bottom").addEventListener("click", close);
    confirm.addEventListener("click", () => deliverImage(() => {
      const choice = readCoverageImageDialog();
      const data = coverageCache.get(choice.request.key);
      if (!data) throw new Error("The coverage is still being calculated.");
      return { markup: coverageSvg(choice.image.width, choice.image.height, choice.renderOptions, data).markup,
        image: choice.image, filename: `similarity-coverage-${choice.options.plot}.${choice.image.format}` };
    }));
    update();
  }

  function svgToPng(markup, width, height) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
      const picture = new Image();
      picture.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(picture, 0, 0, width, height);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG image could not be created.")), "image/png");
      };
      picture.onerror = () => { URL.revokeObjectURL(url); reject(new Error("PNG image could not be created.")); };
      picture.src = url;
    });
  }

  function saveImage() {
    return deliverImage(() => {
      const choice = readImageDialog();
      return { markup: imageMarkup(choice), image: choice.image, filename: `similarity-${choice.type}.${choice.image.format}` };
    });
  }

  // Saves the image that build() returns ({markup, image, filename}); an
  // error thrown by build() is shown in the dialog.
  async function deliverImage(build) {
    if (imageSaving) return;
    let built;
    try {
      built = build();
    } catch (cause) {
      document.getElementById("image-status").textContent = cause.message;
      return;
    }
    const { markup, filename } = built;
    imageSaving = true;
    image = built.image;
    const button = document.getElementById("confirm-image");
    button.disabled = true; button.textContent = "Preparing image…";
    try {
      const blob = image.format === "svg"
        ? new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${markup}`], { type: "image/svg+xml" })
        : await svgToPng(markup, image.width, image.height);
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      if (!bytes.length) throw new Error("The image could not be created.");
      vscode.postMessage({ type: "save-similarity-image", filename, bytes });
    } catch (cause) {
      imageSaving = false;
      error = cause?.message || "The image could not be created.";
      render();
    }
  }

  document.addEventListener("click", (event) => {
    if (!moreOpen || event.target.closest(".result-more")) return;
    moreOpen = false;
    const button = document.getElementById("result-more-button");
    if (button) button.setAttribute("aria-expanded", "false");
    const menu = document.getElementById("result-more-actions");
    if (menu) menu.hidden = true;
  });

  window.addEventListener("message", ({ data: message }) => {
    if (message.type === "similarity-viewer-config") {
      const previous = activeScore();
      scoreColumnOrder = Array.isArray(message.scoreColumnOrder) ? message.scoreColumnOrder : [];
      if (value && activeScore() !== previous) request("page-request", value.page);
      else if (value) render();
    } else if (message.type === "backend-ready") request();
    else if (message.type === "similarity-page") {
      value = message.value; busy = false; error = "";
      // A host without score_columns: the score columns among the table's.
      if (!Array.isArray(value.score_columns) || !value.score_columns.length) {
        value.score_columns = Object.keys(SCORE_LABELS).filter((name) => value.columns?.includes(name));
        if (!value.score_columns.length) value.score_columns = ["similarity"];
      }
      // A reloaded file can have a different schema.
      columnFilters = columnFilters.filter(({ column }) => filterColumnNames().includes(column));
      if (sort.some(({ column }) => !value.columns.includes(column))) {
        sort = sort.filter(({ column }) => value.columns.includes(column));
      }
      // After a reload or a filter change, earlier coverage answers are stale.
      const filters = JSON.stringify(resultFilters());
      // The first request uses the file default until its available score columns are known.
      if (filters !== sentFilters || (sentSort ? sort !== sentSort : sort.length > 0) || (value.score && value.score !== activeScore())) {
        request("page-request", value.page); return;
      }
      if (filters !== coverageFilters) {
        coverageCache.clear(); coverageKey = ""; coverageImageKey = ""; coverageFilters = filters; coverageGeneration++;
      }
      render();
      if (view === "coverage" && hasCoverageColumns()) requestCoverage();
    }
    else if (message.type === "similarity-coverage") receiveCoverage(message.value);
    else if (message.type === "error") { busy = false; error = message.message || "Could not process results."; render(); }
    else if (message.type === "similarity-annotations-updated") {
      metadataPending = false;
      if (message.error) metadataError = message.error;
      else {
        value.metadata = message.metadata;
        value.metadata_modified = true;
        actionDialog = "";
        notice = "Metadata updated. Export as MSSIM to save.";
      }
      render();
    }
    else if (message.type === "export-cancelled") { busy = false; render(); }
    else if (message.type === "export-complete") {
      busy = false; notice = `Exported ${number(message.total_rows)} rows to ${message.path}`; render();
    }
    else if (message.type === "image-save-complete") {
      imageSaving = false; exportOpen = false; notice = `Saved image to ${message.path}`; render();
    }
    else if (message.type === "image-save-cancelled") {
      imageSaving = false; render();
    }
    else if (message.type === "image-save-error") {
      imageSaving = false; error = message.message || "The image could not be saved."; render();
    }
  });
  render();
  // Messages posted before this point would be lost: the host holds them
  // until it receives this.
  vscode.postMessage({ type: "webview-ready" });
})();
