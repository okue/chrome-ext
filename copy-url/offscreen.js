chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen' || msg.type !== 'copy') return;
  const text = msg.text;
  let ok = false;
  const onCopy = (e) => {
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    ok = true;
  };
  document.addEventListener('copy', onCopy, true);
  try {
    document.execCommand('copy');
  } catch (e) {
    console.error(e);
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
  if (!ok) {
    // 念のため textarea 選択方式でも試す
    const ta = document.getElementById('buf');
    ta.value = text;
    ta.select();
    ok = document.execCommand('copy');
  }
  sendResponse(ok);
});
