/* msentity-spectrum-viewer embedding components (framework-free, UMD). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MsEntityViewer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SIDES = new Set(["single", "top", "bottom"]);
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function identityOf(payload) {
    return {
      datasetId: payload?.datasetId ?? payload?.dataset_id ?? null,
      spectrumId: payload?.spectrumId ?? payload?.spectrum_id ?? null,
      spectrumKey: payload?.spectrumKey ?? payload?.spectrum_key ?? null,
      rowId: payload?.rowId ?? payload?.row_id ?? null,
      globalIndex: payload?.globalIndex ?? payload?.global_index ?? null,
    };
  }

  function normalizePeak(peak, side = "single", spectrum = null) {
    if (peak == null) return null;
    if (!SIDES.has(side)) throw new TypeError(`Unknown spectrum side: ${side}`);
    const peakIndex = Number(peak.peakIndex ?? peak.index);
    if (!Number.isInteger(peakIndex) || peakIndex < 0) throw new TypeError("peakIndex must be a non-negative integer");
    const id = identityOf({ ...(spectrum || {}), ...peak });
    return Object.freeze({
      ...id, side, peakIndex,
      mz: Number(peak.mz ?? peak.x),
      intensity: Number(peak.intensity ?? peak.y),
    });
  }

  class ViewerController {
    constructor(initialState = {}) {
      this._listeners = new Map();
      this._destroyed = false;
      this._state = {
        activeDataset: null, activeSpectrum: null,
        comparison: { top: null, bottom: null }, selectedPeak: null,
        columnVisibility: { dataset: {}, peaks: {} },
        loading: {}, ...clone(initialState),
      };
      this._state.comparison = { top: null, bottom: null, ...(this._state.comparison || {}) };
      this._state.columnVisibility = { dataset: {}, peaks: {}, ...(this._state.columnVisibility || {}) };
    }
    getState() { return clone(this._state); }
    getActiveDataset() { return clone(this._state.activeDataset); }
    getActiveSpectrum(side = "single") {
      return clone(side === "single" ? this._state.activeSpectrum : this._state.comparison[side]);
    }
    getSelectedPeak() { return clone(this._state.selectedPeak); }
    getColumnVisibility(component, scope = "default") {
      const entry = this._state.columnVisibility[component]?.[scope];
      return entry ? clone(entry) : { visible: null, hidden: [] };
    }
    subscribe(type, listener) {
      if (typeof type === "function") { listener = type; type = "change"; }
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      const listeners = this._listeners.get(type) || new Set();
      listeners.add(listener); this._listeners.set(type, listeners);
      return () => this.unsubscribe(type, listener);
    }
    on(type, listener) { return this.subscribe(type, listener); }
    unsubscribe(type, listener) {
      const listeners = this._listeners.get(type);
      if (!listeners) return false;
      const removed = listeners.delete(listener);
      if (!listeners.size) this._listeners.delete(type);
      return removed;
    }
    off(type, listener) { return this.unsubscribe(type, listener); }
    _emit(type, detail) {
      if (this._destroyed) return;
      const event = Object.freeze({ type, detail: clone(detail), state: this.getState(), controller: this });
      for (const name of [type, "change"]) {
        for (const listener of [...(this._listeners.get(name) || [])]) listener(event);
      }
    }
    setActiveDataset(dataset) {
      const previous = this._state.activeDataset;
      this._state.activeDataset = clone(dataset);
      const changed = JSON.stringify(identityOf(previous)) !== JSON.stringify(identityOf(dataset));
      if (changed) {
        this._state.activeSpectrum = null;
        this._state.comparison = { top: null, bottom: null };
        this._state.selectedPeak = null;
      }
      this._emit("datasetchange", this._state.activeDataset);
      if (changed) this._emit("peakchange", null);
      return this;
    }
    setActiveSpectrum(spectrum, side = "single") {
      if (!SIDES.has(side)) throw new TypeError(`Unknown spectrum side: ${side}`);
      const next = clone(spectrum);
      if (side === "single") this._state.activeSpectrum = next;
      else this._state.comparison[side] = next;
      const selected = this._state.selectedPeak;
      const id = identityOf(next);
      if (selected && (selected.side !== side ||
        (id.datasetId != null && selected.datasetId !== id.datasetId) ||
        (id.rowId != null && selected.rowId !== id.rowId) ||
        (id.spectrumId != null && selected.spectrumId !== id.spectrumId))) {
        this._state.selectedPeak = null;
        this._emit("peakchange", null);
      }
      this._emit("spectrumchange", { side, spectrum: next });
      return this;
    }
    setComparison(top, bottom) {
      this._state.comparison = { top: clone(top), bottom: clone(bottom) };
      this._state.activeSpectrum = null;
      this._state.selectedPeak = null;
      this._emit("spectrumchange", { side: "comparison", top, bottom });
      this._emit("peakchange", null);
      return this;
    }
    selectPeak(peak, side = peak?.side || "single") {
      const spectrum = side === "single" ? this._state.activeSpectrum : this._state.comparison[side];
      const next = normalizePeak(peak, side, spectrum);
      this._state.selectedPeak = next;
      this._emit("peakchange", next);
      return this;
    }
    clearPeakSelection() {
      if (this._state.selectedPeak === null) return this;
      this._state.selectedPeak = null; this._emit("peakchange", null); return this;
    }
    setColumnVisibility(component, setting, scope = "default") {
      if (!this._state.columnVisibility[component]) this._state.columnVisibility[component] = {};
      const available = Array.isArray(setting.available) ? setting.available.map(String) : null;
      let visible = Array.isArray(setting.visible) ? setting.visible.map(String) : null;
      const hidden = Array.isArray(setting.hidden) ? setting.hidden.map(String) : [];
      if (visible === null && available) visible = available.filter(column => !hidden.includes(column));
      if (visible) visible = [...new Set(visible)].filter(column => !hidden.includes(column));
      const next = { visible, hidden: [...new Set(hidden)] };
      this._state.columnVisibility[component][scope] = next;
      this._emit("columnvisibilitychange", { component, scope, ...next });
      return this;
    }
    setLoading(key, value) {
      this._state.loading[key] = clone(value);
      this._emit("loadingchange", { key, value }); return this;
    }
    destroy() { this._listeners.clear(); this._destroyed = true; }
  }

  class Component {
    constructor(options = {}) {
      this.controller = options.controller || new ViewerController();
      this.options = options; this.element = null; this._cleanups = [];
    }
    mount(target) {
      if (typeof target === "string") target = document.querySelector(target);
      if (!target?.appendChild) throw new TypeError("mount target must be a DOM element or selector");
      this.unmount(); this.element = target; this.render(); return this;
    }
    listen(type, handler) { this._cleanups.push(this.controller.subscribe(type, handler)); }
    unmount() {
      for (const cleanup of this._cleanups.splice(0)) cleanup();
      if (this.element) this.element.replaceChildren();
      this.element = null; return this;
    }
    destroy() { return this.unmount(); }
  }

  class DatasetTable extends Component {
    constructor(options = {}) { super(options); this.data = options.data || null; this.sort = null; this.filter = ""; }
    setData(data) { this.data = data; if (this.element) this.render(); return this; }
    render() {
      if (!this.element) return;
      this._cleanups.splice(0).forEach(fn => fn());
      const columns = (this.data?.all_columns || this.data?.columns || []).map(String);
      const scope = String(this.data?.dataset_id ?? this.data?.datasetId ?? "default");
      const setting = this.controller.getColumnVisibility("dataset", scope);
      const visible = setting.visible || columns.filter(c => !setting.hidden.includes(c));
      let rows = (this.data?.rows || []).map((row, index) => ({ row, index }));
      if (this.filter) rows = rows.filter(x => visible.some(c => String(x.row[c] ?? "").toLowerCase().includes(this.filter)));
      if (this.sort) rows.sort((a, b) => String(a.row[this.sort.column] ?? "").localeCompare(String(b.row[this.sort.column] ?? ""), undefined, { numeric: true }) * this.sort.direction);
      this.element.innerHTML = `<section class="msv-dataset-table"><label class="msv-filter">Filter <input type="search" value="${escapeHtml(this.filter)}"></label><div class="msv-scroll"><table><thead><tr>${visible.map(c => `<th><button data-column="${escapeHtml(c)}">${escapeHtml(c)}${this.sort?.column === c ? (this.sort.direction > 0 ? " ↑" : " ↓") : ""}</button></th>`).join("")}</tr></thead><tbody>${rows.map(({row,index}) => `<tr tabindex="0" data-row="${index}">${visible.map(c => `<td data-cell-column="${escapeHtml(c)}">${escapeHtml(typeof row[c] === "object" ? JSON.stringify(row[c]) : row[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
      this.element.querySelector("input")?.addEventListener("input", e => { this.filter = e.target.value.toLowerCase(); this.render(); });
      this.element.querySelectorAll("[data-column]").forEach(button => button.addEventListener("click", () => {
        const column = button.dataset.column;
        this.sort = { column, direction: this.sort?.column === column ? -this.sort.direction : 1 }; this.render();
      }));
      this.element.querySelectorAll("[data-row]").forEach(row => row.addEventListener("click", () => {
        const local = Number(row.dataset.row), record = this.data.rows[local];
        this.controller.setActiveDataset({ datasetId: this.data.dataset_id ?? this.data.datasetId, data: this.data })
          .setActiveSpectrum({ datasetId: this.data.dataset_id ?? this.data.datasetId, rowId: this.data.row_ids?.[local] ?? local,
            globalIndex: (this.data.row_offset || 0) + local, row: record, spectrum: this.data.spectra?.[local] });
      }));
      if (typeof this.options.editCell === "function") this.element.querySelectorAll("[data-cell-column]").forEach(cell => {
        cell.addEventListener("dblclick", () => { cell.contentEditable = "true"; cell.focus(); });
        cell.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); cell.blur(); } });
        cell.addEventListener("blur", async () => {
          if (cell.contentEditable !== "true") return;
          cell.contentEditable = "false";
          const rowIndex = Number(cell.parentElement.dataset.row), column = cell.dataset.cellColumn, value = cell.textContent;
          const accepted = await this.options.editCell({ rowIndex, rowId: this.data.row_ids?.[rowIndex] ?? rowIndex,
            column, value, row: this.data.rows[rowIndex], dataset: this.data });
          if (accepted !== false) this.data.rows[rowIndex][column] = value;
          this.render();
        });
      });
      this.listen("columnvisibilitychange", event => { if (event.detail.component === "dataset") this.render(); });
    }
  }

  function peaksOf(payload) {
    const data = payload?.spectrum || payload || {};
    const mz = Array.isArray(data.mz) ? data.mz : [];
    return mz.map((value, peakIndex) => ({ peakIndex, mz: Number(value), intensity: Number(data.intensity?.[peakIndex] ?? 0) }))
      .filter(p => Number.isFinite(p.mz) && Number.isFinite(p.intensity));
  }

  class SpectrumPlot extends Component {
    render() {
      if (!this.element) return;
      this._cleanups.splice(0).forEach(fn => fn());
      const state = this.controller.getState();
      const sources = state.comparison.top || state.comparison.bottom
        ? [["top", state.comparison.top], ["bottom", state.comparison.bottom]].filter(x => x[1])
        : [["single", state.activeSpectrum]];
      const all = sources.flatMap(([, source]) => peaksOf(source));
      if (!all.length) { this.element.innerHTML = '<div class="msv-empty">No spectrum selected</div>'; this.listen("spectrumchange", () => this.render()); return; }
      const width = 900, height = 360, left = 48, right = 12, mid = height / 2;
      const maxMz = Math.max(...all.map(p => p.mz), 1), maxI = Math.max(...all.map(p => Math.abs(p.intensity)), 1);
      const selected = state.selectedPeak;
      const lines = sources.flatMap(([side, source]) => peaksOf(source).map(p => {
        const x = left + p.mz / maxMz * (width - left - right);
        const magnitude = Math.abs(p.intensity) / maxI * (mid - 24);
        const y2 = side === "bottom" ? mid + magnitude : mid - magnitude;
        const active = selected?.side === side && selected.peakIndex === p.peakIndex;
        return `<line data-side="${side}" data-peak="${p.peakIndex}" x1="${x}" x2="${x}" y1="${mid}" y2="${y2}" class="${active ? "selected" : ""}"><title>m/z ${p.mz}; intensity ${p.intensity}</title></line>`;
      })).join("");
      this.element.innerHTML = `<div class="msv-spectrum-plot"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Mass spectrum"><line class="axis" x1="${left}" x2="${width-right}" y1="${mid}" y2="${mid}"/>${lines}</svg></div>`;
      this.element.querySelectorAll("[data-peak]").forEach(line => line.addEventListener("click", event => {
        event.stopPropagation(); const side = line.dataset.side;
        const source = side === "single" ? this.controller.getActiveSpectrum() : this.controller.getActiveSpectrum(side);
        this.controller.selectPeak(peaksOf(source).find(p => p.peakIndex === Number(line.dataset.peak)), side);
      }));
      this.element.querySelector("svg")?.addEventListener("click", () => this.controller.clearPeakSelection());
      this.listen("spectrumchange", () => this.render()); this.listen("peakchange", () => this.render());
    }
  }

  class PeaksTable extends Component {
    constructor(options = {}) { super(options); this.sort = { column: "mz", direction: 1 }; }
    render() {
      if (!this.element) return;
      this._cleanups.splice(0).forEach(fn => fn());
      const state = this.controller.getState();
      const sources = state.comparison.top || state.comparison.bottom
        ? [["top", state.comparison.top], ["bottom", state.comparison.bottom]].filter(x => x[1]) : [["single", state.activeSpectrum]];
      const rows = sources.flatMap(([side, source]) => {
        const data = source?.spectrum || source || {}, columns = ["mz", "intensity", ...(data.metadata_columns || [])];
        const scope = String(identityOf(source).datasetId ?? "default");
        const setting = this.controller.getColumnVisibility("peaks", scope);
        const visible = setting.visible || columns.filter(c => !setting.hidden.includes(c));
        return peaksOf(source).map(peak => ({ side, source, peak, visible, metadata: data.metadata?.[peak.peakIndex] || {} }));
      });
      rows.sort((a,b) => ((a.peak[this.sort.column] ?? a.metadata[this.sort.column]) > (b.peak[this.sort.column] ?? b.metadata[this.sort.column]) ? 1 : -1) * this.sort.direction);
      const columns = [...new Set(rows.flatMap(r => r.visible))];
      this.element.innerHTML = `<div class="msv-peaks-table msv-scroll"><table><thead><tr>${sources.length > 1 ? "<th>Side</th>" : ""}${columns.map(c => `<th><button data-sort="${escapeHtml(c)}">${escapeHtml(c)}</button></th>`).join("")}</tr></thead><tbody>${rows.map(({side,peak,metadata}) => `<tr tabindex="0" data-side="${side}" data-peak="${peak.peakIndex}" class="${state.selectedPeak?.side === side && state.selectedPeak.peakIndex === peak.peakIndex ? "selected" : ""}">${sources.length > 1 ? `<td>${side}</td>` : ""}${columns.map(c => `<td data-peak-column="${escapeHtml(c)}">${escapeHtml(c in peak ? peak[c] : metadata[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      this.element.querySelectorAll("[data-peak]").forEach(row => row.addEventListener("click", () => {
        const side = row.dataset.side, source = side === "single" ? this.controller.getActiveSpectrum() : this.controller.getActiveSpectrum(side);
        this.controller.selectPeak(peaksOf(source).find(p => p.peakIndex === Number(row.dataset.peak)), side);
      }));
      this.element.querySelectorAll("[data-sort]").forEach(button => button.addEventListener("click", () => {
        const column = button.dataset.sort; this.sort = { column, direction: this.sort.column === column ? -this.sort.direction : 1 }; this.render();
      }));
      if (typeof this.options.editPeak === "function") this.element.querySelectorAll("[data-peak-column]").forEach(cell => {
        cell.addEventListener("dblclick", () => { cell.contentEditable = "true"; cell.focus(); });
        cell.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); cell.blur(); } });
        cell.addEventListener("blur", async () => {
          if (cell.contentEditable !== "true") return;
          cell.contentEditable = "false";
          const row = cell.parentElement, side = row.dataset.side, peakIndex = Number(row.dataset.peak);
          await this.options.editPeak({ side, peakIndex, column: cell.dataset.peakColumn, value: cell.textContent,
            spectrum: side === "single" ? this.controller.getActiveSpectrum() : this.controller.getActiveSpectrum(side) });
          this.render();
        });
      });
      this.listen("spectrumchange", () => this.render()); this.listen("peakchange", () => this.render());
      this.listen("columnvisibilitychange", e => { if (e.detail.component === "peaks") this.render(); });
    }
  }

  class SimilarityViewer extends Component {
    constructor(options = {}) { super(options); this.data = options.data || null; }
    setData(data) { this.data = data; if (this.element) this.render(); return this; }
    render() {
      if (!this.element) return;
      const data = this.data;
      if (!data) { this.element.innerHTML = '<div class="msv-empty">No similarity results</div>'; return; }
      this.element.innerHTML = `<section class="msv-similarity"><div class="msv-stats">${Object.entries(data.statistics || {}).map(([k,v]) => `<span>${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong></span>`).join("")}</div><div class="msv-scroll"><table><thead><tr>${(data.columns || []).map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${(data.rows || []).map(row => `<tr>${data.columns.map(c => `<td>${escapeHtml(row[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
    }
  }

  class StructureViewer extends Component {
    constructor(options = {}) { super(options); this.structure = options.structure || null; }
    setStructure(value) { this.structure = value; if (this.element) this.render(); return this; }
    render() {
      if (!this.element) return;
      const spectrum = this.controller.getActiveSpectrum() || {};
      const value = this.structure || spectrum.structure || spectrum.row?.SMILES || spectrum.row?.smiles;
      if (typeof this.options.renderStructure === "function" && value) {
        Promise.resolve(this.options.renderStructure(value, spectrum)).then(result => { if (this.element) this._show(result); });
      } else this._show(value);
      this.listen("spectrumchange", () => this.render());
    }
    _show(value) {
      if (!value) this.element.innerHTML = '<div class="msv-empty">No structure available</div>';
      else if (/^(data:|blob:|https?:)/.test(String(value))) this.element.innerHTML = `<img class="msv-structure" alt="Molecular structure" src="${escapeHtml(value)}">`;
      else if (String(value).trim().startsWith("<svg")) this.element.innerHTML = String(value);
      else this.element.innerHTML = `<code class="msv-structure-text">${escapeHtml(value)}</code>`;
    }
  }

  class MessageBridge {
    constructor(controller, options = {}) {
      this.controller = controller; this.target = options.target || (typeof window !== "undefined" ? window : null);
      this.source = options.source || this.target; this.origin = options.origin || "*";
      this._onMessage = event => this.receive(event.data);
      this.source?.addEventListener?.("message", this._onMessage);
    }
    receive(message) {
      if (message?.type === "spectrum") this.controller.setActiveSpectrum(message.payload, "single");
      else if (message?.type === "spectrum-comparison") this.controller.setComparison(message.top, message.bottom);
      else if (message?.type === "dataset-page" || message?.type === "page") this.controller.setActiveDataset(message.payload || message);
      else if (message?.type === "select-peak") message.peak ? this.controller.selectPeak(message.peak, message.peak.side) : this.controller.clearPeakSelection();
      else if (message?.type === "column-visibility") this.controller.setColumnVisibility(message.component, message, message.scope);
    }
    post(message) { this.target?.postMessage?.(message, this.origin); }
    destroy() { this.source?.removeEventListener?.("message", this._onMessage); }
  }

  class DefaultViewer extends Component {
    constructor(options = {}) { super(options); this.components = []; }
    mount(target) {
      super.mount(target); return this;
    }
    render() {
      if (!this.element) return;
      this.element.innerHTML = '<div class="msv-default"><div data-msv="dataset"></div><div class="msv-spectrum-grid"><div data-msv="plot"></div><div data-msv="peaks"></div></div><div data-msv="similarity"></div></div>';
      this.components = [
        new DatasetTable({ controller: this.controller, data: this.options.dataset }).mount(this.element.querySelector('[data-msv="dataset"]')),
        new SpectrumPlot({ controller: this.controller }).mount(this.element.querySelector('[data-msv="plot"]')),
        new PeaksTable({ controller: this.controller }).mount(this.element.querySelector('[data-msv="peaks"]')),
        new SimilarityViewer({ controller: this.controller, data: this.options.similarity }).mount(this.element.querySelector('[data-msv="similarity"]')),
      ];
    }
    unmount() { for (const component of this.components || []) component.destroy(); this.components = []; return super.unmount(); }
  }

  return { ViewerController, DatasetTable, SpectrumPlot, PeaksTable, SimilarityViewer,
    StructureViewer, MessageBridge, DefaultViewer, normalizePeak, version: "1.0.0" };
});
