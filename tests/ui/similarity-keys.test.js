// Browser test of the key columns shown for a by-key result; skipped when Playwright is not installed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
(async () => {
  if (!chromium) { console.log('similarity key test skipped: Playwright is not installed'); return; }
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="app" data-filename="result.mssim"></div>');
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} }); });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../ui/similarity.js'), 'utf8') });
    const show = (key1, key2, columns) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), {
      type: 'similarity-page', value: {
        columns, rows: [Object.fromEntries(columns.map(c => [c, c === 'cosine' ? 0.5 : 'x']))], result_indices: [0],
        page: 0, total_pages: 1, page_size: 100, total_rows: 1, unfiltered_rows: 1, has_matched_data: false,
        matched_data_rows: [0, 0], histogram: { counts: [1], edges: [0, 1] }, statistics: {}, score_columns: ['cosine'], score: 'cosine',
        metadata: { mode: 'by_key', parameters: { key1, key2, methods: ['cosine'] },
          sources: [{ role: 'first', path: '/data/mona.msds' }, { role: 'second', path: 'C:\\data\\cfmid.msds' }] } } });
    const subtitle = () => page.locator('header p').first().innerText();
    const headers = () => page.locator('[data-sort]').evaluateAll(buttons => buttons.map(b => [b.dataset.sort, b.textContent.trim()]));

    // Different names: both columns as they are.
    await show('SpecID', 'SourceSpecID', ['SpecID', 'SourceSpecID', 'index1', 'index2', 'cosine']);
    assert.match(await subtitle(), /· SpecID = SourceSpecID/);
    assert.equal(await page.locator('.key-sides').count(), 0);
    assert.deepEqual(await headers(), [['SpecID', 'SpecID ↕'], ['SourceSpecID', 'SourceSpecID ↕'], ['cosine', 'cosine ↕']]);   // keys identify the pairs: no index columns

    // The same name on both sides: one column, qualified as in SQL, with the datasets a and b.
    await show('SpecID', 'SpecID', ['SpecID', 'index1', 'index2', 'cosine']);
    assert.match(await subtitle(), /· a\.SpecID = b\.SpecID/);
    assert.equal(await page.locator('.key-sides').innerText(), 'a: mona.msds · b: cfmid.msds');
    assert.deepEqual((await headers())[0], ['SpecID', 'a.SpecID = b.SpecID ↕']);   // sorts by the real column
    assert.deepEqual(errors, []);
    console.log('Similarity key tests passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
