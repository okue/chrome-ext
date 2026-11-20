// Minimal unified-diff parser for GitHub's `pull/N.diff`.
// Extracts, per file: path, status, blob id, and the first lines of the new
// file when the diff happens to include line 1 (so we can skip a raw fetch).
(function (root) {
  'use strict';

  const HEADER_LINES = 20; // same as difit

  // git quotes paths with special chars: "b/\343\201\202.txt"
  function unquote(s) {
    if (!s.startsWith('"')) return s;
    const bytes = [];
    for (let i = 1; i < s.length - 1; i++) {
      const c = s[i];
      if (c !== '\\') {
        bytes.push(...new TextEncoder().encode(c));
        continue;
      }
      const n = s[++i];
      if (/[0-7]/.test(n)) {
        bytes.push(parseInt(s.substr(i, 3), 8));
        i += 2;
      } else {
        bytes.push({ n: 10, t: 9, r: 13, '"': 34, '\\': 92 }[n] ?? n.charCodeAt(0));
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  const stripPrefix = (p) => p.replace(/^[ab]\//, '');

  function parseFile(block) {
    const lines = block.split('\n');
    const file = { path: null, oldPath: null, status: 'modified', blob: null, binary: false, headerLines: null };

    // `diff --git a/X b/X` — only reliable when both halves are equal.
    // Used for binary / mode-only changes that have no ---/+++ lines.
    const first = lines[0];
    if (first.length % 2 === 1) {
      const a = first.slice(0, (first.length - 1) / 2);
      const b = first.slice((first.length + 1) / 2);
      if (stripPrefix(unquote(a)) === stripPrefix(unquote(b))) file.path = stripPrefix(unquote(b));
    }

    let i = 1;
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const l = lines[i];
      if (l.startsWith('deleted file mode')) file.status = 'deleted';
      else if (l.startsWith('new file mode')) file.status = 'added';
      else if (l.startsWith('rename from ')) file.oldPath = unquote(l.slice(12));
      else if (l.startsWith('rename to ')) { file.path = unquote(l.slice(10)); file.status = 'renamed'; }
      else if (l.startsWith('index ')) file.blob = l.slice(6).split(' ')[0];
      else if (l.startsWith('--- ') && l !== '--- /dev/null') file.oldPath ??= stripPrefix(unquote(l.slice(4)));
      else if (l.startsWith('+++ ') && l !== '+++ /dev/null') file.path = stripPrefix(unquote(l.slice(4)));
      else if (l.startsWith('Binary files ')) file.binary = true;
    }
    if (!file.path) file.path = file.oldPath;

    // First hunk starting at new-file line 1 → it contains the file header.
    if (i < lines.length && file.status !== 'deleted') {
      const m = lines[i].match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m && Number(m[1]) <= 1) {
        const header = [];
        for (let j = i + 1; j < lines.length && header.length < HEADER_LINES; j++) {
          const l = lines[j];
          if (l.startsWith('@@')) break;
          if (l.startsWith('+') || l.startsWith(' ')) header.push(l.slice(1));
        }
        file.headerLines = header;
      }
    }
    return file;
  }

  function parseDiff(text) {
    return String(text)
      .split(/^diff --git /m)
      .slice(1)
      .map(parseFile)
      .filter((f) => f.path);
  }

  root.PRV = Object.assign(root.PRV || {}, { parseDiff, HEADER_LINES });
})(globalThis);
