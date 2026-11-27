// GitHub notifications page (/notifications):
//  - a "Merged を Done (N)" button next to "Select all" that marks every listed
//    notification of a merged pull request as Done
//  - a Done button on the left of each row, next to its checkbox; GitHub's own
//    Done (a hover action on the right) is hidden on rows that got one
// Both just click GitHub's own Done button of the row, so GitHub does the work.
//
// DOM (the same selectors refined-github relies on):
//   row         li.notifications-list-item
//   checkbox    input.js-notification-bulk-action-check-item (left of the row)
//   merged PR   .octicon-git-merge (the row's state icon)
//   Done        [title="Done"] button inside the row (hover action, right)
//   header      input.js-notifications-mark-all-prompt ("Select all" checkbox)
(function () {
  'use strict';
  const ID = 'prv-done-merged';
  const ROW = '.notifications-list-item';
  const CHECK = 'input.js-notification-bulk-action-check-item';
  const DONE = '[title="Done"], button[aria-label="Done"]'; // GitHub's (ours never match)
  const ROW_BTN = 'prv-row-done';
  const LEFT = 'prv-left-done'; // row class: hides GitHub's Done (notifications.css)

  const isNotifications = () => /^\/notifications(?:\/|$)/.test(location.pathname);

  // Octicons (16px). The merge icon has no `octicon-git-merge` class, so it is
  // never mistaken for a row's merged-state icon.
  const MERGE_PATH =
    'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .001Z';
  const CHECK_PATH =
    'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z';

  function octicon(d) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'octicon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  /** Mark a row Done by clicking GitHub's own Done button. */
  function markDone(row) {
    const native = row.querySelector(DONE);
    if (!native || row.dataset.prvDone) return;
    row.dataset.prvDone = '1';
    const own = row.querySelector(`.${ROW_BTN}`);
    if (own) own.disabled = true;
    native.click();
  }

  // ------------------------------------------------- per-row Done (left)

  function createRowButton(row) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = ROW_BTN;
    btn.title = 'Done にする';
    btn.setAttribute('aria-label', 'Done にする');
    btn.append(octicon(CHECK_PATH));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation(); // keep the click away from the row's own handlers
      markDone(row);
      schedule();
    });
    return btn;
  }

  function ensureRowButtons() {
    for (const row of document.querySelectorAll(ROW)) {
      const check = row.querySelector(CHECK);
      let btn = row.querySelector(`.${ROW_BTN}`);
      if (!check || !row.querySelector(DONE)) {
        // Nothing to proxy (e.g. the Done view): leave GitHub's UI alone.
        btn?.remove();
        if (row.classList.contains(LEFT)) row.classList.remove(LEFT);
        continue;
      }
      if (!btn) {
        // After the checkbox's <label> (a click inside it would toggle the
        // checkbox), unless that label also wraps the row's link.
        const label = check.closest('label');
        const anchor = label && row.contains(label) && !label.querySelector('a') ? label : check;
        anchor.after(createRowButton(row));
      }
      if (!row.classList.contains(LEFT)) row.classList.add(LEFT);
    }
  }

  // ------------------------------------------- "Merged を Done" (header)

  /** Rows of merged PRs that still have a Done button (not yet handled). */
  function mergedRows() {
    return [...document.querySelectorAll(ROW)].filter(
      (row) => !row.dataset.prvDone && row.querySelector('.octicon-git-merge') && row.querySelector(DONE),
    );
  }

  /** Put the button right after "Select all" (fallback: end of the list header). */
  function mount(btn) {
    const label = document.querySelector('input.js-notifications-mark-all-prompt')?.closest('label');
    const header = document.querySelector('.js-check-all-container .Box-header');
    if (label) label.after(btn);
    else if (header) header.append(btn);
    return btn.isConnected;
  }

  function createMergedButton() {
    const svg = octicon(MERGE_PATH);
    svg.style.cssText = 'fill: var(--fgColor-done, #8250df); margin-right: 4px; vertical-align: text-bottom';
    const btn = document.createElement('button');
    btn.id = ID;
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.style.marginLeft = '8px';
    btn.title = 'このページに表示中の通知のうち、マージ済み PR の通知をまとめて Done にする';
    btn.append(svg, document.createElement('span'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Click every Done button synchronously, before GitHub re-renders the list.
      mergedRows().forEach(markDone);
      schedule();
    });
    return btn;
  }

  function ensureMergedButton() {
    let btn = document.getElementById(ID);
    if (!btn) {
      btn = createMergedButton();
      if (!mount(btn)) return;
    }
    const n = mergedRows().length;
    const label = btn.querySelector('span');
    const text = `Merged を Done (${n})`;
    if (label.textContent !== text) label.textContent = text;
    if (btn.disabled !== (n === 0)) btn.disabled = n === 0;
  }

  // ------------------------------------------------------------ wiring

  function refresh() {
    if (!isNotifications() || !document.querySelector(ROW)) return;
    ensureRowButtons();
    ensureMergedButton();
  }

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  };

  // GitHub navigates as an SPA (Turbo) and re-renders the list after actions.
  new MutationObserver(() => {
    if (isNotifications()) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
