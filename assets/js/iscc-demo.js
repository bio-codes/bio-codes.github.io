/**
 * iscc-demo.js — Live, in-browser ISCC-SUM generation for the BIOCODES site.
 *
 * Computes a file's 256-bit Data-Code (similarity) and Instance-Code (exact
 * identity) plus the composite ISCC-SUM, entirely client-side via @iscc/wasm
 * (the WebAssembly build of iscc-lib, the Rust core of ISO 24138). The file
 * never leaves the browser tab — there is no upload.
 *
 * The file is read exactly once: a streamed reader feeds each chunk to a single
 * SumHasher while the next chunk prefetches from disk, so memory stays bounded
 * for multi-GB files. The SumHasher runs the Data-Code (CDC/MinHash) and
 * Instance-Code (BLAKE3) algorithms in one pass and, on finalize, returns the
 * composite ISCC-SUM, both unit strings, the BLAKE3 datahash, and the byte
 * count together — no second pass over the bytes. The engine's conformance
 * self-test runs once at load.
 */

import init, {
  SumHasher,
  conformance_selftest,
} from "https://cdn.jsdelivr.net/npm/@iscc/wasm@0.5.0/iscc_wasm.js";

/** Get an element by id within the demo. */
const $ = (id) => document.getElementById(id);

/** Escape user-supplied text (a file name) before interpolating into HTML. */
const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Double-quote a file name for the verify command (handles spaces; drops any
 *  embedded double quote, which a real file name effectively never contains). */
const shellQuote = (name) => `"${name.replace(/"/g, "")}"`;

/** Format a byte count as a human-readable string. */
function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(2)) + " " + u[i];
}

// The module is a no-op on pages without the demo (it is only included once).
const drop = $("isccDrop");
if (drop) initDemo();

/** Wire up the demo: lazy engine load, drag/drop, processing, copy buttons. */
function initDemo() {
  const fileInput = $("isccFile");
  const statusWrap = $("isccStatus");
  const statusText = $("isccStatusText");
  const progress = $("isccProgress");
  const progressFill = $("isccProgressFill");
  const results = $("isccResults");

  let readyPromise = null;
  let conformanceOk = false;
  let busy = false;

  /** Set the status pill state and message. */
  function setState(state, msg) {
    statusWrap.dataset.state = state;
    if (msg != null) statusText.textContent = msg;
  }

  /** Load the WASM engine once and run its conformance self-test; awaitable. */
  function ensureReady() {
    if (!readyPromise) {
      setState("loading", "Starting the WebAssembly engine…");
      readyPromise = init()
        .then(() => {
          try { conformanceOk = conformance_selftest(); } catch { conformanceOk = false; }
          setState("ready", "Engine ready — drop a file to compute its ISCC-SUM.");
        })
        .catch((e) => { setState("error", "Could not load the engine: " + e.message); throw e; });
    }
    return readyPromise;
  }

  /**
   * Stream the file once, feeding each chunk to a single SumHasher while the
   * next chunk prefetches from disk. Reports progress and returns the composite
   * result: { iscc, datahash, filesize, units: [dataCode, instanceCode] }.
   */
  async function streamThroughHasher(file) {
    const hasher = new SumHasher();
    const reader = file.stream().getReader();
    const total = file.size;
    let read = 0, lastTick = 0;
    try {
      let pending = reader.read();
      for (;;) {
        const { done, value } = await pending;
        if (done) break;
        pending = reader.read(); // prefetch the next chunk during hashing
        hasher.update(value);
        read += value.length;
        // Repaint the bar and yield ~20×/sec — not on every chunk, or frequent
        // small chunks would stall hashing one animation frame at a time.
        const now = performance.now();
        if (now - lastTick >= 50 || read >= total) {
          lastTick = now;
          progressFill.style.width = (total ? (read / total) * 100 : 100) + "%";
          // requestAnimationFrame is paused in background tabs, so skip it there
          // (the awaited read still yields) to keep hashing at full speed.
          if (!document.hidden && read < total) await new Promise(requestAnimationFrame);
        }
      }
    } finally {
      reader.releaseLock();
    }
    progressFill.style.width = "100%";
    // 256-bit units, 128-bit-unit (wide) composite, include the unit strings —
    // all from the one pass, no re-read of the bytes.
    return hasher.finalize(256, true, true);
  }

  /** Hash one file and render its codes. Ignores drops while already hashing. */
  async function process(file) {
    if (busy) return;
    try { await ensureReady(); } catch { return; }

    busy = true;
    results.classList.remove("is-visible");
    progress.classList.add("is-active");
    progressFill.style.width = "0%";
    setState("working", `Hashing “${file.name}” (${fmtBytes(file.size)})…`);

    try {
      const t0 = performance.now();

      // One streaming pass → composite, both unit codes, and the datahash.
      const sum = await streamThroughHasher(file);
      const elapsed = (performance.now() - t0) / 1000;

      render(file, sum, elapsed);
      setState("done", `Done — ${file.name}`);
    } catch (e) {
      setState("error", "Error: " + e.message);
    } finally {
      busy = false;
      progress.classList.remove("is-active");
    }
  }

  /** Paint the result cards and the size / time / throughput meta row. */
  function render(file, sum, elapsed) {
    const [dataCode, instanceCode] = sum.units;
    const size = sum.filesize;
    $("isccCompositeOut").textContent = sum.iscc;
    $("isccDataOut").textContent = dataCode;
    $("isccInstanceOut").textContent = instanceCode;
    $("isccDatahashOut").textContent = sum.datahash;
    $("isccVerifyCmd").textContent = `uvx iscc-sum --units ${shellQuote(file.name)}`;

    const mbps = elapsed > 0 ? (size / 1048576 / elapsed).toFixed(1) : "∞";

    $("isccMeta").innerHTML =
      metaItem("File", escapeHtml(file.name)) +
      metaItem("Size", fmtBytes(size)) +
      metaItem("Time", `${elapsed.toFixed(2)} s`) +
      metaItem("Throughput", `${mbps} MB/s`, true) +
      `<span class="demo-meta-check${conformanceOk ? "" : " is-bad"}">${conformanceOk ? "✓ self-checked" : "✗ self-test failed"}</span>`;

    results.classList.add("is-visible");
  }

  /** Build one labelled meta entry. */
  function metaItem(label, value, highlight) {
    return `<span class="demo-meta-item${highlight ? " is-highlight" : ""}">` +
      `<span class="demo-meta-label">${label}</span><b>${value}</b></span>`;
  }

  // --- wiring ------------------------------------------------------------
  fileInput.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) process(f); });

  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-dragging"); }));
  ["dragleave", "dragend"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("is-dragging"); }));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("is-dragging");
    const f = e.dataTransfer.files[0];
    if (f) process(f);
  });

  document.querySelectorAll(".demo-copy").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const el = $(btn.dataset.copy);
      const txt = el && el.textContent;
      if (txt && txt !== "—" && navigator.clipboard) {
        navigator.clipboard.writeText(txt).then(() => {
          const old = btn.textContent;
          btn.textContent = "Copied";
          btn.classList.add("is-copied");
          setTimeout(() => { btn.textContent = old; btn.classList.remove("is-copied"); }, 1100);
        });
      }
    }));

  // Verify-locally OS tabs: switch which uv-install command is shown. Only the
  // install panels carry data-os; the run command below them is shared.
  const osTabs = document.querySelectorAll(".demo-verify-tab");
  const osPanels = document.querySelectorAll(".demo-verify-panel[data-os]");
  function selectOs(os) {
    osTabs.forEach((t) => {
      const on = t.dataset.os === os;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    osPanels.forEach((p) => p.classList.toggle("is-active", p.dataset.os === os));
  }
  osTabs.forEach((t) => t.addEventListener("click", () => selectOs(t.dataset.os)));
  if (osTabs.length) {
    // Default to the visitor's own platform so the right command is up front.
    const isWin = /win/i.test(navigator.userAgent || navigator.platform || "");
    selectOs(isWin ? "windows" : "unix");
  }

  // Preload the engine when the demo nears the viewport, and on first intent,
  // so the first drop is instant without blocking initial page render.
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) { ensureReady(); io.disconnect(); }
    }, { rootMargin: "400px" });
    io.observe(drop);
  } else {
    ensureReady();
  }
  ["pointerenter", "focus", "click"].forEach((ev) =>
    drop.addEventListener(ev, ensureReady, { once: true, passive: true }));
}
