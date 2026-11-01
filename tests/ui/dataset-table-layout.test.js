const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "../../ui/viewer.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../../ui/viewer.css"), "utf8");

test("dataset table keeps horizontal scroll across page renders", () => {
  assert.match(script, /const tableViews = new Map\(\)/);
  assert.match(script, /tableView\(wrap\.dataset\.datasetId\)\.scrollLeft = wrap\.scrollLeft/);
  assert.match(script, /wrap\.scrollLeft = tableView\(wrap\.dataset\.datasetId\)\.scrollLeft/);
  assert.match(script, /data-dataset-id="\$\{esc\(activeDatasetId\)\}"/);
});

test("column widths are resizable, retained per dataset, and cleared by reload", () => {
  assert.match(script, /const columnWidths = new Map\(\)/);
  assert.match(script, /data-resize-column/);
  assert.match(script, /Math\.max\(48, Math\.round\(startWidth/);
  assert.match(script, /reload-button[\s\S]{0,180}columnWidths\.delete\(activeDatasetId\)/);
  assert.match(script, /dataset-reloaded[\s\S]{0,220}columnWidths\.delete\(String\(message\.dataset_id/);
  assert.match(styles, /\.column-resize-handle[^}]*cursor: col-resize/);
});

test("automatic widths are frozen after the first loaded page", () => {
  assert.match(script, /function freezeAutomaticColumnWidths\(\)/);
  assert.match(script, /getBoundingClientRect\(\)\.width/);
  assert.match(script, /restoreTableView\(\);\s*freezeAutomaticColumnWidths\(\)/);
  assert.match(script, /resettingColumnWidths\.add\(activeDatasetId\)/);
  assert.match(script, /dataset-page[\s\S]{0,240}resettingColumnWidths\.delete\(activeDatasetId\)/);
});
