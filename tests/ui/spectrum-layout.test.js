const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "../../ui/spectrum.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../../ui/spectrum.css"), "utf8");

test("spectrum metadata is initially collapsed and retains its toggle state", () => {
  assert.match(script, /let metadataOpen = false/);
  assert.match(script, /<details id="spectrum-metadata"[^>]*\$\{metadataOpen \? "open" : ""\}/);
  assert.match(script, /metadataOpen = event\.currentTarget\.open/);
});

test("collapsed metadata leaves the component's height to spectrum and peaks", () => {
  // The component fills its container (the page, or the box it is embedded in).
  assert.match(styles, /#spectrum-app \{[^}]*height: 100%/);
  assert.match(styles, /\.spectrum-viewer \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;/);
  // Open metadata: a splitter and its remembered share of the height.
  assert.match(styles, /\.spectrum-viewer\.metadata-open \{ grid-template-rows: auto minmax\(0, 1fr\) 14px minmax\(0, calc\(var\(--metadata-share\) \* 100%\)\)/);
  assert.match(script, /id="metadata-splitter" class="metadata-splitter" role="separator"/);
  assert.match(script, /metadataShare, similaritySettingsOpen/);
  assert.match(styles, /\.spectrum-viewer \{[^}]*height: 100%/);
  assert.doesNotMatch(styles, /\.spectrum-viewer \{[^}]*100vh/);
  assert.match(styles, /\.peak-scroll \{[^}]*flex: 1/);
  assert.match(styles, /#plot-root > svg \{[^}]*height: 100%/);
});

test("a splitter between spectrum and peaks, its share remembered", () => {
  assert.match(script, /id="workspace-splitter" class="workspace-splitter" role="separator"/);
  assert.match(styles, /\.spectrum-workspace \{[^}]*grid-template-columns: minmax\(0, 1fr\) 12px minmax\(0, calc\(var\(--peaks-share\) \* 100%\)\)/);
  assert.match(script, /peaksShare: \{ \.\.\.peaksShare \}/);
});
