"use strict";
// host/similarity.js: default similarity parameters and their validation; the
// VS Code settings must offer the same defaults.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { SIMILARITY_DEFAULTS, similaritySettings, COMPARISON_DEFAULTS, comparisonSettings } = require("../../host");

test("defaults, overrides, and validation", () => {
  assert.deepEqual(similaritySettings(), SIMILARITY_DEFAULTS);
  assert.equal(SIMILARITY_DEFAULTS.mz_tolerance_da, 0.01);
  const ppm = similaritySettings({ mz_tolerance_da: 0, mz_tolerance_ppm: 10, method: "reverse_cosine", threads: undefined });
  assert.equal(ppm.mz_tolerance_da, 0);
  assert.equal(ppm.mz_tolerance_ppm, 10);
  assert.equal(ppm.method, "reverse_cosine");
  assert.equal(ppm.threads, 0);
  assert.throws(() => similaritySettings({ mz_tolerance_da: 0 }), /must not both be 0/);
  assert.throws(() => similaritySettings({ mz_tolerance_ppm: -1 }), /mz_tolerance_ppm must be a number >= 0/);
  assert.throws(() => similaritySettings({ threshold: 1.5 }), /threshold/);
  assert.throws(() => similaritySettings({ intensity_exponent: 0 }), /intensity_exponent/);
  assert.throws(() => similaritySettings({ threads: 1.5 }), /threads/);
  assert.throws(() => similaritySettings({ method: "dot" }), /method/);
  assert.throws(() => similaritySettings({ include_matched_data: "yes" }), /include_matched_data/);
  assert.throws(() => similaritySettings({ bin_width: 0.01 }), /Unknown similarity setting: bin_width/);
});

test("VS Code setting defaults equal SIMILARITY_DEFAULTS", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vscode/package.json"), "utf8"));
  const properties = manifest.contributes.configuration.properties;
  const settings = {
    method: "method", threshold: "threshold", mz_tolerance_da: "mzToleranceDa",
    mz_tolerance_ppm: "mzTolerancePpm", intensity_exponent: "intensityExponent",
    include_matched_data: "includeMatchedData", threads: "threads",
  };
  assert.deepEqual(Object.keys(settings).sort(), Object.keys(SIMILARITY_DEFAULTS).sort());
  for (const [name, setting] of Object.entries(settings)) {
    assert.equal(properties[`msentitySpectrumViewer.similarity.${setting}`]?.default, SIMILARITY_DEFAULTS[name], setting);
  }
});

test("spectrum comparison defaults", () => {
  assert.deepEqual(comparisonSettings(), COMPARISON_DEFAULTS);
  assert.deepEqual(comparisonSettings({ method: "bonanza", tolerance_da: 0.02 }), { method: "bonanza", tolerance_da: 0.02 });
  assert.throws(() => comparisonSettings({ tolerance_da: 0 }), /tolerance_da/);
  assert.throws(() => comparisonSettings({ tolerance_da: 11 }), /tolerance_da/);
  assert.throws(() => comparisonSettings({ method: "cosine" }), /method/);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../vscode/package.json"), "utf8"));
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties["msentitySpectrumViewer.spectrumComparison.method"].default, COMPARISON_DEFAULTS.method);
  assert.equal(properties["msentitySpectrumViewer.spectrumComparison.toleranceDa"].default, COMPARISON_DEFAULTS.tolerance_da);
});
