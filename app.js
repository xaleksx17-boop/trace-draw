'use strict';
const APP_VERSION = '2.0.1';
/* Обводилка — v1.1
   Камера во весь экран + картинка поверх с прозрачностью.
   Жесты: 1 палец — сдвиг, 2 пальца — масштаб и поворот. Замок блокирует жесты. */

const $ = (id) => document.getElementById(id);

// ---------- Настройки (localStorage) ----------
const DEFAULTS = { filter: 'original', bright: 0, contrast: 0, thresh: 60, thick: 1,
  color: '#ff2a2a', zoomDef: 1, mirror: false, opacity: 50, gridOn: false, gridN: 6, gridColor: '#2a7bff',
  blinkOn: false, blinkSec: 5, blinkHide: 1, recSpeed: 10, recOverlay: false };
let S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem('td.settings') || '{}')); } catch (e) {}
function saveSettings() { try { localStorage.setItem('td.settings', JSON.stringify(S)); } catch (e) {} }

// ---------- База (IndexedDB): проекты ----------
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('trace-draw', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async req(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const q = fn(t.objectStore(store));
      t.oncomplete = () => res(q ? q.result : undefined);
      t.onerror = () => rej(t.error);
    });
  },
  get: (s, k) => DB.req(s, 'readonly', (o) => o.get(k)),
  put: (s, v, k) => DB.req(s, 'readwrite', (o) => (k === undefined ? o.put(v) : o.put(v, k))),
  del: (s, k) => DB.req(s, 'readwrite', (o) => o.delete(k)),
  all: (s) => DB.req(s, 'readonly', (o) => o.getAll())
};

// Настройки картинки, которые хранятся в каждом проекте отдельно
const PROJECT_KEYS = ['filter', 'bright', 'contrast', 'thresh', 'thick', 'color', 'mirror', 'opacity',
  'gridOn', 'gridN', 'gridColor'];
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

let srcImage = null;   // картинка текущего проекта
let cur = null;        // текущий проект
let mode = 'camera';   // 'camera' | 'light' (световой стол)
const MAX_SIDE = 1600;

function blobToImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => res(img); img.onerror = rej; img.src = url;
  });
}
function canvasToBlob(c, type, q) { return new Promise((res) => c.toBlob(res, type, q)); }
function makeThumb(src) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const k = 240 / Math.max(w, h), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.75);
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function defaultName() {
  return 'Рисунок ' + new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ---------- Главный экран: список проектов ----------
async function renderProjects() {
  let list = [];
  try { list = await DB.all('projects'); } catch (e) {}
  list.sort((a, b) => b.updated - a.updated);
  const box = $('projects');
  box.innerHTML = '';
  $('projectsEmpty').style.display = list.length ? 'none' : 'block';
  for (const p of list) {
    const el = document.createElement('div');
    el.className = 'proj';
    el.innerHTML = `<img alt=""><div class="proj-info"><div class="proj-name"></div>
      <div class="proj-date"></div></div>
      <div class="proj-acts"><button data-a="light" title="Световой стол">💡</button><button data-a="edit" title="Обрезать">✂️</button>
      <button data-a="rename" title="Переименовать">✏️</button><button data-a="del" title="Удалить">🗑️</button></div>`;
    el.querySelector('img').src = p.thumb;
    el.querySelector('.proj-name').textContent = p.name;
    el.querySelector('.proj-date').textContent = new Date(p.updated).toLocaleString('ru-RU',
      { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    el.addEventListener('click', async (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'del') {
        if (confirm(`Удалить «${p.name}»?`)) { await DB.del('projects', p.id); renderProjects(); }
      } else if (a === 'rename') {
        const n = prompt('Название', p.name);
        if (n && n.trim()) { p.name = n.trim(); await DB.put('projects', p); renderProjects(); }
      } else if (a === 'light') {
        openProject(p, 'light');
      } else if (a === 'edit') {
        openEditor(p.orig || p.blob, p);
      } else openProject(p);
    });
    box.appendChild(el);
  }
}

function setHint(t) { $('homeHint').textContent = t || ''; }
const onPick = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openEditor(f, null); };
$('pickCamera').addEventListener('change', onPick);
$('pickGallery').addEventListener('change', onPick);
$('pasteBtn').addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) { openEditor(await it.getType(type), null); return; }
    }
    setHint('В буфере нет картинки');
  } catch (e) {
    setHint('Браузер не дал доступ к буферу — используйте «Из галереи»');
  }
});
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f && $('home').classList.contains('active')) openEditor(f, null);
});

// ---------- Редактор: поворот, отражение, обрезка ----------
let ed = null;
const edCanvas = $('edCanvas'), cropBox = $('cropBox');

async function openEditor(blob, project) {
  let img;
  try { img = await blobToImage(blob); } catch (e) { setHint('Не удалось открыть картинку'); return; }
  setHint('');
  const e = project?.edit || {};
  ed = { img, blob, project, rot: e.rot || 0, flip: !!e.flip, crop: e.crop ? { ...e.crop } : null };
  buildEdSrc();
  show('editor');
  layoutEditor();
}
function buildEdSrc() {
  const iw = ed.img.naturalWidth, ih = ed.img.naturalHeight;
  const k = Math.min(1, 2400 / Math.max(iw, ih));
  const w0 = Math.round(iw * k), h0 = Math.round(ih * k);
  const odd = ed.rot % 2 === 1;
  const c = document.createElement('canvas');
  c.width = odd ? h0 : w0; c.height = odd ? w0 : h0;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(ed.rot * Math.PI / 2);
  if (ed.flip) ctx.scale(-1, 1);
  ctx.drawImage(ed.img, -w0 / 2, -h0 / 2, w0, h0);
  ed.src = c;
  if (!ed.crop) ed.crop = { x: 0, y: 0, w: 1, h: 1 };
}
function layoutEditor() {
  if (!ed || !$('editor').classList.contains('active')) return;
  const st = $('edStage').getBoundingClientRect(), dpr = devicePixelRatio || 1;
  edCanvas.width = st.width * dpr; edCanvas.height = st.height * dpr;
  edCanvas.style.width = st.width + 'px'; edCanvas.style.height = st.height + 'px';
  const cw = ed.src.width, ch = ed.src.height;
  ed.k = Math.min(st.width / cw, st.height / ch) * 0.94;
  ed.ox = (st.width - cw * ed.k) / 2; ed.oy = (st.height - ch * ed.k) / 2;
  const ctx = edCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, st.width, st.height);
  ctx.drawImage(ed.src, ed.ox, ed.oy, cw * ed.k, ch * ed.k);
  placeCrop();
}
function placeCrop() {
  const cw = ed.src.width * ed.k, ch = ed.src.height * ed.k, c = ed.crop;
  Object.assign(cropBox.style, { left: ed.ox + c.x * cw + 'px', top: ed.oy + c.y * ch + 'px',
    width: c.w * cw + 'px', height: c.h * ch + 'px' });
  $('edSize').textContent = `${Math.round(c.w * ed.src.width)}×${Math.round(c.h * ed.src.height)}`;
}
let cropDrag = null;
cropBox.addEventListener('pointerdown', (e) => {
  cropBox.setPointerCapture(e.pointerId);
  cropDrag = { h: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, c: { ...ed.crop } };
});
cropBox.addEventListener('pointermove', (e) => {
  if (!cropDrag) return;
  const dx = (e.clientX - cropDrag.x) / (ed.src.width * ed.k), dy = (e.clientY - cropDrag.y) / (ed.src.height * ed.k);
  const c0 = cropDrag.c, M = 0.05, cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const c = { ...c0 };
  if (cropDrag.h === 'move') {
    c.x = cl(c0.x + dx, 0, 1 - c0.w); c.y = cl(c0.y + dy, 0, 1 - c0.h);
  } else {
    if (cropDrag.h.includes('l')) { c.x = cl(c0.x + dx, 0, c0.x + c0.w - M); c.w = c0.x + c0.w - c.x; }
    if (cropDrag.h.includes('r')) { c.w = cl(c0.w + dx, M, 1 - c0.x); }
    if (cropDrag.h.includes('t')) { c.y = cl(c0.y + dy, 0, c0.y + c0.h - M); c.h = c0.y + c0.h - c.y; }
    if (cropDrag.h.includes('b')) { c.h = cl(c0.h + dy, M, 1 - c0.y); }
  }
  ed.crop = c; placeCrop();
});
cropBox.addEventListener('pointerup', () => { cropDrag = null; });
cropBox.addEventListener('pointercancel', () => { cropDrag = null; });

$('edRotate').addEventListener('click', () => { ed.rot = (ed.rot + 1) % 4; ed.crop = null; buildEdSrc(); layoutEditor(); });
$('edFlip').addEventListener('click', () => { ed.flip = !ed.flip; ed.crop = null; buildEdSrc(); layoutEditor(); });
$('edFull').addEventListener('click', () => { ed.crop = { x: 0, y: 0, w: 1, h: 1 }; placeCrop(); });
$('edCancel').addEventListener('click', () => { ed = null; show('home'); });
$('edDone').addEventListener('click', async () => {
  const c = ed.crop, sw = ed.src.width, sh = ed.src.height;
  const ow = Math.max(1, Math.round(c.w * sw)), oh = Math.max(1, Math.round(c.h * sh));
  const out = document.createElement('canvas'); out.width = ow; out.height = oh;
  out.getContext('2d').drawImage(ed.src, Math.round(c.x * sw), Math.round(c.y * sh), ow, oh, 0, 0, ow, oh);
  const type = ed.blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await canvasToBlob(out, type, 0.92);
  const edit = { rot: ed.rot, flip: ed.flip, crop: { ...c } };
  let p = ed.project;
  if (p) {
    Object.assign(p, { blob, edit, thumb: makeThumb(out), T: null, updated: Date.now() });
  } else {
    p = { id: newId(), name: defaultName(), created: Date.now(), updated: Date.now(),
      orig: ed.blob, blob, edit, thumb: makeThumb(out), T: null, ...pick(S, PROJECT_KEYS) };
  }
  try { await DB.put('projects', p); } catch (e) { flashToast('Не удалось сохранить проект'); }
  ed = null;
  renderProjects();
  openProject(p);
});
window.addEventListener('resize', () => layoutEditor());

// Перенос картинки из прошлой версии (одна «последняя картинка») в проекты
(async () => {
  try {
    const last = await DB.get('kv', 'last');
    if (last) {
      const list = await DB.all('projects');
      if (!list.length) {
        const img = await blobToImage(last);
        await DB.put('projects', { id: newId(), name: defaultName(), created: Date.now(), updated: Date.now(),
          orig: last, blob: last, edit: null, thumb: makeThumb(img), T: null, ...pick(S, PROJECT_KEYS) });
      }
      await DB.del('kv', 'last');
    }
  } catch (e) {}
  renderProjects();
})();

// ---------- Фильтры ----------
const overlay = $('overlay');
let prepared = null; // { w, h } размер подготовленного canvas

function processImage() {
  if (!srcImage) return;
  const k = Math.min(1, MAX_SIDE / Math.max(srcImage.naturalWidth, srcImage.naturalHeight));
  const w = Math.round(srcImage.naturalWidth * k), h = Math.round(srcImage.naturalHeight * k);
  overlay.width = w; overlay.height = h;
  const ctx = overlay.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(srcImage, 0, 0, w, h);
  prepared = { w, h };
  if (S.filter === 'original' && S.bright === 0 && S.contrast === 0) { drawGrid(ctx, w, h); return; }

  const id = ctx.getImageData(0, 0, w, h), d = id.data;
  const b = S.bright * 1.28;
  const c = S.contrast * 2.55;
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const adj = (v) => { v = f * (v - 128) + 128 + b; return v < 0 ? 0 : v > 255 ? 255 : v; };

  if (S.filter === 'contour') {
    const n = w * h, g = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const a = d[p + 3] / 255; // прозрачные области считаем белыми
      const lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      g[i] = adj(lum * a + 255 * (1 - a));
    }
    const edge = new Uint8Array(n), t = S.thresh * 4;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
        const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
        if (gx * gx + gy * gy > t * t) edge[i] = 1;
      }
    }
    let out = edge;
    for (let r = 1; r < S.thick; r++) { // утолщение линий
      const nx = new Uint8Array(n);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (out[i] || out[i - 1] || out[i + 1] || out[i - w] || out[i + w]) nx[i] = 1;
      }
      out = nx;
    }
    const col = parseInt(S.color.slice(1), 16);
    const cr = (col >> 16) & 255, cg = (col >> 8) & 255, cb = col & 255;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (out[i]) { d[p] = cr; d[p + 1] = cg; d[p + 2] = cb; d[p + 3] = 255; } else d[p + 3] = 0;
    }
  } else {
    for (let p = 0; p < d.length; p += 4) {
      let r = adj(d[p]), gg = adj(d[p + 1]), bb = adj(d[p + 2]);
      if (S.filter === 'gray') {
        const l = 0.299 * r + 0.587 * gg + 0.114 * bb; r = gg = bb = l;
      }
      if (S.filter === 'invert') { r = 255 - r; gg = 255 - gg; bb = 255 - bb; }
      d[p] = r; d[p + 1] = gg; d[p + 2] = bb;
    }
  }
  ctx.putImageData(id, 0, 0);
  drawGrid(ctx, w, h);
}

// Сетка: N клеток по ширине, клетки квадратные
function drawGrid(ctx, w, h) {
  if (!S.gridOn) return;
  const n = Math.max(2, S.gridN), step = w / n;
  ctx.save();
  ctx.strokeStyle = S.gridColor; ctx.lineWidth = Math.max(1, Math.round(w / 500));
  ctx.beginPath();
  for (let i = 0; i <= n; i++) { const x = Math.min(w - 0.5, Math.round(i * step) + 0.5); ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = 0; y <= h + 0.5; y += step) { const yy = Math.min(h - 0.5, Math.round(y) + 0.5); ctx.moveTo(0, yy); ctx.lineTo(w, yy); }
  ctx.stroke();
  ctx.restore();
}

// ---------- Положение картинки ----------
const T = { x: 0, y: 0, s: 1, r: 0 };
function fitScale() {
  return prepared ? Math.min(innerWidth / prepared.w, innerHeight / prepared.h) * 0.9 : 1;
}
function fitImage() {
  if (!prepared) return;
  T.s = fitScale();
  T.x = 0; T.y = 0; T.r = 0;
}
// Ползунок «Размер»: 10%…1000% от размера «по экрану», логарифмическая шкала (середина = 100%)
const SIZE_MIN = 0.1, SIZE_MAX = 10;
function sizeToSlider(k) { return Math.round(1000 * Math.log(k / SIZE_MIN) / Math.log(SIZE_MAX / SIZE_MIN)); }
function sliderToSize(v) { return SIZE_MIN * Math.pow(SIZE_MAX / SIZE_MIN, v / 1000); }
function syncSize() {
  const k = T.s / fitScale();
  $('size').value = sizeToSlider(Math.max(SIZE_MIN, Math.min(SIZE_MAX, k)));
  $('vSize').textContent = Math.round(k * 100) + '%';
}
function applyTransform() {
  if (!prepared) return;
  const m = S.mirror ? -1 : 1;
  overlay.style.transform =
    `translate(${T.x}px, ${T.y}px) rotate(${T.r}rad) scale(${T.s * m}, ${T.s}) translate(${-prepared.w / 2}px, ${-prepared.h / 2}px)`;
  syncSize();
}
// Сохранение текущего проекта (с задержкой, чтобы не писать на каждое движение)
let saveTimer = 0;
function saveProject() {
  if (!cur) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    Object.assign(cur, { T: { ...T }, updated: Date.now(), anchor: anchorState() }, pick(S, PROJECT_KEYS));
    DB.put('projects', cur).catch(() => {});
  }, 400);
}
const saveTransform = saveProject;
function anchorState() { return A.on && A.ref ? { ref: A.ref, screen: A.refScreen } : null; }

// ---------- Жесты ----------
const pointers = new Map();
let gPrev = null;
let locked = false;
const layer = $('gestureLayer');

function gestureState() {
  const pts = [...pointers.values()];
  const cx = innerWidth / 2, cy = innerHeight / 2;
  if (pts.length === 1) return { cx: pts[0].x - cx, cy: pts[0].y - cy, dist: 0, ang: 0, n: 1 };
  const [a, b] = pts;
  return { cx: (a.x + b.x) / 2 - cx, cy: (a.y + b.y) / 2 - cy,
    dist: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), n: 2 };
}
layer.addEventListener('pointerdown', (e) => {
  if (locked) { flashToast('🔒 Заблокировано — нажмите замок, чтобы двигать'); return; }
  if (A.on || A.searching) { flashToast('⚓ Картинка привязана к листу — нажмите ⚓, чтобы двигать'); return; }
  layer.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gPrev = gestureState();
});
layer.addEventListener('pointermove', (e) => {
  if (locked || !pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = gestureState();
  if (!gPrev || g.n !== gPrev.n) { gPrev = g; return; }
  if (g.n === 1) {
    T.x += g.cx - gPrev.cx; T.y += g.cy - gPrev.cy;
  } else {
    const k = gPrev.dist > 0 ? g.dist / gPrev.dist : 1;
    const da = g.ang - gPrev.ang;
    // поворот и масштаб вокруг центра жеста
    const dx = T.x - gPrev.cx, dy = T.y - gPrev.cy;
    const cos = Math.cos(da), sin = Math.sin(da);
    T.x = g.cx + k * (dx * cos - dy * sin);
    T.y = g.cy + k * (dx * sin + dy * cos);
    T.s *= k; T.r += da;
  }
  gPrev = g;
  applyTransform();
});
const endPtr = (e) => { pointers.delete(e.pointerId); gPrev = pointers.size ? gestureState() : null; saveTransform(); };
layer.addEventListener('pointerup', endPtr);
layer.addEventListener('pointercancel', endPtr);

// ---------- Камера ----------
const video = $('video');
let stream = null, track = null, hwZoom = null, torchOn = false, wakeLock = null;
let camId = null; try { camId = localStorage.getItem('td.camId'); } catch (e) {}

const caps = () => (track && track.getCapabilities ? track.getCapabilities() : {});
const isBack = (d) => /back|rear|environment|задн/i.test(d.label);

async function openStream(deviceId) {
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
  return navigator.mediaDevices.getUserMedia({ audio: false, video });
}

async function startCamera(deviceId = camId) {
  stopCamera();
  try {
    try { stream = await openStream(deviceId); }
    catch (e) { if (!deviceId) throw e; stream = await openStream(null); } // сохранённой камеры больше нет
  } catch (e) {
    flashToast('Нет доступа к камере. Разрешите камеру для этого сайта в настройках браузера.', 5000);
    return;
  }
  video.srcObject = stream;
  track = stream.getVideoTracks()[0];
  // возможности камеры (зум, фонарик) браузер отдаёт после старта видео
  await new Promise((r) => { if (video.readyState >= 2) r(); else video.onloadeddata = () => r(); setTimeout(r, 1500); });
  await new Promise((r) => setTimeout(r, 300));
  const c = caps();
  hwZoom = c.zoom ? c.zoom : null;
  const z = $('zoom');
  if (hwZoom) { z.min = hwZoom.min; z.max = Math.min(hwZoom.max, 10); z.step = hwZoom.step || 0.1; }
  else { z.min = 1; z.max = 5; z.step = 0.05; }
  z.value = Math.max(+z.min, Math.min(+z.max, S.zoomDef));
  setZoom(+z.value);
  torchOn = false; $('torchBtn').classList.remove('on');
  $('torchBtn').classList.toggle('off', !c.torch);
}
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; track = null;
}
async function setZoom(v) {
  if (hwZoom && track) {
    try { await track.applyConstraints({ advanced: [{ zoom: v }] }); video.style.transform = ''; return; } catch (e) {}
  }
  video.style.transform = v > 1 ? `scale(${v})` : ''; // программный зум
}
$('zoom').addEventListener('input', (e) => setZoom(+e.target.value));

async function setTorch(on) {
  try { await track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch (e) {}
  try { await track.applyConstraints({ torch: on }); return true; } catch (e) {}
  return false;
}
function rememberCam() {
  try { camId = track.getSettings().deviceId; localStorage.setItem('td.camId', camId); } catch (e) {}
}

// Перебрать задние камеры и найти ту, у которой есть фонарик
async function findTorchCamera() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const current = track ? track.getSettings().deviceId : null;
  const order = [...devs.filter(isBack), ...devs.filter((d) => !isBack(d))].filter((d) => d.deviceId !== current);
  for (const d of order) {
    await startCamera(d.deviceId);
    if (caps().torch) { rememberCam(); return true; }
  }
  await startCamera(current); // не нашли — вернуть прежнюю
  return false;
}

$('torchBtn').addEventListener('click', async () => {
  if (!track) return;
  if (torchOn) { await setTorch(false); torchOn = false; $('torchBtn').classList.remove('on'); return; }
  if (!caps().torch) {
    flashToast('Ищу камеру с фонариком…', 4000);
    if (!(await findTorchCamera())) {
      flashToast('Браузер не даёт управлять фонариком ни на одной камере. Попробуйте Chrome.', 4000);
      return;
    }
  }
  torchOn = await setTorch(true);
  if (!torchOn) flashToast('Не удалось включить фонарик');
  else flashToast('Фонарик включён');
  $('torchBtn').classList.toggle('on', torchOn);
  $('torchBtn').classList.remove('off');
});

// Переключение камер по кругу (задние первыми)
$('camBtn').addEventListener('click', async () => {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  if (devs.length < 2) { flashToast('Камера одна'); return; }
  const list = [...devs.filter(isBack), ...devs.filter((d) => !isBack(d))];
  const cur = track ? track.getSettings().deviceId : null;
  const i = list.findIndex((d) => d.deviceId === cur);
  const next = list[(i + 1) % list.length];
  await startCamera(next.deviceId);
  rememberCam();
  sheet.classList.remove('open');
  flashToast(`Камера ${list.indexOf(next) + 1} из ${list.length}${caps().torch ? ' · есть фонарик' : ''}`);
});

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('trace').classList.contains('active')) {
    requestWakeLock();
    if (mode === 'camera' && (!stream || !track || track.readyState === 'ended')) startCamera();
  }
});

// ---------- Переходы ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}
async function openProject(p, m = 'camera') {
  let img;
  try { img = await blobToImage(p.blob); } catch (e) { flashToast('Не удалось открыть картинку проекта'); return; }
  cur = p; srcImage = img; mode = m;
  for (const k of PROJECT_KEYS) if (p[k] !== undefined) S[k] = p[k];
  syncSettingsUI();
  try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch (e) {}
  show('trace');
  processImage();
  if (p.T) Object.assign(T, p.T); else fitImage();
  applyTransform();
  overlay.style.opacity = S.opacity / 100;
  manualHidden = false; overlay.classList.remove('hidden'); $('eyeBtn').classList.remove('off');
  applyMode();
  $('opacity').value = S.opacity;
  p.updated = Date.now(); DB.put('projects', p).catch(() => {});
  requestWakeLock();
  startBlink();
  if (mode === 'light') { stopCamera(); lightHint(); stopAnchor(); } else { await startCamera(); restoreAnchor(p); }
}

$('backBtn').addEventListener('click', async () => {
  if (rec) await stopRec();
  stopBlink();
  sheet.classList.remove('open');
  stopCamera();
  try { wakeLock?.release(); } catch (e) {}
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setLocked(false);
  if (cur) { clearTimeout(saveTimer); Object.assign(cur, { T: { ...T }, updated: Date.now(), anchor: anchorState() }, pick(S, PROJECT_KEYS));
    DB.put('projects', cur).catch(() => {}).then(renderProjects); }
  cur = null;
  stopAnchor();
  show('home');
});

$('opacity').addEventListener('input', (e) => {
  S.opacity = +e.target.value; overlay.style.opacity = S.opacity / 100; saveSettings(); saveProject();
});
$('eyeBtn').addEventListener('click', () => {
  manualHidden = !manualHidden;
  overlayVisible(!manualHidden);
  $('eyeBtn').classList.toggle('off', manualHidden);
});
function setLocked(v) {
  locked = v;
  $('lockBtn').textContent = v ? '🔒' : '🔓';
  $('lockBtn').classList.toggle('on', v);
  $('lockBadge').classList.toggle('show', v);
  $('size').disabled = v;
  pointers.clear(); gPrev = null;
  // световой стол: блокируем весь экран, панель прячем
  const block = v && mode === 'light';
  $('trace').classList.toggle('blocked', block);
  if (block) { $('toolbar').classList.add('collapsed'); $('showBarBtn').classList.remove('show'); }
  else if (!v && $('trace').classList.contains('light')) { $('toolbar').classList.remove('collapsed'); }
}
$('lockBtn').addEventListener('click', () => setLocked(!locked));
$('size').addEventListener('input', (e) => {
  if (A.on) { syncSize(); flashToast('⚓ Сначала снимите привязку'); return; }
  if (locked) { syncSize(); flashToast('Сначала снимите замок'); return; }
  T.s = fitScale() * sliderToSize(+e.target.value);
  applyTransform();
});
$('size').addEventListener('change', saveTransform);
// двойной тап по проценту — вернуть 100%
$('vSize').addEventListener('dblclick', () => { if (!locked) { T.s = fitScale(); applyTransform(); saveTransform(); } });
$('resetBtn').addEventListener('click', () => {
  if (locked) { flashToast('Сначала снимите замок'); return; }
  if (A.on || A.searching) setAnchor(false);
  fitImage(); applyTransform(); saveTransform();
  sheet.classList.remove('open');
});
$('hideBarBtn').addEventListener('click', () => { $('toolbar').classList.add('collapsed'); $('showBarBtn').classList.add('show'); });
$('showBarBtn').addEventListener('click', () => { $('toolbar').classList.remove('collapsed'); $('showBarBtn').classList.remove('show'); });

let toastTimer = 0;
function flashToast(msg, ms = 2000) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- Экран настроек ----------
const sheet = $('settings');
function syncSettingsUI() {
  document.querySelectorAll('#filterSeg button').forEach((b) => b.classList.toggle('on', b.dataset.f === S.filter));
  sheet.classList.toggle('contour', S.filter === 'contour');
  $('gridBtn').classList.toggle('on', S.gridOn);
  $('sBright').value = S.bright; $('vBright').textContent = S.bright;
  $('sContrast').value = S.contrast; $('vContrast').textContent = S.contrast;
  $('sThresh').value = S.thresh; $('vThresh').textContent = S.thresh;
  $('sThick').value = S.thick; $('vThick').textContent = S.thick;
  $('sColor').value = S.color;
  $('sZoomDef').value = S.zoomDef; $('vZoomDef').textContent = '×' + (+S.zoomDef).toFixed(1);
  $('sMirror').checked = S.mirror;
  $('sGridOn').checked = S.gridOn; sheet.classList.toggle('grid', S.gridOn);
  $('sGridN').value = S.gridN; $('vGridN').textContent = S.gridN;
  $('sGridColor').value = S.gridColor;
  $('sBlinkOn').checked = S.blinkOn; sheet.classList.toggle('blink', S.blinkOn);
  $('sBlinkSec').value = S.blinkSec; $('vBlinkSec').textContent = S.blinkSec;
  $('sBlinkHide').value = S.blinkHide; $('vBlinkHide').textContent = S.blinkHide;
  document.querySelectorAll('#speedSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.s === +S.recSpeed));
  $('sRecOverlay').checked = S.recOverlay;
}
let reprocessTimer = 0;
function changed(reprocess = true) {
  saveSettings(); syncSettingsUI(); saveProject();
  if (reprocess && $('trace').classList.contains('active')) {
    clearTimeout(reprocessTimer);
    reprocessTimer = setTimeout(() => { processImage(); applyTransform(); }, 120);
  } else applyTransform();
}
$('settingsBtn').addEventListener('click', () => { syncSettingsUI(); sheet.classList.add('open'); });
$('closeSettings').addEventListener('click', () => sheet.classList.remove('open'));
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.classList.remove('open'); });
document.querySelectorAll('#filterSeg button').forEach((b) =>
  b.addEventListener('click', () => { S.filter = b.dataset.f; changed(); }));
[['sBright', 'bright'], ['sContrast', 'contrast'], ['sThresh', 'thresh'], ['sThick', 'thick']].forEach(([id, key]) =>
  $(id).addEventListener('input', (e) => { S[key] = +e.target.value; changed(); }));
$('sColor').addEventListener('input', (e) => { S.color = e.target.value; changed(); });
$('sZoomDef').addEventListener('input', (e) => {
  S.zoomDef = +e.target.value; changed(false);
  if (track) { const z = $('zoom'); z.value = Math.max(+z.min, Math.min(+z.max, S.zoomDef)); setZoom(+z.value); }
});
$('sMirror').addEventListener('change', (e) => { S.mirror = e.target.checked; changed(false); });
$('sGridOn').addEventListener('change', (e) => { S.gridOn = e.target.checked; changed(); });
$('sGridN').addEventListener('input', (e) => { S.gridN = +e.target.value; changed(); });
$('sGridColor').addEventListener('input', (e) => { S.gridColor = e.target.value; changed(); });
$('sBlinkOn').addEventListener('change', (e) => { S.blinkOn = e.target.checked; changed(false); startBlink(); });
$('sBlinkSec').addEventListener('input', (e) => { S.blinkSec = +e.target.value; changed(false); startBlink(); });
$('sBlinkHide').addEventListener('input', (e) => { S.blinkHide = +e.target.value; changed(false); startBlink(); });
document.querySelectorAll('#speedSeg button').forEach((b) =>
  b.addEventListener('click', () => { S.recSpeed = +b.dataset.s; changed(false); }));
$('sRecOverlay').addEventListener('change', (e) => { S.recOverlay = e.target.checked; changed(false); });
$('gridBtn').addEventListener('click', () => { S.gridOn = !S.gridOn; changed(); $('gridBtn').classList.toggle('on', S.gridOn); });
$('resetFilters').addEventListener('click', () => {
  Object.assign(S, { filter: 'original', bright: 0, contrast: 0, thresh: 60, thick: 1, color: '#ff2a2a' });
  changed();
});
syncSettingsUI();

window.addEventListener('resize', () => applyTransform());


// ---------- Мигание картинки ----------
let blinkTimer = 0, blinkHideTimer = 0, manualHidden = false;
function overlayVisible(v) { overlay.classList.toggle('hidden', !v); }
function startBlink() {
  stopBlink();
  if (!S.blinkOn || !$('trace').classList.contains('active')) return;
  blinkTimer = setInterval(() => {
    if (manualHidden) return;
    overlayVisible(false);
    blinkHideTimer = setTimeout(() => { if (!manualHidden) overlayVisible(true); }, S.blinkHide * 1000);
  }, Math.max(S.blinkSec, S.blinkHide + 0.5) * 1000);
}
function stopBlink() {
  clearInterval(blinkTimer); clearTimeout(blinkHideTimer);
  if (!manualHidden) overlayVisible(true);
}

// ---------- Режим «Световой стол» ----------
function applyMode() {
  const light = mode === 'light';
  $('trace').classList.toggle('light', light);
  $('modeBtn').textContent = light ? '📷 Режим камеры' : '💡 Световой стол';
  sheet.classList.toggle('light', light);
}
$('modeBtn').addEventListener('click', async () => {
  if (rec) await stopRec();
  mode = mode === 'light' ? 'camera' : 'light';
  applyMode();
  sheet.classList.remove('open');
  if (mode === 'light') { stopCamera(); lightHint(); stopAnchor(); } else await startCamera();
});
function lightHint() {
  flashToast('💡 Выкрутите яркость экрана на максимум, положите лист на экран и нажмите 🔒', 4500);
}
// В световом столе замок закрывает весь экран; разблокировка — удержание в левом верхнем углу
let unlockTimer = 0;
$('unlockCorner').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  $('unlockCorner').classList.add('holding');
  unlockTimer = setTimeout(() => { $('unlockCorner').classList.remove('holding'); setLocked(false); }, 2000);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => $('unlockCorner').addEventListener(ev, () => {
  clearTimeout(unlockTimer); $('unlockCorner').classList.remove('holding');
}));
$('blocker').addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Сохранение файлов ----------
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---------- Фото готового рисунка ----------
$('photoBtn').addEventListener('click', async () => {
  if (!track || !video.videoWidth) { flashToast('Камера ещё не готова'); return; }
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const blob = await canvasToBlob(c, 'image/jpeg', 0.92);
  download(blob, `Обводилка_фото_${stamp()}.jpg`);
  flashToast('📸 Фото сохранено в «Загрузки»');
});

// ---------- Запись видео / таймлапс ----------
let rec = null;
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

// Нарисовать картинку поверх кадра так же, как она лежит на экране
function drawOverlayInto(ctx, W, H, vw, vh) {
  if (!prepared || overlay.classList.contains('hidden')) return;
  const cssZoom = hwZoom ? 1 : Math.max(1, +$('zoom').value || 1);
  const cover = Math.max(innerWidth / vw, innerHeight / vh) * cssZoom; // экранных px на 1 px кадра
  const k = W / vw;
  const m = S.mirror ? -1 : 1;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(k / cover, k / cover);
  if (A.on) { // привязка к листу: аффинная часть гомографии (перспектива на записи не учитывается)
    const h = A.H;
    ctx.translate(-innerWidth / 2, -innerHeight / 2);
    ctx.transform(h[0] / h[8], h[3] / h[8], h[1] / h[8], h[4] / h[8], h[2] / h[8], h[5] / h[8]);
    ctx.translate(innerWidth / 2, innerHeight / 2);
  }
  ctx.translate(T.x, T.y); ctx.rotate(T.r); ctx.scale(T.s * m, T.s);
  ctx.translate(-prepared.w / 2, -prepared.h / 2);
  ctx.globalAlpha = S.opacity / 100;
  ctx.drawImage(overlay, 0, 0);
  ctx.restore();
}

async function startRec() {
  if (!track || !video.videoWidth) { flashToast('Камера ещё не готова'); return; }
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.min(1, 1280 / Math.max(vw, vh));
  const W = even(vw * k), H = even(vh * k);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const draw = () => { ctx.drawImage(video, 0, 0, W, H); if (S.recOverlay) drawOverlayInto(ctx, W, H, vw, vh); };
  let speed = S.recSpeed;
  const r = { start: Date.now(), speed, frames: 0 };

  let codec = null;
  if (window.VideoEncoder && window.Mp4Muxer) {
    for (const cand of ['avc1.42001f', 'avc1.4d0028', 'avc1.640028']) {
      try {
        const sup = await VideoEncoder.isConfigSupported({ codec: cand, width: W, height: H, bitrate: 6e6, framerate: 30 });
        if (sup.supported) { codec = cand; break; }
      } catch (e) {}
    }
  }
  if (codec) {
    // Своя частота кадров → настоящий таймлапс: 1 кадр в видео = speed/30 с реального времени
    const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H }, fastStart: 'in-memory' });
    const enc = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta),
      error: (e) => { flashToast('Ошибка записи: ' + e.message, 4000); } });
    enc.configure({ codec, width: W, height: H, bitrate: 6e6, framerate: 30 });
    r.kind = 'mp4'; r.muxer = muxer; r.enc = enc;
    r.timer = setInterval(() => {
      if (enc.encodeQueueSize > 4) return;
      draw();
      const f = new VideoFrame(c, { timestamp: r.frames * 1e6 / 30, duration: 1e6 / 30 });
      enc.encode(f, { keyFrame: r.frames % 60 === 0 }); f.close();
      r.frames++;
    }, 1000 / 30 * speed);
  } else if (window.MediaRecorder && c.captureStream) {
    // запасной вариант: обычная запись без ускорения
    speed = r.speed = 1;
    const stream = c.captureStream(30);
    const type = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6e6 } : {});
    r.kind = 'mr'; r.mr = mr; r.chunks = []; r.type = mr.mimeType || 'video/webm';
    mr.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    mr.start(1000);
    r.timer = setInterval(draw, 1000 / 30);
    if (S.recSpeed !== 1) flashToast('Ускоренная запись не поддерживается — пишу ×1', 3500);
  } else { flashToast('Браузер не умеет записывать видео'); return; }

  rec = r;
  $('recBtn').classList.add('on'); $('recBtn').textContent = '⏹️';
  $('recInfo').textContent = speed > 1 ? `×${speed}` : '';
  $('recBadge').classList.add('show');
  r.clock = setInterval(() => {
    const s = Math.floor((Date.now() - r.start) / 1000);
    $('recTime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

async function stopRec() {
  const r = rec; if (!r) return;
  rec = null;
  clearInterval(r.timer); clearInterval(r.clock);
  $('recBtn').classList.remove('on'); $('recBtn').textContent = '⏺️';
  $('recBadge').classList.remove('show'); $('recTime').textContent = '00:00';
  let blob = null, ext = 'mp4';
  try {
    if (r.kind === 'mp4') {
      if (!r.frames) { flashToast('Слишком короткая запись'); return; }
      await r.enc.flush(); r.enc.close(); r.muxer.finalize();
      blob = new Blob([r.muxer.target.buffer], { type: 'video/mp4' });
    } else {
      await new Promise((res) => { r.mr.onstop = res; r.mr.stop(); });
      blob = new Blob(r.chunks, { type: r.type });
      ext = r.type.includes('mp4') ? 'mp4' : 'webm';
    }
  } catch (e) { flashToast('Не удалось сохранить видео'); return; }
  download(blob, `Обводилка_видео_${stamp()}.${ext}`);
  flashToast('🎬 Видео сохранено в «Загрузки»', 3000);
}
$('recBtn').addEventListener('click', () => (rec ? stopRec() : startRec()));

// ---------- Картинка, присланная через «Поделиться» ----------
(async () => {
  if (!/[?&]shared=1/.test(location.search)) return;
  history.replaceState(null, '', location.pathname);
  try {
    const c = await caches.open('td-share');
    const r = await c.match('shared-image');
    if (r) { const b = await r.blob(); await c.delete('shared-image'); openEditor(b, null); }
  } catch (e) {}
})();


// ---------- v2: привязка картинки к листу по меткам ArUco ----------
// На листе 4 метки (ArUco 4×4, № 0–3). При привязке запоминаем, где метки были на экране;
// дальше каждый кадр ищем их снова и считаем преобразование «тогда → сейчас» (гомографию),
// которое применяется ко всей картинке. Сдвинули телефон или лист — картинка едет вместе с листом.
const anchorWrap = $('anchorWrap');
const A = { on: false, searching: false, ref: null, H: [1, 0, 0, 0, 1, 0, 0, 0, 1], timer: 0, seen: 0, stable: 0 };
let det = null;
function detector() {
  if (det || !window.AR) return det;
  det = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000' });
  // оставляем только метки № 0–3: меньше ложных срабатываний и больше допуск на ошибки
  det.dictionary.codeList = det.dictionary.codeList.slice(0, 4);
  det.dictionary.tau = Math.max(1, Math.floor((det.dictionary._calculateTau() - 1) / 2));
  return det;
}
const dCanvas = document.createElement('canvas');
const dCtx = dCanvas.getContext('2d', { willReadFrequently: true });

// Найти метки на текущем кадре; углы — в координатах экрана
function detectMarkers() {
  const d = detector();
  if (!d || !video.videoWidth) return [];
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.min(1, 720 / Math.max(vw, vh));
  const dw = Math.round(vw * k), dh = Math.round(vh * k);
  if (dCanvas.width !== dw || dCanvas.height !== dh) { dCanvas.width = dw; dCanvas.height = dh; }
  dCtx.drawImage(video, 0, 0, dw, dh);
  let ms;
  try { ms = d.detect(dCtx.getImageData(0, 0, dw, dh)); } catch (e) { return []; }
  const cssZoom = hwZoom ? 1 : Math.max(1, +$('zoom').value || 1);
  const cover = Math.max(innerWidth / vw, innerHeight / vh) * cssZoom;
  const toScr = (p) => ({ x: innerWidth / 2 + (p.x / k - vw / 2) * cover, y: innerHeight / 2 + (p.y / k - vh / 2) * cover });
  const seen = new Set();
  return ms.filter((m) => m.id >= 0 && m.id < 4 && !seen.has(m.id) && seen.add(m.id))
    .map((m) => ({ id: m.id, pts: m.corners.map(toScr) }));
}

// Решение СЛАУ методом Гаусса (для 8×8)
function solve(M, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let j = c; j < n; j++) M[r][j] -= f * M[c][j];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}
// Гомография по ≥4 парам точек (метод наименьших квадратов, h8 = 1), с нормировкой координат
function homography(src, dst) {
  const s = 1 / Math.max(innerWidth, innerHeight);
  const M = Array.from({ length: 8 }, () => new Array(8).fill(0)), b = new Array(8).fill(0);
  for (let i = 0; i < src.length; i++) {
    const x = src[i].x * s, y = src[i].y * s, u = dst[i].x * s, v = dst[i].y * s;
    const rows = [[x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]];
    for (const r of rows) for (let a = 0; a < 8; a++) { b[a] += r[a] * r[8]; for (let c = 0; c < 8; c++) M[a][c] += r[a] * r[c]; }
  }
  const h = solve(M, b);
  if (!h) return null;
  // вернуть из нормированных координат: H = S⁻¹·Hn·S
  return [h[0], h[1], h[2] / s, h[3], h[4], h[5] / s, h[6] * s, h[7] * s, 1];
}
// Подобие (сдвиг + поворот + масштаб), когда видна только одна метка
function similarity(src, dst) {
  const n = src.length;
  let mx = 0, my = 0, ux = 0, uy = 0;
  for (let i = 0; i < n; i++) { mx += src[i].x; my += src[i].y; ux += dst[i].x; uy += dst[i].y; }
  mx /= n; my /= n; ux /= n; uy /= n;
  let sa = 0, sb = 0, sd = 0;
  for (let i = 0; i < n; i++) {
    const dx = src[i].x - mx, dy = src[i].y - my, ex = dst[i].x - ux, ey = dst[i].y - uy;
    sa += dx * ex + dy * ey; sb += dx * ey - dy * ex; sd += dx * dx + dy * dy;
  }
  if (sd < 1e-6) return null;
  const a = sa / sd, b = sb / sd;
  return [a, -b, ux - (a * mx - b * my), b, a, uy - (b * mx + a * my), 0, 0, 1];
}
function applyAnchor() {
  const h = A.H;
  anchorWrap.style.transform = A.on
    ? `matrix3d(${h[0]},${h[3]},0,${h[6]}, ${h[1]},${h[4]},0,${h[7]}, 0,0,1,0, ${h[2]},${h[5]},0,${h[8]})` : '';
}
function badge(text, cls) {
  const b = $('anchorBadge');
  b.textContent = text; b.className = 'abadge' + (text ? ' show ' + (cls || '') : '');
}

function anchorTick() {
  if (!track || mode !== 'camera' || !$('trace').classList.contains('active')) return;
  const found = detectMarkers();
  if (A.searching) {
    badge(`⚓ Ищу метки… найдено ${found.length} из 4`, found.length >= 2 ? 'ok' : 'lost');
    A.stable = found.length >= 2 ? A.stable + 1 : 0;
    if (A.stable >= 4) { // метки устойчиво видны ~0,5 с — запоминаем
      A.ref = Object.fromEntries(found.map((m) => [m.id, m.pts]));
      A.refScreen = [innerWidth, innerHeight];
      A.H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      A.searching = false; A.on = true;
      $('anchorBtn').classList.add('on');
      flashToast(`⚓ Картинка привязана к листу (меток: ${found.length})`);
      saveProject();
    }
    return;
  }
  if (!A.on) return;
  const src = [], dst = [];
  for (const m of found) {
    const r = A.ref[m.id];
    if (!r) continue;
    for (let i = 0; i < 4; i++) { src.push(r[i]); dst.push(m.pts[i]); }
  }
  const n = src.length / 4;
  if (!n) { badge('⚓ Метки не видны — картинка стоит на месте', 'lost'); return; }
  const Hn = n >= 2 ? homography(src, dst) : similarity(src, dst);
  if (!Hn) return;
  // сглаживание, чтобы картинка не дрожала
  const a = 0.55;
  A.H = A.H.map((v, i) => v + (Hn[i] - v) * a);
  applyAnchor();
  badge(`⚓ ${n} из 4`, 'ok');
}
function startAnchorLoop() {
  clearInterval(A.timer);
  if (A.on || A.searching) A.timer = setInterval(anchorTick, 110);
}
function setAnchor(on) {
  if (on) {
    if (mode !== 'camera' || !track) { flashToast('Привязка работает только с камерой'); return; }
    if (!detector()) { flashToast('Не загрузился модуль распознавания меток'); return; }
    if (locked) setLocked(false);
    A.searching = true; A.on = false; A.stable = 0; A.H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    applyAnchor();
    flashToast('Наведите камеру на лист с метками — нужно хотя бы 2 из 4', 3000);
  } else {
    A.searching = false; A.on = false; A.ref = null; A.H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    applyAnchor(); badge('');
    $('anchorBtn').classList.remove('on');
    saveProject();
  }
  startAnchorLoop();
}
$('anchorBtn').addEventListener('click', () => {
  if (A.on || A.searching) { setAnchor(false); flashToast('Привязка снята'); } else setAnchor(true);
});
// при открытии рисунка — восстановить привязку, если экран тот же
function restoreAnchor(p) {
  A.searching = false; A.H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const ok = p.anchor && p.anchor.screen && p.anchor.screen[0] === innerWidth && p.anchor.screen[1] === innerHeight && mode === 'camera';
  A.on = !!ok; A.ref = ok ? p.anchor.ref : null; A.refScreen = ok ? p.anchor.screen : null;
  $('anchorBtn').classList.toggle('on', A.on);
  applyAnchor(); badge(A.on ? '⚓ Ищу метки…' : '', 'lost');
  startAnchorLoop();
}
function stopAnchor() {
  clearInterval(A.timer); A.searching = false; A.on = false; A.ref = null;
  A.H = [1, 0, 0, 0, 1, 0, 0, 0, 1]; applyAnchor(); badge(''); $('anchorBtn').classList.remove('on');
}


// ---------- Панель кнопок: бесконечная прокрутка по кругу ----------
// Кнопки идут тремя одинаковыми наборами; когда прокрутка уходит в крайний набор,
// незаметно перескакиваем в средний. Копии повторяют вид оригиналов и нажимают их.
(function loopToolbar() {
  const sc = $('tbScroll'), trk = $('tbTrack');
  const originals = [...trk.children];
  const mk = () => originals.map((o) => {
    const c = o.cloneNode(true);
    c.removeAttribute('id'); c.classList.add('clone'); c.dataset.for = o.id;
    c.addEventListener('click', () => o.click());
    return c;
  });
  const before = mk(), after = mk();
  before.forEach((c) => trk.insertBefore(c, originals[0]));
  after.forEach((c) => trk.appendChild(c));
  const sync = (o) => {
    for (const c of trk.querySelectorAll(`.clone[data-for="${o.id}"]`)) {
      c.className = o.className + ' clone'; c.textContent = o.textContent; c.disabled = o.disabled;
    }
  };
  const mo = new MutationObserver((list) => {
    const set = new Set(list.map((m) => (m.target.nodeType === 1 ? m.target : m.target.parentElement).closest('button')));
    set.forEach((o) => o && o.id && sync(o));
  });
  originals.forEach((o) => mo.observe(o, { attributes: true, childList: true, characterData: true, subtree: true }));

  let setW = 0;
  function measure() {
    sc.classList.remove('static');
    const vis = originals.filter((o) => o.offsetParent !== null);
    if (!vis.length) return;
    const gap = parseFloat(getComputedStyle(trk).columnGap) || 0;
    setW = vis.reduce((w, o) => w + o.offsetWidth + gap, 0);
    if (setW <= sc.clientWidth + 1) { sc.classList.add('static'); sc.scrollLeft = 0; setW = 0; return; }
    sc.scrollLeft = setW + (sc.scrollLeft % setW);
  }
  sc.addEventListener('scroll', () => {
    if (!setW) return;
    if (sc.scrollLeft < setW * 0.5) sc.scrollLeft += setW;
    else if (sc.scrollLeft > setW * 1.5) sc.scrollLeft -= setW;
  }, { passive: true });
  window.addEventListener('resize', measure);
  // пересчитать, когда панель показалась или сменился режим (часть кнопок скрывается)
  new MutationObserver(measure).observe($('trace'), { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(measure).observe($('toolbar'), { attributes: true, attributeFilter: ['class'] });
  window.toolbarMeasure = measure;
})();

$('ver').textContent = 'версия ' + APP_VERSION;

// ---------- Офлайн ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
  // пришла новая версия — один раз перезагрузить страницу (только на главном экране)
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !$('home').classList.contains('active')) return;
    reloaded = true; location.reload();
  });
}
