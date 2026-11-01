const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../../ui/viewer.js"), "utf8");
const extension = fs.readFileSync(path.join(__dirname, "../../vscode/extension.js"), "utf8");

test("dataset cell editing is locked by default and explicitly unlockable", () => {
  assert.match(source, /let editingUnlocked = false/);
  assert.match(source, /id="edit-lock-button"/);
  assert.match(source, /editingUnlocked = !editingUnlocked/);
  assert.match(source, /if \(loadingPage \|\| !editingUnlocked\) return/);
  assert.match(source, /lockedCellCopyGesture: "rightClick"/);
  assert.match(source, /showCopyNotifications: true/);
  assert.match(source, /copyLockedCells: true/);
  assert.match(source, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(source, /viewerOptions\.behavior\.copyLockedCells === false/);
  assert.match(source, /addEventListener\("contextmenu", copyCell\)/);
  assert.match(source, /event\.type === "contextmenu"/);
  assert.match(source, /showCopyNotifications !== false/);
});

test("cell clicks and accepted edits update in place without rendering", () => {
  const editStart = source.indexOf('document.querySelectorAll("[data-edit-row]")');
  const editEnd = source.indexOf('document.getElementById("add-column-toggle")', editStart);
  assert.doesNotMatch(source.slice(editStart, editEnd), /\brender\(\)/);
  const updateStart = source.indexOf('message?.type === "metadata-updated"');
  const updateEnd = source.indexOf('message?.type === "edit-error"', updateStart);
  const update = source.slice(updateStart, updateEnd);
  assert.match(update, /cell\.textContent = display\(message\.value\)/);
  assert.doesNotMatch(update.slice(update.indexOf("else if (message.row_id")), /viewRequest|render\(\)/);
});

test("the VS Code dataset viewer displays copy success and error notifications", () => {
  const datasetHandlerStart = extension.indexOf("const messageDisposable = webview.onDidReceiveMessage");
  const datasetHandlerEnd = extension.indexOf("messageDisposable.dispose", datasetHandlerStart);
  const datasetHandler = extension.slice(datasetHandlerStart, datasetHandlerEnd);
  assert.match(datasetHandler, /case "copy-notification":[\s\S]*showInformationMessage/);
  assert.match(datasetHandler, /case "clipboard-error":[\s\S]*showErrorMessage/);
});
