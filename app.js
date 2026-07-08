'use strict';
/* ============================================================
   순간일기 (Moment Diary)
   - 음성 → 텍스트 일기 (Web Speech API, 실패 시 직접 입력 안전망)
   - 카메라: 사진 / 2초 영상, 필터(빈티지·색감강조·볼록거울)
   - 책 모양 다이어리 + 페이지 넘김 (2D 변환만 — 3D 금지 철칙)
   - 월말 브이로그: 한 달 기록을 Canvas+MediaRecorder로 webm 합성
   - 저장: IndexedDB(moment-diary/entries) — 미디어 Blob 포함
   ============================================================ */

/* ==================== 상수 · 상태 ==================== */
const LS_PREFIX = 'momentDiary:';
const DB_NAME = 'moment-diary';
const DB_STORE = 'entries';
const CLIP_SEC = 2;               // 짧은 영상 길이(초)
const VLOG_PHOTO_MS = 1300;       // 브이로그에서 사진 1장 머무는 시간
const VLOG_CLIP_MS = 2400;        // 브이로그에서 영상 최대 재생 시간
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

let db = null;
let entries = [];                 // 날짜순 정렬 유지
let pageIndex = 0;                // 스프레드 왼쪽(모바일은 현재) 페이지 인덱스
let flipping = false;

// 촬영 상태
let camStream = null;
let camLoopId = 0;
let camFilter = 'vintage';
let camMode = 'photo';            // photo | video
let captured = null;              // { kind, blob, thumb, filter }
let recording = false;

// 음성 상태
let speech = null;
let speechOn = false;

const mediaURLCache = new Map();  // entry.id -> objectURL (세션 캐시)

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ==================== 유틸 ==================== */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtDateKo(s) { const d = parseDate(s); return `${d.getMonth() + 1}월 ${d.getDate()}일`; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isMobile() { return window.matchMedia('(max-width: 720px)').matches; }

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/* 확인 모달 (window.confirm 금지 철칙 대응) */
function confirmModal(text) {
  return new Promise((resolve) => {
    $('#modal-text').textContent = text;
    $('#modal-back').classList.add('on');
    const done = (ok) => {
      $('#modal-back').classList.remove('on');
      $('#modal-ok').onclick = $('#modal-cancel').onclick = null;
      resolve(ok);
    };
    $('#modal-ok').onclick = () => done(true);
    $('#modal-cancel').onclick = () => done(false);
  });
}

/* ==================== IndexedDB ==================== */
function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(DB_STORE)) {
        d.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}
function dbAll() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function dbPut(entry) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(entry);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function dbWipe() {
  return new Promise((resolve) => {
    if (db) { db.close(); db = null; }
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

function sortEntries() {
  entries.sort((a, b) => (a.date === b.date ? a.ts - b.ts : (a.date < b.date ? -1 : 1)));
}

/* ==================== 화면 전환 ==================== */
function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== id));
  if (id !== 'scr-capture') stopCamera();
  if (id === 'scr-capture') openCapture();
  if (id === 'scr-book') renderSpread();
  if (id === 'scr-vlog') fillVlogMonths();
  if (id === 'scr-settings') renderStats();
  if (id === 'scr-cover') renderCoverCount();
}

function renderCoverCount() {
  $('#cover-count').textContent = entries.length
    ? `지금까지 ${entries.length}개의 순간이 담겨 있어요`
    : '첫 순간을 기다리고 있어요';
}

/* ==================== 책 렌더링 · 페이지 넘김 ==================== */
function mediaURL(e) {
  if (!e.blob) return null;
  if (!mediaURLCache.has(e.id)) mediaURLCache.set(e.id, URL.createObjectURL(e.blob));
  return mediaURLCache.get(e.id);
}

function pageHTML(e, num) {
  if (!e) {
    return `<div class="pg-empty"><div class="big">🌿</div>
      <p>아직 이 페이지는 비어 있어요.<br>오른쪽 아래 ✍️ 버튼으로<br>오늘의 순간을 담아보세요.</p></div>`;
  }
  const d = parseDate(e.date);
  let media = '';
  if (e.kind === 'photo' && e.blob) {
    media = `<div class="pg-media"><img src="${mediaURL(e)}" alt="일기 사진"><span class="media-tag">${filterLabel(e.filter)}</span></div>`;
  } else if (e.kind === 'video' && e.blob) {
    media = `<div class="pg-media"><video src="${mediaURL(e)}" muted loop autoplay playsinline></video><span class="media-tag">🎥 ${CLIP_SEC}초 · ${filterLabel(e.filter)}</span></div>`;
  }
  return `
    <div class="pg-date"><span class="pg-weather">${e.weather || '📝'}</span>
      ${fmtDateKo(e.date)} <span class="pg-dow">${DOW[d.getDay()]}요일</span></div>
    ${media}
    <div class="pg-text">${escapeHTML(e.text || '')}</div>
    <button class="pg-del" data-id="${e.id}" title="이 기록 지우기" aria-label="이 기록 지우기">🗑️</button>
    <span class="pg-num">${num}</span>`;
}
function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function filterLabel(f) {
  return { none: '무보정', vintage: '🎞️ 빈티지', colorpop: '🌈 색감', fisheye: '🔮 볼록' }[f] || '';
}

function step() { return isMobile() ? 1 : 2; }
function maxIndex() {
  if (!entries.length) return 0;
  const st = step();
  return Math.max(0, Math.floor((entries.length - 1) / st) * st);
}
function clampIndex() {
  pageIndex = Math.min(Math.max(0, pageIndex), maxIndex());
  if (!isMobile()) pageIndex -= pageIndex % 2;
}

function renderSpread() {
  clampIndex();
  const L = $('#page-left'), R = $('#page-right');
  if (isMobile()) {
    R.innerHTML = pageHTML(entries[pageIndex], pageIndex + 1);
  } else {
    L.innerHTML = pageHTML(entries[pageIndex], pageIndex + 1);
    R.innerHTML = pageHTML(entries[pageIndex + 1], pageIndex + 2);
  }
  const total = Math.max(entries.length, 1);
  $('#pg-indicator').textContent = isMobile()
    ? `${Math.min(pageIndex + 1, total)} / ${total}쪽`
    : `${pageIndex + 1}–${Math.min(pageIndex + 2, total)} / ${total}쪽`;
  $('#btn-prev').disabled = pageIndex <= 0;
  $('#btn-next').disabled = pageIndex >= maxIndex();
}

function flip(dir) {
  if (flipping) return Promise.resolve(false);
  const st = step();
  const target = pageIndex + dir * st;
  if (target < 0 || target > maxIndex()) return Promise.resolve(false);
  flipping = true;
  // 책등에 가까운 페이지가 넘어가는 연출 (scaleX 2D 변환)
  const movingEl = (dir > 0 || isMobile()) ? $('#page-right') : $('#page-left');
  movingEl.classList.add('flip-out');
  return sleep(230).then(() => {
    movingEl.classList.remove('flip-out');
    pageIndex = target;
    renderSpread();
    movingEl.classList.add('flip-in');
    return sleep(230);
  }).then(() => {
    movingEl.classList.remove('flip-in');
    flipping = false;
    return true;
  });
}

/* ==================== 카메라 · 필터 ==================== */
const CTX_FILTER_OK = (() => {
  try { return typeof document.createElement('canvas').getContext('2d').filter === 'string'; }
  catch (e) { return false; }
})();

// 필름 그레인(노이즈) 텍스처 — 한 번만 생성
const grainCanvas = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 80 + Math.random() * 120;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
})();

// 볼록거울(어안) 좌표 매핑 — 크기별로 캐시
let fisheyeMap = null, fisheyeKey = '';
function buildFisheyeMap(w, h) {
  const key = w + 'x' + h;
  if (fisheyeKey === key) return fisheyeMap;
  const map = new Int32Array(w * h);
  const cx = w / 2, cy = h / 2;
  const rad = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / rad, ny = (y - cy) / rad;
      const rd = Math.sqrt(nx * nx + ny * ny);
      const rs = rd === 0 ? 0 : Math.pow(rd, 1.6); // 가운데가 볼록하게 확대
      const k = rd === 0 ? 0 : rs / rd;
      let sx = Math.round(cx + (x - cx) * k);
      let sy = Math.round(cy + (y - cy) * k);
      if (sx < 0) sx = 0; if (sx >= w) sx = w - 1;
      if (sy < 0) sy = 0; if (sy >= h) sy = h - 1;
      map[y * w + x] = (sy * w + sx) * 4;
    }
  }
  fisheyeMap = map; fisheyeKey = key;
  return map;
}
function applyFisheye(ctx, w, h) {
  const map = buildFisheyeMap(w, h);
  const src = ctx.getImageData(0, 0, w, h);
  const dst = ctx.createImageData(w, h);
  const s = src.data, d = dst.data;
  for (let i = 0, p = 0; i < map.length; i++, p += 4) {
    const q = map[i];
    d[p] = s[q]; d[p + 1] = s[q + 1]; d[p + 2] = s[q + 2]; d[p + 3] = 255;
  }
  ctx.putImageData(dst, 0, 0);
}

// ctx.filter 미지원 브라우저용 픽셀 필터 (안전망)
function applyPixelFilter(ctx, w, h, name) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (name === 'vintage') {
      const nr = r * 0.44 + g * 0.55 + b * 0.14;
      const ng = r * 0.35 + g * 0.55 + b * 0.13;
      const nb = r * 0.27 + g * 0.43 + b * 0.20;
      r = r * 0.55 + nr * 0.45; g = g * 0.55 + ng * 0.45; b = b * 0.55 + nb * 0.45;
    } else if (name === 'colorpop') {
      const l = r * 0.3 + g * 0.59 + b * 0.11;
      r = l + (r - l) * 1.8; g = l + (g - l) * 1.8; b = l + (b - l) * 1.8;
      r = (r - 128) * 1.12 + 128; g = (g - 128) * 1.12 + 128; b = (b - 128) * 1.12 + 128;
    }
    d[i] = Math.max(0, Math.min(255, r));
    d[i + 1] = Math.max(0, Math.min(255, g));
    d[i + 2] = Math.max(0, Math.min(255, b));
  }
  ctx.putImageData(img, 0, 0);
}

function drawVignette(ctx, w, h, strength) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.38, w / 2, h / 2, Math.max(w, h) * 0.72);
  g.addColorStop(0, 'rgba(30,20,8,0)');
  g.addColorStop(1, `rgba(30,20,8,${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** 소스(비디오/캔버스/이미지)를 필터 적용해 ctx에 그린다 */
function drawFiltered(ctx, source, w, h, filter) {
  ctx.save();
  if (filter === 'vintage' && CTX_FILTER_OK) {
    ctx.filter = 'sepia(0.42) saturate(0.9) contrast(1.06) brightness(1.03)';
  } else if (filter === 'colorpop' && CTX_FILTER_OK) {
    ctx.filter = 'saturate(1.8) contrast(1.12)';
  }
  ctx.drawImage(source, 0, 0, w, h);
  ctx.restore();
  if (!CTX_FILTER_OK && (filter === 'vintage' || filter === 'colorpop')) {
    applyPixelFilter(ctx, w, h, filter);
  }
  if (filter === 'fisheye') {
    applyFisheye(ctx, w, h);
    drawVignette(ctx, w, h, 0.30);
  }
  if (filter === 'vintage') {
    drawVignette(ctx, w, h, 0.38);
    ctx.save();
    ctx.globalAlpha = 0.06;
    for (let x = 0; x < w; x += 128) for (let y = 0; y < h; y += 128) ctx.drawImage(grainCanvas, x, y);
    ctx.restore();
  }
}

function camMsg(text, show = true) {
  $('#cam-msg').classList.toggle('hidden', !show);
  if (text) $('#cam-msg-text').innerHTML = text;
}

async function openCapture() {
  resetCaptureUI();
  camMsg('카메라를 준비하고 있어요…');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment' },
      audio: false,
    });
  } catch (err) {
    camStream = null;
    camMsg('카메라를 쓸 수 없어요 😢<br>주소창 근처의 <b>카메라 권한</b>을 허용해 주세요.<br>사진 없이 <b>글만으로도</b> 일기를 남길 수 있어요!');
    $('#btn-shutter').disabled = true;
    return;
  }
  $('#btn-shutter').disabled = false;
  const video = document.createElement('video');
  video.srcObject = camStream;
  video.muted = true; video.playsInline = true;
  await video.play();
  const cv = $('#cam-canvas');
  const w = video.videoWidth || 640, h = video.videoHeight || 480;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  camMsg('', false);
  const myLoop = ++camLoopId;
  (function loop() {
    if (myLoop !== camLoopId || !camStream) return;
    if (!captured) drawFiltered(ctx, video, w, h, camFilter);
    requestAnimationFrame(loop);
  })();
}

function stopCamera() {
  camLoopId++;
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  stopSpeech();
}

function resetCaptureUI() {
  captured = null;
  recording = false;
  $('#cap-preview-img').classList.add('hidden');
  $('#cap-preview-video').classList.add('hidden');
  $('#cam-canvas').classList.remove('hidden');
  $('#btn-retake').classList.add('hidden');
  $('#btn-shutter').classList.remove('hidden');
  $('#rec-dot').classList.remove('on');
  $('#diary-text').value = '';
  $('#voice-status').textContent = '';
  $$('.wchip').forEach((b) => b.classList.remove('on'));
}

function thumbFrom(canvas) {
  const t = document.createElement('canvas');
  const tw = 320, th = Math.round(320 * canvas.height / canvas.width);
  t.width = tw; t.height = th;
  t.getContext('2d').drawImage(canvas, 0, 0, tw, th);
  return t.toDataURL('image/jpeg', 0.72);
}

function pickMime() {
  const list = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  for (const m of list) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

async function shutter() {
  if (!camStream || recording || captured) return;
  const cv = $('#cam-canvas');
  if (camMode === 'photo') {
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
    captured = { kind: 'photo', blob, thumb: thumbFrom(cv), filter: camFilter };
    $('#cap-preview-img').src = URL.createObjectURL(blob);
    $('#cap-preview-img').classList.remove('hidden');
    $('#cam-canvas').classList.add('hidden');
    afterCapture();
  } else {
    const mime = pickMime();
    if (!mime) { toast('이 브라우저는 영상 녹화를 지원하지 않아요. 사진으로 찍어보세요!'); return; }
    recording = true;
    $('#rec-dot').classList.add('on');
    $('#btn-shutter').disabled = true;
    const thumb = thumbFrom(cv);
    const stream = cv.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start(200);
    await sleep(CLIP_SEC * 1000);
    rec.stop();
    await done;
    stream.getTracks().forEach((t) => t.stop());
    recording = false;
    $('#rec-dot').classList.remove('on');
    $('#btn-shutter').disabled = false;
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    captured = { kind: 'video', blob, thumb, filter: camFilter };
    const pv = $('#cap-preview-video');
    pv.src = URL.createObjectURL(blob);
    pv.classList.remove('hidden');
    pv.play().catch(() => {});
    $('#cam-canvas').classList.add('hidden');
    afterCapture();
  }
}
function afterCapture() {
  $('#btn-shutter').classList.add('hidden');
  $('#btn-retake').classList.remove('hidden');
  toast(camMode === 'photo' ? '찰칵! 마음에 들면 아래에 느낌을 남겨보세요 🎙️' : `${CLIP_SEC}초 순간을 담았어요 🎥`);
}
function retake() {
  const img = $('#cap-preview-img'), pv = $('#cap-preview-video');
  if (img.src) URL.revokeObjectURL(img.src);
  if (pv.src) URL.revokeObjectURL(pv.src);
  img.classList.add('hidden'); pv.classList.add('hidden'); pv.removeAttribute('src');
  captured = null;
  $('#cam-canvas').classList.remove('hidden');
  $('#btn-shutter').classList.remove('hidden');
  $('#btn-retake').classList.add('hidden');
}

/* ==================== 음성 → 텍스트 ==================== */
function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}
function startSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = $('#voice-status');
  if (!SR) {
    status.textContent = '이 브라우저는 음성 받아쓰기를 지원하지 않아요. 아래 칸에 직접 적어주세요 ✏️';
    status.classList.add('err');
    $('#diary-text').focus();
    return;
  }
  speech = new SR();
  speech.lang = 'ko-KR';
  speech.continuous = true;
  speech.interimResults = true;
  let base = $('#diary-text').value;
  speech.onresult = (ev) => {
    let fin = '', interim = '';
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) fin += r[0].transcript;
      else interim += r[0].transcript;
    }
    $('#diary-text').value = (base ? base + ' ' : '') + fin + interim;
  };
  speech.onerror = (ev) => {
    stopSpeech();
    status.classList.add('err');
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      status.textContent = '마이크 권한이 필요해요. 주소창 근처에서 마이크를 허용해 주세요.';
    } else {
      status.textContent = '받아쓰기가 잠시 끊겼어요. 직접 입력하거나 🎙️를 다시 눌러주세요.';
    }
  };
  speech.onend = () => { if (speechOn) stopSpeech(); };
  try { speech.start(); } catch (e) { /* 이미 시작됨 */ }
  speechOn = true;
  $('#btn-mic').classList.add('on');
  status.classList.remove('err');
  status.textContent = '듣고 있어요… 지금의 느낌을 편하게 말해보세요. (다시 누르면 멈춤)';
}
function stopSpeech() {
  if (speech) { try { speech.stop(); } catch (e) {} speech = null; }
  speechOn = false;
  const mic = $('#btn-mic');
  if (mic) mic.classList.remove('on');
  const status = $('#voice-status');
  if (status && !status.classList.contains('err') && status.textContent.startsWith('듣고')) {
    status.textContent = '받아쓰기를 멈췄어요.';
  }
}
function toggleSpeech() { speechOn ? stopSpeech() : startSpeech(); }

/* ==================== 저장 ==================== */
async function saveEntry() {
  const text = $('#diary-text').value.trim();
  if (!captured && !text) {
    toast('사진을 찍거나, 한 줄이라도 느낌을 남겨보세요 🙂');
    return null;
  }
  const weatherBtn = $('.wchip.on');
  const entry = {
    id: uid(),
    date: todayStr(),
    ts: Date.now(),
    kind: captured ? captured.kind : 'none',
    blob: captured ? captured.blob : null,
    thumb: captured ? captured.thumb : null,
    filter: captured ? captured.filter : 'none',
    weather: weatherBtn ? weatherBtn.dataset.weather : '',
    text,
  };
  await dbPut(entry);
  entries.push(entry);
  sortEntries();
  pageIndex = maxIndex();
  toast('일기장에 붙였어요! 📖');
  show('scr-book');
  return entry;
}

/* ==================== 개별 삭제 ==================== */
async function removeEntry(id) {
  await dbDelete(id);
  const url = mediaURLCache.get(id);
  if (url) { URL.revokeObjectURL(url); mediaURLCache.delete(id); }
  entries = entries.filter((e) => e.id !== id);
  clampIndex();
  renderSpread();
  renderCoverCount();
}
async function deleteEntryUI(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const ok = await confirmModal(`${fmtDateKo(e.date)}의 기록을 지울까요? 되돌릴 수 없어요.`);
  if (!ok) return;
  await removeEntry(id);
  toast('기록 하나를 지웠어요.');
}

/* ==================== 월말 브이로그 ==================== */
function monthsWithEntries() {
  const map = new Map();
  entries.forEach((e) => {
    const ym = e.date.slice(0, 7);
    map.set(ym, (map.get(ym) || 0) + 1);
  });
  return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
}
function fillVlogMonths() {
  const sel = $('#vlog-month');
  const months = monthsWithEntries();
  sel.innerHTML = months.length
    ? months.map(([ym, n]) => {
        const [y, m] = ym.split('-');
        return `<option value="${ym}">${y}년 ${Number(m)}월 (${n}개의 순간)</option>`;
      }).join('')
    : '<option value="">아직 기록이 없어요</option>';
  $('#btn-make-vlog').disabled = !months.length;
}

function drawCover(ctx, src, sw, sh, W, H) {
  const scale = Math.max(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}
function vlogCaption(ctx, W, H, e) {
  const g = ctx.createLinearGradient(0, H - 110, 0, H);
  g.addColorStop(0, 'rgba(20,14,8,0)');
  g.addColorStop(1, 'rgba(20,14,8,.75)');
  ctx.fillStyle = g;
  ctx.fillRect(0, H - 110, W, 110);
  ctx.fillStyle = '#f6f1e7';
  ctx.font = '600 26px "Noto Serif KR", serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${fmtDateKo(e.date)} ${e.weather || ''}`, 26, H - 58);
  if (e.text) {
    ctx.font = '18px "Noto Serif KR", serif';
    ctx.fillStyle = 'rgba(246,241,231,.85)';
    let line = e.text.replace(/\s+/g, ' ').trim();
    if (line.length > 26) line = line.slice(0, 26) + '…';
    ctx.fillText(line, 26, H - 26);
  }
}
function vlogTitleSlide(ctx, W, H, title, sub) {
  ctx.fillStyle = '#2b241c';
  ctx.fillRect(0, 0, W, H);
  drawVignette(ctx, W, H, 0.5);
  ctx.fillStyle = '#f6f1e7';
  ctx.textAlign = 'center';
  ctx.font = '600 44px "Noto Serif KR", serif';
  ctx.fillText(title, W / 2, H / 2 - 12);
  ctx.font = '20px "Noto Serif KR", serif';
  ctx.fillStyle = 'rgba(246,241,231,.75)';
  ctx.fillText(sub, W / 2, H / 2 + 34);
}
function loadVideoBlob(blob) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true;
    v.src = URL.createObjectURL(blob);
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error('video load fail'));
  });
}
function blobToImage(blobOrDataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('img load fail'));
    img.src = typeof blobOrDataURL === 'string' ? blobOrDataURL : URL.createObjectURL(blobOrDataURL);
  });
}

async function buildVlog(ym, onProg = () => {}) {
  const list = entries.filter((e) => e.date.startsWith(ym));
  if (!list.length) throw new Error('empty-month');
  const mime = pickMime();
  if (!mime) throw new Error('no-recorder');
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const W = 720, H = 540;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  const stream = cv.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });

  let drawFn = () => {};
  let running = true;
  (function loop() {
    if (!running) return;
    drawFn();
    requestAnimationFrame(loop);
  })();

  rec.start(200);
  // 인트로
  onProg(0, list.length + 2, '표지를 그리는 중…');
  drawFn = () => vlogTitleSlide(ctx, W, H, `${y}년 ${m}월의 여정`, `1일 — ${lastDay}일 · ${list.length}개의 순간`);
  await sleep(1700);

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    onProg(i + 1, list.length + 2, `${fmtDateKo(e.date)}의 순간을 이어 붙이는 중…`);
    try {
      if (e.kind === 'video' && e.blob) {
        const v = await loadVideoBlob(e.blob);
        await v.play().catch(() => {});
        drawFn = () => { drawCover(ctx, v, v.videoWidth || W, v.videoHeight || H, W, H); vlogCaption(ctx, W, H, e); };
        await Promise.race([
          new Promise((r) => { v.onended = r; }),
          sleep(VLOG_CLIP_MS),
        ]);
        v.pause();
        URL.revokeObjectURL(v.src);
      } else if (e.kind === 'photo' && e.blob) {
        const img = await blobToImage(e.blob);
        drawFn = () => { drawCover(ctx, img, img.naturalWidth, img.naturalHeight, W, H); vlogCaption(ctx, W, H, e); };
        await sleep(VLOG_PHOTO_MS);
        URL.revokeObjectURL(img.src);
      } else {
        // 글만 있는 날 — 텍스트 슬라이드
        drawFn = () => {
          ctx.fillStyle = '#efe8d9'; ctx.fillRect(0, 0, W, H);
          ctx.fillStyle = '#4a4238'; ctx.textAlign = 'center';
          ctx.font = '600 30px "Noto Serif KR", serif';
          ctx.fillText(`${fmtDateKo(e.date)} ${e.weather || ''}`, W / 2, H / 2 - 40);
          ctx.font = '22px "Noto Serif KR", serif';
          let line = (e.text || '').replace(/\s+/g, ' ').trim();
          if (line.length > 24) line = line.slice(0, 24) + '…';
          ctx.fillText(line, W / 2, H / 2 + 10);
        };
        await sleep(VLOG_PHOTO_MS);
      }
    } catch (err) {
      // 손상된 미디어는 건너뛰고 계속 (한 장 때문에 전체가 죽으면 안 됨)
      console.warn('vlog: 미디어 하나를 건너뜀', err);
    }
  }

  // 아웃트로
  onProg(list.length + 2, list.length + 2, '마무리하는 중…');
  drawFn = () => vlogTitleSlide(ctx, W, H, '수고했어요, 이번 달도 🌿', '순간일기');
  await sleep(1500);

  running = false;
  rec.stop();
  await stopped;
  return new Blob(chunks, { type: mime.split(';')[0] });
}

let vlogBlob = null;
async function makeVlogUI() {
  const ym = $('#vlog-month').value;
  if (!ym) { toast('아직 기록이 없어요. 먼저 순간을 담아보세요!'); return; }
  const prog = $('#vlog-progress'), bar = $('#vlog-bar'), stepEl = $('#vlog-step');
  $('#vlog-result').classList.remove('on');
  prog.classList.add('on');
  $('#btn-make-vlog').disabled = true;
  try {
    vlogBlob = await buildVlog(ym, (done, total, msg) => {
      bar.style.width = Math.round((done / total) * 100) + '%';
      stepEl.textContent = msg;
    });
    bar.style.width = '100%';
    stepEl.textContent = '완성! 🎉';
    const v = $('#vlog-video');
    if (v.src) URL.revokeObjectURL(v.src);
    v.src = URL.createObjectURL(vlogBlob);
    $('#vlog-result').classList.add('on');
  } catch (err) {
    stepEl.textContent = '';
    prog.classList.remove('on');
    toast(err.message === 'no-recorder'
      ? '이 브라우저는 영상 만들기를 지원하지 않아요. 크롬/엣지에서 열어보세요.'
      : '영상을 만들다 문제가 생겼어요. 다시 한 번 눌러보세요.');
  }
  $('#btn-make-vlog').disabled = false;
}
function downloadVlog() {
  if (!vlogBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(vlogBlob);
  const ym = $('#vlog-month').value.replace('-', '년') + '월';
  a.download = `순간일기_${ym}_브이로그.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ==================== 설정 ==================== */
function renderStats() {
  const photos = entries.filter((e) => e.kind === 'photo').length;
  const clips = entries.filter((e) => e.kind === 'video').length;
  $('#set-stats').textContent =
    `지금까지 순간 ${entries.length}개 (사진 ${photos} · 짧은 영상 ${clips} · 글 ${entries.length - photos - clips})`;
}
async function wipeAll() {
  const ok = await confirmModal('정말 모든 기록을 지울까요? 사진·영상·글이 전부 사라지고 되돌릴 수 없어요.');
  if (!ok) return;
  await dbWipe();
  Object.keys(localStorage)
    .filter((k) => k.startsWith(LS_PREFIX))
    .forEach((k) => localStorage.removeItem(k));
  mediaURLCache.forEach((u) => URL.revokeObjectURL(u));
  mediaURLCache.clear();
  entries = [];
  pageIndex = 0;
  await initDB();
  toast('모든 기록을 지웠어요. 새 마음으로 시작해요 🌱');
  show('scr-cover');
}

/* ==================== 이벤트 바인딩 ==================== */
function bind() {
  $('#btn-open-book').onclick = () => show('scr-book');
  $('#btn-close-book').onclick = () => show('scr-cover');
  $('#btn-new').onclick = () => show('scr-capture');
  $('#btn-cap-back').onclick = () => show('scr-book');
  $('#btn-go-vlog').onclick = () => show('scr-vlog');
  $('#btn-vlog-back').onclick = () => show('scr-book');
  $('#btn-go-settings').onclick = () => show('scr-settings');
  $('#btn-set-back').onclick = () => show('scr-book');

  $('#book').addEventListener('click', (e) => {
    const b = e.target.closest('.pg-del');
    if (b) deleteEntryUI(b.dataset.id);
  });

  $('#btn-prev').onclick = () => flip(-1);
  $('#btn-next').onclick = () => flip(1);
  document.addEventListener('keydown', (e) => {
    if ($('#scr-book').classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') flip(-1);
    if (e.key === 'ArrowRight') flip(1);
  });

  $$('#filter-row .chip').forEach((b) => {
    b.onclick = () => {
      $$('#filter-row .chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      camFilter = b.dataset.filter;
    };
  });
  $$('#mode-toggle button').forEach((b) => {
    b.onclick = () => {
      $$('#mode-toggle button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      camMode = b.dataset.mode;
    };
  });
  $$('.wchip').forEach((b) => {
    b.onclick = () => {
      const was = b.classList.contains('on');
      $$('.wchip').forEach((x) => x.classList.remove('on'));
      if (!was) b.classList.add('on');
    };
  });

  $('#btn-shutter').onclick = shutter;
  $('#btn-retake').onclick = retake;
  $('#btn-mic').onclick = toggleSpeech;
  $('#btn-save-entry').onclick = saveEntry;
  $('#btn-make-vlog').onclick = makeVlogUI;
  $('#btn-vlog-save').onclick = downloadVlog;
  $('#btn-wipe').onclick = wipeAll;

  window.addEventListener('resize', () => {
    if (!$('#scr-book').classList.contains('hidden')) renderSpread();
  });
}

/* ==================== 초기화 ==================== */
async function init() {
  bind();
  await initDB();
  entries = await dbAll();
  sortEntries();
  pageIndex = maxIndex();
  renderCoverCount();
}
const readyPromise = init();

/* ==================== 테스트 훅 (Playwright 스모크용) ==================== */
window.__diary = {
  ready: () => readyPromise,
  getEntries: () => entries.map((e) => ({ ...e, blobSize: e.blob ? e.blob.size : 0 })),
  getPageIndex: () => pageIndex,
  show,
  flip,
  saveEntry,
  deleteEntry: removeEntry, // 테스트용 — UI 확인 모달 없이 즉시 삭제

  buildVlog,
  speechSupported,
  camState: () => ({ hasStream: !!camStream, filter: camFilter, mode: camMode, captured: captured ? captured.kind : null }),
  // 시드용: dataURL을 blob으로 바꿔 엔트리 저장
  async addEntry({ date, text = '', weather = '', filter = 'none', kind = 'none', dataURL = null }) {
    let blob = null, thumb = null;
    if (dataURL) {
      blob = await (await fetch(dataURL)).blob();
      thumb = dataURL;
      if (kind === 'none') kind = 'photo';
    }
    const entry = { id: uid(), date: date || todayStr(), ts: Date.now(), kind, blob, thumb, filter, weather, text };
    await dbPut(entry);
    entries.push(entry);
    sortEntries();
    return entry.id;
  },
  // 필터 단위 검증: 테스트 패턴에 필터를 적용해 중앙/모서리 픽셀 반환
  testFilter(name) {
    const w = 160, h = 120;
    const src = document.createElement('canvas');
    src.width = w; src.height = h;
    const sctx = src.getContext('2d');
    sctx.fillStyle = '#3366cc'; sctx.fillRect(0, 0, w, h);
    sctx.fillStyle = '#cc3333'; sctx.fillRect(0, 0, w / 2, h / 2);
    sctx.fillStyle = '#33aa55'; sctx.fillRect(w / 2, h / 2, w / 2, h / 2);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d', { willReadFrequently: true });
    drawFiltered(octx, src, w, h, name);
    const px = (x, y) => Array.from(octx.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { center: px(w / 2, h / 2), corner: px(2, 2), q1: px(Math.floor(w * 0.25), Math.floor(h * 0.25)) };
  },
};
