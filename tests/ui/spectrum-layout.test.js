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

test("collapsed metadata leaves the viewport height to spectrum and peaks", () => {
  assert.match(styles, /\.spectrum-viewer \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.spectrum-viewer \{[^}]*height: 100vh/);
  assert.match(styles, /\.peak-scroll \{[^}]*flex: 1/);
  assert.match(styles, /#plot-root > svg \{[^}]*height: 100%/);
});
