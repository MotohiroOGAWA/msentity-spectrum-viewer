(() => {
  // The VS Code webview API, or a host object { postMessage(message) } provided by
  // the embedding page as window.msentityViewerHost (see ui/README.md).
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : window.msentityViewerHost;
  const app = document.getElementById("app");
  const saved = vscode.getState() || {};
  // Image settings shared by the chart on screen (plot colors, grid) and the saved image.
  // cov*: axis ranges of the coverage plot (coverage, similarity).
  const IMAGE_DEFAULTS = Object.freeze({ format: "png", width: 1200, height: 720, grid: true,
    color: "#3794ff", boxColor: "#d18616", textColor: "#000000", xMin: "", xMax: "", yMin: "", yMax: "",
    covXMin: "", covXMax: "", covYMin: "", covYMax: "" });
  // "methods": the frequency of every score column as lines, to compare methods.
  const CHART_TYPES = [["histogram", "Histogram"], ["line", "Line"], ["box", "Box plot"], ["methods", "All methods"]];
  // Line colors of the score columns in the "All methods" plot.
  const METHOD_COLORS = { cosine: "#3794ff", reverse_cosine: "#d18616", modified_cosine: "#2e9e4f", bonanza: "#b04fc4", similarity: "#3794ff" };
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
  let sort = saved.sort || null;
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
    modified_cosine: "Modified cosine", bonanza: "BONANZA" };
  const scoreLabel = (name) => SCORE_LABELS[name] || name;
  // The score column shown (statistics, distribution, filter, coverage plot):
  // the chosen one when the result has it, else the result's first.
  let score = typeof saved.score === "string" ? saved.score : "";
  const activeScore = () => value?.score_columns?.includes(score) ? score
    : value?.score_columns?.[0] || score || "cosine";
  // The backend filters of the score range.
  const rangeFilters = (r) => [
    r.min !== "" ? { column: activeScore(), operator: r.minOperator, value: String(r.min) } : null,
    r.max !== "" ? { column: activeScore(), operator: r.maxOperator, value: String(r.max) } : null,
  ].filter(Boolean);
  const rangeLabelText = (r) => [
    r.min !== "" ? `${r.minOperator === ">" ? ">" : "≥"} ${r.min}` : "",
    r.max !== "" ? `${r.maxOperator === "<" ? "<" : "≤"} ${r.max}` : "",
  ].filter(Boolean).join(", ");

  function saveState() {
    vscode.setState({ range, sort, bins, chartType, countScale, image, view, coverage, score });
  }

  let coverageFilters = null;   // the filters of the cached coverage answers
  let sentFilters = "";         // the filters of the last page request
  function request(type = "page-request", page = 0) {
    busy = true; error = ""; notice = "";
    if (type === "reload") coverageFilters = null;
    saveState();
    render();
    const filters = rangeFilters(range);
    sentFilters = JSON.stringify(filters);
    vscode.postMessage({ type, page, filters, sort, bins, score: value ? activeScore() : score || undefined });
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
      ? `${method} library search · all query/reference pairs · threshold ${number(parameters.threshold)}${matching}`
      : `${method} for unique metadata keys shared by both datasets${keyMatch ? ` · ${keyMatch}` : ""}${matching}`;
    const columnLabel = (column) => sharedKey && column === sharedKey ? keyMatch : column;
    // data_index* are rows of the embedded spectra; index* identify a pair only
    // when no key column does (library search).
    const keyed = Boolean(parameters.key1 && value?.columns.includes(parameters.key1));
    const columns = (value?.columns || []).filter((column) =>
      !/^data_index[12]$/.test(column) && !(keyed && /^index[12]$/.test(column)));
    const filterText = rangeLabelText(range);
    const chartTypes = CHART_TYPES.filter(([type]) => type !== "methods" || (value?.score_columns?.length || 0) > 1);
    if (value && !chartTypes.some(([type]) => type === chartType)) chartType = "line";
    const countChart = chartType !== "box";
    const methodsChart = chartType === "methods";
    const hasCoverage = hasCoverageColumns();
    const showCoverage = view === "coverage" && hasCoverage;
    app.innerHTML = `
      <header><div><span class="eyebrow">MSENTITY · SIMILARITY</span><h1>${esc(app.dataset.filename)}</h1>
        <p>${esc(subtitle)}</p>${sharedKey ? `<p class="key-sides">a: ${esc(sourceName(0))} · b: ${esc(sourceName(1))}</p>` : ""}</div>
        <nav aria-label="Result actions">${value ? `<label>Score <select id="score-column" ${disabled}>${value.score_columns.map((name) => option(name, scoreLabel(name), name === activeScore())).join("")}</select></label>` : ""}
        <button id="filter" ${disabled}>Filter${filterText ? ` (${esc(scoreLabel(activeScore()))} ${esc(filterText)})` : ""}</button>
        <button id="export" ${disabled || !value ? "disabled" : ""}>Export…</button>
        <button id="reload" ${disabled}>Reload</button></nav></header>
      <div role="status" class="message">${busy ? "Processing…" : esc(notice)}</div>
      ${error ? `<div role="alert" class="error">${esc(error)}</div>` : ""}
      ${showFilters && value ? `<section class="filter-panel"><h2>Filter by ${esc(scoreLabel(activeScore()))}</h2>
        <p>Leave a bound blank to leave that side open. The filter applies to the table, distribution, statistics, and export.</p>
        <div class="filter-range">
          <input id="range-min" type="number" min="0" max="1" step="0.01" placeholder="0" value="${esc(draftRange.min)}" aria-label="Lower bound">
          <select id="range-min-operator" aria-label="Lower bound comparison">${option(">=", "≤", draftRange.minOperator === ">=")}${option(">", "<", draftRange.minOperator === ">")}</select>
          <span>${esc(scoreLabel(activeScore()))}</span>
          <select id="range-max-operator" aria-label="Upper bound comparison">${option("<=", "≤", draftRange.maxOperator === "<=")}${option("<", "<", draftRange.maxOperator === "<")}</select>
          <input id="range-max" type="number" min="0" max="1" step="0.01" placeholder="1" value="${esc(draftRange.max)}" aria-label="Upper bound">
        </div>
        <div class="actions"><button id="apply" class="primary">Apply</button><button id="clear">Clear</button></div>
      </section>` : ""}
      ${value ? `
        <section class="stats" aria-label="Filtered result statistics">
          <div><span>Matched rows</span><strong>${number(value.total_rows)} <small>/ ${number(value.unfiltered_rows)}${value.scored_rows != null && value.scored_rows < value.total_rows ? ` · ${number(value.scored_rows)} with ${esc(scoreLabel(activeScore()))}` : ""}</small></strong></div>
          <div><span>Stored data</span><strong>${value.has_matched_data ? `${number(value.matched_data_rows[0])} + ${number(value.matched_data_rows[1])}` : "Lightweight"}</strong></div>
          ${Object.entries(value.statistics).map(([key, n]) => `<div><span>${esc(key)}</span><strong>${number(n)}</strong></div>`).join("")}
        </section>
        <section class="distribution"><div class="section-title"><div><h2>${showCoverage ? `Peak intensity coverage and ${esc(scoreLabel(activeScore()).toLowerCase())}` : methodsChart ? "Score distribution of every method" : `${esc(scoreLabel(activeScore()))} distribution`}</h2>
          <p>${showCoverage ? `${coverage.plot === "density" ? "Number of filtered rows per cell" : "One point per filtered row"}${boundApplies() ? (coverage.bound ? `; the dotted line is the largest possible ${esc(scoreLabel(activeScore()).toLowerCase())}, √coverage${activeScore() === "modified_cosine" ? " of its own pairing (direct and precursor-shifted peaks)" : ""}` : "")
              : `; no √coverage bound for ${esc(scoreLabel(activeScore()))}${activeScore() === "reverse_cosine" ? " against the query's coverage (it bounds the reference's)" : activeScore() === "modified_cosine" ? " in this result (recalculate it to get the coverage of the modified-cosine pairing)" : ""}`}.`
            : chartType === "box" ? "Box plot across all filtered rows, showing minimum, Q1, median, Q3, and maximum."
            : methodsChart ? `Frequency of each method's scores across all ${number(value.total_rows)} filtered rows, one point per bin; rows without a score for a method are left out of its line. The filter applies to ${esc(scoreLabel(activeScore()))}.`
            : `Frequency across all ${number(value.total_rows)} filtered rows${chartType === "line" ? ", one point per bin" : ""}.`}</p></div>
          <div class="chart-controls"><label>View <select id="chart-view" ${disabled}>${VIEWS.map(([type, label]) => `<option value="${type}" ${view === type ? "selected" : ""} ${type === "coverage" && !hasCoverage ? "disabled" : ""}>${esc(label)}</option>`).join("")}</select></label>
          ${showCoverage ? coverageControls(disabled) : `<label>Plot <select id="chart-type" ${disabled}>${chartTypes.map(([type, label]) => option(type, label, chartType === type)).join("")}</select></label>
          <label>Count <select id="count-scale" ${disabled || !countChart ? "disabled" : ""}>${option("linear", "Linear", countScale === "linear")}${option("log", "Log₁₀", countScale === "log")}</select></label>
          <label>Bins <input id="bins" type="number" min="1" max="200" step="1" value="${bins}" ${disabled || !countChart ? "disabled" : ""} /></label>`}
          <button id="save-image" ${disabled || (showCoverage && !coverageCache.get(coverageKey)) ? "disabled" : ""}>Save image…</button></div></div>
          ${view === "coverage" && !hasCoverage ? `<p class="hint">This result has no peak intensity coverage columns (peak_intensity_coverage1, peak_intensity_coverage2). Recalculate it to plot coverage.</p>` : ""}
          <div id="chart" class="${showCoverage ? "coverage-chart" : ""}" role="img" aria-label="${showCoverage ? "Peak intensity coverage against similarity" : chartType === "box" ? "Similarity score box plot" : "Similarity score distribution"}"></div>
          <div id="chart-hint" class="hint" aria-live="polite">${showCoverage ? coverageHint() : chartHint()}</div>
          ${showCoverage ? "" : methodsChart ? methodTables() : `<details><summary>Frequency table</summary><div class="frequency-table"><table><thead><tr><th>Similarity range</th><th>Count</th></tr></thead>
          <tbody>${value.histogram.counts.map((count, i) => `<tr><td>${rangeLabel(i)}</td><td>${number(count)}</td></tr>`).join("")}</tbody></table></div></details>`}
        </section>
        <section><div class="section-title"><h2>Comparison results</h2>${columns.some((column) => /^index[12]$/.test(column)) ? "<span>Indices are zero-based input positions</span>" : ""}</div>
        <div class="table-scroll"><table><thead><tr>${value.has_matched_data ? "<th>Match</th>" : ""}${columns.map((column) => `<th aria-sort="${sort?.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}"><button data-sort="${esc(column)}" ${disabled}>${esc(columnLabel(column))} ${sort?.column === column ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button></th>`).join("")}</tr></thead>
        <tbody>${value.rows.length ? value.rows.map((row, index) => `<tr>${value.has_matched_data ? `<td><button data-open-match="${Number(value.result_indices[index])}" ${disabled}>Open spectra</button></td>` : ""}${columns.map((column) => `<td>${/^(cosine|reverse_cosine|modified_cosine|bonanza|similarity|peak_intensity_coverage[12])$/.test(column) ? number(row[column]) : esc(typeof row[column] === "object" && row[column] !== null ? JSON.stringify(row[column]) : row[column])}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${columns.length + (value.has_matched_data ? 1 : 0)}" class="empty">No matching rows</td></tr>`}</tbody></table></div>
        <footer><button id="previous" ${busy || value.page === 0 ? "disabled" : ""}>Previous</button><span>Page ${value.page + 1} / ${value.total_pages}</span><button id="next" ${busy || value.page + 1 >= value.total_pages ? "disabled" : ""}>Next</button></footer></section>
        <details class="metadata"><summary>Calculation metadata</summary><p>Reload reads the saved result. Recalculate from the dataset viewer to use changed spectra.</p><pre>${esc(JSON.stringify(value.metadata, null, 2))}</pre></details>
      ` : "<p>Opening similarity results…</p>"}
      ${exportOpen && value ? (showCoverage ? coverageImageDialog() : imageDialog()) : ""}`;

    document.getElementById("score-column")?.addEventListener("change", (e) => { score = e.target.value; request("page-request", value.page); });
    document.getElementById("filter")?.addEventListener("click", () => { showFilters = !showFilters; draftRange = { ...range }; render(); });
    document.getElementById("reload")?.addEventListener("click", () => request("reload"));
    document.getElementById("export")?.addEventListener("click", () => request("export-similarity"));
    for (const [id, field] of [["range-min", "min"], ["range-max", "max"], ["range-min-operator", "minOperator"], ["range-max-operator", "maxOperator"]]) {
      document.getElementById(id)?.addEventListener("change", (e) => { draftRange[field] = e.target.value.trim(); });
    }
    document.getElementById("apply")?.addEventListener("click", applyRange);
    document.getElementById("clear")?.addEventListener("click", () => { range = { ...RANGE_DEFAULTS }; draftRange = { ...range }; request(); });
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
    document.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
      const column = button.dataset.sort;
      sort = { column, direction: sort?.column === column && sort.direction === "asc" ? "desc" : "asc" };
      request();
    }));
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
    else document.body.classList.remove("modal-open");
  }

  function applyRange() {
    const bound = (text) => text === "" ? "" : Number(text);
    const min = bound(draftRange.min), max = bound(draftRange.max);
    if ([min, max].some((n) => n !== "" && !Number.isFinite(n))) { error = "Similarity bounds must be numbers."; render(); return; }
    if (min !== "" && max !== "" && min > max) { error = "The lower bound must not exceed the upper bound."; render(); return; }
    range = { ...draftRange };
    showFilters = false;
    request();
  }

  // [score column, counts] of every method (one series for results without histograms).
  function scoreSeries() {
    const histograms = value?.histograms;
    return histograms && Object.keys(histograms).length ? Object.entries(histograms) : [[activeScore(), value.histogram.counts]];
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
      <div id="image-preview" class="image-preview" aria-label="Image preview"></div>
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

  function bindImageDialog() {
    const dialog = document.getElementById("image-dialog");
    const status = document.getElementById("image-status");
    const update = () => {
      const choice = readImageDialog();
      const countAxis = choice.type !== "box";
      for (const id of ["image-scale", "image-y-min", "image-y-max"]) document.getElementById(id).disabled = !countAxis;
      image = choice.image;
      saveState();
      drawChart();
      try {
        document.getElementById("image-preview").innerHTML = imageMarkup(choice);
        document.getElementById("image-preview").style.aspectRatio = `${image.width} / ${image.height}`;
        status.textContent = `${image.width} × ${image.height} px ${image.format.toUpperCase()}`;
        document.getElementById("confirm-image").disabled = imageSaving;
      } catch (cause) {
        document.getElementById("image-preview").innerHTML = "";
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
    vscode.postMessage({ type: "coverage-request", filters: rangeFilters(range), request_id: [coverageGeneration, key], ...fields });
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

  window.addEventListener("message", ({ data: message }) => {
    if (message.type === "backend-ready") request();
    else if (message.type === "similarity-page") {
      value = message.value; busy = false; error = "";
      // A host without score_columns: the score columns among the table's.
      if (!Array.isArray(value.score_columns) || !value.score_columns.length) {
        value.score_columns = Object.keys(SCORE_LABELS).filter((name) => value.columns?.includes(name));
        if (!value.score_columns.length) value.score_columns = ["similarity"];
      }
      // After a reload or a filter change, earlier coverage answers are stale.
      const filters = JSON.stringify(rangeFilters(range));
      // The first request of an old saved state may not have known the score column.
      if (filters !== sentFilters) { request("page-request", value.page); return; }
      if (filters !== coverageFilters) {
        coverageCache.clear(); coverageKey = ""; coverageImageKey = ""; coverageFilters = filters; coverageGeneration++;
      }
      render();
      if (view === "coverage" && hasCoverageColumns()) requestCoverage();
    }
    else if (message.type === "similarity-coverage") receiveCoverage(message.value);
    else if (message.type === "error") { busy = false; error = message.message || "Could not process results."; render(); }
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
