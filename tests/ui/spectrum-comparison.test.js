// Browser test of the comparison score settings; skipped when Playwright is not installed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
(async () => {
  if (!chromium) { console.log('spectrum comparison test skipped: Playwright is not installed'); return; }
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="spectrum-app"></div>');
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} }); });
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../../ui/spectrum.css'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../ui/spectrum.js'), 'utf8') });
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const spectrum = (title, mz, row) => ({ title, datasetName: 'd', row, columns: Object.keys(row),
      spectrum: { mz, intensity: mz.map(() => 100) } });
    const method = () => page.locator('#similarity-method').inputValue();
    const disabled = () => page.locator('#similarity-method option:disabled').evaluateAll(options => options.map(o => o.value));
    const note = () => page.locator('.similarity-note').count();
    const matched = async () => Number((await page.locator('.similarity-row').innerText()).match(/(\d+) matched peaks/)[1]);
    // The lower spectrum is the upper one with peak 250 shifted by the precursor
    // difference (-50, a neutral loss) and peak 100 unchanged.
    const show = (title, mz, row) => send({ type: 'spectrum', payload: spectrum(title, mz, row) });
    const upper = row => show('upper', [100, 250], row);
    const lower = row => show('lower', [100, 200], row);

    // Default: Da or ppm, ±0.01 Da and ±10 ppm. The upper spectrum is pinned;
    // each new spectrum replaces the lower one.
    await upper({ pepmass: '500.0 1200' });   // detected: any case, first token
    await page.locator('#pin-top').click();
    await lower({ PrecursorMZ: '450' });
    assert.equal(await page.locator('#similarity-tolerance-unit').inputValue(), 'Da or ppm');
    assert.deepEqual(await disabled(), []);
    await page.locator('#similarity-method').selectOption('modified');
    assert.equal(await matched(), 2);

    // A missing or empty precursor disables the neutral-loss methods and falls back to the dot product.
    await lower({ PrecursorMZ: '' });
    assert.equal(await method(), 'dot');
    assert.deepEqual(await disabled(), ['modified', 'bonanza']);
    assert.match(await page.locator('.similarity-note').innerText(), /lower spectrum \(column: auto-detected\).*showing the dot product/);
    assert.equal(await matched(), 1);
    // The chosen method returns once both precursors are known.
    await lower({ ParentMZ: '450' });
    assert.equal(await method(), 'modified');
    assert.equal(await note(), 0);
    assert.equal(await matched(), 2);

    // A configured column replaces detection, even one named Auto; empty detects again.
    await send({ type: 'comparison-settings', precursor_column: 'Auto' });
    assert.equal(await method(), 'dot');
    await lower({ Auto: '450', ParentMZ: '1' });
    assert.match(await page.locator('.similarity-note').innerText(), /upper spectrum \(column: Auto\)/);
    await send({ type: 'comparison-settings', precursor_column: '' });
    assert.equal(await method(), 'modified');
    // A configured column replaces detection.
    await send({ type: 'comparison-settings', precursor_column: 'Precursor' });
    assert.equal(await method(), 'dot');
    assert.match(await page.locator('.similarity-note').innerText(), /upper and lower spectra \(column: Precursor\)/);
    await page.locator('#pin-top').click();
    await upper({ precursor: '500' });
    await page.locator('#pin-top').click();
    await lower({ PRECURSOR: '450', PrecursorMZ: '1' });
    assert.equal(await method(), 'modified');
    assert.equal(await matched(), 2);
    await page.locator('#similarity-method').selectOption('bonanza');
    assert.equal(await method(), 'bonanza');

    // The intensity exponent: the host's default, then the input. Only m/z 100 matches;
    // upper intensities (100, 100), lower (400, 100).
    const score = async () => Number(await page.locator('.similarity-row output').innerText());
    await page.locator('#similarity-method').selectOption('dot');
    await send({ type: 'spectrum', payload: { ...spectrum('lower', [100, 200], {}), spectrum: { mz: [100, 200], intensity: [400, 100] } } });
    assert.equal(await page.locator('#similarity-exponent').inputValue(), '1');
    assert.equal(await score(), 0.686);   // 400 / (√2·100 · √170000)
    await send({ type: 'comparison-settings', intensity_exponent: 0.5 });
    assert.equal(await page.locator('#similarity-exponent').inputValue(), '0.5');
    assert.equal(await score(), 0.6325);  // 200 / (√2·10 · √500)
    await page.locator('#similarity-exponent').fill('1');
    await page.locator('#similarity-exponent').dispatchEvent('change');
    assert.equal(await score(), 0.686);
    await page.locator('#similarity-exponent').fill('0');   // ignored: not positive
    await page.locator('#similarity-exponent').dispatchEvent('change');
    assert.equal(await page.locator('#similarity-exponent').inputValue(), '1');
    assert.deepEqual(errors, []);
    console.log('Spectrum comparison tests passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
