const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "../../ui/viewer.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../../ui/viewer.css"), "utf8");

test("dataset table keeps horizontal scroll across page renders", () => {
  assert.match(script, /const tableViews = new Map\(\)/);
  assert.match(script, /const view = tableView\(wrap\.dataset\.datasetId\)/);
  assert.match(script, /view\.scrollLeft = wrap\.scrollLeft/);
  assert.match(script, /const savedView = tableView\(datasetId\)/);
  assert.match(script, /const scrollLeft = savedView\.scrollLeft/);
  assert.match(script, /wrap\.scrollLeft = scrollLeft/);
  assert.match(script, /windowScrollX/);
  assert.match(script, /window\.scrollTo\(windowScrollX/);
  assert.match(script, /data-dataset-id="\$\{esc\(activeDatasetId\)\}"/);
  assert.match(script, /requestAnimationFrame\(\(\) =>/);
  assert.match(script, /classList\.add\("restoring-scroll"\)/);
  assert.match(script, /classList\.remove\("restoring-scroll"\)/);
  assert.match(styles, /\.table-wrap\.restoring-scroll[^}]*visibility: hidden/);
  assert.match(styles, /\.table-wrap[^}]*min-width: 0/);
  assert.match(styles, /\.viewer[^}]*overflow: hidden/);
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

test("fixed columns render with a fixed total table width without an automatic-layout frame", () => {
  assert.match(script, /const tableWidthStyle =/);
  assert.match(script, /style="width:\$\{width\}px;min-width:\$\{width\}px"/);
  assert.match(script, /fixTableWidth\(table, currentWidths/);
  assert.doesNotMatch(styles, /\.dataset-table\.has-custom-widths[^}]*max-content/);
});

test("resizing a column preserves the current horizontal scroll position", () => {
  assert.match(script, /const preservedScrollLeft = wrap\?\.scrollLeft \|\| 0/);
  assert.match(script, /function|const preserveScroll =/);
  assert.match(script, /wrap\.scrollLeft = preservedScrollLeft/);
  assert.match(script, /tableView\(wrap\.dataset\.datasetId\)\.scrollLeft = preservedScrollLeft/);
  const resizeStart = script.indexOf('document.querySelectorAll(".column-resize-handle")');
  const resizeEnd = script.indexOf("const moreButton", resizeStart);
  assert.doesNotMatch(script.slice(resizeStart, resizeEnd), /\brender\(\)/);
});

test("pointer actions capture and restore horizontal position around rerenders", () => {
  assert.match(script, /let pointerTableView = null/);
  assert.match(script, /function beginPointerInteraction\(\)/);
  assert.match(script, /addEventListener\("pointerdown", beginPointerInteraction, true\)/);
  assert.match(script, /pointerTableView\?\.datasetId === wrap\.dataset\.datasetId/);
  assert.match(script, /document\.addEventListener\("click"[\s\S]*restoreTableView\(\)/);
  assert.match(script, /restoreTableView\(\);[\s\S]{0,240}pointerTableView = null/);
  const pointerStart = script.indexOf("function beginPointerInteraction()");
  const pointerEnd = script.indexOf("function restoreTableView", pointerStart);
  assert.doesNotMatch(script.slice(pointerStart, pointerEnd), /setTimeout/);
});

test("page navigation keeps the current fixed table visible until new data arrives", () => {
  const requestStart = script.indexOf("function requestPage(requested)");
  const requestEnd = script.indexOf("function toggleColumn", requestStart);
  const requestPage = script.slice(requestStart, requestEnd);
  assert.doesNotMatch(requestPage, /\brender\(\)/);
  assert.match(requestPage, /classList\.add\("page-loading"\)/);
  assert.match(requestPage, /vscode\.postMessage\(viewRequest\(target\)\)/);
  assert.match(styles, /\.table-wrap\.page-loading/);
});

test("toolbar and pagination stay visible while only the table area scrolls", () => {
  assert.match(styles, /html, body[^}]*overflow: hidden/);
  assert.match(styles, /#app[^}]*height: 100vh[^}]*overflow: hidden/);
  assert.match(styles, /\.viewer[^}]*height: 100vh[^}]*flex-direction: column[^}]*overflow: hidden/);
  assert.match(styles, /\.toolbar[^}]*flex: 0 0 auto/);
  assert.match(styles, /\.table-wrap[^}]*flex: 1 1 0[^}]*min-height: 0[^}]*overflow: auto/);
  assert.match(styles, /\.pagination[^}]*flex: 0 0 auto/);
});
