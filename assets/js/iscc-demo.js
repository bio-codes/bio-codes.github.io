/**
 * iscc-demo.js — Live, in-browser ISCC-SUM generation for the BIOCODES site.
 *
 * Computes a file's 256-bit Data-Code (similarity) and Instance-Code (exact
 * identity) plus the composite ISCC-SUM, entirely client-side via @iscc/wasm
 * (the WebAssembly build of iscc-lib, the Rust core of ISO 24138). The file
 * never leaves the browser tab — there is no upload.
 *
 * Two paths run and are cross-checked: streaming hashers fed chunk-by-chunk
 * (the single-pass pattern that keeps memory bounded) and a one-shot
 * gen_sum_code_v0() that yields the composite string and BLAKE3 datahash.
 */

import init, { DataHasher, InstanceHasher, gen_sum_code_v0 }
  from "https://cdn.jsdelivr.net/npm/@iscc/wasm@0.4.0/iscc_wasm.js";

const CHUNK = 2 * 1024 * 1024; // 2 MiB feed size for the streaming pass

/** Get an element by id within the demo. */
const $ = (id) => document.getElementById(id);

/** Escape user-supplied text (a file name) before interpolating into HTML. */
const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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

  /** Set the status pill state and message. */
  function setState(state, msg) {
    statusWrap.dataset.state = state;
    if (msg != null) statusText.textContent = msg;
  }

  /** Load the WASM engine once; idempotent and awaitable. */
  function ensureReady() {
    if (!readyPromise) {
      setState("loading", "Starting the WebAssembly engine…");
      readyPromise = init()
        .then(() => setState("ready", "Engine ready — drop a file to compute its ISCC-SUM."))
        .catch((e) => { setState("error", "Could not load the engine: " + e.message); throw e; });
    }
    return readyPromise;
  }

  /**
   * Feed a buffer to both hashers in chunks (single pass), reporting progress.
   * Returns the two 256-bit ISCC strings.
   */
  async function streamThroughHashers(bytes) {
    const dataHasher = new DataHasher();
    const instanceHasher = new InstanceHasher();
    let off = 0, chunks = 0;
    while (off < bytes.length) {
      const slice = bytes.subarray(off, off + CHUNK);
      dataHasher.update(slice);
      instanceHasher.update(slice);
      off += slice.length;
      if (++chunks % 8 === 0 || off >= bytes.length) {
        progressFill.style.width = (bytes.length ? (off / bytes.length) * 100 : 100) + "%";
        // Yield so the progress bar can repaint. requestAnimationFrame is
        // paused in background tabs, so fall back to a microtask there to keep
        // hashing (and the timing) at full speed if the user switches away.
        await (document.hidden ? Promise.resolve() : new Promise(requestAnimationFrame));
      }
    }
    return {
      dataCode: dataHasher.finalize(256),
      instanceCode: instanceHasher.finalize(256),
    };
  }

  /** Hash one file and render its codes. */
  async function process(file) {
    try { await ensureReady(); } catch { return; }

    results.classList.remove("is-visible");
    progress.classList.add("is-active");
    progressFill.style.width = "0%";
    setState("working", `Hashing “${file.name}” (${fmtBytes(file.size)})…`);

    try {
      const t0 = performance.now();
      const bytes = new Uint8Array(await file.arrayBuffer());

      // Path 1: streaming hashers (single pass) → the two 256-bit codes.
      const streamed = await streamThroughHashers(bytes);
      // Path 2: one-shot composite → ISCC-SUM string, datahash, units.
      const sum = gen_sum_code_v0(bytes, 256, true, true);
      const elapsed = (performance.now() - t0) / 1000;

      render(file, bytes.length, streamed, sum, elapsed);
      setState("done", `Done — ${file.name}`);
    } catch (e) {
      setState("error", "Error: " + e.message);
    } finally {
      progress.classList.remove("is-active");
    }
  }

  /** Paint the result cards and the size / time / throughput meta row. */
  function render(file, size, streamed, sum, elapsed) {
    $("isccCompositeOut").textContent = sum.iscc;
    $("isccDataOut").textContent = streamed.dataCode;
    $("isccInstanceOut").textContent = streamed.instanceCode;
    $("isccDatahashOut").textContent = sum.datahash;

    const mbps = elapsed > 0 ? (size / 1048576 / elapsed).toFixed(1) : "∞";
    const u = sum.units || [];
    const match = u[0] === streamed.dataCode && u[1] === streamed.instanceCode;

    $("isccMeta").innerHTML =
      metaItem("File", escapeHtml(file.name)) +
      metaItem("Size", fmtBytes(size)) +
      metaItem("Time", `${elapsed.toFixed(2)} s`) +
      metaItem("Throughput", `${mbps} MB/s`, true) +
      `<span class="demo-meta-check${match ? "" : " is-bad"}">${match ? "✓ self-checked" : "✗ mismatch"}</span>`;

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
