// File tree (left sidebar) integration, difit-like:
//  - each file and folder gets a "Viewed" checkbox; viewed entries are dimmed
//  - a folder is checked when all files under it are viewed (mixed = "−")
//  - toggling a file / folder toggles GitHub's native Viewed state
(function () {
  'use strict';
  const CLS = 'prv-viewed';
  const BOX = 'prv-box';
  const { PRV } = globalThis;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DIGEST_RE = /^#diff-([0-9a-f]{64})$/;
  const TREE = '[role="tree"], #pr-file-tree, file-tree';
  const busy = new Set(); // digests being toggled
  const pathCache = new Map(); // digest -> path

  const isFilesPage = () => /\/pull\/\d+\/(files|changes)/.test(location.pathname);

  // ------------------------------------------------------------ tree model

  /** [{digest, link, entry}] for every file currently rendered in the tree. */
  function treeFiles() {
    const out = [];
    for (const a of document.querySelectorAll('a[href^="#diff-"]')) {
      const m = a.getAttribute('href').match(DIGEST_RE);
      if (!m || !a.closest(TREE)) continue;
      out.push({ digest: m[1], link: a, entry: a.closest('[role="treeitem"]') || a });
    }
    return out;
  }

  /** [{entry, label}] for folders: tree items that contain other tree items. */
  function treeDirs() {
    const out = [];
    for (const li of document.querySelectorAll('[role="treeitem"]')) {
      if (!li.closest(TREE) || !li.querySelector('[role="treeitem"]')) continue;
      const label = [...li.children].find((c) => c.getAttribute('role') !== 'group' && c.tagName !== 'UL');
      if (label) out.push({ entry: li, label });
    }
    return out;
  }

  // Full path of a tree file, verified against its digest (sha256(path)).
  async function treePath({ digest, link, entry }) {
    if (pathCache.has(digest)) return pathCache.get(digest);
    const payloadPath = (entry.getAttribute('data-hydro-click-payload') || '').match(/"path":"([^"]+)"/)?.[1];
    const candidates = [
      entry.id,
      entry.getAttribute('data-path'),
      entry.querySelector('[data-filterable-item-text]')?.textContent,
      payloadPath,
      link.getAttribute('title'),
      entry.getAttribute('aria-label'),
      link.textContent,
    ];
    for (const c of candidates) {
      const p = (c || '').trim();
      if (p && (await PRV.sha256Hex(p)) === digest) {
        pathCache.set(digest, p);
        return p;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ toggling

  /** Set without scrolling. Returns false if the file needs a jump. */
  async function setInPlace(file, want) {
    const { digest } = file;
    if (PRV.findControl(null, digest)) {
      await PRV.bridge('set', { digest, want });
      await PRV.waitViewed(null, digest, want);
      return true;
    }
    // Row not mounted. New UI + marking viewed → same POST as GitHub's button.
    if (want && PRV.isNewUi()) {
      const path = await treePath(file);
      if (path && (await PRV.bridge('post', { path })).ok) {
        PRV.knownViewed.set(digest, true);
        PRV.uiSync.set(digest, true);
        return true;
      }
    }
    return false;
  }

  /** Jump to the file so its row mounts, then use its control. */
  async function setByJump(file, want) {
    file.link.click();
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if (PRV.findControl(null, file.digest)) {
        await PRV.bridge('set', { digest: file.digest, want });
        await PRV.waitViewed(null, file.digest, want);
        return;
      }
    }
  }

  async function setFiles(files, want) {
    files = files.filter((f) => !busy.has(f.digest) && PRV.knownViewed.get(f.digest) !== want);
    files.forEach((f) => {
      busy.add(f.digest);
      PRV.uiSync.delete(f.digest); // the user's choice overrides a pending sync
    });
    try {
      const needJump = [];
      for (const f of files) if (!(await setInPlace(f, want))) needJump.push(f);
      for (const f of needJump) await setByJump(f, want);
    } finally {
      files.forEach((f) => busy.delete(f.digest));
      schedule();
    }
  }

  // ------------------------------------------------------------ checkbox UI

  // The box goes on the left of the row's icon: [chevron] [box] [icon] name.
  // Row layouts (legacy ActionList / Primer TreeView) are CSS grids, and a new
  // direct child would be auto-placed into whatever cell is empty (often the
  // trailing one, on the right). So the box goes *inside* the icon's wrapper
  // (or inside the name label when there is no icon), never into the grid.
  const LABEL_SEL =
    '.ActionList-item-label, [class*="item-content-text"], [class*="ContentText"], [class*="ItemLabel"]';

  /** [parent, nextSibling] the box should sit at in `row`. */
  function boxSlot(row) {
    const label = row.querySelector(LABEL_SEL);
    if (!label) return [row, row.firstChild];
    const icon = label.previousElementSibling;
    if (icon?.matches('svg')) return [icon.parentElement, icon];
    if (icon?.querySelector('svg')) return [icon, icon.firstChild];
    return [label, label.firstChild];
  }

  function ensureBox(row, onClick) {
    let box = row.querySelector(`.${BOX}`);
    if (!box) {
      // A span, not <input>: legacy folder rows are <button>s, and an input
      // inside a button doesn't reliably receive its own clicks.
      box = document.createElement('span');
      box.className = BOX;
      box.setAttribute('role', 'checkbox');
      box.tabIndex = -1;
      box.addEventListener('click', (e) => {
        // Keep the click away from the tree's own handlers (navigate / expand).
        e.preventDefault();
        e.stopPropagation();
        box.prvOnClick?.();
      });
      for (const t of ['mousedown', 'pointerdown', 'mouseup', 'pointerup']) {
        box.addEventListener(t, (e) => e.stopPropagation());
      }
    }
    // Re-place only when off (a no-op move would still fire the MutationObserver).
    const [parent, next] = boxSlot(row);
    if (box.parentNode !== parent || (next !== box && box.nextSibling !== next)) parent.insertBefore(box, next);
    box.prvOnClick = onClick;
    return box;
  }

  /** state: true | false | 'mixed' | undefined (unknown) */
  function render(box, dimTarget, state, unknownTitle) {
    box.setAttribute('aria-checked', state === 'mixed' ? 'mixed' : String(state === true));
    box.title = state === undefined ? unknownTitle : 'Viewed';
    if (dimTarget.classList.contains(CLS) !== (state === true)) dimTarget.classList.toggle(CLS, state === true);
  }

  async function refresh() {
    if (!isFilesPage()) return;

    // Rows we saved via POST while unmounted: sync their React state now.
    for (const [digest, want] of [...PRV.uiSync]) {
      const ctrl = PRV.findControl(null, digest);
      if (!ctrl) continue;
      PRV.uiSync.delete(digest);
      if (PRV.viewedState(ctrl) !== want) await PRV.bridge('set', { digest, want });
    }

    // Learn states from diff rows currently in the DOM.
    for (const { digest, control } of PRV.allRows()) {
      if (PRV.uiSync.has(digest) || busy.has(digest)) continue;
      const v = PRV.viewedState(control);
      if (v !== null) PRV.knownViewed.set(digest, v);
    }

    const files = treeFiles();
    for (const file of files) {
      // Whole entry, not the link: the link may wrap only the name, not the icon.
      const box = ensureBox(file.entry, () => setFiles([file], PRV.knownViewed.get(file.digest) !== true));
      render(box, file.link, PRV.knownViewed.get(file.digest), 'Viewed（状態未取得：ファイルを表示すると反映）');
      box.classList.toggle('prv-busy', busy.has(file.digest));
    }

    for (const dir of treeDirs()) {
      const inside = files.filter((f) => dir.entry.contains(f.entry));
      const states = inside.map((f) => PRV.knownViewed.get(f.digest) === true);
      const all = states.length > 0 && states.every(Boolean);
      const state = all ? true : states.some(Boolean) ? 'mixed' : states.length ? false : undefined;
      // Folder click: view all, or un-view all when everything is viewed.
      const box = ensureBox(dir.label, () => setFiles(inside, !all));
      render(box, dir.label, state, 'フォルダを展開すると反映');
      box.classList.toggle('prv-busy', inside.some((f) => busy.has(f.digest)));
    }
  }

  // ------------------------------------------------------------ wiring

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  };
  PRV.refreshTree = schedule;

  // Rows mount/unmount (virtualized list) and the React button flips
  // aria-pressed / aria-label when toggled.
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed', 'aria-label', 'checked'],
  });
  // Legacy checkbox state is a property (no attribute mutation).
  document.addEventListener('change', (e) => {
    if (e.target.matches?.('input.js-reviewed-checkbox, input[name="viewed"]')) schedule();
  }, true);
  // New PR page → forget the previous PR's states.
  let lastPr = null;
  setInterval(() => {
    const pr = location.pathname.match(/^\/[^/]+\/[^/]+\/pull\/\d+/)?.[0];
    if (pr !== lastPr) {
      lastPr = pr;
      PRV.knownViewed.clear();
      PRV.uiSync.clear();
      pathCache.clear();
      schedule();
    }
  }, 500);
  schedule();
})();
