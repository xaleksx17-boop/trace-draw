'use strict';
/* Обводилка — MVP
   Камера во весь экран + картинка поверх с прозрачностью.
   Жесты: 1 палец — сдвиг, 2 пальца — масштаб и поворот. Замок блокирует жесты. */

const $ = (id) => document.getElementById(id);

// ---------- Настройки (localStorage) ----------
const DEFAULTS = { filter: 'original', bright: 0, contrast: 0, thresh: 60, thick: 1,
  color: '#ff2a2a', zoomDef: 1, mirror: false, opacity: 50 };
let S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem('td.settings') || '{}')); } catch (e) {}
function saveSettings() { try { localStorage.setItem('td.settings', JSON.stringify(S)); } catch (e) {} }

// ---------- Хранение последней картинки (IndexedDB) ----------
const DB = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('trace-draw', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async put(key, val) {
    try { const db = await this.open();
      await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
    } catch (e) {}
  },
  async get(key) {
    try { const db = await this.open();
      return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(key);
        q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
    } catch (e) { return null; }
  }
};

// ---------- Загрузка картинки ----------
let srcImage = null;       // ImageBitmap/Image исходной картинки (уменьшенной)
let srcBlob = null;
const MAX_SIDE = 1600;

async function loadBlob(blob, persist = true) {
  if (!blob) return;
  try {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    srcImage = img; srcBlob = blob;
    $('previewImg').src = url;
    $('preview').classList.add('has');
    $('startBtn').disabled = false;
    $('homeHint').textContent = `Картинка ${img.naturalWidth}×${img.naturalHeight}`;
    if (persist) DB.put('last', blob);
    prepared = null;
  } catch (e) {
    $('homeHint').textContent = 'Не удалось открыть картинку';
  }
}

$('pickCamera').addEventListener('change', (e) => loadBlob(e.target.files[0]));
$('pickGallery').addEventListener('change', (e) => loadBlob(e.target.files[0]));
$('pasteBtn').addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) { await loadBlob(await it.getType(type)); return; }
    }
    $('homeHint').textContent = 'В буфере нет картинки';
  } catch (e) {
    $('homeHint').textContent = 'Браузер не дал доступ к буферу — используйте «Из галереи»';
  }
});
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) loadBlob(f);
});
DB.get('last').then((b) => { if (b) loadBlob(b, false); });

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
  if (S.filter === 'original' && S.bright === 0 && S.contrast === 0) { prepared = { w, h }; return; }

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
  prepared = { w, h };
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
function saveTransform() { try { localStorage.setItem('td.transform', JSON.stringify(T)); } catch (e) {} }

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
$('startBtn').addEventListener('click', async () => {
  if (!srcImage) return;
  try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch (e) {}
  show('trace');
  processImage();
  let restored = false;
  try {
    const t = JSON.parse(localStorage.getItem('td.transform') || 'null');
    if (t && localStorage.getItem('td.transformFor') === imgKey()) { Object.assign(T, t); restored = true; }
  } catch (e) {}
  if (!restored) fitImage();
  try { localStorage.setItem('td.transformFor', imgKey()); } catch (e) {}
  applyTransform();
  overlay.style.opacity = S.opacity / 100;
  $('opacity').value = S.opacity;
  await startCamera();
  requestWakeLock();
});
function imgKey() { return srcBlob ? `${srcBlob.size}-${srcImage.naturalWidth}x${srcImage.naturalHeight}` : ''; }

$('backBtn').addEventListener('click', () => {
  stopCamera();
  try { wakeLock?.release(); } catch (e) {}
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setLocked(false);
  show('home');
});

$('opacity').addEventListener('input', (e) => {
  S.opacity = +e.target.value; overlay.style.opacity = S.opacity / 100; saveSettings();
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
  $('sBright').value = S.bright; $('vBright').textContent = S.bright;
  $('sContrast').value = S.contrast; $('vContrast').textContent = S.contrast;
  $('sThresh').value = S.thresh; $('vThresh').textContent = S.thresh;
  $('sThick').value = S.thick; $('vThick').textContent = S.thick;
  $('sColor').value = S.color;
  $('sZoomDef').value = S.zoomDef; $('vZoomDef').textContent = '×' + (+S.zoomDef).toFixed(1);
  $('sMirror').checked = S.mirror;
}
let reprocessTimer = 0;
function changed(reprocess = true) {
  saveSettings(); syncSettingsUI();
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
