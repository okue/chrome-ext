// Isolated-world client for bridge.js (page MAIN world), plus shared state.
(function (root) {
  'use strict';
  const CH = '__pr_viewed__';
  let reqId = 0;

  /** op: 'set' {path?, digest, want} | 'post' {path} */
  function bridge(op, args, timeoutMs = 10000) {
    const id = `${Date.now()}-${++reqId}`;
    return new Promise((resolve) => {
      const onMsg = (e) => {
        if (e.source !== window || e.data?.ch !== CH || e.data.dir !== 'res' || e.data.id !== id) return;
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(e.data.result || {});
      };
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, found: false, error: 'timeout' });
      }, timeoutMs);
      window.addEventListener('message', onMsg);
      window.postMessage({ ch: CH, dir: 'req', id, op, args }, '*');
    });
  }

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Wait until the file's Viewed control reports `want` (true/false). */
  async function waitViewed(path, digest, want = true, ms = 2000) {
    for (let t = 0; t < ms; t += 100) {
      await new Promise((r) => setTimeout(r, 100));
      if (root.PRV.viewedState(root.PRV.findControl(path, digest)) === want) return true;
    }
    return false;
  }

  root.PRV = Object.assign(root.PRV || {}, {
    bridge,
    sha256Hex,
    waitViewed,
    // digest -> wanted state, saved on GitHub via POST while the row was not
    // mounted; applied to the row's button once it mounts (React state sync).
    uiSync: new Map(),
  });
})(globalThis);
