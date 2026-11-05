"use strict";
// host/similarity.js: default similarity parameters and their validation; the
// VS Code settings must offer the same defaults.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const {
  SIMILARITY_DEFAULTS, similaritySettings, parseMzTolerance, formatMzTolerance, COMPARISON_DEFAULTS, comparisonSettings,
} = require("../../host");

test("defaults, overrides, and validation", () => {
  assert.deepEqual(similaritySettings(), SIMILARITY_DEFAULTS);
  assert.equal(SIMILARITY_DEFAULTS.mz_tolerance, "0.01Da,10ppm");
  const ppm = similaritySettings({ mz_tolerance: " 10 PPM ", method: "reverse_cosine", threads: undefined });
  assert.equal(ppm.mz_tolerance, "10ppm");   // canonical text
  assert.equal(ppm.method, "reverse_cosine");
  assert.equal(ppm.threads, 1);
  assert.throws(() => similaritySettings({ threads: 0 }), /threads must be an integer >= 1/);
  assert.equal(similaritySettings({ mz_tolerance: "10ppm,0.01da" }).mz_tolerance, "0.01Da,10ppm");
  assert.throws(() => similaritySettings({ mz_tolerance: "0Da,0ppm" }), /positive/);
  assert.throws(() => similaritySettings({ mz_tolerance: 0.01 }), /Similarity setting m\/z tolerance must look like/);
  assert.throws(() => similaritySettings({ mz_tolerance_da: 0.01 }), /Unknown similarity setting: mz_tolerance_da/);
  assert.throws(() => similaritySettings({ threshold: 1.5 }), /threshold/);
  assert.throws(() => similaritySettings({ intensity_exponent: 0 }), /intensity_exponent/);
  assert.throws(() => similaritySettings({ threads: 1.5 }), /threads/);
  assert.throws(() => similaritySettings({ method: "dot" }), /method/);
  assert.throws(() => similaritySettings({ include_matched_data: "yes" }), /include_matched_data/);
});

test("VS Code setting defaults equal SIMILARITY_DEFAULTS", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vscode/package.json"), "utf8"));
  const properties = manifest.contributes.configuration.properties;
  const settings = {
    method: "method", threshold: "threshold",
    intensity_exponent: "intensityExponent",
    include_matched_data: "includeMatchedData", threads: "threads",
  };
  // The m/z tolerance is msentitySpectrumViewer.spectrumComparison.tolerance*, shared with the comparison view.
  assert.deepEqual(Object.keys(settings).sort(), Object.keys(SIMILARITY_DEFAULTS).filter((name) => name !== "mz_tolerance").sort());
  assert.equal(properties["msentitySpectrumViewer.similarity.mzTolerance"], undefined);
  assert.equal(formatMzTolerance({ da: COMPARISON_DEFAULTS.tolerance_da, ppm: COMPARISON_DEFAULTS.tolerance_ppm }),
    SIMILARITY_DEFAULTS.mz_tolerance);
  assert.equal(COMPARISON_DEFAULTS.tolerance_unit, "Da or ppm");
  // The comparison view's intensity exponent is msentitySpectrumViewer.similarity.intensityExponent.
  assert.equal(COMPARISON_DEFAULTS.intensity_exponent, SIMILARITY_DEFAULTS.intensity_exponent);
  for (const [name, setting] of Object.entries(settings)) {
    assert.equal(properties[`msentitySpectrumViewer.similarity.${setting}`]?.default, SIMILARITY_DEFAULTS[name], setting);
  }
});

test("m/z tolerance text", () => {
  assert.deepEqual(parseMzTolerance("0.01Da,10ppm"), { da: 0.01, ppm: 10 });
  assert.deepEqual(parseMzTolerance(" 10 PPM , 0.01da "), { da: 0.01, ppm: 10 });
  assert.deepEqual(parseMzTolerance("10ppm"), { da: 0, ppm: 10 });
  assert.deepEqual(parseMzTolerance("5e-3Da"), { da: 0.005, ppm: 0 });
  for (const bad of ["", "0.01", "Da", "0.01Da,", "0.01Da,0.02Da", "-1Da", "0Da", "10mDa", "0.01 Da 10ppm",
    "InfinityDa", "1e400Da", "0x10Da", "0,01Da", null]) {
    assert.throws(() => parseMzTolerance(bad), /m\/z tolerance/, String(bad));
  }
  assert.equal(formatMzTolerance({ da: 0.01, ppm: 10 }), "0.01Da,10ppm");
  assert.equal(formatMzTolerance({ da: 0, ppm: 10 }), "10ppm");
  assert.equal(formatMzTolerance({ da: 0.01, ppm: 0 }), "0.01Da");
});

test("spectrum comparison defaults", () => {
  assert.deepEqual(comparisonSettings(), COMPARISON_DEFAULTS);
  assert.deepEqual(comparisonSettings({ method: "bonanza", tolerance_da: 0.02 }),
    { method: "bonanza", tolerance_unit: "Da or ppm", tolerance_da: 0.02, tolerance_ppm: 10, intensity_exponent: 1, precursor_column: "" });
  assert.equal(comparisonSettings({ intensity_exponent: 0.5 }).intensity_exponent, 0.5);
  assert.throws(() => comparisonSettings({ intensity_exponent: 0 }), /intensity_exponent/);
  assert.throws(() => comparisonSettings({ intensity_exponent: "1" }), /intensity_exponent/);
  assert.equal(comparisonSettings({ precursor_column: " PEPMASS " }).precursor_column, "PEPMASS");
  assert.equal(comparisonSettings({ precursor_column: "Auto" }).precursor_column, "Auto");   // a column named Auto
  assert.equal(comparisonSettings({ precursor_column: " " }).precursor_column, "");
  assert.throws(() => comparisonSettings({ precursor_column: 1 }), /precursor_column/);
  assert.equal(comparisonSettings({ tolerance_unit: "Da" }).tolerance_unit, "Da");
  assert.equal(comparisonSettings({ tolerance_unit: "ppm", tolerance_ppm: 20 }).tolerance_ppm, 20);
  assert.throws(() => comparisonSettings({ tolerance_da: 0 }), /tolerance_da/);
  assert.throws(() => comparisonSettings({ tolerance_da: 11 }), /tolerance_da/);
  assert.throws(() => comparisonSettings({ tolerance_ppm: 0 }), /tolerance_ppm/);
  assert.throws(() => comparisonSettings({ tolerance_ppm: 1001 }), /tolerance_ppm/);
  assert.throws(() => comparisonSettings({ tolerance_unit: "mDa" }), /tolerance_unit/);
  assert.throws(() => comparisonSettings({ method: "cosine" }), /method/);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vscode/package.json"), "utf8"));
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties["msentitySpectrumViewer.spectrumComparison.method"].default, COMPARISON_DEFAULTS.method);
  assert.equal(properties["msentitySpectrumViewer.spectrumComparison.toleranceUnit"].default, COMPARISON_DEFAULTS.tolerance_unit);
  assert.equal(properties["msentitySpectrumViewer.spectrumComparison.toleranceDa"].default, COMPARISON_DEFAULTS.tolerance_da);
  assert.equal(properties["msentitySpectrumViewer.spectrumComparison.tolerancePpm"].default, COMPARISON_DEFAULTS.tolerance_ppm);
  assert.equal(properties["msentitySpectrumViewer.spectrumComparison.precursorColumn"].default, COMPARISON_DEFAULTS.precursor_column);
});
