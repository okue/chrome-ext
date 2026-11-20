// GitHub PR "Files changed" DOM helpers. Loaded in both the isolated world
// (content scripts) and the page MAIN world (bridge.js).
//
// Legacy /files : div.file[data-tagsearch-path] + input.js-reviewed-checkbox
// New /changes  : virtualized rows + <button aria-label="Viewed|Not Viewed" aria-pressed>
//                 (row attributes vary between builds, so a row is found by
//                 walking up from its Viewed control to the nearest ancestor
//                 that identifies exactly one file via id / #diff-<digest> link)
// File tree     : <li role="treeitem"> containing <a href="#diff-<sha256(path)>">
(function (root) {
  'use strict';
  const VIEWED_RE = /^(not )?viewed$/i;
  const DIGEST_IN = /(?:^|#|-)diff-([0-9a-f]{64})/;
  const CONTROL_SELECTOR = 'input.js-reviewed-checkbox, input[name="viewed"], button[aria-label]';

  const isViewedControl = (el) =>
    el.tagName === 'INPUT' || VIEWED_RE.test((el.getAttribute('aria-label') || '').trim());

  function viewedControls(scope = document) {
    return [...scope.querySelectorAll(CONTROL_SELECTOR)].filter(isViewedControl);
  }

  /** Digest identifying `el` as one file's container; 'MANY' if it spans several files. */
  function digestOf(el) {
    const own =
      el.getAttribute('data-path-digest') ||
      el.id?.match(DIGEST_IN)?.[1] ||
      el.getAttribute('data-anchor')?.match(DIGEST_IN)?.[1];
    if (own) return own;
    const found = new Set();
    for (const a of el.querySelectorAll('a[href*="#diff-"], [data-anchor^="diff-"], [id^="diff-"]')) {
      const m = (a.getAttribute('href') || a.getAttribute('data-anchor') || a.id).match(DIGEST_IN);
      if (m) found.add(m[1]);
      if (found.size > 1) return 'MANY';
    }
    return found.size === 1 ? [...found][0] : null;
  }

  /** {row, digest} for a Viewed control, by walking up to the file container. */
  function rowOfControl(ctrl) {
    let el = ctrl.parentElement;
    for (let i = 0; i < 25 && el && el !== document.body; i++, el = el.parentElement) {
      if (el.closest('[role="tree"], #pr-file-tree')) return null;
      const d = digestOf(el);
      if (d === 'MANY') return null;
      if (d) return { row: el, digest: d };
    }
    return null;
  }

  /** All mounted file rows: [{row, digest, control}] */
  function allRows() {
    const out = [];
    const seen = new Set();
    for (const control of viewedControls()) {
      const r = rowOfControl(control);
      if (r && !seen.has(r.digest)) {
        seen.add(r.digest);
        out.push({ ...r, control });
      }
    }
    return out;
  }

  /** Viewed control of a file, or null if its row isn't mounted. */
  function findControl(path, digest) {
    const legacy = path && document.querySelector(`.file[data-tagsearch-path="${CSS.escape(path)}"]`);
    if (legacy) return viewedControls(legacy)[0] || null;
    return allRows().find((r) => r.digest === digest)?.control || null;
  }

  /** @returns {null | boolean} */
  function viewedState(control) {
    if (!control) return null;
    if (control.tagName === 'INPUT') return control.checked;
    const pressed = control.getAttribute('aria-pressed');
    return pressed != null ? pressed === 'true' : /^viewed$/i.test(control.getAttribute('aria-label').trim());
  }

  /** File-tree entry (li[role=treeitem] or the link itself) for a digest. */
  function treeEntry(digest) {
    const li = document.getElementById(`file-tree-item-diff-${digest}`);
    if (li) return li;
    for (const a of document.querySelectorAll(`a[href="#diff-${digest}"]`)) {
      if (a.closest('[role="tree"], #pr-file-tree, file-tree, nav')) return a.closest('[role="treeitem"]') || a;
    }
    return null;
  }

  const isNewUi = () => /\/pull\/\d+\/changes/.test(location.pathname) || !!document.querySelector('[data-path-digest]');

  root.PRV = Object.assign(root.PRV || {}, {
    allRows,
    findControl,
    viewedState,
    treeEntry,
    isNewUi,
    // digest -> boolean. Filled from mounted rows and from our own marking,
    // so files whose diff row is not in the DOM keep their known state.
    knownViewed: new Map(),
  });
})(globalThis);
