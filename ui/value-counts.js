(() => {
  const host = acquireVsCodeApi();
  const app = document.getElementById("app");
  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const display = value => {
    if (value == null) return "<em>(Missing)</em>";
    if (value === "") return "<em>(Empty)</em>";
    return escapeHtml(typeof value === "object" ? JSON.stringify(value) : value);
  };

  let page = 0;
  let result;
  let mode = "scroll";
  let pageSize = 100;

  function configure(settings) {
    const size = Number(settings?.pageSize);
    pageSize = Number.isFinite(size) ? Math.max(1, Math.min(5000, Math.trunc(size))) : 100;
    mode = settings?.mode === "pages" ? "pages" : "scroll";
    page = 0;
  }
  let widths;

  function enableColumnResize(table) {
    const headers = [...table.tHead.rows[0].cells];
    const columns = [...table.querySelectorAll("col")];
    const applyWidths = () => {
      table.classList.add("has-custom-widths");
      table.style.width = `${widths[0] + widths[1]}px`;
      columns.forEach((column, index) => { column.style.width = `${widths[index]}px`; });
    };
    if (widths) applyWidths();

    headers.forEach((header, index) => {
      const handle = header.querySelector(".column-resize-handle");
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        widths ??= headers.map(cell => Math.round(cell.getBoundingClientRect().width));
        const startWidth = widths[index];
        const startX = event.clientX;
        const move = current => {
          if (current.pointerId !== event.pointerId) return;
          widths[index] = Math.max(48, startWidth + current.clientX - startX);
          applyWidths();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("lostpointercapture", () => {
          handle.removeEventListener("pointermove", move);
          handle.classList.remove("is-resizing");
        }, { once: true });
        handle.classList.add("is-resizing");
      });
    });
  }
  function render() {
    const { column, dataset_name, rows, total_rows } = result;
    const paged = mode === "pages";
    const start = paged ? page * pageSize : 0;
    const end = paged ? Math.min(start + pageSize, rows.length) : rows.length;
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    app.innerHTML = `<div class="viewer">
      <div class="toolbar">
        <div class="summary"><strong>${escapeHtml(dataset_name)} · ${escapeHtml(column)}</strong>
          <span>${rows.length.toLocaleString()} distinct values in ${total_rows.toLocaleString()} rows</span></div>
        <button class="secondary-button" id="export-counts">Export CSV / TSV…</button>
      </div>
      <div class="table-wrap"><table class="dataset-table value-counts-table">
        <colgroup><col><col></colgroup>
        <thead><tr>${[column, column === "Count" ? "Occurrences" : "Count"].map(label =>
          `<th scope="col"><span class="value-counts-heading" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="column-resize-handle" aria-hidden="true"></span></th>`).join("")}</tr></thead>
        <tbody>${rows.length ? (paged ? rows.slice(start, end) : rows).map(({ value, count }) =>
          `<tr><td>${display(value)}</td><td>${count.toLocaleString()}</td></tr>`).join("")
          : '<tr><td colspan="2" class="empty">No rows to count.</td></tr>'}</tbody>
      </table></div>
      ${paged ? `<div class="pagination">
        <span>${rows.length ? start + 1 : 0}–${end} of ${rows.length}</span>
        <div class="page-controls">
          <button id="prev-counts" aria-label="Previous page" ${page === 0 ? "disabled" : ""}>‹</button>
          <span><input id="counts-page" type="number" min="1" max="${pageCount}" value="${page + 1}" aria-label="Page number" title="Enter a page number and press Enter"> / ${pageCount}</span>
          <button id="next-counts" aria-label="Next page" ${page + 1 >= pageCount ? "disabled" : ""}>›</button>
        </div>
      </div>` : ""}
    </div>`;
    enableColumnResize(app.querySelector(".value-counts-table"));
    document.getElementById("export-counts").onclick = () => host.postMessage({ type: "save-value-counts" });
    if (!paged) return;
    function goToPage(number, controlId) {
      const target = Math.min(pageCount, Math.max(1, Math.trunc(number)));
      if (!Number.isFinite(target) || target === page + 1) {
        document.getElementById("counts-page").value = page + 1;
        return;
      }
      page = target - 1;
      render();
      const control = document.getElementById(controlId);
      (control.disabled ? document.getElementById("counts-page") : control).focus();
    }
    document.getElementById("prev-counts").onclick = () => goToPage(page, "prev-counts");
    document.getElementById("next-counts").onclick = () => goToPage(page + 2, "next-counts");
    const pageInput = document.getElementById("counts-page");
    pageInput.addEventListener("keydown", event => {
      if (event.key === "Enter") goToPage(pageInput.valueAsNumber, pageInput.id);
    });
  }

  window.addEventListener("message", ({ data }) => {
    if (data?.type === "column-value-counts") result = data;
    else if (data?.type !== "value-counts-settings") return;
    configure(data.settings);
    if (result) render();
  });
  host.postMessage({ type: "webview-ready" });
})();
