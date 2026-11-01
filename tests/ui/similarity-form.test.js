// Browser test of the Calculate similarity form; skipped when Playwright is not installed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
(async () => {
  if (!chromium) { console.log('similarity form test skipped: Playwright is not installed'); return; }
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="app"></div>');
    await page.evaluate(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: m => messages.push(m) }); });
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../../ui/viewer.css'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../ui/viewer.js'), 'utf8') });
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const last = () => page.evaluate(() => messages.at(-1));
    const preview = () => page.locator('#similarity-preview').innerText();
    const problem = () => page.locator('#similarity-problem').innerText();
    await send({ type: 'backend-ready', dataset: { id: 'query', name: 'query.msp' } });
    await send({ type: 'dataset-page', value: { dataset_id: 'query', dataset_path: '/query.msp', columns: ['Name', 'SpecID'],
      rows: [{ Name: 'a', SpecID: '1' }], row_ids: [0], total_rows: 1, total_pages: 1, attributes: {}, tags: [] } });

    await page.locator('#more-actions-button').click();
    await page.locator('#similarity-button').click();
    assert.equal((await last()).type, 'calculate-similarity');
    const datasets = [
      { id: 'query', name: 'query.msp', columns: ['Name', 'SpecID'], total_rows: 120 },
      { id: 'library', name: 'library.msp', columns: ['InChIKey', 'Name'], total_rows: 5000 },
    ];
    await send({ type: 'similarity-options', active_dataset_id: 'query', datasets, max_threads: 3,
      defaults: { method: 'cosine', threshold: 0.7, mz_tolerance: '0.02Da,5ppm', intensity_exponent: 1, include_matched_data: true } });

    // Every choice is visible at once and the preview follows the inputs.
    assert.equal(await page.locator('#similarity-dataset1').inputValue(), 'query');
    assert.equal(await page.locator('#similarity-dataset2').inputValue(), 'library');
    assert.equal(await page.locator('#similarity-threshold').inputValue(), '0.7');
    assert.equal(await page.locator('#similarity-tolerance-unit').inputValue(), 'Da or ppm');
    assert.equal(await page.locator('#similarity-tolerance-da').inputValue(), '0.02');
    assert.equal(await page.locator('#similarity-tolerance-ppm').inputValue(), '5');
    assert.match(await preview(), /120 query spectra .*× 5,000 reference spectra .*= 600,000 pairs/);
    assert.match(await preview(), /m\/z 0\.02 Da or 5 ppm/);
    await page.locator('#similarity-tolerance-da').fill('');
    assert.match(await problem(), /positive m\/z tolerance in Da and ppm/);
    // The unit decides which values are used; switching keeps both.
    await page.locator('#similarity-tolerance-unit').selectOption('ppm');
    assert.equal(await page.locator('#similarity-tolerance-da').count(), 0);
    assert.match(await preview(), /m\/z 5 ppm ·/);
    await page.locator('#similarity-tolerance-ppm').fill('0');
    assert.match(await problem(), /positive m\/z tolerance in ppm/);
    assert.equal(await page.locator('#submit-similarity-form').isDisabled(), true);
    await page.locator('#similarity-tolerance-ppm').fill('10');
    await page.locator('#similarity-threshold').fill('1.5');
    assert.match(await problem(), /threshold/);
    await page.locator('#similarity-threshold').fill('0.6');
    // Threads: 1 by default, at most max_threads.
    assert.equal(await page.locator('#similarity-threads').inputValue(), '1');
    assert.match(await preview(), /· 1 thread$/m);
    await page.locator('#similarity-threads').fill('4');
    assert.match(await problem(), /Threads must be an integer from 1 to 3/);
    await page.locator('#similarity-threads').fill('2');
    assert.match(await preview(), /· 2 threads/);
    await page.locator('#similarity-method').selectOption('reverse_cosine');
    await page.locator('#similarity-include').uncheck();
    assert.match(await preview(), /Reverse cosine.*\n?.*scores only/s);
    await page.screenshot({ path: path.join(os.tmpdir(), 'msentity-similarity-form.png') });

    // A reference file replaces the reference dataset.
    await page.locator('#similarity-dataset2').selectOption('file');
    assert.equal((await last()).type, 'choose-similarity-reference');
    await send({ type: 'similarity-reference', path: '/data/ref/massbank.msp' });
    assert.match(await preview(), /every spectrum in massbank\.msp/);
    await page.locator('#submit-similarity-form').click();
    assert.deepEqual(JSON.parse(JSON.stringify(await last())), { type: 'similarity-submit', mode: 'library_search', dataset1: 'query',
      reference_path: '/data/ref/massbank.msp', parameters: { method: 'reverse_cosine', mz_tolerance: '10ppm',
        intensity_exponent: 1, include_matched_data: false, threads: 2, threshold: 0.6 } });
    assert.equal(await page.locator('#submit-similarity-form').isDisabled(), true);

    // A cancelled save dialog or a host error keeps the form and its choices.
    await send({ type: 'similarity-save-cancelled' });
    assert.equal(await page.locator('#submit-similarity-form').isDisabled(), false);
    await page.locator('input[value="by_key"]').check();
    assert.equal(await page.locator('#similarity-dataset2').inputValue(), 'library');
    assert.equal(await page.locator('#similarity-key1').inputValue(), 'SpecID');
    assert.equal(await page.locator('#similarity-key2').inputValue(), 'InChIKey');
    await page.locator('#similarity-key2').selectOption('Name');
    assert.match(await preview(), /query\.msp SpecID = library\.msp Name · at most 120 pairs/);
    await page.locator('#submit-similarity-form').click();
    const byKey = await last();
    assert.equal(byKey.mode, 'by_key');
    assert.equal(byKey.dataset2, 'library');
    assert.deepEqual([byKey.parameters.key1, byKey.parameters.key2, byKey.parameters.threshold], ['SpecID', 'Name', undefined]);
    await send({ type: 'similarity-form-error', message: 'Use the .mssim extension.' });
    assert.equal(await problem(), 'Use the .mssim extension.');

    // similarity-start closes the form and shows the calculation.
    await send({ type: 'similarity-start' });
    assert.equal(await page.locator('#similarity-backdrop').count(), 0);
    await page.locator('#more-actions-button').click();
    assert.match(await page.locator('#similarity-button').innerText(), /Calculating/);
    await send({ type: 'similarity-cancelled' });

    // Escape closes the form without a request.
    await page.locator('#similarity-button').click();
    await send({ type: 'similarity-options', active_dataset_id: 'query', datasets: datasets.slice(0, 1),
      tolerance: { unit: 'Da', da: 0.03, ppm: 7 } });
    assert.equal(await page.locator('#similarity-dataset2').inputValue(), 'file');
    assert.equal(await page.locator('#similarity-tolerance-unit').inputValue(), 'Da');
    assert.equal(await page.locator('#similarity-tolerance-da').inputValue(), '0.03');
    assert.equal(await page.locator('#similarity-tolerance-ppm').count(), 0);
    await page.locator('#similarity-tolerance-unit').selectOption('Da or ppm');
    assert.equal(await page.locator('#similarity-tolerance-ppm').inputValue(), '7');
    assert.match(await problem(), /reference file/);
    const before = await page.evaluate(() => messages.length);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#similarity-backdrop').count(), 0);
    assert.equal(await page.evaluate(() => messages.length), before);
    assert.deepEqual(errors, []);
    console.log('Similarity form tests passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
