import { getCapture, putCapture, pruneCaptures, KEEP_CAPTURES } from './db.js';

// 編集モデル: 撮影画像 (base) + 操作の配列 (ops)。
// 描画は view canvas に「base → ops を順に適用」で行う。追加は差分適用、移動・undo は全再描画。
// 図形は ops に座標データとして残るので、あとから選択して動かせる (最後の切り抜きより後のものだけ)。
// undo/redo は ops 全体のスナップショットを積む (ops は座標だけなので軽い)。
// 黒塗り・モザイクは view のピクセル自体を書き換えるので、書き出した画像から元の文字は復元できない。

const $ = (id) => document.getElementById(id);
const view = $('view');
const vctx = view.getContext('2d');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const stage = $('stage');
const textInput = $('textInput');

const FONT = 'bold {size}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';
const LINE_HEIGHT = 1.25;
// Skitch に近い原色寄りのパレット。数字キー 1〜8 で選べる
const PALETTE = [
  ['#e53935', '赤'],
  ['#fb8c00', 'オレンジ'],
  ['#fdd835', '黄'],
  ['#43a047', '緑'],
  ['#1e88e5', '青'],
  ['#8e24aa', '紫'],
  ['#212121', '黒'],
  ['#ffffff', '白'],
];
const TOOL_KEYS = { c: 'crop', r: 'rect', a: 'arrow', t: 'text', h: 'highlight', b: 'redact', m: 'mosaic' };

let base; // ImageBitmap: 撮影したままの画像
let meta; // IndexedDB のレコード (title, url, createdAt, truncated ...)
let scale = 1; // 画像 px / CSS px (Retina なら 2)
let ops = [];
const undoStack = [];
const redoStack = [];
let selected = null; // 選択中の図形の ops 内 index
let moving = null; // { mode: 'move' | 'start' | 'end', start, orig, moved }
let tool = 'rect';
let currentColor = localStorage.getItem('color') ?? PALETTE[0][0];
let drag = null; // { x0, y0, x1, y1 } 画像座標
let pendingText = null; // { x, y, size, color }

init().catch((e) => { $('info').textContent = `読み込み失敗: ${e.message}`; });

async function init() {
  setTool('rect');
  buildPalette();
  syncOverlaySize();
  bindEvents();
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return showEmpty('⌘V でクリップボードの画像を貼り付けるか、画像ファイルをドロップしてください');
  const rec = await getCapture(id);
  if (!rec) return showEmpty('キャプチャが見つかりません (古いものは自動で削除されます)。⌘V で画像を貼り付けることもできます');
  await load(rec);
}

function showEmpty(message) {
  $('emptyMessage').textContent = message;
  $('empty').hidden = false;
  view.hidden = true;
  $('info').textContent = '';
}

/** 撮影 or 貼り付けたレコードを編集対象にする (編集履歴はリセット) */
async function load(rec) {
  cancelText();
  meta = rec;
  scale = rec.scale || 1;
  base?.close();
  base = await createImageBitmap(rec.blob);
  ops = [];
  undoStack.length = 0;
  redoStack.length = 0;
  selected = null;
  document.title = `✂︎ ${rec.title || 'capture'}`;
  $('empty').hidden = true;
  view.hidden = false;
  renderInfo();
  renderAll();
}

/** クリップボード / ドロップされた画像を新しい編集対象として読み込む */
async function loadImageBlob(blob, title) {
  if (ops.length && !confirm('編集中の内容を破棄して、新しい画像に置き換えますか？')) return;
  const id = String(Date.now());
  // 画像に倍率情報は無いので、この画面の倍率で撮ったスクショとみなす (線の太さを揃えるため)
  const rec = { id, blob, scale: devicePixelRatio, truncated: false, title, url: '', createdAt: new Date().toISOString() };
  await putCapture(rec); // リロードしても消えないように保存
  await pruneCaptures(KEEP_CAPTURES);
  history.replaceState(null, '', `?id=${id}`);
  await load(rec);
  toast('画像を読み込みました');
}

function renderInfo() {
  const info = $('info');
  info.textContent = meta.url ? `${meta.title} — ${meta.url}` : meta.title;
  if (meta.truncated) {
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = '  ※ ページが長すぎるため途中までのキャプチャです';
    info.append(warn);
  }
}

// ---------------------------------------------------------------- 描画

/** skip: 移動中の図形は view に描かず overlay 側に描く */
function renderAll(skip = -1) {
  view.width = base.width;
  view.height = base.height;
  vctx.drawImage(base, 0, 0);
  ops.forEach((op, i) => { if (i !== skip) applyOp(op); });
  afterChange();
}

function applyOp(op) {
  if (op.type === 'crop') {
    const tmp = new OffscreenCanvas(op.w, op.h);
    tmp.getContext('2d').drawImage(view, -op.x, -op.y);
    view.width = op.w;
    view.height = op.h;
    vctx.drawImage(tmp, 0, 0);
  } else {
    drawShape(vctx, op);
  }
}

function drawShape(ctx, op) {
  ctx.save();
  switch (op.type) {
    case 'rect':
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.lineJoin = 'round';
      ctx.strokeRect(op.x, op.y, op.w, op.h);
      break;
    case 'highlight':
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = op.color;
      ctx.fillRect(op.x, op.y, op.w, op.h);
      break;
    case 'redact':
      ctx.fillStyle = '#000';
      ctx.fillRect(op.x, op.y, op.w, op.h);
      break;
    case 'mosaic':
      pixelate(ctx, op);
      break;
    case 'arrow':
      drawArrow(ctx, op);
      break;
    case 'text':
      drawText(ctx, op);
      break;
  }
  ctx.restore();
}

function pixelate(ctx, op) {
  const sw = Math.max(1, Math.ceil(op.w / op.block));
  const sh = Math.max(1, Math.ceil(op.h / op.block));
  const small = new OffscreenCanvas(sw, sh);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(ctx.canvas, op.x, op.y, op.w, op.h, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, sw, sh, op.x, op.y, op.w, op.h);
}

/**
 * Skitch 風の矢印: 根元が細く先へ向かって太くなる胴体 + 大きな三角の頭を 1 つの図形にし、
 * 白フチ + ドロップシャドウを付ける。矢印の向きに回転した座標系 (x: 根元→先端) で描く。
 */
function arrowGeometry({ x1, y1, x2, y2, width }) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const base = width * 3.5; // 線の太さ設定 4 → 胴体の最大幅 約 13px / 頭の幅 約 42px (CSS px)
  const headLen = Math.min(base * 3.2, len * 0.6); // 短い矢印では頭を縮める
  const headHalf = headLen * 0.47;
  return {
    len,
    base,
    headHalf,
    neck: len - headLen * 0.85, // 頭の付け根 (少し食い込ませて胴体と一体に見せる)
    tailHalf: base * 0.12,
    neckHalf: Math.min(base * 0.45, headHalf * 0.55),
  };
}

function drawArrow(ctx, op) {
  const { x1, y1, x2, y2, color } = op;
  const { len, base, headHalf, neck, tailHalf, neckHalf } = arrowGeometry(op);
  if (len < 1) return;

  ctx.translate(x1, y1);
  ctx.rotate(Math.atan2(y2 - y1, x2 - x1));
  ctx.beginPath();
  ctx.moveTo(0, -tailHalf);
  ctx.lineTo(neck, -neckHalf);
  ctx.lineTo(neck, -headHalf);
  ctx.lineTo(len, 0);
  ctx.lineTo(neck, headHalf);
  ctx.lineTo(neck, neckHalf);
  ctx.lineTo(0, tailHalf);
  ctx.closePath();

  ctx.lineJoin = 'round';
  // 1) 影付きの白フチ (フチの外側半分だけが見える)
  ctx.shadowColor = 'rgba(0,0,0,.4)';
  ctx.shadowBlur = base * 0.9;
  ctx.shadowOffsetY = base * 0.25;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(2, base * 0.45);
  ctx.stroke();
  // 2) 本体の塗り (影なし)
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = color;
  ctx.fill();
}

function drawText(ctx, { x, y, text, size, color }) {
  ctx.font = FONT.replace('{size}', size);
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  const offset = ((LINE_HEIGHT - 1) / 2) * size; // textarea の行内余白に合わせる
  text.split('\n').forEach((line, i) => {
    const ly = y + offset + i * size * LINE_HEIGHT;
    ctx.strokeStyle = outlineFor(color); // どんな背景でも読めるようにフチを付ける
    ctx.lineWidth = Math.max(2, size / 5);
    ctx.strokeText(line, x, ly);
    ctx.fillStyle = color;
    ctx.fillText(line, x, ly);
  });
}

// ---------------------------------------------------------------- プレビュー (overlay)

function syncOverlaySize() {
  const r = overlay.getBoundingClientRect();
  overlay.width = Math.round(r.width * devicePixelRatio);
  overlay.height = Math.round(r.height * devicePixelRatio);
}

function clearOverlay() {
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

/** 画像座標でそのまま描けるよう、overlay に view の表示位置・倍率を反映する */
function displayScale() {
  return view.getBoundingClientRect().width / view.width; // CSS px / 画像 px
}

/** overlay をクリアし、画像座標で描けるよう変換を設定する。戻り値は CSS px / 画像 px */
function beginOverlay() {
  clearOverlay();
  const d = devicePixelRatio;
  const vr = view.getBoundingClientRect();
  const or = overlay.getBoundingClientRect();
  const k = displayScale();
  octx.setTransform(k * d, 0, 0, k * d, (vr.left - or.left) * d, (vr.top - or.top) * d);
  return k;
}

/** ドラッグ中の新規図形のプレビュー */
function drawPreview(op) {
  drawOnOverlay(op, beginOverlay());
}

function drawOnOverlay(op, k) {
  if (op.type === 'rect' || op.type === 'arrow' || op.type === 'highlight' || op.type === 'text') {
    drawShape(octx, op);
    return;
  }
  octx.save();
  if (op.type === 'crop') {
    octx.fillStyle = 'rgba(0,0,0,.55)';
    octx.beginPath();
    octx.rect(0, 0, view.width, view.height);
    octx.rect(op.x, op.y, op.w, op.h);
    octx.fill('evenodd');
  } else if (op.type === 'redact') {
    octx.fillStyle = 'rgba(0,0,0,.6)';
    octx.fillRect(op.x, op.y, op.w, op.h);
  } else if (op.type === 'mosaic') {
    octx.fillStyle = 'rgba(26,115,232,.15)';
    octx.fillRect(op.x, op.y, op.w, op.h);
  }
  octx.setLineDash([6 / k, 4 / k]);
  octx.lineWidth = 1.5 / k;
  octx.strokeStyle = '#1a73e8';
  octx.strokeRect(op.x, op.y, op.w, op.h);
  octx.restore();
}

/** 選択中の図形のハンドル (矢印は両端の丸、それ以外は点線の枠)。移動中は図形本体も overlay に描く */
function drawSelection() {
  if (drag) return;
  clearOverlay();
  const op = selected === null ? null : ops[selected];
  if (!op) return;
  const k = beginOverlay();
  if (moving?.moved) drawOnOverlay(op, k);
  octx.save();
  octx.lineWidth = 2 / k;
  octx.strokeStyle = '#1a73e8';
  if (op.type === 'arrow') {
    octx.fillStyle = '#fff';
    for (const [x, y] of [[op.x1, op.y1], [op.x2, op.y2]]) {
      octx.beginPath();
      octx.arc(x, y, 6 / k, 0, Math.PI * 2);
      octx.fill();
      octx.stroke();
    }
  } else {
    const b = bounds(op);
    const pad = 4 / k;
    octx.setLineDash([6 / k, 4 / k]);
    octx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  }
  octx.restore();
}

// ---------------------------------------------------------------- 選択・移動

function bounds(op) {
  if (op.type === 'arrow') {
    return { x: Math.min(op.x1, op.x2), y: Math.min(op.y1, op.y2), w: Math.abs(op.x2 - op.x1), h: Math.abs(op.y2 - op.y1) };
  }
  if (op.type === 'text') {
    vctx.save();
    vctx.font = FONT.replace('{size}', op.size);
    const lines = op.text.split('\n');
    const w = Math.max(...lines.map((l) => vctx.measureText(l).width));
    vctx.restore();
    return { x: op.x, y: op.y, w, h: lines.length * op.size * LINE_HEIGHT };
  }
  return { x: op.x, y: op.y, w: op.w, h: op.h };
}

const inside = (p, x, y, w, h) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;

function distToSegment(p, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy));
}

/** 点 p で掴める図形を上 (後に描いたもの) から探す。切り抜きより前の図形は座標系が違うので対象外 */
function hitTest(p) {
  const tol = 6 / displayScale(); // 画面上 6px の遊び
  const from = ops.findLastIndex((o) => o.type === 'crop') + 1;
  for (let i = ops.length - 1; i >= from; i--) {
    const op = ops[i];
    if (op.type === 'arrow') {
      const { base } = arrowGeometry(op);
      if (Math.hypot(p.x - op.x2, p.y - op.y2) <= tol * 2 + base * 0.3) return { index: i, mode: 'end' };
      if (Math.hypot(p.x - op.x1, p.y - op.y1) <= tol * 2) return { index: i, mode: 'start' };
      if (distToSegment(p, op.x1, op.y1, op.x2, op.y2) <= base * 0.5 + tol) return { index: i, mode: 'move' };
    } else if (op.type === 'rect') {
      // 枠線の上だけ掴める (内側からは新しい図形を描き始められるように)
      const t = op.width / 2 + tol;
      if (inside(p, op.x - t, op.y - t, op.w + t * 2, op.h + t * 2) && !inside(p, op.x + t, op.y + t, op.w - t * 2, op.h - t * 2)) {
        return { index: i, mode: 'move' };
      }
    } else {
      const b = bounds(op);
      if (inside(p, b.x - tol, b.y - tol, b.w + tol * 2, b.h + tol * 2)) return { index: i, mode: 'move' };
    }
  }
  return null;
}

function movedOp(orig, mode, dx, dy) {
  const op = { ...orig };
  if (op.type === 'arrow') {
    if (mode !== 'end') { op.x1 += dx; op.y1 += dy; }
    if (mode !== 'start') { op.x2 += dx; op.y2 += dy; }
  } else {
    op.x = Math.round(orig.x + dx);
    op.y = Math.round(orig.y + dy);
  }
  return op;
}

function select(index) {
  selected = index;
  drawSelection();
}

function deselect() {
  if (selected === null) return;
  selected = null;
  drawSelection();
}

/** 選択中の図形を書き換える (色・太さの変更など) */
function updateSelected(patch) {
  const op = ops[selected];
  if (!op) return;
  const changes = Object.entries(patch).filter(([k, v]) => k in op && op[k] !== v);
  if (!changes.length) return;
  pushHistory();
  ops[selected] = { ...op, ...Object.fromEntries(changes) };
  renderAll();
}

function deleteSelected() {
  if (selected === null) return;
  pushHistory();
  ops.splice(selected, 1);
  selected = null;
  renderAll();
}

function updateHoverCursor(e) {
  if (!base || drag || moving) return;
  const hit = tool === 'crop' ? null : hitTest(toImagePoint(e));
  if (hit) view.style.cursor = hit.mode === 'move' ? 'move' : 'grab';
  else view.style.cursor = tool === 'text' ? 'text' : 'crosshair';
}

// ---------------------------------------------------------------- 操作

const lineWidthPx = () => Math.max(1, Number($('lineWidth').value) || 4) * scale;
const fontSizePx = () => Math.max(8, Number($('fontSize').value) || 20) * scale;
const color = () => currentColor;

function buildPalette() {
  if (!PALETTE.some(([c]) => c === currentColor)) currentColor = PALETTE[0][0];
  PALETTE.forEach(([c, name], i) => {
    const b = document.createElement('button');
    b.dataset.color = c;
    b.title = `${name} (${i + 1})`;
    b.style.background = c;
    $('colors').append(b);
  });
  setColor(currentColor);
}

function setColor(c) {
  currentColor = c;
  localStorage.setItem('color', c); // 次に開いたときも同じ色
  for (const b of $('colors').children) b.classList.toggle('active', b.dataset.color === c);
  if (pendingText) {
    pendingText.color = c;
    textInput.style.color = c;
  }
  if (selected !== null) updateSelected({ color: c }); // 選択中の図形の色も変える
}

/** 明るい色 (白・黄) の文字には黒フチ、それ以外は白フチ */
function outlineFor(c) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 186 ? '#000' : '#fff';
}

function toImagePoint(e) {
  const r = view.getBoundingClientRect();
  const x = ((e.clientX - r.left) * view.width) / r.width;
  const y = ((e.clientY - r.top) * view.height) / r.height;
  return { x: Math.max(0, Math.min(view.width, x)), y: Math.max(0, Math.min(view.height, y)) };
}

function opFromDrag({ x0, y0, x1, y1 }) {
  if (tool === 'arrow') {
    return { type: 'arrow', x1: x0, y1: y0, x2: x1, y2: y1, color: color(), width: lineWidthPx() };
  }
  const x = Math.round(Math.min(x0, x1));
  const y = Math.round(Math.min(y0, y1));
  const w = Math.round(Math.abs(x1 - x0));
  const h = Math.round(Math.abs(y1 - y0));
  if (tool === 'mosaic') return { type: 'mosaic', x, y, w, h, block: Math.round(12 * scale) };
  return { type: tool, x, y, w, h, color: color(), width: lineWidthPx() };
}

function isMeaningful(op) {
  if (op.type === 'arrow') return Math.hypot(op.x2 - op.x1, op.y2 - op.y1) > 4 * scale;
  return op.w >= 3 && op.h >= 3;
}

function pushHistory() {
  undoStack.push(structuredClone(ops));
  redoStack.length = 0;
}

function commit(op) {
  pushHistory();
  ops.push(op);
  applyOp(op);
  if (op.type === 'crop') {
    setTool('rect'); // 切り抜きは 1 回で終わることが多い
    selected = null;
  } else {
    selected = ops.length - 1; // 描いた直後にそのまま位置を調整できるよう選択状態にする
  }
  afterChange();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(structuredClone(ops));
  ops = undoStack.pop();
  selected = null;
  renderAll();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(structuredClone(ops));
  ops = redoStack.pop();
  selected = null;
  renderAll();
}

function afterChange() {
  updateZoom();
  drawSelection();
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
}

function updateZoom() {
  const cssW = view.width / scale;
  const cssH = view.height / scale;
  const v = $('zoom').value;
  const z = v === 'fit' ? Math.min(1, (stage.clientWidth - 32) / cssW) : Number(v);
  view.style.width = `${cssW * z}px`;
  view.style.height = `${cssH * z}px`;
}

function setTool(t) {
  tool = t;
  for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('active', b.dataset.tool === t);
  view.style.cursor = t === 'text' ? 'text' : 'crosshair';
}

// ---------------------------------------------------------------- テキスト入力

function openTextInput(e, p) {
  commitText();
  const size = fontSizePx();
  pendingText = { x: p.x, y: p.y, size, color: color() };
  Object.assign(textInput.style, {
    left: `${e.clientX}px`,
    top: `${e.clientY}px`,
    fontSize: `${size * displayScale()}px`,
    color: pendingText.color,
    width: '6em',
    height: 'auto',
  });
  textInput.value = '';
  textInput.hidden = false;
  textInput.focus(); // pointerdown を preventDefault 済みなので、同期でフォーカスしても奪われない
}

function fitTextInput() {
  const lines = textInput.value.split('\n');
  textInput.style.width = `${Math.max(4, ...lines.map((l) => l.length)) + 2}em`;
  textInput.style.height = 'auto';
  textInput.style.height = `${textInput.scrollHeight}px`;
}

function commitText() {
  if (!pendingText) return;
  const p = pendingText;
  pendingText = null;
  const text = textInput.value.replace(/\s+$/, '');
  textInput.hidden = true;
  if (text) commit({ type: 'text', x: p.x, y: p.y, text, size: p.size, color: p.color });
}

function cancelText() {
  pendingText = null;
  textInput.hidden = true;
}

// ---------------------------------------------------------------- 書き出し

const toBlob = () => new Promise((resolve) => view.toBlob(resolve, 'image/png'));

function fileName() {
  const d = new Date(meta.createdAt);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const title = (meta.title || 'capture').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || 'capture';
  return `${title}_${stamp}.png`;
}

async function save() {
  if (!base) return;
  commitText();
  const url = URL.createObjectURL(await toBlob());
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName() });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copy() {
  if (!base) return;
  commitText();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob() })]);
    toast('クリップボードにコピーしました');
  } catch (e) {
    toast(`コピーに失敗しました: ${e.message}`);
  }
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2000);
}

// ---------------------------------------------------------------- イベント

function bindEvents() {
  $('tools').addEventListener('click', (e) => {
    const t = e.target.closest('button')?.dataset.tool;
    if (t) setTool(t);
  });
  $('colors').addEventListener('pointerdown', (e) => {
    e.preventDefault(); // テキスト入力中でもフォーカスを奪わない
    const c = e.target.dataset?.color;
    if (c) setColor(c);
  });
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('save').addEventListener('click', save);
  $('copy').addEventListener('click', copy);
  $('zoom').addEventListener('change', () => { cancelText(); afterChange(); });
  addEventListener('resize', () => { syncOverlaySize(); if (base) afterChange(); });
  // 選択中の図形があれば、太さ・文字サイズの変更をその図形にも反映する
  $('lineWidth').addEventListener('change', () => { if (selected !== null) updateSelected({ width: lineWidthPx() }); });
  $('fontSize').addEventListener('change', () => { if (selected !== null) updateSelected({ size: fontSizePx() }); });

  // ⌘V: クリップボードの画像を編集対象にする (テキスト入力中の貼り付けは邪魔しない)
  document.addEventListener('paste', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
    if (!item) { toast('クリップボードに画像がありません'); return; }
    e.preventDefault();
    loadImageBlob(item.getAsFile(), 'クリップボードの画像');
  });
  // 画像ファイルのドラッグ&ドロップ
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) loadImageBlob(file, file.name.replace(/\.[^.]+$/, ''));
  });

  view.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    commitText();
    const p = toImagePoint(e);
    // 既存の図形の上なら、選択して移動 (矢印の両端なら端点だけ動かす)
    const hit = tool === 'crop' ? null : hitTest(p);
    if (hit) {
      select(hit.index);
      moving = { mode: hit.mode, start: p, orig: structuredClone(ops[hit.index]), moved: false };
      view.setPointerCapture(e.pointerId);
      return;
    }
    deselect();
    if (tool === 'text') {
      openTextInput(e, p);
      return;
    }
    drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove', (e) => {
    if (moving) {
      const p = toImagePoint(e);
      const dx = p.x - moving.start.x;
      const dy = p.y - moving.start.y;
      if (!moving.moved) {
        if (Math.hypot(dx, dy) * displayScale() < 2) return; // クリックだけなら選択のみ
        moving.moved = true;
        pushHistory();
        renderAll(selected); // 動かす図形を除いて描き直し、本体は overlay に描く
      }
      ops[selected] = movedOp(moving.orig, moving.mode, dx, dy);
      drawSelection();
      return;
    }
    if (!drag) { updateHoverCursor(e); return; }
    const p = toImagePoint(e);
    drag.x1 = p.x;
    drag.y1 = p.y;
    drawPreview(opFromDrag(drag));
  });
  view.addEventListener('pointerup', () => {
    if (moving) {
      const { moved } = moving;
      moving = null;
      if (moved) renderAll();
      return;
    }
    if (!drag) return;
    const op = opFromDrag(drag);
    drag = null;
    clearOverlay();
    if (isMeaningful(op)) commit(op);
  });
  view.addEventListener('pointercancel', () => {
    drag = null;
    if (moving?.moved) { moving = null; renderAll(); }
    moving = null;
    clearOverlay();
  });
  stage.addEventListener('scroll', () => {
    if (drag) drawPreview(opFromDrag(drag));
    else drawSelection();
    if (pendingText) commitText(); // スクロールで入力欄の位置がずれるので確定させる
  });

  textInput.addEventListener('input', fitTextInput);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); commitText(); }
    if (e.key === 'Escape') cancelText();
  });
  textInput.addEventListener('blur', commitText);

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && key === 's') { e.preventDefault(); save(); return; }
    if (mod && key === 'c' && !getSelection().toString()) { e.preventDefault(); copy(); return; }
    if (e.key === 'Escape') {
      if (drag) { drag = null; clearOverlay(); } else deselect();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) { e.preventDefault(); deleteSelected(); return; }
    if (!mod && !e.altKey && TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
    if (!mod && !e.altKey && PALETTE[Number(key) - 1]) setColor(PALETTE[Number(key) - 1][0]);
  });
}
