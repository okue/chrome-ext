// Service worker: fetches the PR diff and decides which files to auto-mark as
// Viewed using difit's rules. Runs here (not in the content script) because
// the diff host (patch-diff.githubusercontent.com) sends no CORS headers.
importScripts('lib/generated.js', 'lib/diff.js', 'lib/settings.js');

const { PRV } = globalThis;
const RAW_CONCURRENCY = 6;
const RAW_MAX_FILES = 200;
const HEAD_SCAN_BYTES = 4 * 1024; // same as difit

const cache = new Map(); // `${owner}/${repo}#${n}` -> { at, promise }
const CACHE_TTL_MS = 30 * 1000;

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// Read only the first few KB of a file (like difit's header scan).
async function fetchHead(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < HEAD_SCAN_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  const head = buf.subarray(0, HEAD_SCAN_BYTES);
  if (head.includes(0)) return null; // binary
  return new TextDecoder().decode(head).split('\n').slice(0, PRV.HEADER_LINES);
}

async function findHeadSha(owner, repo, number) {
  const html = await fetchText(`https://github.com/${owner}/${repo}/pull/${number}`);
  const m =
    html.match(/"headSha":"([0-9a-f]{40})"/) ||
    html.match(/"headRefOid":"([0-9a-f]{40})"/) ||
    html.match(/end_commit_oid=([0-9a-f]{40})/);
  return m ? m[1] : null;
}

const rawUrl = (owner, repo, sha, path) =>
  `https://github.com/${owner}/${repo}/raw/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function analyze({ owner, repo, number, headSha }) {
  const settings = await PRV.getSettings();
  const patterns = PRV.parsePatterns(settings.patterns);
  const files = PRV.parseDiff(await fetchText(`https://github.com/${owner}/${repo}/pull/${number}.diff`));

  // Head commit is needed to read raw files (.gitattributes, file headers).
  const s = headSha || (await findHeadSha(owner, repo, number).catch(() => null));

  // Root .gitattributes `linguist-generated` (difit honors it via git check-attr).
  let attrRules = [];
  if (s) {
    const text = await fetchText(rawUrl(owner, repo, s, '.gitattributes')).catch(() => '');
    attrRules = PRV.parseGitattributes(text);
  }

  const results = [];
  const contentCandidates = [];
  for (const f of files) {
    const key = f.blob || '';
    const byPath = PRV.isGeneratedPath(f.path);
    let reason = null;
    if (f.status === 'deleted') reason = 'deleted';
    else if (byPath.isGenerated) reason = `generated (${byPath.matchedPattern})`;
    else if (PRV.isLinguistGenerated(f.path, attrRules)) reason = 'linguist-generated';
    else if (PRV.matchesAnyPattern(f.path, patterns)) reason = 'pattern';

    if (reason) results.push({ path: f.path, reason, key });
    else if (settings.contentCheck && !f.binary && !PRV.isMarkdown(f.path)) contentCandidates.push(f);
  }

  // Header-based detection (difit layers 2 & 3). Use the diff when it already
  // contains line 1 of the file; otherwise read the head of the raw file.
  const needRaw = [];
  for (const f of contentCandidates) {
    if (f.headerLines) {
      const r = PRV.isGeneratedContent(f.path, f.headerLines);
      if (r.isGenerated) results.push({ path: f.path, reason: `generated (content: ${r.matchedPattern})`, key: f.blob || '' });
    } else {
      needRaw.push(f);
    }
  }
  if (needRaw.length && s) {
    await mapLimit(needRaw.slice(0, RAW_MAX_FILES), RAW_CONCURRENCY, async (f) => {
      const lines = await fetchHead(rawUrl(owner, repo, s, f.path)).catch(() => null);
      if (!lines) return;
      const r = PRV.isGeneratedContent(f.path, lines);
      if (r.isGenerated) results.push({ path: f.path, reason: `generated (content: ${r.matchedPattern})`, key: f.blob || '' });
    });
  }

  return { targets: results, total: files.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'analyze') {
    const k = `${msg.owner}/${msg.repo}#${msg.number}`;
    const hit = cache.get(k);
    if (!msg.force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
      hit.promise.then(sendResponse);
      return true;
    }
    const promise = analyze(msg).then(
      (r) => ({ ok: true, ...r }),
      (e) => ({ ok: false, error: String(e?.message || e) }),
    );
    cache.set(k, { at: Date.now(), promise });
    promise.then(sendResponse);
    return true;
  }
  if (msg?.type === 'badge' && sender.tab?.id != null) {
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: msg.error ? '#d1242f' : '#1f6feb' });
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.text || '' });
    chrome.action.setTitle({ tabId: sender.tab.id, title: msg.title || 'PR Auto Viewed' });
  }
});

// Toolbar click: re-run on the current PR, ignoring "already auto-marked" memory.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'rerun' }).catch(() => {});
});
