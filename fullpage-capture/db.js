// キャプチャ画像の受け渡し用 IndexedDB。
// service worker と editor.html は同じ拡張オリジンなので同じ DB を共有できる。
const DB_NAME = 'fullpage-capture';
const STORE = 'captures';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}

export const putCapture = (record) => run('readwrite', (s) => s.put(record));
export const getCapture = (id) => run('readonly', (s) => s.get(id));

/** 新しい順に keep 件だけ残して古いキャプチャを消す (id はタイムスタンプ文字列) */
export async function pruneCaptures(keep) {
  const keys = await run('readonly', (s) => s.getAllKeys());
  const old = [...keys].sort().reverse().slice(keep);
  if (old.length) await run('readwrite', (s) => { old.forEach((k) => s.delete(k)); });
}
