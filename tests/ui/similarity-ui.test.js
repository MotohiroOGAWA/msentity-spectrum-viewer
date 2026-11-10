/* Wizard tests always run; browser tests need Playwright (skipped otherwise). */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
let chromium = null;
if (!process.env.WIZARD_ONLY) {
  try { chromium = require("playwright").chromium; } catch { chromium = null; }
}
const root = path.resolve(__dirname, "../..");
const host = require("../../host");
const { findBackendExecutable, similaritySettings } = host;
const backendExecutable = findBackendExecutable({ roots: [root] });

async function wizardTests() {
  let choices = [], requests = [], messages = [];
  let saveTarget = (options) => options.defaultUri;
  let writtenImage = null;
  const vscode = {
    Uri: {
      file: (fsPath) => ({ fsPath }),
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath || String(base), ...parts) }),
    },
    workspace: { fs: { writeFile: async (target, bytes) => { writtenImage = { target, bytes }; } } },
    window: {
      showQuickPick: async (items, options) => { choices.push(options); return items[0]; },
      showSaveDialog: async (options) => saveTarget(options),
      showInformationMessage: () => {},
    },
  };
  const context = { Buffer, require: (name) => name === "vscode" ? vscode : require(name), module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "vscode", "extension.js"), "utf8") +
    "\nmodule.exports.Provider = MSEntityViewerProvider;", context);
  const provider = new context.module.exports.Provider({ extensionUri: "/extension" });
  const datasets = [0, 1, 2].map((i) => ({ id: `dataset${i}`, name: `dataset${i}`, columns: ["Name", "SpecID"] }));
  const defaults = similaritySettings({ threads: 1 });   // any machine allows 1 thread
  const submit = (form) => {
    requests = []; messages = [];
    return provider.startSimilarity(form, datasets, { fsPath: "/tmp/source.msds" },
      (m) => requests.push(m), (m) => messages.push(m), () => false, defaults, host);
  };
  const library = { mode: "library_search", dataset1: "dataset0", dataset2: "dataset1",
    parameters: { method: "reverse_cosine", threshold: 0.6, mz_tolerance: "10 PPM", intensity_exponent: 0.5,
      include_matched_data: false, key1: "ignored" } };

  // One submission carries every choice; the save dialog is the only host dialog.
  await submit(library);
  assert.deepEqual(messages.map((m) => m.type), ["similarity-start"]);
  assert.equal(requests[0].type, "calculate-similarity");
  assert.equal(requests[0].mode, "library_search");
  assert.equal(requests[0].dataset1, "dataset0");
  assert.equal(requests[0].dataset2, "dataset1");
  assert.equal(requests[0].path, path.join("/tmp", "similarity.mssim"));
  // "method" (one name) is still accepted; the backend gets "methods".
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].parameters)), { methods: ["reverse_cosine"],
    precursor_column: "", threads: 1, mz_tolerance: "10ppm", intensity_exponent: 0.5,
    include_matched_data: false, threshold: 0.6 });
  await submit({ ...library, parameters: { ...library.parameters, method: undefined,
    methods: ["bonanza", "cosine"], precursor_column: "PEPMASS" } });
  assert.deepEqual([...requests[0].parameters.methods], ["cosine", "bonanza"]);
  assert.equal(requests[0].parameters.precursor_column, "PEPMASS");

  await submit({ ...library, dataset2: undefined, reference_path: "/tmp/reference.msp" });
  assert.equal(requests[0].reference_path, "/tmp/reference.msp");
  assert.equal(requests[0].dataset2, undefined);

  await submit({ mode: "by_key", dataset1: "dataset1", dataset2: "dataset0",
    parameters: { method: "cosine", mz_tolerance: "0.01Da,10ppm", intensity_exponent: 1,
      include_matched_data: true, key1: "SpecID", key2: "Name", threshold: 0.9 } });
  assert.equal(requests[0].mode, "by_key");
  assert.equal(requests[0].parameters.key1, "SpecID");
  assert.equal(requests[0].parameters.key2, "Name");
  assert.equal(requests[0].parameters.threshold, undefined);

  // Invalid choices throw (the host answers similarity-form-error) and send nothing.
  for (const [form, pattern] of [
    [{ ...library, mode: "pairs" }, /paired/],
    [{ ...library, dataset1: "missing" }, /query dataset/],
    [{ ...library, dataset2: "dataset0" }, /different/],
    [{ ...library, dataset2: undefined }, /reference/],
    [{ ...library, parameters: { ...library.parameters, threshold: 2 } }, /threshold/],
    [{ ...library, parameters: { ...library.parameters, mz_tolerance: "0Da" } }, /positive/],
    [{ ...library, parameters: { ...library.parameters, intensity_exponent: 0 } }, /intensity_exponent/],
    [{ ...library, parameters: { ...library.parameters, threads: 0 } }, /threads/],
    [{ ...library, parameters: { ...library.parameters, threads: 100000 } }, /at most \d+ threads/],
    [{ mode: "by_key", dataset1: "dataset0", parameters: { key1: "SpecID", key2: "SpecID" } }, /second dataset/],
    [{ mode: "by_key", dataset1: "dataset0", dataset2: "dataset1", parameters: { key1: "SpecID", key2: "Missing" } }, /key column/],
  ]) {
    await assert.rejects(submit(form), pattern);
    assert.equal(requests.length, 0);
  }

  // A cancelled save dialog keeps the form open.
  saveTarget = () => undefined;
  await submit(library);
  assert.equal(requests.length, 0);
  assert.deepEqual(messages.map((m) => m.type), ["similarity-save-cancelled"]);
  saveTarget = () => ({ fsPath: "/tmp/result.txt" });
  await assert.rejects(submit(library), /\.mssim/);
  saveTarget = (options) => options.defaultUri;
  const savedPath = await provider.saveImage(
    { fsPath: "/tmp/data/result.mssim" },
    { filename: "similarity-box.png", bytes: [137, 80, 78, 71] }
  );
  assert.equal(savedPath, "/tmp/data/similarity-box.png");
  assert.deepEqual(Array.from(writtenImage.bytes), [137, 80, 78, 71]);
  const savedPeaksPath = await provider.savePeaks(
    { fsPath: "/tmp/data/source.msds" },
    { basename: "upper-vs-lower", sourcePath: "/tmp/data/source.msds",
      contents: { tsv: "Upper m/z\tLower m/z\n100\t100.01\n", csv: "Upper m/z,Lower m/z\n100,100.01\n" } }
  );
  assert.equal(savedPeaksPath, "/tmp/data/upper-vs-lower.tsv");
  assert.equal(Buffer.from(writtenImage.bytes).toString("utf8"), "Upper m/z\tLower m/z\n100\t100.01\n");
  assert.equal(choices.at(-1).title, "Save spectrum peaks");
}

async function browserTests() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mssim-ui-"));
  const file = path.join(temporary, "sample.mssim");
  // Fixture: by-key cosine 0 ("<script>…"), 0.894 (B), and 1 (C); no precursor
  // m/z, so the modified_cosine column is empty.
  const first = path.join(temporary, "first.tsv");
  const second = path.join(temporary, "second.tsv");
  fs.writeFileSync(first, "SpecID\tPeak\n<script>bad</script>\t100,1\nB\t100,1;200,0.5\nC\t300,1\n");
  fs.writeFileSync(second, "SpecID\tPeak\n<script>bad</script>\t500,1\nB\t100,1\nC\t300,1\n");
  const fixture = spawnSync(backendExecutable, ["dataset", first], { encoding: "utf8",
    input: [{ type: "add-dataset", path: second },
      { type: "calculate-similarity", dataset1: fs.realpathSync(first), dataset2: fs.realpathSync(second), path: file,
        parameters: { methods: ["cosine", "modified_cosine"] } }]
      .map((r) => JSON.stringify(r) + "\n").join("") });
  assert.ok(fixture.stdout.includes("similarity-complete"), fixture.stdout + fixture.stderr);
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'self'; script-src 'nonce-test';">
        <link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/similarity.css"></head><body>
        <div id="app" data-filename="sample.mssim"></div><script nonce="test">window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {}, postMessage: m => window.sendHostMessage(m) });</script>
        <script nonce="test" src="/similarity.js"></script></body></html>`);
    } else if (request.url === "/theme.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(":root { --vscode-font-family: sans-serif; --vscode-font-size: 13px; --vscode-foreground: #ddd; --vscode-editor-background: #181818; --vscode-panel-border: #393939; --vscode-descriptionForeground: #aaa; --vscode-button-secondaryBackground: #333; --vscode-button-secondaryForeground: #eee; --vscode-input-background: #292929; --vscode-input-foreground: #eee; --vscode-errorForeground: #ff7777; }");
    } else if (["/similarity.js", "/similarity.css"].includes(request.url)) {
      response.setHeader("Content-Type", request.url.endsWith(".js") ? "text/javascript" : "text/css");
      response.end(fs.readFileSync(path.join(root, "ui", request.url.slice(1))));
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  let child;
  const savedImages = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.exposeFunction("sendHostMessage", (message) => {
      if (message.type === "save-similarity-image") {
        savedImages.push(message);
        return;
      }
      if (message.type === "webview-ready") return;   // for the host, which this test stands in for
      const type = { "page-request": "page", "coverage-request": "coverage" }[message.type] || message.type;
      child.stdin.write(JSON.stringify({ ...message, type }) + "\n");
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    child = spawn(backendExecutable, ["similarity", file, "--page-size", "2"]);
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) if (line.startsWith("MSENTITY_JSON:")) {
        const message = JSON.parse(line.slice("MSENTITY_JSON:".length));
        page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), message).catch(() => {});
      }
    });
    await page.waitForSelector(".stats");
    assert.equal(await page.locator(".table-scroll tbody tr").count(), 2);
    assert.ok((await page.locator(".table-scroll").innerText()).includes("<script>bad</script>"));
    await page.locator("#next").click();
    await page.waitForFunction(() => document.querySelector("footer").textContent.includes("Page 2 / 2"));
    // The filter is a similarity range: here 0.8 <= similarity < 1.
    await page.locator("#filter").click();
    await page.locator("#range-min").fill("0.8"); await page.locator("#range-min").dispatchEvent("change");
    await page.locator("#range-max").fill("1"); await page.locator("#range-max").dispatchEvent("change");
    await page.locator("#range-max-operator").selectOption("<");
    await page.locator("#apply").click();
    await page.waitForFunction(() => document.querySelector(".stats strong").textContent.startsWith("1"));
    assert.equal(await page.locator("#filter").innerText(), "Filter (Cosine ≥ 0.8, < 1)");
    assert.ok((await page.locator(".table-scroll").innerText()).includes("0.89"));
    await page.locator("#filter").click();
    await page.locator("#clear").click();
    await page.waitForFunction(() => document.querySelector(".stats strong").textContent.startsWith("3"));
    // The key column identifies the pairs of this by-key result: index* and data_index* are hidden.
    assert.deepEqual(await page.locator("[data-sort]").evaluateAll((b) => b.map((e) => e.dataset.sort)),
      ["SpecID", "cosine", "modified_cosine", "peak_intensity_coverage1", "peak_intensity_coverage2",
        "modified_peak_intensity_coverage1", "modified_peak_intensity_coverage2"]);
    assert.deepEqual(await page.locator("#score-column option").allTextContents(), ["Cosine", "Modified cosine"]);
    assert.match(await page.locator('[data-sort="SpecID"]').innerText(), /^a\.SpecID = b\.SpecID/);
    await page.locator("#bins").fill("2"); await page.locator("#bins").press("Tab");
    await page.waitForFunction(() => document.querySelectorAll(".frequency-table tbody tr").length === 2);
    await page.locator(".distribution summary").click();
    const counts = await page.locator(".frequency-table tbody tr td:nth-child(2)").allTextContents();
    assert.deepEqual(counts, ["1", "2"]);
    assert.equal(await page.locator(".stats div").count(), 8);
    assert.ok((await page.locator(".stats").innerText()).includes("Q1"));
    assert.ok((await page.locator(".stats").innerText()).includes("Q3"));
    assert.equal(await page.locator("#chart svg rect[fill]").count(), 2);   // one bar per bin
    // Clicking the chart does not filter.
    await page.locator("#chart").click();
    assert.equal(await page.locator("#filter").innerText(), "Filter");
    assert.ok((await page.locator(".stats strong").first().innerText()).startsWith("3"));
    await page.locator("#chart-type").selectOption("line");
    assert.equal(await page.locator("#chart svg circle").count(), 2);
    await page.locator("#count-scale").selectOption("log");
    assert.ok((await page.locator("#chart-hint").innerText()).includes("log₁₀"));
    assert.ok((await page.locator("#chart svg").innerHTML()).includes("Count (log₁₀ scale)"));
    // All methods: one line per score column, and their statistics.
    await page.locator("#chart-type").selectOption("methods");
    assert.equal(await page.locator('#chart svg polyline[data-method]').count(), 2);
    assert.deepEqual(await page.locator(".method-statistics tbody td:first-child").allInnerTexts(), ["Cosine", "Modified cosine"]);
    assert.deepEqual(await page.locator(".method-statistics tbody tr:nth-child(2) td:nth-child(2)").allInnerTexts(), ["0"]);   // no precursor
    await page.locator("#chart-type").selectOption("box");
    assert.ok((await page.locator(".distribution p").innerText()).includes("Q1"));

    // Save image: a preview of the chosen size, colors, axis ranges, and format.
    // The dialog opens as a modal over the page; Escape closes it.
    await page.locator("#save-image").click();
    assert.equal(await page.locator("#image-dialog").evaluate((d) => d.matches(":modal")), true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#image-dialog"));
    await page.locator("#save-image").click();
    await page.locator("#image-type").selectOption("histogram");
    await page.locator("#image-width").fill("640");
    await page.locator("#image-height").fill("480");
    await page.locator("#image-grid").uncheck();
    await page.locator("#image-color").fill("#ff0000");
    await page.locator("#image-x-min").fill("0.5");
    await page.locator("#image-y-max").fill("5");
    const preview = await page.locator("#image-preview svg").evaluate((svg) => svg.outerHTML);
    assert.match(preview, /width="640" height="480"/);
    assert.match(preview, /fill="#ff0000"/);
    assert.ok(!preview.includes('stroke-opacity="0.15"'));   // no grid
    assert.match(await page.locator("#image-preview svg").innerHTML(), />0\.5</);
    await page.locator("#image-x-max").fill("0.2");   // maximum below minimum
    assert.match(await page.locator("#image-status").innerText(), /greater than/);
    assert.equal(await page.locator("#confirm-image").isDisabled(), true);
    await page.locator("#image-x-max").fill("");
    await page.locator("#image-format").selectOption("svg");
    await page.locator("#confirm-image").click();
    await page.waitForFunction(() => document.querySelector("#confirm-image")?.textContent.includes("Preparing"));
    for (let i = 0; i < 50 && savedImages.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(savedImages.length, 1, await page.locator('[role="alert"]').allInnerTexts().then(String));
    assert.equal(savedImages[0].filename, "similarity-histogram.svg");
    assert.match(Buffer.from(savedImages[0].bytes).toString("utf8"), /^<\?xml[^]*<svg[^]*width="640"/);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "image-save-complete", path: "/tmp/similarity-histogram.svg" }
    })));
    await page.waitForFunction(() => !document.querySelector("#image-dialog"));
    await page.locator("#save-image").click();
    await page.locator("#image-format").selectOption("png");
    await page.locator("#confirm-image").click();
    for (let i = 0; i < 50 && savedImages.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(savedImages[1].filename, "similarity-box.png");
    assert.deepEqual(savedImages[1].bytes.slice(1, 4), [80, 78, 71]);   // "PNG"
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "image-save-cancelled" } })));
    await page.locator("#cancel-image").click();

    // Coverage view: peak intensity coverage against similarity with the √coverage
    // bound. B (coverage 0.8, cosine 0.894) lies on the bound.
    await page.locator("#chart-view").selectOption("coverage");
    await page.waitForFunction(() => document.querySelector("#chart-hint").textContent.includes("20 × 20 cells"));
    assert.match(await page.locator("#chart-hint").innerText(), /^3 rows/);
    let coverageSvg = await page.locator("#chart svg").innerHTML();
    assert.match(coverageSvg, /max = √coverage/);
    assert.match(coverageSvg, /Density/);                         // marginal densities
    assert.equal(await page.locator('#chart svg g[shape-rendering] rect').count(), 3);   // three occupied cells
    assert.ok(!(await page.locator("#chart-hint").innerText()).includes("above"));
    await page.locator("#coverage-plot").selectOption("scatter");
    await page.waitForFunction(() => document.querySelectorAll("#chart svg circle").length === 3);
    await page.locator("#coverage-marginals").uncheck();
    assert.ok(!(await page.locator("#chart svg").innerHTML()).includes(">Density<"));
    await page.locator("#coverage-side").selectOption("2");
    await page.waitForFunction(() => document.querySelector("#chart-hint").textContent.includes("second dataset"));
    await page.locator("#coverage-plot").selectOption("density");
    await page.locator("#coverage-x-bins").fill("0"); await page.locator("#coverage-x-bins").press("Tab");
    assert.match(await page.locator('[role="alert"]').innerText(), /between 1 and 200/);
    // The image picks square cells for its own plot area: 20 × 10 at 800 × 400 px.
    await page.waitForFunction(() => !document.querySelector("#save-image").disabled);
    await page.locator("#save-image").click();
    await page.locator("#image-width").fill("800");
    await page.locator("#image-height").fill("400");
    await page.waitForFunction(() => document.querySelector("#image-status").textContent.includes("20 × 10 cells"));
    await page.locator("#image-format").selectOption("svg");
    await page.locator("#confirm-image").click();
    for (let i = 0; i < 50 && savedImages.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(savedImages[2].filename, "similarity-coverage-density.svg");
    assert.match(Buffer.from(savedImages[2].bytes).toString("utf8"), /width="800" height="400"/);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "image-save-cancelled" } })));
    await page.locator("#cancel-image").click();
    // Modified cosine is plotted against the coverage of its own pairing,
    // which bounds it too (no precursor here, so no rows).
    await page.locator("#coverage-plot").selectOption("scatter");
    await page.locator("#score-column").selectOption("modified_cosine");
    await page.waitForFunction(() => document.querySelector("#chart-hint").textContent.startsWith("0 rows"));
    assert.match(await page.locator("#chart-hint").innerText(), /peak intensity coverage with shifted peaks/);
    assert.ok((await page.locator("#chart svg").innerHTML()).includes("max = √coverage"));
    assert.match(await page.locator(".stats").innerText(), /0 with Modified cosine/);
    // The √coverage line can be hidden.
    await page.locator("#coverage-bound").uncheck();
    assert.ok(!(await page.locator("#chart svg").innerHTML()).includes("max = √coverage"));
    await page.locator("#coverage-bound").check();
    await page.locator("#score-column").selectOption("cosine");
    await page.waitForFunction(() => document.querySelector("#chart-hint").textContent.startsWith("3 rows"));
    await page.locator("#chart-view").selectOption("distribution");
    await page.locator('[data-sort="cosine"]').click();
    await page.waitForSelector('[aria-sort="ascending"]');
    await page.waitForFunction(() => !document.querySelector("#reload").disabled);
    await page.locator('[data-sort="cosine"]').click();
    await page.waitForFunction(() => document.querySelector(".table-scroll tbody tr td").textContent === "C");
    await page.locator("#reload").click();
    await page.waitForFunction(() => !document.querySelector("#reload").disabled);
    await page.screenshot({ path: path.join(os.tmpdir(), "msentity-similarity-ui.png"), fullPage: true });
    await page.setViewportSize({ width: 500, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    child?.kill(); await browser.close(); server.close(); fs.rmSync(temporary, { recursive: true, force: true });
  }
}

(async () => {
  await wizardTests();
  if (chromium && backendExecutable) await browserTests();
  console.log(chromium && backendExecutable
    ? "Similarity wizard and browser interaction tests passed."
    : "Similarity wizard tests passed (browser tests skipped: Playwright or the backend is missing).");
})()
  .catch((error) => { console.error(error); process.exitCode = 1; });
