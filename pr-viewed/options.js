(async () => {
  const $ = (id) => document.getElementById(id);
  const s = await PRV.getSettings();
  $('enabled').checked = s.enabled;
  $('contentCheck').checked = s.contentCheck;
  $('patterns').value = s.patterns;
  $('save').addEventListener('click', async () => {
    await chrome.storage.sync.set({
      enabled: $('enabled').checked,
      contentCheck: $('contentCheck').checked,
      patterns: $('patterns').value,
    });
    $('saved').textContent = '保存しました（次に PR を開いたときから反映）';
  });
})();
