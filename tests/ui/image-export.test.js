const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../ui/spectrum.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('  const exportRange ='), source.indexOf('  const comparison =')) + '\nthis.range = exportRange; this.labels = labelPeaks;', context);
test('export ranges use auto endpoints and reject reversed or invalid ranges', () => {
  assert.deepEqual(Array.from(context.range('', 200, [10, 100])), [10, 200]);
  assert.deepEqual(Array.from(context.range(20, '', [10, 100])), [20, 100]);
  for (const range of [[100, 20], [20, 20], [-1, 20], ['bad', 20]]) {
    assert.throws(() => context.range(...range, [0, 100]));
  }
});
test('top K ranks eligible peaks separately and keeps stable ties', () => {
  const peaks = [{y: 20, index: 0}, {y: 50, index: 1}, {y: 50, index: 2}, {y: 100, index: 3}];
  assert.deepEqual(Array.from(context.labels(peaks, [0, 60], {topK: 1}), p => p.index), [1]);
  assert.deepEqual(Array.from(context.labels(peaks, [0, 60], {topK: 0}), p => p.index), [0, 1, 2]);
  assert.deepEqual(Array.from(context.labels(peaks, [0, 60], {topK: 10}), p => p.index), [1, 2, 0]);
  assert.equal(peaks[0].index, 0);
});

let chromium;
try { ({ chromium } = require('playwright')); } catch {}
test('dragging export preview handles updates the saved SVG and PNG dimensions', { skip: !chromium }, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await page.setContent('<div id="spectrum-app"></div>');
    await page.evaluate(() => {
      let state;
      window.exports = [];
      window.acquireVsCodeApi = () => ({
        postMessage: message => { if (message.type === 'save-image') window.exports.push(message); },
        getState: () => state,
        setState: value => { state = value; }
      });
    });
    await page.addStyleTag({ path: require('node:path').join(__dirname, '../../ui/spectrum.css') });
    await page.addScriptTag({ content: source });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'spectrum', payload: { title: 'Resize', spectrum: { mz: [100], intensity: [1] } } }
    })));
    await page.locator('#export-image').click();
    const dimensions = async () => Promise.all(['width', 'height'].map(async axis =>
      Number(await page.locator(`#export-${axis}`).inputValue())));
    await page.locator('#export-width').fill('500');
    await page.locator('#export-height').fill('300');
    const drag = async (axes, dx, dy) => {
      const bounds = await page.locator(`[data-export-resize="${axes}"]`).boundingBox();
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 3 });
      await page.mouse.up();
    };
    await drag('x', 45, 10);
    const [wider, sameHeight] = await dimensions();
    assert.ok(wider > 500);
    assert.equal(sameHeight, 300);
    await drag('y', 10, -30);
    const [sameWidth, shorter] = await dimensions();
    assert.equal(sameWidth, wider);
    assert.ok(shorter < 300);
    await drag('xy', -25, 20);
    const [width, height] = await dimensions();
    assert.ok(width < wider && height > shorter);
    const preview = page.locator('#export-preview svg');
    assert.equal(await preview.getAttribute('width'), String(width));
    assert.equal(await preview.getAttribute('height'), String(height));
    await page.locator('#export-svg').click();
    await page.locator('#export-png').click();
    await page.waitForFunction(() => window.exports.length === 2);
    const images = await page.evaluate(() => window.exports);
    const svg = Buffer.from(images.find(image => image.filename.endsWith('.svg')).bytes).toString();
    assert.match(svg, new RegExp(`<svg[^>]*width="${width}"[^>]*height="${height}"`));
    const png = Buffer.from(images.find(image => image.filename.endsWith('.png')).bytes);
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
  } finally {
    await browser.close();
  }
});
