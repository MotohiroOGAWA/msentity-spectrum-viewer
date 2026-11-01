const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ViewerController, MessageBridge, normalizePeak } = require("../../ui/components");

const spectrum = (datasetId, rowId, mz = [200, 100], intensity = [2, 1]) => ({
  datasetId, rowId, spectrumId: `s${rowId}`, spectrum: { mz, intensity },
});

test("peak selections have stable source indices and complete identity", () => {
  const controller = new ViewerController();
  controller.setActiveSpectrum(spectrum("d1", 4));
  controller.selectPeak({ peakIndex: 1, mz: 100, intensity: 1 });
  assert.deepEqual(controller.getSelectedPeak(), {
    datasetId: "d1", spectrumId: "s4", spectrumKey: null, rowId: 4, globalIndex: null,
    side: "single", peakIndex: 1, mz: 100, intensity: 1,
  });
});

test("mirror selection distinguishes top and bottom", () => {
  const controller = new ViewerController();
  controller.setComparison(spectrum("a", 1), spectrum("b", 2));
  controller.selectPeak({ peakIndex: 0, mz: 200, intensity: 2 }, "bottom");
  assert.equal(controller.getSelectedPeak().side, "bottom");
  assert.equal(controller.getSelectedPeak().datasetId, "b");
});

test("spectrum and dataset changes clear stale peak selection", () => {
  const controller = new ViewerController();
  controller.setActiveSpectrum(spectrum("a", 1)).selectPeak({ peakIndex: 0, mz: 1, intensity: 1 });
  controller.setActiveSpectrum(spectrum("a", 2));
  assert.equal(controller.getSelectedPeak(), null);
  controller.selectPeak({ peakIndex: 0, mz: 1, intensity: 1 }).setActiveDataset({ datasetId: "b" });
  assert.equal(controller.getSelectedPeak(), null);
  assert.equal(controller.getActiveSpectrum(), null);
});

test("subscriptions return an unsubscribe function", () => {
  const controller = new ViewerController(), values = [];
  const unsubscribe = controller.subscribe("peakchange", event => values.push(event.detail));
  controller.setActiveSpectrum(spectrum("a", 1)).selectPeak({ peakIndex: 0, mz: 1, intensity: 2 });
  unsubscribe(); controller.clearPeakSelection();
  assert.equal(values.length, 1);
});

test("column visibility is generic, scoped, and independent from data", () => {
  const controller = new ViewerController();
  controller.setColumnVisibility("peaks", { available: ["mz", "intensity", "ion"], hidden: ["ion"] }, "d1");
  assert.deepEqual(controller.getColumnVisibility("peaks", "d1"), { visible: ["mz", "intensity"], hidden: ["ion"] });
  assert.deepEqual(controller.getColumnVisibility("peaks", "d2"), { visible: null, hidden: [] });
});

test("controllers on the same page remain independent", () => {
  const first = new ViewerController(), second = new ViewerController();
  first.setActiveSpectrum(spectrum("a", 1)).selectPeak({ peakIndex: 0, mz: 1, intensity: 1 });
  assert.equal(second.getActiveSpectrum(), null);
  assert.equal(second.getSelectedPeak(), null);
});

test("message bridge accepts existing spectrum messages and cleans up", () => {
  const listeners = new Set();
  const source = {
    addEventListener(type, fn) { if (type === "message") listeners.add(fn); },
    removeEventListener(type, fn) { if (type === "message") listeners.delete(fn); },
  };
  const controller = new ViewerController(), bridge = new MessageBridge(controller, { source, target: null });
  for (const listener of listeners) listener({ data: { type: "spectrum", payload: spectrum("a", 1) } });
  assert.equal(controller.getActiveSpectrum().datasetId, "a");
  bridge.destroy(); assert.equal(listeners.size, 0);
});

test("peak validation rejects ambiguous indices and invalid sides", () => {
  assert.throws(() => normalizePeak({ mz: 1 }, "single"), /peakIndex/);
  assert.throws(() => normalizePeak({ peakIndex: 0 }, "left"), /side/);
});
