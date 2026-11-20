import { getCapture } from './db.js';

// 編集モデル: 撮影画像 (base) + 操作の配列 (ops)。
// 描画は view canvas に「base → ops を順に適用」で行う。追加は差分適用、undo は全再描画。
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
const TOOL_KEYS = { c: 'crop', r: 'rect', a: 'arrow', t: 'text', h: 'highlight', b: 'redact', m: 'mosaic' };

let base; // ImageBitmap: 撮影したままの画像
let meta; // IndexedDB のレコード (title, url, createdAt, truncated ...)
let scale = 1; // 画像 px / CSS px (Retina なら 2)
const ops = [];
const redoStack = [];
let tool = 'rect';
let drag = null; // { x0, y0, x1, y1 } 画像座標
let pendingText = null; // { x, y, size, color }

init().catch((e) => { $('info').textContent = `読み込み失敗: ${e.message}`; });

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  const rec = id ? await getCapture(id) : null;
  if (!rec) {
    $('info').textContent = 'キャプチャが見つかりません (古いものは自動で削除されます)';
    return;
  }
  meta = rec;
  scale = rec.scale || 1;
  base = await createImageBitmap(rec.blob);
  document.title = `✂︎ ${rec.title || 'capture'}`;
  renderInfo();
  setTool('rect');
  syncOverlaySize();
  renderAll();
  bindEvents();
}

function renderInfo() {
  const info = $('info');
  info.textContent = `${meta.title} — ${meta.url}`;
  if (meta.truncated) {
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = '  ※ ページが長すぎるため途中までのキャプチャです';
    info.append(warn);
  }
}

// ---------------------------------------------------------------- 描画

function renderAll() {
  view.width = base.width;
  view.height = base.height;
  vctx.drawImage(base, 0, 0);
  ops.forEach(applyOp);
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

function drawArrow(ctx, { x1, y1, x2, y2, color, width }) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = width * 3.5 + 8 * scale;
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2 - Math.cos(angle) * head * 0.8, y2 - Math.sin(angle) * head * 0.8);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
  ctx.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
}

function drawText(ctx, { x, y, text, size, color }) {
  ctx.font = FONT.replace('{size}', size);
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  const offset = ((LINE_HEIGHT - 1) / 2) * size; // textarea の行内余白に合わせる
  text.split('\n').forEach((line, i) => {
    const ly = y + offset + i * size * LINE_HEIGHT;
    ctx.strokeStyle = '#fff'; // どんな背景でも読めるように白フチ
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

function drawPreview(op) {
  clearOverlay();
  const d = devicePixelRatio;
  const vr = view.getBoundingClientRect();
  const or = overlay.getBoundingClientRect();
  const k = displayScale();
  octx.setTransform(k * d, 0, 0, k * d, (vr.left - or.left) * d, (vr.top - or.top) * d);

  if (op.type === 'rect' || op.type === 'arrow' || op.type === 'highlight') {
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

// ---------------------------------------------------------------- 操作

const lineWidthPx = () => Math.max(1, Number($('lineWidth').value) || 4) * scale;
const fontSizePx = () => Math.max(8, Number($('fontSize').value) || 20) * scale;
const color = () => $('color').value;

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

function commit(op) {
  ops.push(op);
  redoStack.length = 0;
  applyOp(op);
  if (op.type === 'crop') setTool('rect'); // 切り抜きは 1 回で終わることが多い
  afterChange();
}

function undo() {
  if (!ops.length) return;
  redoStack.push(ops.pop());
  renderAll();
}

function redo() {
  if (!redoStack.length) return;
  const op = redoStack.pop();
  ops.push(op);
  applyOp(op);
  afterChange();
}

function afterChange() {
  updateZoom();
  $('undo').disabled = !ops.length;
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
  requestAnimationFrame(() => textInput.focus());
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
  commitText();
  const url = URL.createObjectURL(await toBlob());
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName() });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copy() {
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
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('save').addEventListener('click', save);
  $('copy').addEventListener('click', copy);
  $('zoom').addEventListener('change', () => { cancelText(); updateZoom(); });
  addEventListener('resize', () => { syncOverlaySize(); updateZoom(); });

  view.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = toImagePoint(e);
    if (tool === 'text') {
      e.preventDefault();
      openTextInput(e, p);
      return;
    }
    commitText();
    drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    view.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toImagePoint(e);
    drag.x1 = p.x;
    drag.y1 = p.y;
    drawPreview(opFromDrag(drag));
  });
  view.addEventListener('pointerup', () => {
    if (!drag) return;
    const op = opFromDrag(drag);
    drag = null;
    clearOverlay();
    if (isMeaningful(op)) commit(op);
  });
  view.addEventListener('pointercancel', () => { drag = null; clearOverlay(); });
  stage.addEventListener('scroll', () => {
    if (drag) drawPreview(opFromDrag(drag));
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
    if (e.key === 'Escape' && drag) { drag = null; clearOverlay(); return; }
    if (!mod && !e.altKey && TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
  });
}
