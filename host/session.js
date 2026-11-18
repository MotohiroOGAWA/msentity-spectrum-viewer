"use strict";

// Connects a dataset viewer UI to its backend and the optional chemistry
// features (chemistry/index.js).
//
// Requests from the UI go to `session.request(request)`; messages for the UI
// arrive through `onMessage`. Requests are processed in order. The session
// answers the chemistry requests itself:
//   * filters with operator "smarts" are resolved to {operator: "row_ids"}
//     before page, reload, export, and structure-count requests;
//   * render-structure and calculate-structure-counts use RDKit;
//   * a "capabilities" message follows "backend-ready".

const { NO_CHEMISTRY } = require("./chemistry");

const MAX_SMARTS_RESULTS = 16;

const containsSmarts = node => Array.isArray(node)
  ? node.some(containsSmarts)
  : Boolean(node && ((node.operator === "smarts" && node.value != null && String(node.value) !== "") ||
    (Array.isArray(node.children) && node.children.some(containsSmarts))));

const RESOLVED_TYPES = new Set(["page", "reload", "export", "calculate-structure-counts"]);

class DatasetSession {
  /**
   * @param {import("./backend").BackendProcess} backend  started or not yet started
   * @param {{capabilities: Promise<object>, call: Function} | null} chemistry  e.g. an RdkitChemistry
   * @param {(message: object) => void} onMessage  messages for the UI
   */
  constructor(backend, chemistry, onMessage) {
    this.backend = backend;
    this.chemistry = chemistry;
    this.onMessage = onMessage;
    this.queue = Promise.resolve();
    this.smartsResults = new Map();
    this.initialDatasetId = "";
    this.supportsDeferredReload = false;
    backend.on("message", (message) => {
      if (message.type === "backend-ready") {
        this.smartsResults.clear();
        this.initialDatasetId = message.dataset?.id || message.file || "";
        this.supportsDeferredReload = message.defer_reload_page === true;
      }
      onMessage(message);
      if (message.type === "backend-ready") {
        this.capabilities().then((chemistry) => onMessage({ type: "capabilities", chemistry }));
      }
    });
  }

  capabilities() {
    return this.chemistry ? this.chemistry.capabilities : Promise.resolve(NO_CHEMISTRY);
  }

  /** Handle one request from the UI (backend requests, see docs/protocol.md). */
  request(request) {
    this.queue = this.queue
      .then(() => this.process(request))
      .catch((error) => this.onMessage({ type: "error", title: "Viewer error", message: error.message || String(error) }));
    return this.queue;
  }

  async process(request) {
    if (request.type === "render-structure") return this.renderStructure(request);
    const datasetId = request.dataset_id || this.initialDatasetId;
    // Invalidate before submitting a mutation, including when the next request
    // arrives before the backend has acknowledged the change.
    if (["reload", "remove-dataset"].includes(request.type)) {
      this.invalidateSmarts(datasetId);
    } else if (["update-cell", "add-column", "assign-spec-id"].includes(request.type)) {
      this.invalidateSmarts(datasetId, request.type === "assign-spec-id" ? "SpecID" : request.column);
    }
    if (!RESOLVED_TYPES.has(request.type)) {
      this.backend.send(request);
      return;
    }
    const reloadWithSmarts = request.type === "reload" && containsSmarts(request.filters);
    if (reloadWithSmarts && this.supportsDeferredReload) {
      const { request_id, ...reply } = await this.backend.request({ ...request, defer_page: true });
      this.onMessage(reply);
      if (reply.type !== "dataset-reloaded") return;
      request = { ...request, type: "page", page: 0 };
    }
    let filters;
    try {
      filters = await this.resolveFilters(datasetId, request.filters);
    } catch (error) {
      const message = error.message || String(error);
      if (request.type === "export") this.onMessage({ type: "export-error", message });
      else if (request.type === "calculate-structure-counts") {
        this.onMessage({ type: "structure-counts-error", dataset_id: request.dataset_id, message });
      } else this.onMessage({ type: "filter-error", operator: "smarts", message });
      return;
    }
    if (request.type === "calculate-structure-counts") return this.structureCounts(request, filters);
    // Older backends reload and page in one request. Do not retain matches
    // computed against the pre-reload dataset.
    if (request.type === "reload") this.invalidateSmarts(datasetId);
    this.backend.send({ ...request, filters });
  }

  /** Replace SMARTS conditions with the row ids of the matching spectra. */
  async resolveFilters(datasetId, filters) {
    if (!containsSmarts(filters)) return filters;
    const capabilities = await this.capabilities();
    const resolve = async condition => {
      if (condition && Array.isArray(condition.children)) {
        return { ...condition, children: (await Promise.all(condition.children.map(resolve))).filter(Boolean) };
      }
      if (!condition || condition.operator !== "smarts" || condition.value == null || String(condition.value) === "") return condition;
      if (!capabilities.smarts_filter) throw new Error("SMARTS filtering requires optional RDKit support");
      return this.matchSmarts(datasetId, condition.column, String(condition.value));
    };
    if (Array.isArray(filters)) return (await Promise.all(filters.map(resolve))).filter(Boolean);
    return filters && typeof filters === "object" ? resolve(filters) : filters;
  }

  invalidateSmarts(datasetId, column) {
    for (const [key, entry] of this.smartsResults) {
      if (entry.datasetId === datasetId && (column == null || entry.column === column)) {
        this.smartsResults.delete(key);
      }
    }
  }

  async matchSmarts(datasetId, column, pattern) {
    const key = JSON.stringify([datasetId, column, pattern]);
    const existing = this.smartsResults.get(key);
    if (existing) {
      this.smartsResults.delete(key);
      this.smartsResults.set(key, existing);
      return existing.result;
    }

    const result = (async () => {
      const reply = await this.backend.request({ type: "column-values", dataset_id: datasetId, column });
      if (reply.error) return null; // unknown column: ignored for legacy compatibility
      const matches = await this.chemistry.call("smarts-match", { values: reply.values, pattern });
      return { operator: "row_ids", row_ids: reply.row_ids.filter((_, i) => matches[i]) };
    })();
    const entry = { datasetId, column, result };
    this.smartsResults.set(key, entry);
    if (this.smartsResults.size > MAX_SMARTS_RESULTS) {
      this.smartsResults.delete(this.smartsResults.keys().next().value);
    }

    let match;
    try {
      match = await result;
      return match;
    } finally {
      // Failed lookups can be retried on the next request.
      if (!match && this.smartsResults.get(key) === entry) {
        this.smartsResults.delete(key);
      }
    }
  }

  async structureCounts(request, filters) {
    const fail = (message) => this.onMessage({
      type: "structure-counts-error", dataset_id: request.dataset_id, message,
    });
    const capabilities = await this.capabilities();
    if (!capabilities.structure_count) return fail("Structure counting requires optional RDKit support");
    const reply = await this.backend.request({
      type: "column-values", dataset_id: request.dataset_id, filters, detect_smiles: true,
      structure_smiles_column: request.structure_smiles_column,
    });
    if (reply.error) return fail(reply.error);
    try {
      const values = reply.values.filter((value) => value != null);
      const counts = await this.chemistry.call("structure-counts", { values });
      this.onMessage({
        type: "structure-counts", dataset_id: request.dataset_id, total_rows: reply.total_rows,
        smiles_column: reply.column, ...counts,
      });
    } catch (error) {
      fail(error.message || String(error));
    }
  }

  async renderStructure(request) {
    try {
      const capabilities = await this.capabilities();
      if (!capabilities.structure_render) throw new Error("Structure rendering requires optional RDKit support");
      const { smiles, svg } = await this.chemistry.call("render", {
        smiles: request.smiles, width: request.width, height: request.height,
      });
      this.onMessage({ type: "structure-rendered", smiles, svg });
    } catch (error) {
      this.onMessage({ type: "chemistry-error", operation: "render-structure", message: error.message || String(error) });
    }
  }
}

module.exports = { DatasetSession };
