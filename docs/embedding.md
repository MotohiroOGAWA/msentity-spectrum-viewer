# Using this repository in another project

msentity-spectrum-viewer is meant to be added to other projects as a Git
submodule. It then provides three things, which can be used separately:

| Part | Directory | Use it for |
|---|---|---|
| msentity, msentity-similarity | `external/` (nested submodules) | reading/writing spectra and similarity results from C++, C, Python, Java, C# |
| UI components | `ui/` | showing a dataset table, a spectrum, or a similarity result in any web page or webview |
| Backend and host library | `backend/`, `host/` | serving those components from data files (Node.js host) |

```console
git submodule add <url>/msentity-spectrum-viewer.git third_party/msentity-spectrum-viewer
git submodule update --init --recursive        # also fetches external/msentity*
```

The versions of msentity and msentity-similarity are those recorded in this
repository's submodules, so a project that includes the viewer uses exactly the
libraries the viewer was tested with.

## 1. msentity and msentity-similarity from C++

```cmake
# CMakeLists.txt of your project
set(MSENTITY_VIEWER_BUILD_BACKEND OFF)        # optional: skip the viewer backend
add_subdirectory(third_party/msentity-spectrum-viewer)

target_link_libraries(app PRIVATE msentity::msentity msentity::similarity)
```

```cpp
#include <msentity/msentity.hpp>
#include <msentity/similarity/similarity.hpp>

auto ds = msentity::io::load_ms_dataset("example.msp");          // 2 spectra
auto matrix = msentity::similarity::all_pairs_matrix(ds, ds);    // matrix[1] = 0.759714
```

`add_subdirectory` builds msentity-similarity, which uses `external/msentity`
(the viewer sets `FETCHCONTENT_SOURCE_DIR_MSENTITY` to it), so only one copy of
msentity is compiled. The C APIs used by the language bindings are off by
default; turn them on before `add_subdirectory` when you need them:

```cmake
set(MSENTITY_BUILD_C_API ON CACHE BOOL "" FORCE)             # libmsentity_c
set(MSENTITY_SIMILARITY_BUILD_C_API ON CACHE BOOL "" FORCE)  # libmsentity_similarity_c
```

## 2. msentity from Python, Java, or C#

The bindings live in the nested submodules:

| Language | msentity | msentity-similarity |
|---|---|---|
| Python | `external/msentity/bindings/python` | `external/msentity-similarity/bindings/python` |
| Java | `external/msentity/bindings/java` | `external/msentity-similarity/bindings/java` |
| C# | `external/msentity/bindings/csharp` | `external/msentity-similarity/bindings/csharp` |

Each needs the C library built as above (or the release packages of msentity);
see `external/msentity/docs/bindings.md` and
`external/msentity-similarity/docs/bindings.md`.

## 3. The UI components

Each component is one script and one stylesheet with no dependencies. It
renders into a fixed element and talks to its host only through messages, so
any part can be used on its own:

| Component | Files | Element | Shows |
|---|---|---|---|
| Dataset table | `ui/viewer.js`, `ui/viewer.css` | `<div id="app" data-filename="…">` | paged metadata table, filters, editing, dataset list |
| Spectrum | `ui/spectrum.js`, `ui/spectrum.css` | `<div id="spectrum-app">` | one spectrum or a mirrored comparison, peak table, image export |
| Similarity result | `ui/similarity.js`, `ui/similarity.css` | `<div id="app" data-filename="…">` | result table, histogram/box plot, statistics |

Messages to a component are `message` events on `window`; messages from it go
to `acquireVsCodeApi().postMessage` inside a VS Code webview and to
`window.msentityViewerHost.postMessage` anywhere else. The messages are listed
in [protocol.md](protocol.md).

Example: the spectrum component in a plain page, without any backend:

```html
<link rel="stylesheet" href="ui/spectrum.css">
<div id="spectrum-app"></div>
<script>
  // Messages from the component (image export, peak copy, ...).
  window.msentityViewerHost = { postMessage: (message) => console.log(message) };
</script>
<script src="ui/spectrum.js"></script>
<script>
  window.postMessage({
    type: "spectrum",
    payload: {
      title: "MassSpecID0000001", datasetName: "example.msp", globalIndex: 0,
      columns: ["Name"], row: { Name: "MassSpecID0000001" },
      spectrum: { mz: [91.0542, 125.0233, 185.0961, 246.1125],
                  intensity: [0.245, 1.0, 0.349, 0.735],
                  metadata_columns: [], metadata: [] }
    }
  }, "*");
</script>
```

The components use VS Code's theme variables (`--vscode-editor-background`,
`--vscode-foreground`, …); define them in the page to style the components
outside VS Code.

## 4. The backend and the host library

To show data files, run the backend and connect it to a component. The
Node.js host library does this without VS Code:

```js
const { BackendProcess, RdkitChemistry, DatasetSession, findBackendExecutable } =
  require("./third_party/msentity-spectrum-viewer/host");

const backend = new BackendProcess({
  executable: findBackendExecutable({ roots: ["third_party/msentity-spectrum-viewer"] }),
  mode: "dataset", file: "/data/example.msp", pageSize: 20,
});
const chemistry = new RdkitChemistry();            // optional: SMARTS, structures (needs @rdkit/rdkit)
const session = new DatasetSession(backend, chemistry, (message) => {
  webview.postMessage(message);                     // to ui/viewer.js
});
backend.start();
webview.onMessage((message) => {                    // from ui/viewer.js
  if (message.type === "page-request") {
    session.request({ type: "page", page: message.page, dataset_id: message.datasetId,
                      filters: message.filters, sort: message.sort });
  }
  // ... the other messages: see protocol.md
});
```

Default calculation settings come from the host library as well, so every
host can offer its own defaults (the VS Code extension maps its settings to
these):

```js
const { similaritySettings, comparisonSettings } = require("./third_party/msentity-spectrum-viewer/host");

// Parameters of calculate-similarity: your settings over SIMILARITY_DEFAULTS, validated.
const defaults = similaritySettings({ mz_tolerance_da: 0, mz_tolerance_ppm: 10, threshold: 0.7 });
backend.send({ type: "calculate-similarity", mode: "library_search", dataset1, dataset2,
               path: "/data/result.mssim", parameters: defaults });

// Initial method and tolerance of the score in ui/spectrum.js.
spectrumWebview.postMessage({ type: "comparison-settings", ...comparisonSettings({ tolerance_da: 0.02 }) });
```

`DatasetSession` handles the chemistry part of the protocol: it turns SMARTS
filters into row-id filters with RDKit and answers structure requests. Pass
`null` instead of `chemistry` to leave these features off; RDKit is the
optional dependency `@rdkit/rdkit` of `host/` (`cd host && npm install`).

Messages from the UI need a small translation before they reach the session
(`page-request` → `page`, `datasetId` → `dataset_id`, and dialogs for export,
SpecID, and similarity); [protocol.md](protocol.md#host-messages-from-the-ui)
lists every message, and [`vscode/extension.js`](../vscode/extension.js) is a
complete host.

### Configuring the legacy Dataset Viewer

All controls are visible by default. An embedding can define options before
loading `viewer.js`, call the public API later, or post a `viewer-config`
message. Controls can be hidden independently (hiding `more` hides its entire
menu):

```html
<script>
window.msentityViewerOptions = {
  behavior: {
    copyLockedCells: true,
    lockedCellCopyGesture: "rightClick",
    showCopyNotifications: true
  },
  controls: {
    reload: false, filter: false, export: true, more: true,
    metadata: false, columns: true, assignSpecId: false,
    structureCounts: false, similarity: true,
    loadingOptions: false, settings: true
  },
  settings: [
    // Fixed existing/application setting: retained in values but not shown.
    { id: "mzTolerance", type: "number", value: 0.01, hidden: true },
    // Application-owned visible settings.
    { id: "formulaMode", label: "Formula mode", type: "select", value: "auto",
      options: [{ value: "auto", label: "Automatic" }, { value: "manual", label: "Manual" }] },
    { id: "showIsotopes", label: "Show isotopes", type: "boolean", value: true }
  ]
};
</script>
<script src="ui/viewer.js"></script>
```

Runtime equivalents are
`window.msentityDatasetViewer.configure(options)`, `getOptions()`,
`getSettings()`, and `setSetting(id, value)`. A host can instead send
`{ type: "viewer-config", options }`. Changes from visible settings emit
`viewer-settings-change` with `{ id, value, values }`; the embedding decides
how those generic values map to its own configuration. With no custom setting
definitions, Settings retains its existing VS Code `open-settings` behavior.
Dataset cells are read-only by default and the lock button next to More enables
editing. While locked, right-clicking a cell copies its complete value by default,
including text truncated in the table. Set `behavior.lockedCellCopyGesture` to
`"leftClick"` to use a left-click, `behavior.showCopyNotifications` to `false`
to suppress the success notification, or `behavior.copyLockedCells` to `false`
to disable copying. The VS Code extension exposes the same options under
`msentitySpectrumViewer`.

`findBackendExecutable` finds `build/backend/msentity-viewer-backend` after
building this repository with CMake (section 1 with
`MSENTITY_VIEWER_BUILD_BACKEND` left ON), or an executable given by the
`MSENTITY_VIEWER_BACKEND` environment variable.

## Individual components

New embeddings should load the component bundle. It is framework-free and
exports `window.MsEntityViewer` in a browser or CommonJS exports in Node:

```html
<link rel="stylesheet" href="third_party/msentity-spectrum-viewer/ui/components.css">
<div id="metadata"></div>
<div class="analysis-row">
  <div id="plot"></div>
  <div id="formula-candidates"></div><!-- application-owned -->
  <div id="peaks"></div>
</div>
<script src="third_party/msentity-spectrum-viewer/ui/components.js"></script>
<script>
  const controller = new MsEntityViewer.ViewerController();
  const plot = new MsEntityViewer.SpectrumPlot({ controller }).mount("#plot");
  const peaks = new MsEntityViewer.PeaksTable({ controller }).mount("#peaks");

  // The application decides the layout and can observe the same state.
  const stop = controller.subscribe("peakchange", ({ detail: peak }) => {
    document.querySelector("#formula-candidates").textContent =
      peak ? `Candidates for m/z ${peak.mz}` : "Select a peak";
  });

  controller.setActiveSpectrum({
    datasetId: "library", spectrumId: "scan-42", rowId: 42,
    spectrum: { mz: [91.05, 125.02], intensity: [0.25, 1] }
  });

  // Cleanup when the containing view is removed.
  stop(); plot.destroy(); peaks.destroy(); controller.destroy();
</script>
```

The available views are:

| Class | Responsibility |
|---|---|
| `DatasetTable` | Dataset rows, filtering, sorting, row selection |
| `SpectrumPlot` | Single or top/bottom mirror spectrum and peak selection |
| `PeaksTable` | Peak rows, sorting, annotations, synchronized selection |
| `SimilarityViewer` | Similarity result rows and statistics |
| `StructureViewer` | A structure image/SVG/text; accepts an async `renderStructure` callback so the existing host/RDKit renderer can be reused |
| `DefaultViewer` | Ready-made Dataset + Spectrum + Peaks + Similarity composition |

Every view accepts `{ controller }`, mounts into an element or selector with
`mount(target)`, and releases its DOM and subscriptions with `destroy()` (or
`unmount()`). No global element ID is used internally. Sharing one controller
synchronizes components; using separate controllers creates fully independent
viewers on the same page.

To enable editing without coupling the library to a storage protocol, pass an
async `editCell({ rowIndex, rowId, column, value, row, dataset })` callback to
`DatasetTable`, or `editPeak({ side, peakIndex, column, value, spectrum })` to
`PeaksTable`. Cells become editable on double-click. Return `false` from
`editCell` to reject an update; callbacks can send the existing host edit
messages or use an application-specific data service.

The compact `DefaultViewer` is useful when the embedding application does not
need to choose a layout:

```js
const viewer = new MsEntityViewer.DefaultViewer({
  controller, dataset: initialPage, similarity: initialSimilarityPage
}).mount(document.querySelector("#viewer"));
```

The existing `viewer.js`, `spectrum.js`, and `similarity.js` remain the default
VS Code screens and retain their existing DOM and message behavior.

## Controller API

`ViewerController` has no DOM dependency. Its relevant methods are:

- `getState()`, `getActiveDataset()`, `getActiveSpectrum(side)`,
  `getSelectedPeak()`
- `setActiveDataset(value)`, `setActiveSpectrum(value, side)`,
  `setComparison(top, bottom)`
- `selectPeak(value, side)`, `clearPeakSelection()`
- `setColumnVisibility(component, setting, scope)`,
  `getColumnVisibility(component, scope)`
- `setLoading(key, value)`
- `subscribe(event, listener)` / `on(event, listener)`; the returned function
  unsubscribes. `unsubscribe` / `off` are also available.
- `destroy()` removes all subscribers.

Events are `datasetchange`, `spectrumchange`, `peakchange`,
`columnvisibilitychange`, and `loadingchange`. A listener receives
`{ type, detail, state, controller }`. Subscribing to `change` observes all of
them. Returned state and event detail are copies, so external code cannot
mutate controller state accidentally.

Dataset switches clear spectra and peak selection. Spectrum switches clear a
selection that belongs to a different side or identity. A comparison has
independent `top` and `bottom` spectra.

### Peak selection

A normalized selection contains:

```js
{
  datasetId, spectrumId, spectrumKey, rowId, globalIndex,
  side: "single" | "top" | "bottom",
  peakIndex, mz, intensity
}
```

`peakIndex` is the index in the original spectrum arrays. Tables carry it
through sorting and filtering rather than replacing it with a rendered-row
index. External tools can select a peak with the same object:

```js
controller.selectPeak({ peakIndex: 7, mz: 184.073, intensity: 0.63 }, "top");
controller.clearPeakSelection();
```

### Column visibility

Column settings are separate from row/peak data and never affect edits or
exports. `component` is normally `dataset` or `peaks`; `scope` is commonly a
dataset ID and defaults to `default`.

```js
controller.setColumnVisibility("dataset", {
  available: ["Name", "Formula", "SMILES"], hidden: ["SMILES"]
}, "library");

controller.setColumnVisibility("peaks", {
  visible: ["mz", "intensity", "ion"], hidden: []
}, "library");

const saved = controller.getColumnVisibility("peaks", "library");
// Persist `saved` in the embedding application and pass it back later.
```

Column names are not special-cased. When `available` and `hidden` are given,
the controller derives the ordered visible list. An explicit `visible` list
can both select and order columns.

## Connecting an existing message host

`MessageBridge` maps the existing `spectrum` and `spectrum-comparison`
messages to controller state and additionally accepts `dataset-page`/`page`,
`select-peak`, and `column-visibility`. It listens on `window` by default:

```js
const bridge = new MsEntityViewer.MessageBridge(controller);
// Later:
bridge.destroy(); // removes the window message listener
```

This is additive to the protocol used by the legacy screens. A host can keep
posting the same spectrum messages while migrating its layout component by
component. `MessageBridge.receive(message)` is also available when an
embedding uses its own transport instead of window messages.
