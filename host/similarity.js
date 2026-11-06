"use strict";

// Default settings of a similarity calculation (the backend request
// calculate-similarity). Every host starts from SIMILARITY_DEFAULTS and may
// override any of them from its own settings; the VS Code extension reads
// msentitySpectrumViewer.similarity.*.

const SIMILARITY_DEFAULTS = Object.freeze({
  method: "cosine",            // "cosine" or "reverse_cosine"
  threshold: 0.8,              // library search: lowest score kept, 0–1
  mz_tolerance: "0.01Da,10ppm", // peaks match within either term (see parseMzTolerance)
  intensity_exponent: 1,       // intensities are raised to this power (> 0)
  include_matched_data: true,  // library search: store the matched spectra in the result
  threads: 1,                  // worker threads, an integer >= 1
});

const METHODS = ["cosine", "reverse_cosine"];

const MZ_TOLERANCE_TERM = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(da|ppm)\s*$/i;

/**
 * Reads an m/z tolerance as msentity-similarity's parse_mz_tolerance does:
 * "<value>Da" and/or "<value>ppm" joined by a comma, in either order, units
 * case-insensitive ("0.01Da,10ppm", "10ppm", "10 PPM, 0.01da"). A unit left
 * out is 0 (off). Throws an Error when the text is invalid.
 * @param {string} text
 * @returns {{da: number, ppm: number}}
 */
function parseMzTolerance(text) {
  const invalid = () => new Error(`m/z tolerance must look like 0.01Da, 10ppm, or 0.01Da,10ppm, got ${JSON.stringify(text)}`);
  if (typeof text !== "string") throw invalid();
  const values = {};
  for (const term of text.split(",")) {
    const match = MZ_TOLERANCE_TERM.exec(term);
    const unit = match?.[2].toLowerCase();
    if (!match || unit in values) throw invalid();
    values[unit] = Number(match[1]);
  }
  const tolerance = { da: values.da ?? 0, ppm: values.ppm ?? 0 };
  if (![tolerance.da, tolerance.ppm].every((v) => Number.isFinite(v) && v >= 0)) throw invalid();
  if (tolerance.da === 0 && tolerance.ppm === 0) throw new Error("m/z tolerance needs a positive Da or ppm value");
  return tolerance;
}

/**
 * Canonical text of an m/z tolerance, e.g. "0.01Da,10ppm" (a zero term is left out).
 * @param {{da: number, ppm: number}} tolerance
 * @returns {string}
 */
function formatMzTolerance({ da, ppm }) {
  return [da > 0 ? `${da}Da` : "", ppm > 0 ? `${ppm}ppm` : ""].filter(Boolean).join(",");
}

/**
 * SIMILARITY_DEFAULTS with `overrides` applied (keys as in SIMILARITY_DEFAULTS;
 * undefined values keep the default). Throws an Error naming the first invalid
 * setting.
 * @param {Partial<typeof SIMILARITY_DEFAULTS>} [overrides]
 * @returns {typeof SIMILARITY_DEFAULTS}
 */
function similaritySettings(overrides = {}) {
  const settings = { ...SIMILARITY_DEFAULTS };
  for (const [name, value] of Object.entries(overrides || {})) {
    if (!(name in SIMILARITY_DEFAULTS)) throw new Error(`Unknown similarity setting: ${name}`);
    if (value !== undefined && value !== null) settings[name] = value;
  }
  const number = (name, valid, rule) => {
    const value = settings[name];
    if (typeof value !== "number" || !Number.isFinite(value) || !valid(value)) {
      throw new Error(`Similarity setting ${name} must be ${rule}, got ${JSON.stringify(value)}`);
    }
  };
  if (!METHODS.includes(settings.method)) {
    throw new Error(`Similarity setting method must be one of ${METHODS.join(", ")}, got ${JSON.stringify(settings.method)}`);
  }
  number("threshold", (v) => v >= 0 && v <= 1, "a number from 0 to 1");
  try {
    settings.mz_tolerance = formatMzTolerance(parseMzTolerance(settings.mz_tolerance));
  } catch (error) {
    throw new Error(`Similarity setting ${error.message}`);
  }
  number("intensity_exponent", (v) => v > 0, "a number > 0");
  number("threads", (v) => Number.isSafeInteger(v) && v >= 1, "an integer >= 1");
  if (typeof settings.include_matched_data !== "boolean") {
    throw new Error("Similarity setting include_matched_data must be true or false");
  }
  return Object.freeze(settings);
}

// Defaults of the score shown when two spectra are compared in the spectrum
// view (ui/spectrum.js, message comparison-settings). This score is computed in
// the UI and matches peaks within a tolerance in Da or in ppm; intensities are
// raised to intensity_exponent first, as in the similarity calculation.
const COMPARISON_DEFAULTS = Object.freeze({
  method: "dot",               // "dot", "reverse", "modified", or "bonanza"
  tolerance_unit: "Da or ppm", // initial unit: "Da", "ppm", or "Da or ppm" (within either tolerance)
  tolerance_da: 0.01,          // peaks match within ± this many Da, > 0 and <= 10
  tolerance_ppm: 10,           // peaks match within ± this many ppm of their mean m/z, > 0 and <= 1000
  intensity_exponent: 1,       // intensities are raised to this power before scoring, > 0
  precursor_column: "",        // metadata column of the precursor m/z; "" tries PrecursorMZ, precursor_mz, PEPMASS, ParentMZ
});

const COMPARISON_METHODS = ["dot", "reverse", "modified", "bonanza"];
const COMPARISON_TOLERANCE_UNITS = ["Da", "ppm", "Da or ppm"];

/**
 * COMPARISON_DEFAULTS with `overrides` applied, validated like similaritySettings.
 * @param {Partial<typeof COMPARISON_DEFAULTS>} [overrides]
 * @returns {typeof COMPARISON_DEFAULTS}
 */
function comparisonSettings(overrides = {}) {
  const settings = { ...COMPARISON_DEFAULTS };
  for (const [name, value] of Object.entries(overrides || {})) {
    if (!(name in COMPARISON_DEFAULTS)) throw new Error(`Unknown comparison setting: ${name}`);
    if (value !== undefined && value !== null) settings[name] = value;
  }
  if (!COMPARISON_METHODS.includes(settings.method)) {
    throw new Error(`Comparison setting method must be one of ${COMPARISON_METHODS.join(", ")}, got ${JSON.stringify(settings.method)}`);
  }
  if (!COMPARISON_TOLERANCE_UNITS.includes(settings.tolerance_unit)) {
    throw new Error(`Comparison setting tolerance_unit must be one of ${COMPARISON_TOLERANCE_UNITS.join(", ")}, got ${JSON.stringify(settings.tolerance_unit)}`);
  }
  if (typeof settings.precursor_column !== "string") {
    throw new Error(`Comparison setting precursor_column must be a column name, or empty to detect it, got ${JSON.stringify(settings.precursor_column)}`);
  }
  settings.precursor_column = settings.precursor_column.trim();
  for (const [name, maximum] of [["tolerance_da", 10], ["tolerance_ppm", 1000]]) {
    const tolerance = settings[name];
    if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance > maximum) {
      throw new Error(`Comparison setting ${name} must be a number > 0 and <= ${maximum}, got ${JSON.stringify(tolerance)}`);
    }
  }
  const exponent = settings.intensity_exponent;
  if (typeof exponent !== "number" || !Number.isFinite(exponent) || exponent <= 0) {
    throw new Error(`Comparison setting intensity_exponent must be a number > 0, got ${JSON.stringify(exponent)}`);
  }
  return Object.freeze(settings);
}

module.exports = {
  SIMILARITY_DEFAULTS, similaritySettings, parseMzTolerance, formatMzTolerance,
  COMPARISON_DEFAULTS, comparisonSettings,
};
