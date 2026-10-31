"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { skip, runBackend, tempDir, ofType } = require("./helpers");

test("merge is memory-only, keeps duplicates, reloads snapshots, and survives source removal", { skip }, () => {
  const tmp = tempDir();
  try {
    const a = tmp.file("a.tsv", "SpecID\tA\tPeak\ndup\tone\t100,1\n");
    const b = tmp.file("b.tsv", "SpecID\tSourceDataset\tB\tPeak\ndup\texisting\ttwo\t200,2\n");
    const messages = runBackend("dataset", a, [
      { type: "add-dataset", path: b },
      { type: "merge-datasets", dataset_ids: [a, b], name: "AB" },
      { type: "update-cell", dataset_id: "memory:merge:1", row_id: 0, column: "A", value: "edited" },
      { type: "reload", dataset_id: "memory:merge:1" },
      { type: "remove-dataset", dataset_id: a },
      { type: "merge-datasets", dataset_ids: [b, "memory:merge:1"], name: "nested" },
    ]);
    assert.deepEqual(ofType(messages, "merge-error"), []);
    const added = ofType(messages, "dataset-added");
    assert.equal(added[1].dataset.id, "memory:merge:1");
    assert.equal(added[1].dataset.path, null);
    const mergedPages = ofType(messages, "dataset-page").filter(m => m.value.dataset_id === "memory:merge:1");
    assert.equal(mergedPages.at(-1).value.rows[0].A, "one");
    assert.deepEqual(mergedPages.at(-1).value.rows.map(row => row.SpecID), ["dup", "dup"]);
    assert.ok(mergedPages.at(-1).value.columns.includes("SourceDataset_2"));
    assert.ok(ofType(messages, "dataset-added").some(m => m.dataset.id === "memory:merge:2"));
  } finally { tmp.cleanup(); }
});

test("reload accepts changed loading options", { skip }, () => {
  const tmp = tempDir();
  try {
    const source = tmp.file("types.tsv", "ID\tPeak\n007\t1,1\n");
    const messages = runBackend("dataset", source, [
      { type: "reload", page_size: 1, load_options: { inferTypes: true } },
    ]);
    const pages = ofType(messages, "dataset-page");
    assert.equal(pages.at(-1).value.rows[0].ID, 7);
    assert.equal(pages.at(-1).value.page_size, 1);
  } finally { tmp.cleanup(); }
});

test("merge uses merged_dataset as its default name", { skip }, () => {
  const tmp = tempDir();
  try {
    const a = tmp.file("a.tsv", "Name\tPeak\na\t1,1\n");
    const b = tmp.file("b.tsv", "Name\tPeak\nb\t2,2\n");
    const messages = runBackend("dataset", a, [
      { type: "add-dataset", path: b },
      { type: "merge-datasets", dataset_ids: [a, b] },
    ]);
    const merged = ofType(messages, "dataset-added").at(-1).dataset;
    assert.equal(merged.name, "merged_dataset");
  } finally { tmp.cleanup(); }
});
