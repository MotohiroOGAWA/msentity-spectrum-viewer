"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

let chromium;
try { ({ chromium } = require("playwright")); } catch { /* optional in npm test */ }

const ROOT = path.resolve(__dirname, "../..");
const skip = !chromium;

async function openViewer() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  await page.setContent('<!doctype html><html><body><div id="app" data-filename="test.msds"></div></body></html>');
  await page.addStyleTag({ path: path.join(ROOT, "ui/viewer.css") });
  await page.addInitScript(() => {});
  await page.evaluate(() => {
    window.__trace = { messages: [], scrollTo: [], raf: 0, mutations: 0, appReplacements: 0, copied: [] };
    const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    Object.defineProperty(Element.prototype, "innerHTML", { configurable: true,
      get: innerHTML.get,
      set(value) { if (this.id === "app") window.__trace.appReplacements++; innerHTML.set.call(this, value); }
    });
    const originalScrollTo = window.scrollTo.bind(window);
    window.scrollTo = (...args) => { window.__trace.scrollTo.push(args); originalScrollTo(...args); };
    const originalRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => { window.__trace.raf++; return originalRaf(callback); };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async text => { window.__trace.copied.push(text); }
    }});
    const columns = Array.from({ length: 14 }, (_, i) => `Column_${String(i).padStart(2, "0")}`);
    const row = Object.fromEntries(columns.map((column, i) => [column, `${column}_value_${"x".repeat(22 + i)}`]));
    const value = { dataset_id: "dataset", page: 0, page_size: 20, total_rows: 1, total_pages: 1,
      row_offset: 0, all_columns: columns, columns, rows: [row], row_ids: [0], spectra: [{ mz: [], intensity: [] }] };
    window.msentityViewerHost = {
      postMessage(message) {
        window.__trace.messages.push(message);
        if (message.type === "webview-ready") setTimeout(() => window.postMessage({ type: "backend-ready", dataset: { id: "dataset", name: "dataset" } }, "*"));
        if (message.type === "ready" || message.type === "page-request") setTimeout(() => window.postMessage({ type: "dataset-page", value }, "*"));
        if (message.type === "edit-cell") setTimeout(() => window.postMessage({ type: "metadata-updated",
          dataset_id: message.datasetId, row_id: message.rowId, column: message.column, value: `${message.value}_edited` }, "*"));
      }
    };
    new MutationObserver(records => { window.__trace.mutations += records.length; })
      .observe(document.getElementById("app"), { childList: true, subtree: true });
  });
  await page.addScriptTag({ path: path.join(ROOT, "ui/viewer.js") });
  await page.waitForSelector('[data-edit-column="Column_13"]');
  await page.waitForTimeout(50);
  return { browser, page };
}

async function snapshot(page, targetSelector) {
  return page.evaluate(selector => {
    const wrap = document.querySelector(".table-wrap"), table = document.querySelector(".dataset-table");
    const tbody = table.tBodies[0], target = document.querySelector(selector);
    window.__tableRef ??= table; window.__tbodyRef ??= tbody;
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return {
      sameTable: window.__tableRef === table, sameTbody: window.__tbodyRef === tbody,
      scrollLeft: wrap.scrollLeft, windowX: window.scrollX, windowY: window.scrollY,
      tableRect: rect(table), cellRect: rect(target),
      widths: [...table.querySelectorAll("thead th")].map(th => th.getBoundingClientRect().width),
      active: document.activeElement?.outerHTML?.slice(0, 120), trace: JSON.parse(JSON.stringify(window.__trace)),
    };
  }, targetSelector);
}

function assertStable(before, after) {
  assert.equal(after.sameTable, true); assert.equal(after.sameTbody, true);
  assert.equal(after.scrollLeft, before.scrollLeft);
  assert.equal(after.windowX, before.windowX); assert.equal(after.windowY, before.windowY);
  assert.deepEqual(after.tableRect, before.tableRect);
  assert.deepEqual(after.cellRect, before.cellRect);
  assert.deepEqual(after.widths, before.widths);
  assert.equal(after.trace.appReplacements, before.trace.appReplacements);
}

test("locked cell click preserves table DOM, geometry, and scroll", { skip }, async () => {
  const { browser, page } = await openViewer();
  try {
    const selector = '[data-edit-column="Column_13"]';
    await page.evaluate(() => { const wrap = document.querySelector(".table-wrap"); wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth - 80; });
    const before = await snapshot(page, selector);
    const box = await page.locator(selector).boundingBox();
    await page.mouse.click(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
    await page.waitForTimeout(80);
    const after = await snapshot(page, selector);
    console.log("VIEWER_CELL_CLICK", JSON.stringify({ before, after }));
    assertStable(before, after);
    assert.equal(after.trace.copied.at(-1)?.startsWith("Column_13_value"), true);
    assert.equal(after.trace.messages.some(message => message.type === "page-request"), false);
    assert.equal(after.trace.scrollTo.length, before.trace.scrollTo.length);
    assert.equal(after.trace.raf, before.trace.raf);
  } finally { await browser.close(); }
});

test("locked cell click remains stable after applying a filter", { skip }, async () => {
  const { browser, page } = await openViewer();
  try {
    await page.locator("#filter-button").click();
    await page.locator("#add-filter").click();
    await page.locator("#apply-filters").click();
    await page.waitForFunction(() => !document.querySelector(".table-wrap")?.classList.contains("page-loading"));
    const selector = '[data-edit-column="Column_13"]';
    await page.evaluate(() => { const wrap = document.querySelector(".table-wrap"); wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth - 80; });
    const before = await snapshot(page, selector);
    const box = await page.locator(selector).boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await page.waitForTimeout(50);
    const after = await snapshot(page, selector);
    console.log("VIEWER_FILTERED_CELL_CLICK", JSON.stringify({ before, after }));
    assertStable(before, after);
    assert.equal(after.trace.copied.at(-1)?.startsWith("Column_13_value"), true);
    const pageRequests = after.trace.messages.filter(message => message.type === "page-request");
    assert.equal(pageRequests.length, 1);
  } finally { await browser.close(); }
});

test("edit start and accepted value update preserve table DOM and position", { skip }, async () => {
  const { browser, page } = await openViewer();
  try {
    await page.locator("#edit-lock-button").click();
    const selector = '[data-edit-column="Column_13"]';
    await page.evaluate(() => { const wrap = document.querySelector(".table-wrap"); wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth - 80; });
    const before = await snapshot(page, selector);
    const box = await page.locator(selector).boundingBox();
    await page.mouse.dblclick(box.x + 20, box.y + box.height / 2);
    await page.waitForTimeout(50);
    const after = await snapshot(page, selector);
    console.log("VIEWER_CELL_EDIT", JSON.stringify({ before, after }));
    assertStable(before, after);
    assert.match(await page.locator(selector).textContent(), /_edited$/);
    assert.match(after.active, /^<td/);
  } finally { await browser.close(); }
});

test("column resize preserves table DOM and viewport without correction frames", { skip }, async () => {
  const { browser, page } = await openViewer();
  try {
    const target = '[data-edit-column="Column_13"]';
    const handle = '[data-resize-column="metadata:Column_12"]';
    await page.evaluate(() => { const wrap = document.querySelector(".table-wrap"); wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth - 80; });
    const before = await snapshot(page, target);
    await page.evaluate(selector => {
      const resizeHandle = document.querySelector(selector);
      const startX = resizeHandle.getBoundingClientRect().x + resizeHandle.getBoundingClientRect().width / 2;
      resizeHandle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: startX, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: startX - 20, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: startX - 20, pointerId: 1 }));
    }, handle);
    await page.waitForTimeout(30);
    const after = await snapshot(page, target);
    console.log("VIEWER_COLUMN_RESIZE", JSON.stringify({ before, after }));
    assert.equal(after.sameTable, true); assert.equal(after.sameTbody, true);
    assert.equal(after.scrollLeft, before.scrollLeft);
    assert.equal(after.windowX, before.windowX); assert.equal(after.windowY, before.windowY);
    assert.equal(after.tableRect.x, before.tableRect.x); assert.equal(after.tableRect.y, before.tableRect.y);
    assert.equal(after.trace.appReplacements, before.trace.appReplacements);
    assert.equal(after.trace.raf, before.trace.raf);
    assert.ok(after.widths[14] < before.widths[14]);
  } finally { await browser.close(); }
});
