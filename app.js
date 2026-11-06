'use strict';
/* Обводилка — v1.1
   Камера во весь экран + картинка поверх с прозрачностью.
   Жесты: 1 палец — сдвиг, 2 пальца — масштаб и поворот. Замок блокирует жесты. */

const $ = (id) => document.getElementById(id);

// ---------- Настройки (localStorage) ----------
const DEFAULTS = { filter: 'original', bright: 0, contrast: 0, thresh: 60, thick: 1,
  color: '#ff2a2a', zoomDef: 1, mirror: false, opacity: 50, gridOn: false, gridN: 6, gridColor: '#2a7bff' };
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
      <div class="proj-acts"><button data-a="edit" title="Обрезать">✂️</button>
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
    Object.assign(cur, { T: { ...T }, updated: Date.now() }, pick(S, PROJECT_KEYS));
    DB.put('projects', cur).catch(() => {});
  }, 400);
}
const saveTransform = saveProject;

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
  flashToast(`Камера ${list.indexOf(next) + 1} из ${list.length}${caps().torch ? ' · есть фонарик' : ''}`);
});

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('trace').classList.contains('active')) {
    requestWakeLock();
    if (!stream || !track || track.readyState === 'ended') startCamera();
  }
});

// ---------- Переходы ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}
async function openProject(p) {
  let img;
  try { img = await blobToImage(p.blob); } catch (e) { flashToast('Не удалось открыть картинку проекта'); return; }
  cur = p; srcImage = img;
  for (const k of PROJECT_KEYS) if (p[k] !== undefined) S[k] = p[k];
  syncSettingsUI();
  try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch (e) {}
  show('trace');
  processImage();
  if (p.T) Object.assign(T, p.T); else fitImage();
  applyTransform();
  overlay.style.opacity = S.opacity / 100;
  overlay.classList.remove('hidden'); $('eyeBtn').classList.remove('off');
  $('opacity').value = S.opacity;
  p.updated = Date.now(); DB.put('projects', p).catch(() => {});
  await startCamera();
  requestWakeLock();
}

$('backBtn').addEventListener('click', () => {
  stopCamera();
  try { wakeLock?.release(); } catch (e) {}
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setLocked(false);
  if (cur) { clearTimeout(saveTimer); Object.assign(cur, { T: { ...T }, updated: Date.now() }, pick(S, PROJECT_KEYS));
    DB.put('projects', cur).catch(() => {}).then(renderProjects); }
  cur = null;
  show('home');
});

$('opacity').addEventListener('input', (e) => {
  S.opacity = +e.target.value; overlay.style.opacity = S.opacity / 100; saveSettings(); saveProject();
});
$('eyeBtn').addEventListener('click', () => {
  const hidden = overlay.classList.toggle('hidden');
  $('eyeBtn').classList.toggle('off', hidden);
});
function setLocked(v) {
  locked = v;
  $('lockBtn').textContent = v ? '🔒' : '🔓';
  $('lockBtn').classList.toggle('on', v);
  $('lockBadge').classList.toggle('show', v);
  $('size').disabled = v;
  pointers.clear(); gPrev = null;
}
$('lockBtn').addEventListener('click', () => setLocked(!locked));
$('size').addEventListener('input', (e) => {
  if (locked) { syncSize(); flashToast('Сначала снимите замок'); return; }
  T.s = fitScale() * sliderToSize(+e.target.value);
  applyTransform();
});
$('size').addEventListener('change', saveTransform);
// двойной тап по проценту — вернуть 100%
$('vSize').addEventListener('dblclick', () => { if (!locked) { T.s = fitScale(); applyTransform(); saveTransform(); } });
$('resetBtn').addEventListener('click', () => {
  if (locked) { flashToast('Сначала снимите замок'); return; }
  fitImage(); applyTransform(); saveTransform();
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
$('gridBtn').addEventListener('click', () => { S.gridOn = !S.gridOn; changed(); $('gridBtn').classList.toggle('on', S.gridOn); });
$('resetFilters').addEventListener('click', () => {
  Object.assign(S, { filter: 'original', bright: 0, contrast: 0, thresh: 60, thick: 1, color: '#ff2a2a' });
  changed();
});
syncSettingsUI();

window.addEventListener('resize', () => applyTransform());

// ---------- Офлайн ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
