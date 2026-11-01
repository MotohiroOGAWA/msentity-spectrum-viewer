const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../../ui/viewer.js"), "utf8");

test("dataset controls are visible by default and individually configurable", () => {
  for (const name of ["reload", "filter", "export", "more", "metadata", "columns", "settings"]) {
    assert.match(source, new RegExp(`${name}: true`));
  }
  assert.match(source, /showControl\("reload"\)/);
  assert.match(source, /showControl\("more"\)/);
  assert.match(source, /showControl\("metadata"\)/);
  assert.match(source, /message\?\.type === "viewer-config"/);
});

test("external settings support hidden fixed values and custom controls", () => {
  assert.match(source, /item\.hidden !== true/);
  assert.match(source, /item\.type === "boolean"/);
  assert.match(source, /item\.type === "select"/);
  assert.match(source, /type: "viewer-settings-change"/);
  assert.match(source, /window\.msentityDatasetViewer =/);
});
