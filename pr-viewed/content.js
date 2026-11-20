// Content script (isolated world). On a PR "Files changed" page, asks the
// background which files difit would auto-collapse, then marks them Viewed
// using GitHub's own Viewed control (so state is saved on GitHub).
(function () {
  'use strict';
  const TAG = '[pr-viewed]';
  const PR_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)(?:\/|$)/;
  const MAX_CLICK_ATTEMPTS = 3;

  /** @type {null | {prKey:string, pending:Map<string,any>, targets:any[], marked:number, skipped:number}} */
  let session = null;

  // --------------------------------------------------------------- helpers

  function parsePr() {
    const m = location.pathname.match(PR_RE);
    return m && { owner: m[1], repo: m[2], number: m[3] };
  }

  function findHeadShaInPage() {
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const m = s.textContent.match(/"headSha":"([0-9a-f]{40})"/) || s.textContent.match(/"headRefOid":"([0-9a-f]{40})"/);
      if (m) return m[1];
    }
    const el = document.querySelector('[src*="end_commit_oid="],[data-url*="end_commit_oid="],[href*="end_commit_oid="]');
    const attr = el && (el.getAttribute('src') || el.getAttribute('data-url') || el.getAttribute('href'));
    return attr?.match(/end_commit_oid=([0-9a-f]{40})/)?.[1] || null;
  }

  const { findControl, viewedState, isNewUi, bridge, sha256Hex, waitViewed } = PRV;

  // --------------------------------------------------------------- storage
  // Remember what we auto-marked (per PR, path → blob id) so a file you
  // un-view by hand is not re-marked on reload — unless its content changed.

  const storeKey = (prKey) => `pr:${prKey}`;

  async function loadStore(prKey) {
    const v = (await chrome.storage.local.get(storeKey(prKey)))[storeKey(prKey)];
    return v?.files || {};
  }

  async function remember(prKey, path, key) {
    const files = await loadStore(prKey);
    files[path] = key;
    await chrome.storage.local.set({ [storeKey(prKey)]: { at: Date.now(), files } });
  }

  // ------------------------------------------------------------------ badge

  function updateBadge(extra) {
    if (!session) return chrome.runtime.sendMessage({ type: 'badge', text: '' }).catch(() => {});
    const { targets, marked, skipped, pending } = session;
    const lines = targets.map((t) => `${t.path}  — ${t.reason}`);
    chrome.runtime
      .sendMessage({
        type: 'badge',
        text: targets.length ? String(targets.length) : '',
        title:
          `PR Auto Viewed: ${marked} marked, ${skipped} already handled, ${pending.size} pending\n` +
          `(click to re-apply)\n\n` +
          lines.slice(0, 40).join('\n') +
          (lines.length > 40 ? `\n… +${lines.length - 40}` : ''),
        ...extra,
      })
      .catch(() => {});
  }

  // ------------------------------------------------------------ main logic

  async function markDone(s, path, t) {
    s.pending.delete(path);
    PRV.knownViewed.set(t.digest, true);
    PRV.refreshTree?.();
    s.marked++;
    await remember(s.prKey, path, t.key);
  }

  let busy = false;
  let again = false;

  async function processPending() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        const s = session;
        if (!s) return;

        for (const [path, t] of [...s.pending]) {
          if (session !== s) return;
          const control = findControl(path, t.digest);
          const state = viewedState(control);

          if (state === true) {
            await markDone(s, path, t);
          } else if (state === false) {
            if (t.attempts >= MAX_CLICK_ATTEMPTS) continue;
            t.attempts++;
            const r = await bridge('set', { path, digest: t.digest, want: true });
            if (r.found && (await waitViewed(path, t.digest))) await markDone(s, path, t);
          } else if (!control && isNewUi() && !t.apiTried) {
            // Row is virtualized away: save Viewed on GitHub directly, then
            // sync the React UI once the row scrolls into the DOM.
            t.apiTried = true;
            const r = await bridge('post', { path });
            if (r.ok) {
              PRV.uiSync.set(t.digest, true);
              await markDone(s, path, t);
            } else {
              console.warn(TAG, 'file_review POST failed', path, r);
            }
          }
        }

        updateBadge();
      } while (again);
    } finally {
      busy = false;
    }
  }

  async function run(force = false) {
    const pr = parsePr();
    if (!pr) {
      if (session) { session = null; updateBadge(); }
      return;
    }
    const settings = await PRV.getSettings();
    if (!settings.enabled && !force) return;

    const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
    if (!force && session?.prKey === prKey) return void processPending();

    const s = (session = { prKey, pending: new Map(), targets: [], marked: 0, skipped: 0 });
    chrome.runtime.sendMessage({ type: 'badge', text: '…' }).catch(() => {});

    const res = await chrome.runtime.sendMessage({ type: 'analyze', ...pr, headSha: findHeadShaInPage(), force });
    if (session !== s) return;
    if (!res?.ok) {
      console.warn(TAG, 'analyze failed:', res?.error);
      updateBadge({ text: '!', error: true, title: `PR Auto Viewed: failed to load diff\n${res?.error || ''}` });
      return;
    }

    const store = force ? {} : await loadStore(prKey);
    s.targets = res.targets;
    for (const t of res.targets) {
      if (store[t.path] === t.key) { s.skipped++; continue; }
      s.pending.set(t.path, { ...t, digest: await sha256Hex(t.path), attempts: 0, apiTried: false });
    }
    console.info(TAG, `${res.targets.length}/${res.total} files to auto-view`, res.targets);
    updateBadge();
    processPending();
  }

  // --------------------------------------------------------------- wiring

  let timer = null;
  const observer = new MutationObserver(() => {
    if (!session?.pending.size) return;
    clearTimeout(timer);
    timer = setTimeout(processPending, 200);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // GitHub navigates as an SPA (Turbo / React Router).
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      run();
    }
  }, 500);
  document.addEventListener('turbo:load', () => run());

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'rerun') run(true);
  });

  run();
})();
