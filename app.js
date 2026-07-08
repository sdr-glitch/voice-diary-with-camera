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
const VLOG_INTRO_MS = 1900;       // 브이로그 표지
const VLOG_OUTRO_MS = 1600;       // 브이로그 마무리
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

let db = null;
let entries = [];                 // 날짜순 정렬 유지
let pageIndex = 0;                // 스프레드 왼쪽(모바일은 현재) 페이지 인덱스
let flipping = false;
let curScreen = 'scr-cover';      // 현재 화면 id
let backTo = 'scr-cal';           // 하위 화면(기록·브이로그·설정)에서 돌아갈 곳

// 촬영 상태
let camStream = null;
let camLoopId = 0;
let camFilter = 'vintage';
let camMode = 'photo';            // photo | video
let captured = null;              // { kind, blob, thumb, filter, durMs }
let recording = false;
let vidRec = null;                // 진행 중인 MediaRecorder (영상 토글 녹화)
let vidChunks = [];
let vidStream = null;
let recStartTs = 0;
let recTimer = 0;

// 음성 상태
let speech = null;
let speechOn = false;

// 꾸미기(스티커) 상태 — {e:이모지, x/y:0~1 상대좌표, s:가로폭 대비 크기}
let capStickers = [];
let selSticker = -1;

// 사용자 배경음악 파일 (브이로그용)
let userAudioData = null; // ArrayBuffer
let userAudioName = '';

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

/* ==================== 소리 (전부 자체 합성 — 외부 음원 없음 = 저작권 안전) ==================== */
let AC = null;
function audioCtx() {
  if (!AC) {
    try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  }
  if (AC.state === 'suspended') AC.resume().catch(() => {});
  return AC;
}
function soundOn() { return localStorage.getItem(LS_PREFIX + 'sound') !== 'off'; }

/** 감쇠하는 단음 하나 */
function tone(ctx, dest, t, freq, dur, opt = {}) {
  const { type = 'sine', gain = 0.12 } = opt;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.05);
}
/** 짧은 노이즈 (셔터·책장 소리용) */
function noiseBurst(ctx, dest, t, dur, gain, freq) {
  const len = Math.max(1, Math.ceil(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
  const g = ctx.createGain(); g.gain.value = gain;
  src.connect(f); f.connect(g); g.connect(dest);
  src.start(t);
}
/** UI 효과음 (설정에서 켜고 끔) */
function playFx(name, ctx = null, dest = null) {
  const ui = !ctx;
  if (ui && !soundOn()) return;
  if (ui) { ctx = audioCtx(); if (!ctx) return; dest = ctx.destination; }
  try {
    const t = ctx.currentTime + 0.02;
    if (name === 'shutter') {
      noiseBurst(ctx, dest, t, 0.05, 0.25, 2400);
      noiseBurst(ctx, dest, t + 0.07, 0.05, 0.18, 1200);
    } else if (name === 'flip') {
      noiseBurst(ctx, dest, t, 0.16, 0.14, 900);
    } else if (name === 'chime') {
      tone(ctx, dest, t, 880, 0.35, { gain: 0.07 });
      tone(ctx, dest, t + 0.09, 1318.5, 0.4, { gain: 0.05 });
    }
  } catch (e) { /* 소리는 실패해도 앱 동작에 영향 없음 */ }
}
/** 배경음악 한 소절을 t0부터 예약하고 소절 길이(초)를 반환 */
function scheduleBgmBar(ctx, dest, name, t0) {
  if (name === 'piano') {
    // C — G — Am — F, 72bpm 아르페지오 + 낮은 패드
    const chords = [
      [261.6, 329.6, 392.0], [196.0, 246.9, 392.0],
      [220.0, 261.6, 329.6], [174.6, 220.0, 261.6],
    ];
    const beat = 60 / 72;
    chords.forEach((ch, ci) => {
      const base = t0 + ci * beat * 2;
      ch.forEach((f) => tone(ctx, dest, base, f / 2, beat * 2.1, { type: 'triangle', gain: 0.028 }));
      for (let i = 0; i < 4; i++) {
        tone(ctx, dest, base + (i * beat) / 2, ch[i % 3] * (i === 3 ? 2 : 1), 0.55, { gain: 0.055 });
      }
    });
    return beat * 8;
  }
  if (name === 'musicbox') {
    // 오르골풍 펜타토닉 멜로디 + 한 옥타브 위 반짝임
    const notes = [523.3, 659.3, 784.0, 880.0, 784.0, 659.3, 587.3, 523.3];
    const step = 0.44;
    notes.forEach((f, i) => {
      tone(ctx, dest, t0 + i * step, f, 1.1, { gain: 0.05 });
      tone(ctx, dest, t0 + i * step, f * 2, 0.7, { gain: 0.018 });
    });
    return notes.length * step;
  }
  return 1;
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
  curScreen = id;
  $$('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== id));
  if (id !== 'scr-capture') stopCamera();
  if (id === 'scr-capture') openCapture();
  if (id === 'scr-cal') renderCal();
  if (id === 'scr-book') renderSpread();
  if (id === 'scr-vlog') fillVlogMonths();
  if (id === 'scr-settings') renderStats();
  if (id === 'scr-cover') renderCoverCount();
}
/** 하위 화면 열기 — 돌아갈 화면(backTo)을 현재 화면으로 기억 */
function openSub(id) { backTo = curScreen; show(id); }

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
    return `<button class="pg-empty" id="pg-empty-btn">
      <span class="pg-empty-plus">＋</span>
      <p>아직 이 페이지는 비어 있어요.<br>여기를 눌러<br>오늘의 순간을 담아보세요.</p></button>`;
  }
  const d = parseDate(e.date);
  const stk = (e.stickers || []).map((s) =>
    `<span class="stk" data-s="${s.s}" style="left:${s.x * 100}%;top:${s.y * 100}%">${s.e}</span>`).join('');
  let media = '';
  if (e.kind === 'photo' && e.blob) {
    media = `<div class="pg-media"><img src="${mediaURL(e)}" alt="일기 사진">${stk}<span class="media-tag">${filterLabel(e.filter)}</span></div>`;
  } else if (e.kind === 'video' && e.blob) {
    const secs = e.durMs ? Math.max(1, Math.round(e.durMs / 1000)) + '초 ' : '';
    media = `<div class="pg-media"><video src="${mediaURL(e)}" muted loop autoplay playsinline></video>${stk}<span class="media-tag">영상 ${secs}· ${filterLabel(e.filter)}</span></div>`;
  }
  const meta = [e.mood ? `기분 ${moodLabel(e.mood)}` : '', e.weather ? `날씨 ${e.weather}` : '']
    .filter(Boolean).join('　');
  return `
    <div class="pg-date">${fmtDateKo(e.date)} <span class="pg-dow">${DOW[d.getDay()]}요일</span></div>
    ${meta ? `<div class="pg-meta">${meta}</div>` : ''}
    ${media}
    <div class="pg-text">${escapeHTML(e.text || '')}</div>
    <button class="pg-del" data-id="${e.id}" title="이 기록 지우기" aria-label="이 기록 지우기">지우기</button>
    <span class="pg-num">${num}</span>`;
}
function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function filterLabel(f) {
  return { none: '무보정', vintage: '빈티지', colorpop: '색감', fisheye: '볼록거울' }[f] || '';
}
function moodLabel(m) {
  return { 설렘: '설렘', 행복: '행복', 평온: '평온', 그저그럼: '그저 그럼', 지침: '지침', 울적: '울적', 속상: '속상' }[m] || m;
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
  sizePageStickers();
  const total = Math.max(entries.length, 1);
  $('#pg-indicator').textContent = isMobile()
    ? `${Math.min(pageIndex + 1, total)} / ${total}쪽`
    : `${pageIndex + 1}–${Math.min(pageIndex + 2, total)} / ${total}쪽`;
  $('#btn-prev').disabled = pageIndex <= 0;
  $('#btn-next').disabled = pageIndex >= maxIndex();
}

/** 페이지 스티커 크기를 컨테이너 폭 기준으로 계산 (CSS만으론 컨테이너 비례 폰트가 안 됨) */
function sizePageStickers() {
  $$('.pg-media').forEach((box) => {
    const w = box.clientWidth || 300;
    box.querySelectorAll('.stk').forEach((el) => {
      el.style.fontSize = Math.round(parseFloat(el.dataset.s || 0.15) * w) + 'px';
    });
  });
}

function flip(dir) {
  if (flipping) return Promise.resolve(false);
  const st = step();
  const target = pageIndex + dir * st;
  if (target < 0 || target > maxIndex()) return Promise.resolve(false);
  flipping = true;
  playFx('flip');
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
    camMsg('카메라를 쓸 수 없어요.<br>주소창 근처의 <b>카메라 권한</b>을 허용해 주세요.<br>사진 없이 <b>글만으로도</b> 일기를 남길 수 있어요.');
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
    // 촬영 완료(미리보기) 전까지는 계속 그린다 — 영상 녹화 중에도 캔버스가 갱신돼야 녹화가 담김
    if (!(captured && captured.blob)) drawFiltered(ctx, video, w, h, camFilter);
    requestAnimationFrame(loop);
  })();
}

function stopCamera() {
  camLoopId++;
  // 녹화 중 화면을 벗어나면 안전하게 정리
  if (recording && vidRec) {
    clearInterval(recTimer);
    try { vidRec.onstop = null; vidRec.stop(); } catch (e) {}
    if (vidStream) vidStream.getTracks().forEach((t) => t.stop());
    recording = false;
  }
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  stopSpeech();
}

function resetCaptureUI() {
  captured = null;
  recording = false;
  clearStickers();
  $('#cap-preview-img').classList.add('hidden');
  $('#cap-preview-video').classList.add('hidden');
  $('#cam-canvas').classList.remove('hidden');
  $('#btn-retake').classList.add('hidden');
  $('#btn-shutter').classList.remove('hidden');
  $('#btn-shutter').classList.remove('recording');
  $('#rec-dot').classList.remove('on');
  $('#diary-text').value = '';
  $('#voice-status').textContent = '';
  $$('.wchip').forEach((b) => b.classList.remove('on'));
  $$('.mchip').forEach((b) => b.classList.remove('on'));
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

/** 셔터 버튼: 사진이면 즉시 촬영, 영상이면 녹화 시작/정지 토글(길이 제한 없음) */
async function shutter() {
  if (!camStream) return;
  if (captured && captured.blob) return; // 이미 촬영 완료(미리보기 중)
  const cv = $('#cam-canvas');
  if (camMode === 'photo') {
    playFx('shutter');
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
    captured = { kind: 'photo', blob, thumb: thumbFrom(cv), filter: camFilter };
    $('#cap-preview-img').src = URL.createObjectURL(blob);
    $('#cap-preview-img').classList.remove('hidden');
    $('#cam-canvas').classList.add('hidden');
    afterCapture();
    return;
  }
  // 영상 모드
  if (!recording) startVideoRec();
  else stopVideoRec();
}

function startVideoRec() {
  const cv = $('#cam-canvas');
  const mime = pickMime();
  if (!mime) { toast('이 브라우저는 영상 녹화를 지원하지 않아요. 사진으로 찍어보세요.'); return; }
  playFx('shutter');
  recording = true;
  captured = { kind: 'video', thumb: thumbFrom(cv), filter: camFilter, _mime: mime };
  vidChunks = [];
  vidStream = cv.captureStream(30);
  vidRec = new MediaRecorder(vidStream, { mimeType: mime });
  vidRec.ondataavailable = (e) => { if (e.data.size) vidChunks.push(e.data); };
  vidRec.start(200);
  recStartTs = Date.now();
  $('#rec-dot').classList.add('on');
  $('#btn-shutter').classList.add('recording');
  $('#rec-time').textContent = '0초';
  recTimer = setInterval(() => {
    $('#rec-time').textContent = Math.floor((Date.now() - recStartTs) / 1000) + '초';
  }, 250);
  toast('녹화 시작! 다시 누르면 멈춰요. 원하는 만큼 담아보세요.');
}

function stopVideoRec() {
  if (!recording || !vidRec) return;
  clearInterval(recTimer);
  const durMs = Date.now() - recStartTs;
  const mime = captured._mime;
  const done = new Promise((r) => { vidRec.onstop = r; });
  vidRec.stop();
  done.then(() => {
    if (vidStream) vidStream.getTracks().forEach((t) => t.stop());
    recording = false;
    $('#rec-dot').classList.remove('on');
    $('#btn-shutter').classList.remove('recording');
    const blob = new Blob(vidChunks, { type: mime.split(';')[0] });
    captured.blob = blob;
    captured.durMs = durMs;
    const pv = $('#cap-preview-video');
    pv.src = URL.createObjectURL(blob);
    pv.classList.remove('hidden');
    pv.play().catch(() => {});
    $('#cam-canvas').classList.add('hidden');
    afterCapture();
  });
}
function afterCapture() {
  $('#btn-shutter').classList.add('hidden');
  $('#btn-retake').classList.remove('hidden');
  $('#deco-box').classList.remove('hidden');
  document.querySelector('.cam-stage').classList.add('decorating');
  toast(captured && captured.kind === 'photo'
    ? '찰칵! 스티커로 꾸미거나 아래에 느낌을 남겨보세요.'
    : '순간을 담았어요. 스티커로 꾸며보세요.');
}
function retake() {
  const img = $('#cap-preview-img'), pv = $('#cap-preview-video');
  if (img.src) URL.revokeObjectURL(img.src);
  if (pv.src) URL.revokeObjectURL(pv.src);
  img.classList.add('hidden'); pv.classList.add('hidden'); pv.removeAttribute('src');
  captured = null;
  clearStickers();
  $('#cam-canvas').classList.remove('hidden');
  $('#btn-shutter').classList.remove('hidden');
  $('#btn-shutter').classList.remove('recording');
  $('#btn-retake').classList.add('hidden');
}

/* ==================== 꾸미기 (스티커) ==================== */
function clearStickers() {
  capStickers = [];
  selSticker = -1;
  const layer = $('#sticker-layer');
  if (layer) layer.innerHTML = '';
  const box = $('#deco-box');
  if (box) box.classList.add('hidden');
  const stage = document.querySelector('.cam-stage');
  if (stage) stage.classList.remove('decorating');
  const ctrl = $('#deco-controls');
  if (ctrl) ctrl.classList.add('hidden');
}
function renderStickerLayer() {
  const layer = $('#sticker-layer');
  const w = layer.clientWidth || 400;
  layer.innerHTML = capStickers.map((s, i) =>
    `<span class="stk ${i === selSticker ? 'sel' : ''}" data-i="${i}"
       style="left:${s.x * 100}%;top:${s.y * 100}%;font-size:${Math.round(s.s * w)}px">${s.e}</span>`).join('');
  $('#deco-controls').classList.toggle('hidden', selSticker < 0);
}
function addSticker(emoji) {
  if (!captured || !captured.blob) { toast('먼저 사진이나 영상을 찍은 다음 꾸밀 수 있어요.'); return; }
  capStickers.push({ e: emoji, x: 0.5, y: 0.5, s: 0.16 });
  selSticker = capStickers.length - 1;
  renderStickerLayer();
}
function bindStickerDrag() {
  const layer = $('#sticker-layer');
  let dragI = -1, moved = false;
  layer.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest('.stk');
    if (!el) { selSticker = -1; renderStickerLayer(); return; }
    dragI = Number(el.dataset.i);
    selSticker = dragI;
    moved = false;
    renderStickerLayer();
    layer.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  layer.addEventListener('pointermove', (ev) => {
    if (dragI < 0) return;
    const r = layer.getBoundingClientRect();
    const s = capStickers[dragI];
    if (!s) return;
    s.x = Math.min(0.97, Math.max(0.03, (ev.clientX - r.left) / r.width));
    s.y = Math.min(0.97, Math.max(0.03, (ev.clientY - r.top) / r.height));
    moved = true;
    const el = layer.querySelector(`.stk[data-i="${dragI}"]`);
    if (el) { el.style.left = s.x * 100 + '%'; el.style.top = s.y * 100 + '%'; }
  });
  const end = () => { dragI = -1; if (moved) renderStickerLayer(); };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
}
function resizeSticker(f) {
  const s = capStickers[selSticker];
  if (!s) return;
  s.s = Math.min(0.5, Math.max(0.06, s.s * f));
  renderStickerLayer();
}
function deleteSticker() {
  if (selSticker < 0) return;
  capStickers.splice(selSticker, 1);
  selSticker = -1;
  renderStickerLayer();
}

/* ==================== 음성 → 텍스트 ==================== */
function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}
function startSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = $('#voice-status');
  if (!SR) {
    status.textContent = '이 브라우저는 음성 받아쓰기를 지원하지 않아요. 아래 칸에 직접 적어주세요.';
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
      status.textContent = '받아쓰기가 잠시 끊겼어요. 직접 입력하거나 음성 버튼을 다시 눌러주세요.';
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
  const hasMedia = captured && captured.blob;
  if (!hasMedia && !text) {
    toast('사진·영상을 찍거나, 한 줄이라도 느낌을 남겨보세요.');
    return null;
  }
  if (recording) { toast('녹화를 먼저 멈춰주세요. 셔터 버튼을 한 번 더 누르면 멈춰요.'); return null; }
  const weatherBtn = $('.wchip.on');
  const moodBtn = $('.mchip.on');
  const entry = {
    id: uid(),
    date: todayStr(),
    ts: Date.now(),
    kind: hasMedia ? captured.kind : 'none',
    blob: hasMedia ? captured.blob : null,
    thumb: hasMedia ? captured.thumb : null,
    filter: hasMedia ? captured.filter : 'none',
    durMs: hasMedia && captured.durMs ? captured.durMs : 0,
    weather: weatherBtn ? weatherBtn.dataset.weather : '',
    mood: moodBtn ? moodBtn.dataset.mood : '',
    stickers: hasMedia ? capStickers.slice() : [],
    text,
  };
  await dbPut(entry);
  entries.push(entry);
  sortEntries();
  pageIndex = entries.indexOf(entry);
  if (!isMobile()) pageIndex -= pageIndex % 2;
  toast('일기장에 붙였어요.');
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
let vlogClips = [];   // [{id, on}] — 현재 선택 달의 장면 순서/포함 여부
let vlogTargetSec = 60;

function fillVlogMonths() {
  const sel = $('#vlog-month');
  const months = monthsWithEntries();
  const prev = sel.value;
  sel.innerHTML = months.length
    ? months.map(([ym, n]) => {
        const [y, m] = ym.split('-');
        return `<option value="${ym}">${y}년 ${Number(m)}월 (${n}개의 순간)</option>`;
      }).join('')
    : '<option value="">아직 기록이 없어요</option>';
  if (prev && months.some(([ym]) => ym === prev)) sel.value = prev;
  $('#btn-make-vlog').disabled = !months.length;
  buildClipList();
}

/** 선택한 달의 장면 목록(포함/순서 편집용)을 만든다 */
function buildClipList() {
  const ym = $('#vlog-month').value;
  vlogClips = entries.filter((e) => e.date.startsWith(ym)).map((e) => ({ id: e.id, on: true }));
  renderClipList();
}
function kindLabel(e) {
  return e.kind === 'video' ? '영상' : e.kind === 'photo' ? '사진' : '글';
}
function renderClipList() {
  const ul = $('#clip-list');
  if (!vlogClips.length) { ul.innerHTML = '<li class="clip-empty">이 달에는 아직 기록이 없어요.</li>'; return; }
  ul.innerHTML = vlogClips.map((c, i) => {
    const e = entries.find((x) => x.id === c.id);
    if (!e) return '';
    const thumb = e.thumb ? `<img src="${e.thumb}" alt="">` : '<span class="clip-noimg">글</span>';
    const preview = (e.text || '').replace(/\s+/g, ' ').trim().slice(0, 18) || moodLabel(e.mood) || '기록';
    return `<li class="clip-item ${c.on ? '' : 'off'}" data-i="${i}">
      <input type="checkbox" class="clip-chk" data-i="${i}" ${c.on ? 'checked' : ''} aria-label="넣기">
      <span class="clip-thumb">${thumb}</span>
      <span class="clip-info"><b>${fmtDateKo(e.date)}</b> <em>${kindLabel(e)}</em><br>${escapeHTML(preview)}</span>
      <span class="clip-move">
        <button class="clip-up" data-i="${i}" aria-label="위로" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="clip-down" data-i="${i}" aria-label="아래로" ${i === vlogClips.length - 1 ? 'disabled' : ''}>▼</button>
      </span>
    </li>`;
  }).join('');
  const on = vlogClips.filter((c) => c.on).length;
  $('#btn-make-vlog').disabled = !on;
}
function moveClip(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= vlogClips.length) return;
  const t = vlogClips[i]; vlogClips[i] = vlogClips[j]; vlogClips[j] = t;
  renderClipList();
}
function toggleClip(i, on) { if (vlogClips[i]) vlogClips[i].on = on; renderClipList(); }

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
function vlogStickers(ctx, W, H, e) {
  (e.stickers || []).forEach((s) => {
    ctx.save();
    ctx.font = `${Math.max(10, Math.round(s.s * W))}px "Apple SD Gothic Neo", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.e, s.x * W, s.y * H);
    ctx.restore();
  });
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

async function buildVlog(ym, onProg = () => {}, opts = {}) {
  // 넣을 장면·순서 (편집기에서 고른 ids가 있으면 그대로, 없으면 그달 전부)
  let list;
  if (opts.ids && opts.ids.length) {
    list = opts.ids.map((id) => entries.find((e) => e.id === id)).filter(Boolean);
  } else {
    list = entries.filter((e) => e.date.startsWith(ym));
  }
  if (!list.length) throw new Error('empty-month');
  const mime = pickMime();
  if (!mime) throw new Error('no-recorder');
  const bgm = opts.bgm || 'none';
  const fxOn = !!opts.fx;
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();

  // 전체를 목표 길이(기본 60초)로 압축 — 장면 수에 맞춰 한 장면 시간 자동 계산
  const targetSec = opts.targetSec || 60;
  const bodyMs = Math.max(list.length * 500, targetSec * 1000 - VLOG_INTRO_MS - VLOG_OUTRO_MS);
  const slotMs = Math.min(5000, Math.max(500, Math.round(bodyMs / list.length)));
  const title = (opts.title && opts.title.trim()) ? opts.title.trim() : `${y}년 ${m}월의 여정`;

  const W = 720, H = 540;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  // 소리 트랙 (배경음악·전환 효과음 — 전부 자체 합성, 실패해도 무음으로 계속)
  let acx = null, adest = null, bgmTimer = 0;
  if (bgm !== 'none' || fxOn) {
    try {
      acx = new (window.AudioContext || window.webkitAudioContext)();
      await acx.resume().catch(() => {});
      adest = acx.createMediaStreamDestination();
      if (bgm === 'user') {
        if (!userAudioData) throw new Error('no-user-audio');
        const buf = await acx.decodeAudioData(userAudioData.slice(0));
        const src = acx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const g = acx.createGain(); g.gain.value = 0.55;
        src.connect(g); g.connect(adest);
        src.start();
      } else if (bgm !== 'none') {
        // 소절 단위 예약 스케줄러 — 영상 길이를 몰라도 계속 이어짐
        let nextBar = acx.currentTime + 0.05;
        const pump = () => {
          while (nextBar < acx.currentTime + 3) nextBar += scheduleBgmBar(acx, adest, bgm, nextBar);
        };
        pump();
        bgmTimer = setInterval(pump, 500);
      }
    } catch (err) {
      if (err.message === 'no-user-audio') { if (acx) acx.close().catch(() => {}); throw err; }
      acx = null; adest = null; // 소리 실패 → 무음 브이로그로 진행
    }
  }

  const vstream = cv.captureStream(30);
  const stream = (adest && adest.stream.getAudioTracks().length)
    ? new MediaStream([...vstream.getVideoTracks(), ...adest.stream.getAudioTracks()])
    : vstream;
  window.__diary._lastVlogAudioTracks = stream.getAudioTracks().length;
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
  drawFn = () => vlogTitleSlide(ctx, W, H, title, `1일 — ${lastDay}일 · ${list.length}개의 순간`);
  await sleep(VLOG_INTRO_MS);

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    onProg(i + 1, list.length + 2, `${fmtDateKo(e.date)}의 순간을 이어 붙이는 중…`);
    if (fxOn && acx) playFx('chime', acx, adest); // 장면 전환 효과음
    try {
      if (e.kind === 'video' && e.blob) {
        // 영상은 길이가 제각각 — 배정된 시간(slotMs)만큼만 보여주고 넘어감(압축)
        const v = await loadVideoBlob(e.blob);
        v.loop = true;
        await v.play().catch(() => {});
        drawFn = () => { drawCover(ctx, v, v.videoWidth || W, v.videoHeight || H, W, H); vlogStickers(ctx, W, H, e); vlogCaption(ctx, W, H, e); };
        await sleep(slotMs);
        v.pause();
        URL.revokeObjectURL(v.src);
      } else if (e.kind === 'photo' && e.blob) {
        const img = await blobToImage(e.blob);
        drawFn = () => { drawCover(ctx, img, img.naturalWidth, img.naturalHeight, W, H); vlogStickers(ctx, W, H, e); vlogCaption(ctx, W, H, e); };
        await sleep(slotMs);
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
        await sleep(slotMs);
      }
    } catch (err) {
      // 손상된 미디어는 건너뛰고 계속 (한 장 때문에 전체가 죽으면 안 됨)
      console.warn('vlog: 미디어 하나를 건너뜀', err);
    }
  }

  // 아웃트로
  onProg(list.length + 2, list.length + 2, '마무리하는 중…');
  drawFn = () => vlogTitleSlide(ctx, W, H, '수고했어요, 이번 달도', '순간일기');
  await sleep(VLOG_OUTRO_MS);

  running = false;
  rec.stop();
  await stopped;
  if (bgmTimer) clearInterval(bgmTimer);
  if (acx) acx.close().catch(() => {});
  return new Blob(chunks, { type: mime.split(';')[0] });
}

let vlogBlob = null;
async function makeVlogUI() {
  const ym = $('#vlog-month').value;
  if (!ym) { toast('아직 기록이 없어요. 먼저 순간을 담아보세요!'); return; }
  const prog = $('#vlog-progress'), bar = $('#vlog-bar'), stepEl = $('#vlog-step');
  $('#vlog-result').classList.remove('on');
  prog.classList.add('on');
  const ids = vlogClips.filter((c) => c.on).map((c) => c.id);
  if (!ids.length) { toast('브이로그에 넣을 장면을 하나 이상 골라주세요.'); return; }
  $('#btn-make-vlog').disabled = true;
  try {
    const opts = {
      bgm: $('#vlog-bgm').value,
      fx: $('#vlog-fx').checked,
      title: $('#vlog-title').value,
      targetSec: vlogTargetSec,
      ids,
    };
    vlogBlob = await buildVlog(ym, (done, total, msg) => {
      bar.style.width = Math.round((done / total) * 100) + '%';
      stepEl.textContent = msg;
    }, opts);
    bar.style.width = '100%';
    stepEl.textContent = '완성!';
    const v = $('#vlog-video');
    if (v.src) URL.revokeObjectURL(v.src);
    v.src = URL.createObjectURL(vlogBlob);
    $('#vlog-result').classList.add('on');
  } catch (err) {
    stepEl.textContent = '';
    prog.classList.remove('on');
    toast(err.message === 'no-recorder'
      ? '이 브라우저는 영상 만들기를 지원하지 않아요. 크롬/엣지에서 열어보세요.'
      : err.message === 'no-user-audio'
        ? '먼저 아래에서 내 음원 파일을 골라주세요.'
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

/* ==================== 달력 (홈 화면) ==================== */
let calYM = '';
/** 달력을 특정 달로 세팅하고 홈 화면으로 이동 */
function goCalendar(ym) {
  calYM = ym || todayStr().slice(0, 7);
  show('scr-cal');
}
function shiftCalMonth(d) {
  const [y, m] = calYM.split('-').map(Number);
  const nd = new Date(y, m - 1 + d, 1);
  calYM = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}`;
  renderCal();
}
function renderCal() {
  if (!calYM) calYM = todayStr().slice(0, 7);
  const [y, m] = calYM.split('-').map(Number);
  $('#cal-title').textContent = `${y}년 ${m}월`;
  const startDow = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const today = todayStr();
  const firstIdxByDay = new Map();
  entries.forEach((e, i) => {
    if (e.date.slice(0, 7) === calYM && !firstIdxByDay.has(e.date)) firstIdxByDay.set(e.date, i);
  });
  let html = DOW.map((d) => `<span class="cal-dow">${d}</span>`).join('');
  for (let i = 0; i < startDow; i++) html += '<span></span>';
  for (let d = 1; d <= days; d++) {
    const ds = `${calYM}-${String(d).padStart(2, '0')}`;
    const idx = firstIdxByDay.get(ds);
    const isToday = ds === today;
    if (idx !== undefined) {
      html += `<button class="cal-day has${isToday ? ' today' : ''}" data-idx="${idx}">${d}<i></i></button>`;
    } else if (isToday) {
      // 기록 없는 오늘 → 눌러서 바로 오늘의 순간 담기
      html += `<button class="cal-day today" data-today="1">${d}</button>`;
    } else {
      html += `<span class="cal-day">${d}</span>`;
    }
  }
  $('#cal-grid').innerHTML = html;
}
function jumpToEntry(idx) {
  pageIndex = isMobile() ? idx : idx - (idx % 2);
  playFx('flip');
  show('scr-book');
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
  toast('모든 기록을 지웠어요. 새 마음으로 시작해요.');
  show('scr-cover');
}

/* ==================== 이벤트 바인딩 ==================== */
function bind() {
  // 표지 → 달력(홈), 제목 클릭 → 표지
  $('#btn-open-book').onclick = () => goCalendar(todayStr().slice(0, 7));
  $('#cal-home-title').onclick = () => show('scr-cover');
  $('#book-home-title').onclick = () => show('scr-cover');

  // 달력 화면
  $('#btn-cal-vlog').onclick = () => openSub('scr-vlog');
  $('#btn-cal-settings').onclick = () => openSub('scr-settings');
  $('#btn-cal-new').onclick = () => openSub('scr-capture');
  $('#cal-prev').onclick = () => shiftCalMonth(-1);
  $('#cal-next').onclick = () => shiftCalMonth(1);
  $('#cal-grid').addEventListener('click', (e) => {
    const day = e.target.closest('.cal-day');
    if (!day) return;
    if (day.dataset.today) { openSub('scr-capture'); return; }   // 기록 없는 오늘
    if (day.classList.contains('has')) jumpToEntry(Number(day.dataset.idx));
  });

  // 책 화면
  $('#btn-cal').onclick = () => goCalendar(calYM || (entries[pageIndex] ? entries[pageIndex].date.slice(0, 7) : todayStr().slice(0, 7)));
  $('#btn-go-vlog').onclick = () => openSub('scr-vlog');
  $('#btn-go-settings').onclick = () => openSub('scr-settings');
  $('#btn-new').onclick = () => openSub('scr-capture');

  // 하위 화면 돌아가기
  $('#btn-cap-back').onclick = () => show(backTo);
  $('#btn-vlog-back').onclick = () => show(backTo);
  $('#btn-set-back').onclick = () => show(backTo);

  // 책: 개별 삭제 / 빈 페이지 클릭 → 기록하기
  $('#book').addEventListener('click', (e) => {
    const del = e.target.closest('.pg-del');
    if (del) { deleteEntryUI(del.dataset.id); return; }
    if (e.target.closest('.pg-empty')) openSub('scr-capture');
  });

  $('#btn-prev').onclick = () => flip(-1);
  $('#btn-next').onclick = () => flip(1);
  document.addEventListener('keydown', (e) => {
    if ($('#scr-book').classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') flip(-1);
    if (e.key === 'ArrowRight') flip(1);
  });

  // 필터 / 촬영 모드 / 날씨 / 기분
  $$('#filter-row .chip').forEach((b) => {
    b.onclick = () => {
      $$('#filter-row .chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      camFilter = b.dataset.filter;
    };
  });
  $$('#mode-toggle button').forEach((b) => {
    b.onclick = () => {
      if (recording) return; // 녹화 중 모드 변경 금지
      $$('#mode-toggle button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      camMode = b.dataset.mode;
    };
  });
  const singlePick = (sel) => $$(sel).forEach((b) => {
    b.onclick = () => {
      const was = b.classList.contains('on');
      $$(sel).forEach((x) => x.classList.remove('on'));
      if (!was) b.classList.add('on');
    };
  });
  singlePick('.wchip');
  singlePick('.mchip');

  $('#btn-shutter').onclick = shutter;
  $('#btn-retake').onclick = retake;
  $('#btn-mic').onclick = toggleSpeech;
  $('#btn-save-entry').onclick = saveEntry;
  $('#btn-make-vlog').onclick = makeVlogUI;
  $('#btn-vlog-save').onclick = downloadVlog;
  $('#btn-wipe').onclick = wipeAll;

  // 꾸미기 (스티커)
  $$('#sticker-palette .schip').forEach((b) => { b.onclick = () => addSticker(b.textContent); });
  bindStickerDrag();
  $('#stk-bigger').onclick = () => resizeSticker(1.25);
  $('#stk-smaller').onclick = () => resizeSticker(0.8);
  $('#stk-delete').onclick = deleteSticker;

  // 브이로그 편집기 (달 선택 / 길이 / 장면 포함·순서)
  $('#vlog-month').onchange = buildClipList;
  $$('#vlog-len button').forEach((b) => {
    b.onclick = () => {
      $$('#vlog-len button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      vlogTargetSec = Number(b.dataset.len);
    };
  });
  $('#clip-list').addEventListener('click', (e) => {
    const up = e.target.closest('.clip-up'), down = e.target.closest('.clip-down');
    if (up) moveClip(Number(up.dataset.i), -1);
    else if (down) moveClip(Number(down.dataset.i), 1);
  });
  $('#clip-list').addEventListener('change', (e) => {
    const chk = e.target.closest('.clip-chk');
    if (chk) toggleClip(Number(chk.dataset.i), chk.checked);
  });

  // 브이로그 소리 옵션
  $('#vlog-bgm').addEventListener('change', () => {
    $('#user-audio-row').classList.toggle('hidden', $('#vlog-bgm').value !== 'user');
  });
  $('#vlog-user-audio').onchange = async () => {
    const file = $('#vlog-user-audio').files[0];
    if (!file) return;
    userAudioData = await file.arrayBuffer();
    userAudioName = file.name;
    $('#user-audio-name').textContent = `${file.name} — 이 음원의 이용 범위(상업용 가능 여부)를 꼭 확인해 주세요`;
  };

  // 효과음 설정
  const soundChk = $('#set-sound');
  soundChk.checked = soundOn();
  soundChk.onchange = () => {
    localStorage.setItem(LS_PREFIX + 'sound', soundChk.checked ? 'on' : 'off');
    if (soundChk.checked) playFx('chime');
  };

  window.addEventListener('resize', () => {
    if (!$('#scr-book').classList.contains('hidden')) renderSpread();
    else sizePageStickers();
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
  // 오프라인 캐시 — https에서만 (file://은 서비스 워커 미지원이라 스킵)
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
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
  camState: () => ({ hasStream: !!camStream, filter: camFilter, mode: camMode, recording, captured: (captured && captured.blob) ? captured.kind : null }),
  // 시드용: dataURL을 blob으로 바꿔 엔트리 저장
  async addEntry({ date, text = '', weather = '', mood = '', filter = 'none', kind = 'none', dataURL = null, stickers = [], durMs = 0 }) {
    let blob = null, thumb = null;
    if (dataURL) {
      blob = await (await fetch(dataURL)).blob();
      thumb = dataURL;
      if (kind === 'none') kind = 'photo';
    }
    const entry = { id: uid(), date: date || todayStr(), ts: Date.now(), kind, blob, thumb, filter, durMs, weather, mood, stickers, text };
    await dbPut(entry);
    entries.push(entry);
    sortEntries();
    return entry.id;
  },
  // 꾸미기·달력·소리 훅
  addSticker,
  getStickers: () => capStickers.slice(),
  goCalendar,
  jumpToEntry,
  // 영상 토글 녹화 (테스트: startVideoRec 후 원하는 시간 뒤 stopVideoRec)
  startVideoRec, stopVideoRec,
  isRecording: () => recording,
  // 브이로그 편집기
  getClips: () => vlogClips.map((c) => ({ ...c })),
  moveClip, toggleClip, setTarget: (s) => { vlogTargetSec = s; },
  _lastVlogAudioTracks: -1,
  // 배경음악이 실제 소리를 내는지 오프라인 렌더로 검증 (평균 진폭 반환)
  async bgmSample(name) {
    const oc = new OfflineAudioContext(1, 44100 * 2, 44100);
    scheduleBgmBar(oc, oc.destination, name, 0);
    const buf = await oc.startRendering();
    const d = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += Math.abs(d[i]);
    return sum / (d.length / 4);
  },
  userAudioLoaded: () => userAudioName,
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
