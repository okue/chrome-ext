(function (root) {
  'use strict';
  const DEFAULTS = {
    enabled: true,
    contentCheck: true, // read file headers for "@generated" / "DO NOT EDIT" etc.
    patterns: '', // extra glob patterns, one per line (difit's "auto viewed patterns")
  };
  async function getSettings() {
    return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  }
  root.PRV = Object.assign(root.PRV || {}, { DEFAULTS, getSettings });
})(globalThis);
