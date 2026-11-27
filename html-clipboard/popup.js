// Opening the popup copies the active tab's HTML as a file right away; the
// popup only shows the result.
//
// Chrome extensions cannot put files on the clipboard, so the native messaging
// host in native-host/ does it. A local file is copied as it is; a web page is
// saved to a temporary file first.
const NATIVE_HOST = 'html_clipboard';
const statusMessage = document.querySelector('#status');

copyAsFile().then(
  message => { statusMessage.textContent = message; },
  error => { statusMessage.textContent = error.message; }
);

async function copyAsFile() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('対象のタブが見つかりません。');

  const message = tab.url?.startsWith('file:') ?
    { path: decodeURIComponent(new URL(tab.url).pathname) } :
    { name: tab.title, html: await pageHtml(tab) };

  let response;
  try {
    response = await chrome.runtime.sendNativeMessage(NATIVE_HOST, message);
  } catch (error) {
    // "not found" before installation, "forbidden" when the ID does not match.
    if (/not found|forbidden/i.test(error.message)) {
      throw new Error('補助ツールが必要です。ターミナルで ' +
        `html-clipboard/native-host/install.sh ${chrome.runtime.id} を実行してください。`);
    }
    throw new Error('補助ツールを実行できませんでした: ' + error.message);
  }
  if (!response?.ok) throw new Error(response?.error ?? 'ファイルをコピーできませんでした。');

  const name = response.path.split('/').pop();
  return `${name} をコピーしました。Slack などに貼り付けると添付されます。`;
}

async function pageHtml(tab) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => (document.doctype ?
      new XMLSerializer().serializeToString(document.doctype) + '\n' : '') +
      document.documentElement.outerHTML
  }).catch(() => []);
  const html = results[0]?.result;
  if (typeof html !== 'string') {
    throw new Error('このページは読み取れません（chrome:// などのページは対象外です）。');
  }
  return html;
}
