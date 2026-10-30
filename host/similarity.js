"use strict";

// Default settings of a similarity calculation (the backend request
// calculate-similarity). Every host starts from SIMILARITY_DEFAULTS and may
// override any of them from its own settings; the VS Code extension reads
// msentitySpectrumViewer.similarity.*.

const SIMILARITY_DEFAULTS = Object.freeze({
  method: "cosine",            // "cosine" or "reverse_cosine"
  threshold: 0.8,              // library search: lowest score kept, 0–1
  mz_tolerance_da: 0.01,       // peaks match within this many Da (0 = off) ...
  mz_tolerance_ppm: 0,         // ... or within this many ppm (0 = off)
  intensity_exponent: 1,       // intensities are raised to this power (> 0)
  include_matched_data: true,  // library search: store the matched spectra in the result
  threads: 0,                  // 0 = all hardware threads
});

const METHODS = ["cosine", "reverse_cosine"];

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
  number("mz_tolerance_da", (v) => v >= 0, "a number >= 0");
  number("mz_tolerance_ppm", (v) => v >= 0, "a number >= 0");
  if (settings.mz_tolerance_da === 0 && settings.mz_tolerance_ppm === 0) {
    throw new Error("Similarity settings mz_tolerance_da and mz_tolerance_ppm must not both be 0");
  }
  number("intensity_exponent", (v) => v > 0, "a number > 0");
  number("threads", (v) => Number.isSafeInteger(v) && v >= 0, "an integer >= 0");
  if (typeof settings.include_matched_data !== "boolean") {
    throw new Error("Similarity setting include_matched_data must be true or false");
  }
  return Object.freeze(settings);
}

// Defaults of the score shown when two spectra are compared in the spectrum
// view (ui/spectrum.js, message comparison-settings). This score is computed in
// the UI and matches peaks within a Da tolerance only.
const COMPARISON_DEFAULTS = Object.freeze({
  method: "dot",               // "dot", "reverse", "modified", or "bonanza"
  tolerance_da: 0.05,          // peaks match within ± this many Da, > 0 and <= 10
});

const COMPARISON_METHODS = ["dot", "reverse", "modified", "bonanza"];

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
  const tolerance = settings.tolerance_da;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 10) {
    throw new Error(`Comparison setting tolerance_da must be a number > 0 and <= 10, got ${JSON.stringify(tolerance)}`);
  }
  return Object.freeze(settings);
}

module.exports = { SIMILARITY_DEFAULTS, similaritySettings, COMPARISON_DEFAULTS, comparisonSettings };
