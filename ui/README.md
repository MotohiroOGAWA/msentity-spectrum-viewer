# UI components

Framework-free webview components of msentity-spectrum-viewer:

| Component | Files | Root element |
|---|---|---|
| Dataset table | `viewer.js`, `viewer.css` | `<div id="app" data-filename="…">` |
| Spectrum | `spectrum.js`, `spectrum.css` | `<div id="spectrum-app">` |
| Similarity result | `similarity.js`, `similarity.css` | `<div id="app" data-filename="…">` |

For new embeddings, `components.js` and `components.css` expose independent
`DatasetTable`, `SpectrumPlot`, `PeaksTable`, `SimilarityViewer`, and
`StructureViewer` classes. They can mount into any element and share a
`ViewerController`; unlike the legacy entry points they do not use global DOM
IDs. `DefaultViewer` provides a ready-made composition. See
[embedding.md](../docs/embedding.md#individual-components).

A component receives messages as `message` events on `window` and sends them
with `acquireVsCodeApi().postMessage` in a VS Code webview, otherwise with
`window.msentityViewerHost.postMessage` (define it before loading the script).
Messages: [../docs/protocol.md](../docs/protocol.md); embedding example:
[../docs/embedding.md](../docs/embedding.md#3-the-ui-components).
