(() => {
  // The VS Code webview API, or a host object { postMessage(message) } provided by
  // the embedding page as window.msentityViewerHost (see ui/README.md).
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : window.msentityViewerHost;
  const app = document.getElementById("app");
  const saved = vscode.getState() || {};
  // Image settings shared by the chart on screen (plot colors, grid) and the saved image.
  const IMAGE_DEFAULTS = Object.freeze({ format: "png", width: 1200, height: 720, grid: true,
    color: "#3794ff", boxColor: "#d18616", textColor: "#000000", xMin: "", xMax: "", yMin: "", yMax: "" });
  const CHART_TYPES = [["histogram", "Histogram"], ["line", "Line"], ["box", "Box plot"]];
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

  // The backend filters of the similarity range.
  const rangeFilters = (r) => [
    r.min !== "" ? { column: "similarity", operator: r.minOperator, value: String(r.min) } : null,
    r.max !== "" ? { column: "similarity", operator: r.maxOperator, value: String(r.max) } : null,
  ].filter(Boolean);
  const rangeLabelText = (r) => [
    r.min !== "" ? `${r.minOperator === ">" ? ">" : "≥"} ${r.min}` : "",
    r.max !== "" ? `${r.maxOperator === "<" ? "<" : "≤"} ${r.max}` : "",
  ].filter(Boolean).join(", ");

  function saveState() {
    vscode.setState({ range, sort, bins, chartType, countScale, image });
  }

  function request(type = "page-request", page = 0) {
    busy = true; error = ""; notice = "";
    saveState();
    render();
    vscode.postMessage({ type, page, filters: rangeFilters(range), sort, bins });
  }

  function render() {
    observer?.disconnect();
    const disabled = busy ? "disabled" : "";
    const mode = value?.metadata?.mode;
    const method = value?.metadata?.parameters?.method === "reverse_cosine"
      ? "Reverse cosine similarity" : "Cosine similarity";
    const parameters = value?.metadata?.parameters || {};
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
    const countChart = chartType !== "box";
    app.innerHTML = `
      <header><div><span class="eyebrow">MSENTITY · SIMILARITY</span><h1>${esc(app.dataset.filename)}</h1>
        <p>${esc(subtitle)}</p>${sharedKey ? `<p class="key-sides">a: ${esc(sourceName(0))} · b: ${esc(sourceName(1))}</p>` : ""}</div>
        <nav aria-label="Result actions"><button id="filter" ${disabled}>Filter${filterText ? ` (${esc(filterText)})` : ""}</button>
        <button id="export" ${disabled || !value ? "disabled" : ""}>Export…</button>
        <button id="reload" ${disabled}>Reload</button></nav></header>
      <div role="status" class="message">${busy ? "Processing…" : esc(notice)}</div>
      ${error ? `<div role="alert" class="error">${esc(error)}</div>` : ""}
      ${showFilters && value ? `<section class="filter-panel"><h2>Filter by similarity</h2>
        <p>Leave a bound blank to leave that side open. The filter applies to the table, distribution, statistics, and export.</p>
        <div class="filter-range">
          <input id="range-min" type="number" min="0" max="1" step="0.01" placeholder="0" value="${esc(draftRange.min)}" aria-label="Lower bound">
          <select id="range-min-operator" aria-label="Lower bound comparison">${option(">=", "≤", draftRange.minOperator === ">=")}${option(">", "<", draftRange.minOperator === ">")}</select>
          <span>similarity</span>
          <select id="range-max-operator" aria-label="Upper bound comparison">${option("<=", "≤", draftRange.maxOperator === "<=")}${option("<", "<", draftRange.maxOperator === "<")}</select>
          <input id="range-max" type="number" min="0" max="1" step="0.01" placeholder="1" value="${esc(draftRange.max)}" aria-label="Upper bound">
        </div>
        <div class="actions"><button id="apply" class="primary">Apply</button><button id="clear">Clear</button></div>
      </section>` : ""}
      ${value ? `
        <section class="stats" aria-label="Filtered result statistics">
          <div><span>Matched rows</span><strong>${number(value.total_rows)} <small>/ ${number(value.unfiltered_rows)}</small></strong></div>
          <div><span>Stored data</span><strong>${value.has_matched_data ? `${number(value.matched_data_rows[0])} + ${number(value.matched_data_rows[1])}` : "Lightweight"}</strong></div>
          ${Object.entries(value.statistics).map(([key, n]) => `<div><span>${esc(key)}</span><strong>${number(n)}</strong></div>`).join("")}
        </section>
        <section class="distribution"><div class="section-title"><div><h2>Similarity distribution</h2>
          <p>${chartType === "box" ? "Box plot across all filtered rows, showing minimum, Q1, median, Q3, and maximum."
            : `Frequency across all ${number(value.total_rows)} filtered rows${chartType === "line" ? ", one point per bin" : ""}.`}</p></div>
          <div class="chart-controls"><label>Plot <select id="chart-type" ${disabled}>${CHART_TYPES.map(([type, label]) => option(type, label, chartType === type)).join("")}</select></label>
          <label>Count <select id="count-scale" ${disabled || !countChart ? "disabled" : ""}>${option("linear", "Linear", countScale === "linear")}${option("log", "Log₁₀", countScale === "log")}</select></label>
          <label>Bins <input id="bins" type="number" min="1" max="200" step="1" value="${bins}" ${disabled || !countChart ? "disabled" : ""} /></label>
          <button id="save-image" ${disabled}>Save image…</button></div></div>
          <div id="chart" role="img" aria-label="${chartType === "box" ? "Similarity score box plot" : "Similarity score distribution"}"></div>
          <div id="chart-hint" class="hint" aria-live="polite">${chartHint()}</div>
          <details><summary>Frequency table</summary><div class="frequency-table"><table><thead><tr><th>Similarity range</th><th>Count</th></tr></thead>
          <tbody>${value.histogram.counts.map((count, i) => `<tr><td>${rangeLabel(i)}</td><td>${number(count)}</td></tr>`).join("")}</tbody></table></div></details>
        </section>
        <section><div class="section-title"><h2>Comparison results</h2>${columns.some((column) => /^index[12]$/.test(column)) ? "<span>Indices are zero-based input positions</span>" : ""}</div>
        <div class="table-scroll"><table><thead><tr>${value.has_matched_data ? "<th>Match</th>" : ""}${columns.map((column) => `<th aria-sort="${sort?.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}"><button data-sort="${esc(column)}" ${disabled}>${esc(columnLabel(column))} ${sort?.column === column ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button></th>`).join("")}</tr></thead>
        <tbody>${value.rows.length ? value.rows.map((row, index) => `<tr>${value.has_matched_data ? `<td><button data-open-match="${Number(value.result_indices[index])}" ${disabled}>Open spectra</button></td>` : ""}${columns.map((column) => `<td>${column === "similarity" ? number(row[column]) : esc(typeof row[column] === "object" && row[column] !== null ? JSON.stringify(row[column]) : row[column])}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${columns.length + (value.has_matched_data ? 1 : 0)}" class="empty">No matching rows</td></tr>`}</tbody></table></div>
        <footer><button id="previous" ${busy || value.page === 0 ? "disabled" : ""}>Previous</button><span>Page ${value.page + 1} / ${value.total_pages}</span><button id="next" ${busy || value.page + 1 >= value.total_pages ? "disabled" : ""}>Next</button></footer></section>
        <details class="metadata"><summary>Calculation metadata</summary><p>Reload reads the saved result. Recalculate from the dataset viewer to use changed spectra.</p><pre>${esc(JSON.stringify(value.metadata, null, 2))}</pre></details>
      ` : "<p>Opening similarity results…</p>"}
      ${exportOpen && value ? imageDialog() : ""}`;

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
    document.getElementById("count-scale")?.addEventListener("change", (e) => { countScale = e.target.value; saveState(); render(); });
    document.getElementById("save-image")?.addEventListener("click", () => { exportOpen = true; render(); });
    document.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
      const column = button.dataset.sort;
      sort = { column, direction: sort?.column === column && sort.direction === "asc" ? "desc" : "asc" };
      request();
    }));
    document.querySelectorAll("[data-open-match]").forEach((button) => button.addEventListener("click", () => {
      vscode.postMessage({ type: "open-similarity-match", resultIndex: Number(button.dataset.openMatch) });
    }));
    document.getElementById("previous")?.addEventListener("click", () => request("page-request", value.page - 1));
    document.getElementById("next")?.addEventListener("click", () => request("page-request", value.page + 1));
    const chart = document.getElementById("chart");
    if (chart) {
      observer = new ResizeObserver(drawChart); observer.observe(chart);
      chart.addEventListener("mousemove", (event) => {
        const i = binAt(event);
        document.getElementById("chart-hint").textContent = i === null ? chartHint() : `${rangeLabel(i)}: ${number(value.histogram.counts[i])} rows`;
      });
      chart.addEventListener("mouseleave", () => { document.getElementById("chart-hint").textContent = chartHint(); });
      drawChart();
    }
    if (exportOpen && value) bindImageDialog();
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
    const plot = [];
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
      const log = options.scale === "log";
      const transform = (count) => log ? Math.log10(count + 1) : count;
      const observed = Math.max(1, ...counts);
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
      if (options.type === "line") {
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
      `<path d="M${left} ${yAxis ? `${top}V${top + plotHeight}` : top + plotHeight}H${left + plotWidth}" fill="none" stroke="${text}"/>`);
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
    return `<dialog id="image-dialog" class="chart-dialog" open><form method="dialog"><div class="dialog-title"><h2>Save distribution image</h2><button id="cancel-image" type="button" aria-label="Close">×</button></div>
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
    document.getElementById("cancel-image").addEventListener("click", close);
    document.getElementById("cancel-image-bottom").addEventListener("click", close);
    document.getElementById("confirm-image").addEventListener("click", saveImage);
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

  async function saveImage() {
    if (imageSaving) return;
    const choice = readImageDialog();
    let markup;
    try {
      markup = imageMarkup(choice);
    } catch (cause) {
      document.getElementById("image-status").textContent = cause.message;
      return;
    }
    imageSaving = true;
    image = choice.image;
    const button = document.getElementById("confirm-image");
    button.disabled = true; button.textContent = "Preparing image…";
    try {
      const blob = choice.image.format === "svg"
        ? new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${markup}`], { type: "image/svg+xml" })
        : await svgToPng(markup, choice.image.width, choice.image.height);
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      if (!bytes.length) throw new Error("The image could not be created.");
      vscode.postMessage({ type: "save-similarity-image", filename: `similarity-${choice.type}.${choice.image.format}`, bytes });
    } catch (cause) {
      imageSaving = false;
      error = cause?.message || "The image could not be created.";
      render();
    }
  }

  window.addEventListener("message", ({ data: message }) => {
    if (message.type === "backend-ready") request();
    else if (message.type === "similarity-page") { value = message.value; busy = false; error = ""; render(); }
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
