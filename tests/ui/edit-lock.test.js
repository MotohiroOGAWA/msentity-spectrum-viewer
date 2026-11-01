const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../../ui/viewer.js"), "utf8");

test("dataset cell editing is locked by default and explicitly unlockable", () => {
  assert.match(source, /let editingUnlocked = false/);
  assert.match(source, /id="edit-lock-button"/);
  assert.match(source, /editingUnlocked = !editingUnlocked/);
  assert.match(source, /if \(loadingPage \|\| !editingUnlocked\) return/);
  assert.match(source, /Editing is locked/);
  assert.match(source, /copyLockedCells: true/);
  assert.match(source, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(source, /viewerOptions\.behavior\.copyLockedCells === false/);
});
