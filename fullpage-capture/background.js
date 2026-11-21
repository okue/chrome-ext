import { putCapture, pruneCaptures, KEEP_CAPTURES } from './db.js';

// chrome.tabs.captureVisibleTab は 1 秒 2 回まで (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)
const MIN_CAPTURE_INTERVAL_MS = 550;
// スクロール後、遅延読み込みや再描画が落ち着くまでの待ち
const SETTLE_MS = 150;
// Chrome の canvas 上限 (1 辺 32767px)
const MAX_CANVAS_DIM = 32767;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false;

// ---- 編集画面だけを開く (クリップボードの画像を貼り付けて編集する用) ----
const openEditor = () => chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'open-editor',
    title: 'クリップボードの画像を編集 (⌘⇧E)',
    contexts: ['action'], // 拡張アイコンの右クリックメニュー
  });
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-editor') openEditor();
});
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-editor') openEditor();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (busy) return;
  busy = true;
  try {
    await capture(tab);
    await setBadge('');
  } catch (e) {
    console.error(e);
    await setBadge('ERR', '#d93025');
    await chrome.action.setTitle({ tabId: tab.id, title: `キャプチャ失敗: ${e.message}` });
    setTimeout(() => setBadge(''), 5000);
  } finally {
    busy = false;
  }
});

async function setBadge(text, color = '#1a73e8') {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

async function inPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

async function capture(tab) {
  const page = await inPage(tab.id, preparePage);
  if (!page) throw new Error('このページではキャプチャできません (chrome:// や Web Store など)');

  const vh = page.viewportHeight;
  // 上限を超える長さは切り捨てる (devicePixelRatio で概算)
  const maxCssHeight = Math.floor(MAX_CANVAS_DIM / page.dpr);
  const truncated = page.height > maxCssHeight;
  const totalHeight = Math.min(page.height, maxCssHeight);

  const positions = [];
  for (let y = 0; y < totalHeight; y += vh) positions.push(y);

  let canvas, ctx, scale;
  let lastCaptureAt = 0;
  try {
    for (let i = 0; i < positions.length; i++) {
      // 2 枚目以降は fixed / sticky 要素 (追従ヘッダー等) を隠して写り込みを防ぐ
      const actualY = await inPage(tab.id, scrollPageTo, [positions[i], i > 0]);
      await sleep(SETTLE_MS);
      const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
      if (wait > 0) await sleep(wait);

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      lastCaptureAt = Date.now();
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());

      if (!canvas) {
        // 実画像の幅から倍率を決める (ズーム倍率も含めて正確)
        scale = bmp.width / page.viewportWidth;
        canvas = new OffscreenCanvas(bmp.width, Math.min(Math.round(totalHeight * scale), MAX_CANVAS_DIM));
        ctx = canvas.getContext('2d');
      }
      // 最後のコマはページ末尾でスクロールが止まるので、実際の位置に描けば重なりは上書きされる
      ctx.drawImage(bmp, 0, Math.round(actualY * scale));
      bmp.close();
      await setBadge(`${Math.round(((i + 1) / positions.length) * 100)}%`);
    }
  } finally {
    await inPage(tab.id, restorePage).catch(() => {});
  }

  await setBadge('…');
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const id = String(Date.now());
  await putCapture({
    id, blob, scale, truncated,
    title: page.title, url: page.url, createdAt: new Date().toISOString(),
  });
  await pruneCaptures(KEEP_CAPTURES);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${id}`), index: tab.index + 1 });
}

// ---- 以下はページ内 (isolated world) で実行される関数。外側の変数は参照できない ----

function preparePage() {
  const de = document.documentElement;
  const save = (prop) => [prop, de.style.getPropertyValue(prop), de.style.getPropertyPriority(prop)];
  window.__fpc = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    htmlStyles: [save('overflow'), save('scroll-behavior')],
    hidden: [],
    fixedHidden: false,
  };
  de.style.setProperty('overflow', 'hidden', 'important'); // スクロールバーを写さない
  de.style.setProperty('scroll-behavior', 'auto', 'important'); // smooth scroll を無効化
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    height: Math.max(de.scrollHeight, document.body?.scrollHeight ?? 0),
    dpr: window.devicePixelRatio,
    title: document.title,
    url: location.href,
  };
}

function scrollPageTo(y, hideFixed) {
  const st = window.__fpc;
  if (hideFixed && !st.fixedHidden) {
    st.fixedHidden = true;
    for (const el of document.querySelectorAll('body *')) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') {
        st.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }
  window.scrollTo(0, y);
  // 2 フレーム待って描画を確定させる
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.scrollY))));
}

function restorePage() {
  const st = window.__fpc;
  if (!st) return;
  const restore = (style, [prop, value, priority]) => {
    if (value) style.setProperty(prop, value, priority);
    else style.removeProperty(prop);
  };
  for (const [el, value, priority] of st.hidden) restore(el.style, ['visibility', value, priority]);
  for (const saved of st.htmlStyles) restore(document.documentElement.style, saved);
  window.scrollTo(st.scrollX, st.scrollY);
  delete window.__fpc;
}
