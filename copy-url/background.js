// 選択中（ハイライト）タブを取得。Shift/Cmd+クリックで複数選択していればすべて、
// そうでなければアクティブタブ 1 つだけが返る。
async function getSelectedTabs() {
  return chrome.tabs.query({ highlighted: true, currentWindow: true });
}

function format(tabs, mode) {
  return tabs
    .map((t) => (mode === 'markdown' ? `[${(t.title || t.url).replace(/([\[\]])/g, '\\$1')}](${t.url})` : t.url))
    .join('\n');
}

// ページ内 / offscreen 共通のコピー処理。copy イベントで clipboardData に直接書き込む。
// （注入して実行するため、外側の変数は参照しない自己完結した関数にしている）
function copyInDocument(text) {
  return new Promise((resolve) => {
    const viaExecCommand = () => {
      let ok = false;
      const onCopy = (e) => {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
        ok = true;
      };
      document.addEventListener('copy', onCopy, true);
      try {
        document.execCommand('copy');
      } finally {
        document.removeEventListener('copy', onCopy, true);
      }
      return ok;
    };
    if (navigator.clipboard && document.hasFocus()) {
      navigator.clipboard.writeText(text).then(() => resolve(true), () => resolve(viaExecCommand()));
    } else {
      resolve(viaExecCommand());
    }
  });
}

// 1) アクティブタブにスクリプトを注入してコピー（ショートカット/アイコン操作で activeTab 権限が付与される）
async function copyViaTab(text) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return false;
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: copyInDocument,
    args: [text],
  });
  return res?.result === true;
}

// 2) chrome:// 等スクリプト注入できないページ用のフォールバック: offscreen document
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Copy tab URLs to clipboard',
  });
}

async function copyViaOffscreen(text) {
  await ensureOffscreen();
  const ok = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
  return ok === true;
}

async function writeClipboard(text) {
  try {
    if (await copyViaTab(text)) return;
  } catch (e) {
    console.warn('copyViaTab failed, fallback to offscreen:', e);
  }
  if (!(await copyViaOffscreen(text))) throw new Error('clipboard write failed');
}

async function flashBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
}

async function copy(mode = 'url') {
  try {
    const tabs = await getSelectedTabs();
    if (tabs.length === 0) return;
    await writeClipboard(format(tabs, mode));
    await flashBadge(tabs.length > 1 ? String(tabs.length) : '✓', '#2e7d32');
  } catch (e) {
    console.error(e);
    await flashBadge('!', '#c62828');
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'copy-urls') copy('url');
  if (command === 'copy-markdown') copy('markdown');
});

// ツールバーアイコンクリックでもコピー
chrome.action.onClicked.addListener(() => copy('url'));

// 右クリックメニュー（ページ上 / ツールバーアイコン）
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const contexts = ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio', 'action'];
    chrome.contextMenus.create({ id: 'copy-urls', title: 'タブの URL をコピー', contexts });
    chrome.contextMenus.create({ id: 'copy-markdown', title: 'タブを Markdown リンクでコピー', contexts });
  });
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'copy-urls') copy('url');
  if (info.menuItemId === 'copy-markdown') copy('markdown');
});
