// Runs in the page's MAIN world. Two jobs for the content script:
//   set:   bring a file's native "Viewed" control. For the React UI we call
//          the button's onClick via __reactProps so React's own state update
//          and network request run (a synthetic DOM click is sometimes ignored).
//   post:  POST /pull/N/file_review — the same request GitHub's button sends —
//          for files whose diff row is virtualized away (not in the DOM).
//          Must run in the page world so the request has Origin: github.com.
// Techniques adapted from gh-pr-auto-viewer (MIT, (c) 2026 Amitai Frey).
(function () {
  if (window.__prvBridge) return;
  window.__prvBridge = true;

  const CH = '__pr_viewed__';
  const { findControl, viewedState } = globalThis.PRV; // lib/dom.js (also loaded in MAIN world)

  function callReactOnClick(btn) {
    const key = Object.keys(btn).find((k) => k.startsWith('__reactProps'));
    const onClick = key && btn[key]?.onClick;
    if (typeof onClick !== 'function') return false;
    onClick({
      preventDefault() {},
      stopPropagation() {},
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
      type: 'click',
      target: btn,
      currentTarget: btn,
      nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true }),
    });
    return true;
  }

  // Bring the file's Viewed control to `want` (true = viewed).
  function set({ path, digest, want = true }) {
    const ctrl = findControl(path, digest);
    if (!ctrl) return { found: false };
    if (viewedState(ctrl) === want) return { found: true };
    if (ctrl.tagName === 'INPUT' || !callReactOnClick(ctrl)) ctrl.click();
    return { found: true };
  }

  function meta(name) {
    return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || null;
  }

  function fetchNonce() {
    for (const n of ['fetch-nonce', 'github-fetch-nonce', 'github-react-fetch-nonce', 'react-fetch-nonce']) {
      const v = meta(n);
      if (v) return v;
    }
    for (const m of document.querySelectorAll('meta[content]')) {
      const c = m.getAttribute('content') || '';
      if (/^v2:[a-f0-9-]+$/i.test(c)) return c;
    }
    return null;
  }

  function clientVersion() {
    const v = meta('github-client-version') || meta('client-version');
    if (v) return v;
    const env = document.querySelector('script[type="application/json"][data-target="client-env"]');
    const m = env?.textContent?.match(/"[A-Za-z_]*(?:version|sha)[A-Za-z_]*"\s*:\s*"([0-9a-f]{40})"/i);
    return m ? m[1] : null;
  }

  async function post({ path }) {
    const base = location.pathname.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)/)?.[1];
    if (!base) return { ok: false, error: 'not a PR page' };
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'GitHub-Verified-Fetch': 'true',
      'GitHub-Is-React': 'true',
    };
    const nonce = fetchNonce();
    if (nonce) headers['X-Fetch-Nonce'] = nonce;
    const ver = clientVersion();
    if (ver) headers['X-GitHub-Client-Version'] = ver;
    const res = await fetch(`${base}/file_review`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ path, viewed: 'viewed' }),
    });
    return { ok: res.ok, status: res.status };
  }

  const handlers = { set, post };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.ch !== CH || e.data.dir !== 'req') return;
    const { id, op, args } = e.data;
    let result;
    try {
      result = await handlers[op](args);
    } catch (err) {
      result = { ok: false, found: false, error: String(err?.message || err) };
    }
    window.postMessage({ ch: CH, dir: 'res', id, result }, '*');
  });
})();
