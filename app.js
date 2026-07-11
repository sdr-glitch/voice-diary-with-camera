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
const VLOG_STORE = 'vlogs';       // 만든 브이로그 보관함
const VLOG_CAP = 24;              // 보관 최대 개수
const VLOG_INTRO_MS = 1900;       // 브이로그 표지
const VLOG_OUTRO_MS = 1600;       // 브이로그 마무리
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

let db = null;
let entries = [];                 // 날짜순 정렬 유지
let flipping = false;
let curScreen = 'scr-cover';      // 현재 화면 id
let backTo = 'scr-cal';           // 하위 화면(기록·브이로그·설정)에서 돌아갈 곳

// 촬영 상태
let camStream = null;
let camVideo = null;              // 라이브 비디오 엘리먼트 (사진 원본 프레임용)
let camLoopId = 0;
let camFilter = 'vintage';
let camMode = 'video';            // 영상 중심 — 기본 영상 (photo | video)
let captured = null;              // 사진:{kind,srcCanvas,_work,filter,fit} 영상:{kind,blob,thumb,filter,durMs}
let recording = false;
let fitState = { scale: 1, x: 0, y: 0 };  // 사진 크기/위치 조절값 (%,배율)
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

let captureDate = null;   // 기록 중인 날짜(YYYY-MM-DD) — 달력에서 지난 날 채우기 지원
let editId = null;        // 수정 중인 기록 id (null이면 새 기록)
let reminderTimer = 0;    // 알림 예약 타이머
let gridFilterMood = '';  // 모아보기 기분 필터
let selDate = '';         // 달력에서 선택한 날짜 (아래 크게보기 카드)

/* 사진 꾸미기 — 폴라로이드 프레임 색 / 마스킹 테이프 색 */
const FRAME_COLORS = [
  { k: 'ivory', label: '아이보리', c: '#fffdf7' },
  { k: 'black', label: '블랙', c: '#23211d' },
  { k: 'kraft', label: '크래프트', c: '#d8c6a4' },
  { k: 'pink', label: '핑크', c: '#f4d3dd' },
  { k: 'mint', label: '민트', c: '#cfe8dc' },
  { k: 'sky', label: '하늘', c: '#d3e2f0' },
];
const TAPE_COLORS = [
  { k: 'cream', label: '크림', c: 'rgba(240,225,190,.72)' },
  { k: 'peach', label: '복숭아', c: 'rgba(244,190,170,.7)' },
  { k: 'sky', label: '하늘', c: 'rgba(180,205,230,.68)' },
  { k: 'sage', label: '세이지', c: 'rgba(178,205,178,.68)' },
  { k: 'lilac', label: '라일락', c: 'rgba(205,190,225,.68)' },
  { k: 'gray', label: '그레이', c: 'rgba(180,178,172,.6)' },
];
function getFrame() { return localStorage.getItem(LS_PREFIX + 'frame') || 'ivory'; }
function getTape() { return localStorage.getItem(LS_PREFIX + 'tape') || 'cream'; }
function frameC() { return (FRAME_COLORS.find((f) => f.k === getFrame()) || FRAME_COLORS[0]).c; }
function tapeC() { return (TAPE_COLORS.find((t) => t.k === getTape()) || TAPE_COLORS[0]).c; }
function applyDecoVars() {
  document.body.style.setProperty('--frame', frameC());
  document.body.style.setProperty('--tape', tapeC());
  document.body.classList.toggle('frame-dark', getFrame() === 'black');
}
const DEFAULT_OUTRO = '이번 달도 수고했어';
const APP_NAME = '순간일기';

/* ==================== 여러 일기장 (책장) ==================== */
/* diaries: [{ id, name, topic, created }]  · active: 현재 쓰는 일기장 id
   기록(entry)마다 diaryId 로 소속을 구분하고, 메모리 entries 는 활성 일기장만 담는다.
   covers/members 는 일기장별로 localStorage 키를 나눈다(covers:<id> / members:<id>). */
let obPick = '';   // 온보딩·새 일기장에서 고른 주제 key
let coverTargetId = '';  // 표지 사진을 바꾸는 대상 일기장 id
function loadDiaries() {
  try { const a = JSON.parse(localStorage.getItem(LS_PREFIX + 'diaries') || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function saveDiaries(a) { localStorage.setItem(LS_PREFIX + 'diaries', JSON.stringify(a)); }
function activeDiaryId() { return localStorage.getItem(LS_PREFIX + 'active') || ''; }
function setActiveDiaryId(id) { localStorage.setItem(LS_PREFIX + 'active', id); }
function activeDiary() { const id = activeDiaryId(); return loadDiaries().find((d) => d.id === id) || null; }
/** 새 일기장 만들기 → id 반환 */
function addDiary(name, topic) {
  const info = allTopics().find((t) => t.k === topic);
  name = (name || '').trim() || (info ? info.label : '나의 일기장');
  const a = loadDiaries();
  const id = 'd_' + uid();
  a.push({ id, name: name.slice(0, 20), topic: topic || 'free', created: Date.now() });
  saveDiaries(a);
  return id;
}
function renameDiary(id, name) {
  name = (name || '').trim(); if (!name) return;
  const a = loadDiaries(); const d = a.find((x) => x.id === id);
  if (d) { d.name = name.slice(0, 20); saveDiaries(a); }
}
/** 일기장 삭제 — 소속 기록·대표사진·멤버 전부 제거 */
async function removeDiary(id) {
  const all = await dbAll();
  for (const e of all) {
    if (e.diaryId === id) {
      await dbDelete(e.id);
      const u = mediaURLCache.get(e.id); if (u) { URL.revokeObjectURL(u); mediaURLCache.delete(e.id); }
    }
  }
  localStorage.removeItem(LS_PREFIX + 'covers:' + id);
  localStorage.removeItem(LS_PREFIX + 'members:' + id);
  localStorage.removeItem(LS_PREFIX + 'events:' + id);
  saveDiaries(loadDiaries().filter((d) => d.id !== id));
}
/** 일기장 표지 사진 설정 — 이미지를 적당히 줄여 dataURL로 diary 레코드에 저장 */
function coverImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxW = 640;
      const scale = Math.min(1, maxW / (img.naturalWidth || maxW));
      const w = Math.round((img.naturalWidth || maxW) * scale);
      const h = Math.round((img.naturalHeight || maxW) * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
    img.src = url;
  });
}
async function setDiaryCover(id, file) {
  if (!file) return;
  try {
    const dataURL = await coverImageFromFile(file);
    const a = loadDiaries(); const d = a.find((x) => x.id === id);
    if (d) { d.cover = dataURL; saveDiaries(a); }
    renderShelf(); renderDiaryList();
    toast('표지 사진을 바꿨어요.');
  } catch (e) { toast('사진을 불러오지 못했어요. 다른 사진으로 해보세요.'); }
}
function clearDiaryCover(id) {
  const a = loadDiaries(); const d = a.find((x) => x.id === id);
  if (d) { delete d.cover; saveDiaries(a); }
  renderShelf(); renderDiaryList();
}
/** 일기장 열기 — 그 일기장의 기록만 메모리에 싣고 달력(홈)으로 */
async function openDiary(id) {
  setActiveDiaryId(id);
  entries = (await dbAll()).filter((e) => e.diaryId === id);
  sortEntries();
  activeAuthor = '';
  goCalendar(todayStr().slice(0, 7));
}
/** 기존 단일 일기장 데이터를 여러 일기장 구조로 1회 이전 */
async function migrateToDiaries() {
  if (localStorage.getItem(LS_PREFIX + 'diaries') !== null) return; // 이미 이전 완료(빈 배열이라도)
  const oldTopic = localStorage.getItem(LS_PREFIX + 'topic');
  const all = await dbAll();
  const hasData = all.length > 0 || (oldTopic && oldTopic.length);
  if (!hasData) { saveDiaries([]); return; } // 신규 사용자 → 책장 비움, 온보딩에서 첫 일기장 생성
  const topic = oldTopic || 'daily';
  const info = allTopics().find((t) => t.k === topic);
  const id = 'd_' + uid();
  saveDiaries([{ id, name: info ? info.label : '나의 일기장', topic, created: Date.now() }]);
  setActiveDiaryId(id);
  const oldCov = localStorage.getItem(LS_PREFIX + 'covers');
  if (oldCov !== null) { localStorage.setItem(LS_PREFIX + 'covers:' + id, oldCov); localStorage.removeItem(LS_PREFIX + 'covers'); }
  const oldMem = localStorage.getItem(LS_PREFIX + 'members');
  if (oldMem !== null) { localStorage.setItem(LS_PREFIX + 'members:' + id, oldMem); localStorage.removeItem(LS_PREFIX + 'members'); }
  localStorage.removeItem(LS_PREFIX + 'topic');
  for (const e of all) { if (!e.diaryId) { e.diaryId = id; await dbPut(e); } }
}

/** 날짜별 대표(썸네일) 사진 선택 — { 'YYYY-MM-DD': entryId }, 일기장별 저장 */
function coversKey() { return LS_PREFIX + 'covers:' + activeDiaryId(); }
function loadCovers() {
  try { return JSON.parse(localStorage.getItem(coversKey()) || '{}'); } catch (e) { return {}; }
}
function saveCovers(m) { localStorage.setItem(coversKey(), JSON.stringify(m)); }
function setCover(date, id) { const m = loadCovers(); m[date] = id; saveCovers(m); }
/** 그 날의 대표 이미지가 될 엔트리(선택값 우선 → 없으면 그날 첫 미디어) */
function coverEntry(date) {
  const chosenId = loadCovers()[date];
  const dayMedia = entries.filter((e) => e.date === date && e.thumb);
  if (chosenId) { const c = dayMedia.find((e) => e.id === chosenId); if (c) return c; }
  return dayMedia[0] || null;
}
function isCover(e) {
  return coverEntry(e.date) && coverEntry(e.date).id === e.id;
}

/* ==================== 일정·기념일 (일기장별) ==================== */
/* events: [{ id, date:'YYYY-MM-DD', title, type:'plan'|'anniv', yearly:bool }] */
function eventsKey() { return LS_PREFIX + 'events:' + activeDiaryId(); }
function loadEvents() {
  try { const a = JSON.parse(localStorage.getItem(eventsKey()) || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function saveEvents(a) { localStorage.setItem(eventsKey(), JSON.stringify(a)); }
function addEvent(date, title, type, yearly) {
  title = (title || '').trim(); if (!date || !title) return;
  const a = loadEvents();
  a.push({ id: uid(), date, title: title.slice(0, 30), type: type === 'anniv' ? 'anniv' : 'plan', yearly: !!yearly });
  saveEvents(a);
}
function removeEvent(id) { saveEvents(loadEvents().filter((e) => e.id !== id)); }
/** 그 날짜에 해당하는 일정 (매년 반복 기념일은 월-일이 같으면 포함) */
function eventsOnDate(dateStr) {
  const md = dateStr.slice(5);
  return loadEvents().filter((ev) => ev.date === dateStr || (ev.yearly && ev.date.slice(5) === md));
}
/** 이 달에 일정이 있는 날짜 집합 (반복 기념일 포함) */
function eventDaysInMonth(ym) {
  const set = new Set();
  const year = ym.slice(0, 4);
  loadEvents().forEach((ev) => {
    if (ev.date.slice(0, 7) === ym) set.add(ev.date);
    if (ev.yearly) { const ds = `${year}-${ev.date.slice(5)}`; if (ds.slice(0, 7) === ym) set.add(ds); }
  });
  return set;
}
/** 오늘 이후 이 일정의 다음 발생일(YYYY-MM-DD) — 반복이면 올해/내년 중 가까운 쪽 */
function nextOccurrence(ev, fromStr) {
  if (!ev.yearly) return ev.date >= fromStr ? ev.date : null;
  const fy = Number(fromStr.slice(0, 4));
  let cand = `${fy}-${ev.date.slice(5)}`;
  if (cand < fromStr) cand = `${fy + 1}-${ev.date.slice(5)}`;
  return cand;
}
/** 다가오는 일정 목록 (오늘 포함, 가까운 순) */
function upcomingEvents(limit = 3) {
  const today = todayStr();
  return loadEvents()
    .map((ev) => ({ ev, when: nextOccurrence(ev, today) }))
    .filter((x) => x.when)
    .sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0))
    .slice(0, limit);
}
/** 남은 날짜 표시 (오늘/내일/D-n) */
function ddayLabel(fromStr, toStr) {
  const diff = Math.round((parseDate(toStr) - parseDate(fromStr)) / 86400000);
  return diff <= 0 ? '오늘' : diff === 1 ? '내일' : `D-${diff}`;
}

/* 일기장 주제 (프리셋 + 사용자 커스텀) */
const TOPICS = [
  { k: 'daily', label: '일상', sub: '매일의 작은 순간들' },
  { k: 'baby', label: '아기 성장', sub: '아이가 자라는 하루하루' },
  { k: 'couple', label: '부부·커플', sub: '둘이 함께 쓰는 기록' },
  { k: 'pet', label: '반려동물', sub: '우리 아이의 나날' },
  { k: 'love', label: '연애', sub: '설레는 우리의 기록' },
  { k: 'hobby', label: '취미', sub: '좋아하는 것들의 기록' },
  { k: 'run', label: '러닝·운동', sub: '오늘도 달린 나의 기록' },
  { k: 'plant', label: '식물집사', sub: '초록이들과의 나날' },
  { k: 'travel', label: '여행', sub: '떠난 곳에서의 순간들' },
  { k: 'study', label: '공부', sub: '하루의 배움 기록' },
  { k: 'food', label: '맛집', sub: '맛있던 순간들' },
  { k: 'free', label: '자유', sub: '무엇이든 담는 나의 일기' },
];
function loadCustomTopics() {
  try { const c = JSON.parse(localStorage.getItem(LS_PREFIX + 'customTopics') || '[]'); return Array.isArray(c) ? c : []; }
  catch (e) { return []; }
}
function saveCustomTopics(c) { localStorage.setItem(LS_PREFIX + 'customTopics', JSON.stringify(c)); }
function allTopics() { return TOPICS.concat(loadCustomTopics()); }
/** 사용자 주제 추가 → key 반환 */
function addCustomTopic(label, sub) {
  label = (label || '').trim();
  if (!label) return '';
  const c = loadCustomTopics();
  const k = 'c_' + uid();
  c.push({ k, label: label.slice(0, 16), sub: (sub || label).trim().slice(0, 24), custom: true });
  saveCustomTopics(c);
  return k;
}
function removeCustomTopic(k) {
  saveCustomTopics(loadCustomTopics().filter((t) => t.k !== k));
  if (getTopic() === k) setTopic('');
}
function getTopic() { const d = activeDiary(); return d ? d.topic : ''; }
function setTopic(k) { const a = loadDiaries(); const d = a.find((x) => x.id === activeDiaryId()); if (d) { d.topic = k; saveDiaries(a); } }
function topicInfo() { return allTopics().find((t) => t.k === getTopic()) || null; }

/* 함께 쓰기 — 작성자(멤버) */
const MEMBER_COLORS = ['#b0713f', '#57b98c', '#7a86b0', '#c25a44', '#e0a13c', '#6a8f6a'];
function membersKey() { return LS_PREFIX + 'members:' + activeDiaryId(); }
function loadMembers() {
  try {
    const m = JSON.parse(localStorage.getItem(membersKey()) || 'null');
    if (Array.isArray(m) && m.length) return m;
  } catch (e) {}
  return [{ id: 'me', name: '나', color: MEMBER_COLORS[0] }];
}
function saveMembers(m) { localStorage.setItem(membersKey(), JSON.stringify(m)); }
function memberById(id) { return loadMembers().find((m) => m.id === id) || null; }
let activeAuthor = '';   // 기록 화면에서 선택된 작성자 id

/* 기분별 공감·위로·응원 카드 */
const MOOD_CARD = {
  설렘: { kind: '공감', msg: '설레는 마음, 그 두근거림을 오래 기억해요.' },
  행복: { kind: '공감', msg: '행복한 순간들이 차곡차곡 쌓이고 있어요.' },
  평온: { kind: '공감', msg: '잔잔한 하루도, 그 자체로 충분히 좋은 날이에요.' },
  그저그럼: { kind: '응원', msg: '무던한 날도 잘 지나왔어요. 그걸로 충분해요.' },
  지침: { kind: '위로', msg: '오늘 참 많이 애썼어요. 조금 쉬어가도 괜찮아요.' },
  울적: { kind: '위로', msg: '울적한 마음, 여기 적어두는 것만으로 조금 가벼워져요.' },
  속상: { kind: '위로', msg: '속상했던 마음, 이 페이지에 다 내려놓아도 돼요.' },
};

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
function fxVolume() {
  const v = parseInt(localStorage.getItem(LS_PREFIX + 'volume'), 10);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.7;
}

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
/** 주파수가 시간에 따라 훑고 지나가는 필터드 노이즈 (종이 넘김용) */
function paperNoise(ctx, dest, t, dur, gain, fStart, fEnd) {
  const len = Math.max(1, Math.ceil(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const env = Math.sin((Math.PI * i) / len); // 부드럽게 커졌다 사라짐
    d[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.6;
  f.frequency.setValueAtTime(fStart, t);
  f.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
  const g = ctx.createGain(); g.gain.value = gain;
  src.connect(f); f.connect(g); g.connect(dest);
  src.start(t);
}

/** UI 효과음 (설정에서 켜고 끔 + 음량). 모두 자체 합성 */
function playFx(name, ctx = null, dest = null) {
  const ui = !ctx;
  if (ui && !soundOn()) return;
  const vol = ui ? fxVolume() : 1;
  if (vol <= 0 && ui) return;
  if (ui) { ctx = audioCtx(); if (!ctx) return; dest = ctx.destination; }
  const G = (g) => g * vol;
  try {
    const t = ctx.currentTime + 0.02;
    if (name === 'shutter') {
      noiseBurst(ctx, dest, t, 0.05, G(0.25), 2400);
      noiseBurst(ctx, dest, t + 0.07, 0.05, G(0.18), 1200);
    } else if (name === 'flip') {
      // 실제 종이가 사르륵 넘어가는 소리 — 고음 러스틀 + 저음 훑기 두 겹
      paperNoise(ctx, dest, t, 0.22, G(0.13), 5200, 1400);
      paperNoise(ctx, dest, t + 0.04, 0.18, G(0.08), 2600, 700);
    } else if (name === 'chime') {
      tone(ctx, dest, t, 880, 0.35, { gain: G(0.07) });
      tone(ctx, dest, t + 0.09, 1318.5, 0.4, { gain: G(0.05) });
    } else if (name === 'bubble') {
      // 비눗방울 톡 — 빠르게 위로 휘는 사인 + 짧은 팝
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(420, t);
      o.frequency.exponentialRampToValueAtTime(1150, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(G(0.14), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.2);
      noiseBurst(ctx, dest, t + 0.005, 0.03, G(0.05), 2000);
    } else if (name === 'mic') {
      // 음성 버튼 — 부드러운 물방울 두 톤
      tone(ctx, dest, t, 660, 0.18, { gain: G(0.08) });
      tone(ctx, dest, t + 0.06, 990, 0.2, { gain: G(0.06) });
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
  if (name === 'guitar') {
    // 따뜻한 기타 핑거스타일 — 낮은 근음 + 위 세 음 아르페지오, D — A — Bm — G
    const chords = [
      [146.8, 220.0, 293.7, 349.2], [110.0, 164.8, 220.0, 277.2],
      [123.5, 185.0, 246.9, 293.7], [98.0, 146.8, 196.0, 246.9],
    ];
    const beat = 60 / 76;
    chords.forEach((ch, ci) => {
      const base = t0 + ci * beat * 2;
      // 근음 두 번
      tone(ctx, dest, base, ch[0], beat * 1.6, { type: 'triangle', gain: 0.05 });
      tone(ctx, dest, base + beat, ch[0], beat * 1.4, { type: 'triangle', gain: 0.04 });
      // 위 음 굴리기
      [1, 2, 3, 2].forEach((idx, k) => tone(ctx, dest, base + (k * beat) / 2 + 0.15, ch[idx], 0.7, { type: 'triangle', gain: 0.04 }));
    });
    return beat * 8;
  }
  if (name === 'lofi') {
    // 로파이 앰비언트 — 낮고 넓은 패드 화음 + 위 반짝이는 벨, 느리게
    const chords = [[130.8, 155.6, 196.0], [174.6, 220.0, 261.6]];
    const bar = 3.6;
    chords.forEach((ch, ci) => {
      const base = t0 + ci * bar;
      ch.forEach((f) => tone(ctx, dest, base, f, bar * 1.05, { type: 'sine', gain: 0.03 }));
      tone(ctx, dest, base + 0.4, ch[2] * 2, 1.3, { type: 'sine', gain: 0.02 });
      tone(ctx, dest, base + bar / 2 + 0.2, ch[1] * 2, 1.3, { type: 'sine', gain: 0.02 });
    });
    return bar * 2;
  }
  return 1;
}

/* ==================== IndexedDB ==================== */
function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(VLOG_STORE)) d.createObjectStore(VLOG_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}
function vlogAll() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(VLOG_STORE, 'readonly').objectStore(VLOG_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function vlogPut(rec) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VLOG_STORE, 'readwrite');
    tx.objectStore(VLOG_STORE).put(rec);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
function vlogDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VLOG_STORE, 'readwrite');
    tx.objectStore(VLOG_STORE).delete(id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
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

const TAB_SCREENS = ['scr-cal', 'scr-grid', 'scr-stats', 'scr-vloglib', 'scr-settings'];
const FAB_SCREENS = ['scr-cal', 'scr-grid'];

/* ==================== 화면 전환 ==================== */
function show(id) {
  curScreen = id;
  $$('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== id));
  if (id !== 'scr-capture') stopCamera();
  if (id === 'scr-capture') openCapture();
  if (id === 'scr-cal') renderCal();
  if (id === 'scr-grid') renderGrid();
  if (id === 'scr-stats') renderMoodStats();
  if (id === 'scr-vloglib') renderVlogLib();
  if (id === 'scr-vlog') fillVlogMonths();
  if (id === 'scr-settings') renderStats();
  if (id === 'scr-cover') renderShelf();
  // 하단 탭 표시 + 활성 탭
  const nav = $('#bottomnav');
  nav.classList.toggle('hidden', !TAB_SCREENS.includes(id));
  $$('#bottomnav .navbtn').forEach((b) => b.classList.toggle('on', b.dataset.scr === id));
  // 플로팅 기록 버튼
  $('#fab').classList.toggle('hidden', !FAB_SCREENS.includes(id));
}
/** 하위 화면 열기 — 돌아갈 화면(backTo)을 현재 화면으로 기억 */
function openSub(id) { backTo = curScreen; show(id); }

/** 책장(표지 화면) — 일기장들을 책으로 나열 + 새 일기장 타일 */
async function renderShelf() {
  const shelf = $('#shelf');
  if (!shelf) return;
  const diaries = loadDiaries();
  const active = activeDiaryId();
  const counts = {};
  try { (await dbAll()).forEach((e) => { if (e.diaryId) counts[e.diaryId] = (counts[e.diaryId] || 0) + 1; }); } catch (e) {}
  const books = diaries.map((d, i) => {
    const info = allTopics().find((t) => t.k === d.topic);
    const sub = info ? info.sub : '';
    const n = counts[d.id] || 0;
    const hasCover = !!d.cover;
    const style = hasCover ? ` style="background-image:url('${d.cover}')"` : '';
    return `<button class="book-tile spine-${i % 5} ${d.id === active ? 'cur' : ''}${hasCover ? ' has-cover' : ''}"${style} data-id="${d.id}">
      <span class="book-band" aria-hidden="true"></span>
      <span class="book-name">${escapeHTML(d.name)}</span>
      <span class="book-topic">${escapeHTML(sub)}</span>
      <span class="book-count">${n ? n + '개의 순간' : '첫 순간을 기다려요'}</span>
    </button>`;
  }).join('');
  shelf.innerHTML = books +
    `<button class="book-tile add" id="shelf-add"><span class="book-plus" aria-hidden="true">＋</span><span class="book-name">새 일기장</span></button>`;
}

/* ==================== 책 렌더링 · 페이지 넘김 ==================== */
function mediaURL(e) {
  if (!e.blob) return null;
  if (!mediaURLCache.has(e.id)) mediaURLCache.set(e.id, URL.createObjectURL(e.blob));
  return mediaURLCache.get(e.id);
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function filterLabel(f) {
  return { none: '무보정', vintage: '빈티지', colorpop: '색감', fisheye: '볼록거울',
    film: '필름', retro: '폴더폰', mono: '흑백', dreamy: '몽환' }[f] || '';
}
function moodLabel(m) {
  return { 설렘: '설렘', 행복: '행복', 평온: '평온', 그저그럼: '그저 그럼', 지침: '지침', 울적: '울적', 속상: '속상' }[m] || m;
}
function stickersHTMLFor(e) {
  return (e.stickers || []).map((s) =>
    `<span class="stk" data-s="${s.s}" style="left:${s.x * 100}%;top:${s.y * 100}%">${s.e}</span>`).join('');
}
function fitStyle(e) {
  const f = e.fit;
  if (!f || (f.scale === 1 && !f.x && !f.y)) return '';
  return ` style="transform:translate(${f.x}%,${f.y}%) scale(${f.scale})"`;
}
/** 사진·영상 블록 (폴라로이드 프레임 + 마스킹 테이프) */
function mediaBlockHTML(e) {
  if (e.kind === 'photo' && e.blob) {
    return `<div class="pg-media polaroid"><span class="masking-tape"></span><img src="${mediaURL(e)}" alt="일기 사진"${fitStyle(e)}>${stickersHTMLFor(e)}<span class="media-tag">${filterLabel(e.filter)}</span></div>`;
  }
  if (e.kind === 'video' && e.blob) {
    const secs = e.durMs ? Math.max(1, Math.round(e.durMs / 1000)) + '초 ' : '';
    return `<div class="pg-media polaroid"><span class="masking-tape"></span><video src="${mediaURL(e)}" muted loop autoplay playsinline${fitStyle(e)}></video>${stickersHTMLFor(e)}<span class="media-tag">영상 ${secs}· ${filterLabel(e.filter)}</span></div>`;
  }
  return '';
}
/** 달력 아래 크게보기 카드 (사진·글 바로 수정) */
function bigEntryHTML(e) {
  const who = authorTag(e);
  const meta = [who, e.mood ? `기분 ${moodLabel(e.mood)}` : '', e.weather ? `날씨 ${e.weather}` : '']
    .filter(Boolean).join('　');
  const dayMediaCount = entries.filter((x) => x.date === e.date && x.thumb).length;
  const coverPick = (e.thumb && dayMediaCount > 1)
    ? `<label class="pg-cover"><input type="checkbox" class="cover-chk" data-id="${e.id}" data-date="${e.date}" ${isCover(e) ? 'checked' : ''}> 이 날의 대표 사진(달력 썸네일)으로</label>`
    : '';
  return `<article class="big-entry" id="big-${e.id}" data-id="${e.id}">
    <div class="be-head">
      <div class="pg-meta">${meta}</div>
      <button class="tbtn be-editphoto" data-id="${e.id}">수정</button>
    </div>
    ${mediaBlockHTML(e)}
    ${coverPick}
    <textarea class="be-text" data-id="${e.id}" rows="3" placeholder="메모를 입력하세요…">${escapeHTML(e.text || '')}</textarea>
    <div class="be-actions"><button class="tbtn danger be-del" data-id="${e.id}">이 기록 지우기</button></div>
  </article>`;
}
/** 스티커 크기를 컨테이너 폭 기준으로 계산 */
function sizePageStickers() {
  $$('.pg-media').forEach((box) => {
    const w = box.clientWidth || 300;
    box.querySelectorAll('.stk').forEach((el) => {
      el.style.fontSize = Math.round(parseFloat(el.dataset.s || 0.15) * w) + 'px';
    });
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
    } else if (name === 'mono') {
      const l = r * 0.3 + g * 0.59 + b * 0.11;
      r = g = b = (l - 128) * 1.12 + 128;
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

const CSS_FILTER = {
  vintage: 'sepia(0.42) saturate(0.9) contrast(1.06) brightness(1.03)',
  colorpop: 'saturate(1.8) contrast(1.12)',
  film: 'contrast(1.12) saturate(0.82) brightness(1.04) hue-rotate(-8deg)',
  mono: 'grayscale(1) contrast(1.12) brightness(1.02)',
  dreamy: 'saturate(1.25) brightness(1.12) contrast(0.94)',
};
function tintRect(ctx, w, h, color, alpha) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); ctx.restore();
}
function grainOverlay(ctx, w, h, alpha) {
  ctx.save(); ctx.globalAlpha = alpha;
  for (let x = 0; x < w; x += 128) for (let y = 0; y < h; y += 128) ctx.drawImage(grainCanvas, x, y);
  ctx.restore();
}

/** 소스(비디오/캔버스/이미지)를 필터 적용해 ctx에 그린다 */
function drawFiltered(ctx, source, w, h, filter) {
  if (filter === 'retro') {
    // 옛날 폴더폰 감성 — 저해상도로 줄였다 키워 픽셀 뭉갬 + 초록빛 + 낮은 채도
    const sw = Math.max(1, Math.round(w / 6)), sh = Math.max(1, Math.round(h / 6));
    const tmp = document.createElement('canvas'); tmp.width = sw; tmp.height = sh;
    const tctx = tmp.getContext('2d');
    if (CTX_FILTER_OK) tctx.filter = 'saturate(0.7) contrast(1.15) brightness(0.98)';
    tctx.drawImage(source, 0, 0, sw, sh);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, w, h);
    ctx.restore();
    if (!CTX_FILTER_OK) applyPixelFilter(ctx, w, h, 'vintage');
    tintRect(ctx, w, h, '#0a3d1e', 0.14);   // 형광 초록빛 LCD 느낌
    // 스캔라인
    ctx.save(); ctx.globalAlpha = 0.10; ctx.fillStyle = '#000';
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
    ctx.restore();
    return;
  }

  ctx.save();
  if (CTX_FILTER_OK && CSS_FILTER[filter]) ctx.filter = CSS_FILTER[filter];
  ctx.drawImage(source, 0, 0, w, h);
  ctx.restore();

  if (!CTX_FILTER_OK && (filter === 'vintage' || filter === 'colorpop' || filter === 'mono')) {
    applyPixelFilter(ctx, w, h, filter === 'mono' ? 'mono' : filter);
  }
  if (filter === 'fisheye') {
    applyFisheye(ctx, w, h);
    drawVignette(ctx, w, h, 0.30);
  }
  if (filter === 'vintage') {
    drawVignette(ctx, w, h, 0.38);
    grainOverlay(ctx, w, h, 0.06);
  }
  if (filter === 'film') {
    // 필름 카메라 — 살짝 바랜 색 + 오른쪽 위 라이트 리크 + 곱은 입자
    const g = ctx.createLinearGradient(w, 0, w * 0.4, h);
    g.addColorStop(0, 'rgba(255,180,120,0.22)');
    g.addColorStop(0.4, 'rgba(255,180,120,0.06)');
    g.addColorStop(1, 'rgba(255,180,120,0)');
    ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); ctx.restore();
    tintRect(ctx, w, h, '#0b1a2b', 0.06);
    drawVignette(ctx, w, h, 0.30);
    grainOverlay(ctx, w, h, 0.08);
  }
  if (filter === 'mono') {
    drawVignette(ctx, w, h, 0.28);
    grainOverlay(ctx, w, h, 0.05);
  }
  if (filter === 'dreamy') {
    // 몽환 — 부드러운 흰 블룸(가장자리에서 안쪽으로 은은하게)
    const g = ctx.createRadialGradient(w / 2, h * 0.42, Math.min(w, h) * 0.1, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(255,245,250,0.30)');
    g.addColorStop(0.55, 'rgba(255,240,248,0.10)');
    g.addColorStop(1, 'rgba(255,235,245,0)');
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); ctx.restore();
    tintRect(ctx, w, h, '#ffd9ec', 0.06);
  }
}

function camMsg(text, show = true) {
  $('#cam-msg').classList.toggle('hidden', !show);
  if (text) $('#cam-msg-text').innerHTML = text;
}

/** 특정 날짜의 새 기록 화면 열기 */
function openCaptureFor(date) {
  editId = null;
  captureDate = date || todayStr();
  openSub('scr-capture');
}
/** 기존 기록 수정 (사진·글 바꾸기) */
function openEditEntry(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  editId = id;
  captureDate = e.date;
  openSub('scr-capture');
}
function renderCaptureDate() {
  const d = captureDate || todayStr();
  const isToday = d === todayStr();
  $('#cap-title').textContent = editId ? '기록 수정' : (isToday ? '오늘의 순간 담기' : '그날의 순간 채우기');
  const wd = DOW[parseDate(d).getDay()];
  $('#cap-datebar').textContent = isToday && !editId
    ? `오늘 · ${fmtDateKo(d)} ${wd}요일`
    : `${fmtDateKo(d)} ${wd}요일`;
}
/** 수정 모드: 기존 값 채우기 */
function prefillEdit() {
  const banner = $('#cap-edit-banner');
  const e = editId ? entries.find((x) => x.id === editId) : null;
  if (!e) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  $('#diary-text').value = e.text || '';
  if (e.mood) { const b = $(`.mchip[data-mood="${e.mood}"]`); if (b) b.classList.add('on'); }
  if (e.weather) { const b = $(`.wchip[data-weather="${e.weather}"]`); if (b) b.classList.add('on'); }
  camFilter = e.filter || 'vintage';
  $$('#filter-row .chip').forEach((x) => x.classList.toggle('on', x.dataset.filter === camFilter));
  if (e.author) { activeAuthor = e.author; renderAuthorChips(); }
  fitState = e.fit ? { ...e.fit } : { scale: 1, x: 0, y: 0 };  // 기존 크기조절 이어받기
}

async function openCapture() {
  if (!captureDate) captureDate = todayStr();
  resetCaptureUI();
  renderCaptureDate();
  renderAuthorChips();
  prefillEdit();
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
  camVideo = video;
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
    if (!(captured && (captured.blob || captured._work))) drawFiltered(ctx, video, w, h, camFilter);
    requestAnimationFrame(loop);
  })();
}

/** 캡처된 사진(원본 srcCanvas)에 현재 필터를 적용해 미리보기 갱신 */
function renderCapturedPhoto() {
  if (!captured || !captured.srcCanvas) return;
  const s = captured.srcCanvas, w = s.width, h = s.height;
  const work = document.createElement('canvas'); work.width = w; work.height = h;
  const wc = work.getContext('2d', { willReadFrequently: true });
  drawFiltered(wc, s, w, h, captured.filter);
  captured._work = work;
  const img = $('#cap-preview-img');
  img.src = work.toDataURL('image/jpeg', 0.92);
  applyFitPreview();
}
function applyFitPreview() {
  const img = $('#cap-preview-img');
  img.style.transform = `translate(${fitState.x}%, ${fitState.y}%) scale(${fitState.scale})`;
}
/** 사진 미리보기 핀치 줌 + 한 손가락 이동 (부드럽게: rect 캐시 + rAF) */
function bindPhotoPinch() {
  const stage = document.querySelector('.cam-stage');
  const pts = new Map();
  let startDist = 0, startScale = 1, startX = 0, startY = 0, startMid = null;
  let rect = null, raf = 0, pending = false;
  const editingPhoto = () => captured && captured.kind === 'photo' && !$('#cap-preview-img').classList.contains('hidden');
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const flush = () => { raf = 0; if (pending) { applyFitPreview(); pending = false; } };
  stage.addEventListener('pointerdown', (e) => {
    if (!editingPhoto()) return;
    if (e.target.closest('.stk')) return;  // 스티커 드래그는 스티커가 처리
    rect = stage.getBoundingClientRect();   // 이동 중엔 다시 측정하지 않음(리플로우 방지)
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { startX = fitState.x; startY = fitState.y; startMid = { x: e.clientX, y: e.clientY }; }
    if (pts.size === 2) { const a = [...pts.values()]; startDist = dist(a[0], a[1]) || 1; startScale = fitState.scale; }
    try { stage.setPointerCapture(e.pointerId); } catch (er) {}
  });
  stage.addEventListener('pointermove', (e) => {
    if (!editingPhoto() || !pts.has(e.pointerId) || !rect) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2) {
      const a = [...pts.values()];
      fitState.scale = Math.min(4, Math.max(0.3, startScale * (dist(a[0], a[1]) / startDist)));
    } else if (startMid) {
      fitState.x = startX + (e.clientX - startMid.x) / rect.width * 100;
      fitState.y = startY + (e.clientY - startMid.y) / rect.height * 100;
    }
    pending = true;
    if (!raf) raf = requestAnimationFrame(flush);   // 프레임당 한 번만 적용
    e.preventDefault();
  }, { passive: false });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) startMid = null; if (!pts.size) rect = null; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
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
  fitState = { scale: 1, x: 0, y: 0 };
  clearStickers();
  $('#cap-preview-img').classList.add('hidden');
  $('#cap-preview-img').style.transform = '';
  $('#cap-preview-video').classList.add('hidden');
  $('#cam-canvas').classList.remove('hidden');
  $('#btn-retake').classList.add('hidden');
  $('#btn-shutter').classList.remove('hidden');
  $('#btn-shutter').classList.remove('recording');
  $('#rec-dot').classList.remove('on');
  $('#fit-controls').classList.add('hidden');
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
  // mp4(H.264)를 최우선 — 아이폰 사진앱·카톡 공유·PC 어디서나 재생됨.
  // webm은 아이폰에서 재생이 안 되므로 지원 안 될 때의 최후 대안으로만 사용.
  const list = [
    'video/mp4;codecs=h264,aac', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=h264', 'video/mp4',
    'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
  ];
  for (const m of list) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
/** blob/mime 타입에 맞는 파일 확장자 — 확장자와 실제 내용이 달라 재생 안 되던 문제 방지 */
function extForType(t) { t = t || ''; return t.includes('webm') ? 'webm' : 'mp4'; }

/** 셔터 버튼: 사진이면 즉시 촬영, 영상이면 녹화 시작/정지 토글(길이 제한 없음) */
async function shutter() {
  if (!camStream) return;
  if (captured && (captured.blob || captured._work)) return; // 이미 촬영 완료(미리보기 중)
  if (camMode === 'photo') {
    playFx('shutter');
    // 원본 프레임을 srcCanvas에 보관 → 촬영 후에도 필터를 바꿔 다시 적용 가능
    const w = camVideo.videoWidth || 640, h = camVideo.videoHeight || 480;
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    src.getContext('2d').drawImage(camVideo, 0, 0, w, h);
    fitState = { scale: 1, x: 0, y: 0 };
    captured = { kind: 'photo', srcCanvas: src, filter: camFilter, fit: fitState };
    renderCapturedPhoto();
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
  // 사진일 때만 크기 조절(핀치/버튼) 노출
  $('#fit-controls').classList.toggle('hidden', !(captured && captured.kind === 'photo'));
  toast(captured && captured.kind === 'photo'
    ? '찰칵! 손가락으로 사진 크기를 맞추고, 스티커로 꾸며보세요.'
    : '순간을 담았어요. 스티커로 꾸며보세요.');
}
function retake() {
  const pv = $('#cap-preview-video');
  if (pv.src) URL.revokeObjectURL(pv.src);
  $('#cap-preview-img').classList.add('hidden');
  $('#cap-preview-img').style.transform = '';
  pv.classList.add('hidden'); pv.removeAttribute('src');
  captured = null;
  fitState = { scale: 1, x: 0, y: 0 };
  clearStickers();
  $('#cam-canvas').classList.remove('hidden');
  $('#btn-shutter').classList.remove('hidden');
  $('#btn-shutter').classList.remove('recording');
  $('#btn-retake').classList.add('hidden');
  $('#fit-controls').classList.add('hidden');
}

/* ==================== 갤러리에서 가져오기 (지난 날 채우기) ==================== */
async function importFromGallery(file) {
  if (!file) return;
  if (recording) { toast('녹화를 먼저 멈춰주세요.'); return; }
  try {
    if (file.type.startsWith('video/')) {
      const v = await loadVideoBlob(file);
      const durMs = Math.round((v.videoDuration || v.duration || 0) * 1000) || 0;
      // 첫 프레임으로 썸네일
      const tw = 320, th = Math.round(320 * (v.videoHeight || 3) / (v.videoWidth || 4));
      const tc = document.createElement('canvas'); tc.width = tw; tc.height = th;
      try { tc.getContext('2d').drawImage(v, 0, 0, tw, th); } catch (e) {}
      URL.revokeObjectURL(v.src);
      captured = { kind: 'video', blob: file, thumb: tc.toDataURL('image/jpeg', 0.72), filter: 'none', durMs };
      const pv = $('#cap-preview-video');
      pv.src = URL.createObjectURL(file);
      pv.classList.remove('hidden');
      pv.play().catch(() => {});
      $('#cam-canvas').classList.add('hidden');
      afterCapture();
    } else if (file.type.startsWith('image/')) {
      const img = await blobToImage(file);
      const w = img.naturalWidth || 640, h = img.naturalHeight || 480;
      // 원본을 srcCanvas에 보관 → 필터를 바꿔가며 다시 적용 + 크기조절 가능
      const src = document.createElement('canvas'); src.width = w; src.height = h;
      src.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(img.src);
      fitState = { scale: 1, x: 0, y: 0 };
      captured = { kind: 'photo', srcCanvas: src, filter: camFilter, fit: fitState };
      renderCapturedPhoto();
      $('#cap-preview-img').classList.remove('hidden');
      $('#cam-canvas').classList.add('hidden');
      afterCapture();
    } else {
      toast('사진이나 영상 파일만 가져올 수 있어요.');
    }
  } catch (e) {
    toast('파일을 불러오지 못했어요. 다른 파일로 다시 시도해 주세요.');
  }
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
  if (!captured || !(captured.blob || captured._work)) { toast('먼저 사진이나 영상을 찍은 다음 꾸밀 수 있어요.'); return; }
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

/** 캡처된 미디어를 최종 blob/thumb/fit으로 확정 (사진은 필터 적용된 _work에서 생성) */
async function finalizeCaptured() {
  if (!captured) return null;
  if (captured.kind === 'photo' && captured._work) {
    const blob = await new Promise((r) => captured._work.toBlob(r, 'image/jpeg', 0.92));
    return { kind: 'photo', blob, thumb: thumbFrom(captured._work), filter: captured.filter, durMs: 0, fit: { ...fitState } };
  }
  if (captured.kind === 'video' && captured.blob) {
    return { kind: 'video', blob: captured.blob, thumb: captured.thumb, filter: captured.filter, durMs: captured.durMs || 0, fit: { scale: 1, x: 0, y: 0 } };
  }
  return null;
}

/* ==================== 저장 ==================== */
async function saveEntry() {
  const text = $('#diary-text').value.trim();
  if (recording) { toast('녹화를 먼저 멈춰주세요. 셔터 버튼을 한 번 더 누르면 멈춰요.'); return null; }
  const weatherBtn = $('.wchip.on');
  const moodBtn = $('.mchip.on');
  const media = await finalizeCaptured();

  // 수정 모드 — 기존 기록 갱신 (미디어는 새로 찍었을 때만 교체)
  if (editId) {
    const e = entries.find((x) => x.id === editId);
    if (e) {
      if (media) {
        const u = mediaURLCache.get(e.id); if (u) { URL.revokeObjectURL(u); mediaURLCache.delete(e.id); }
        e.kind = media.kind; e.blob = media.blob; e.thumb = media.thumb;
        e.filter = media.filter; e.durMs = media.durMs; e.fit = media.fit; e.stickers = capStickers.slice();
      }
      e.text = text;
      e.weather = weatherBtn ? weatherBtn.dataset.weather : '';
      e.mood = moodBtn ? moodBtn.dataset.mood : '';
      e.author = activeAuthor || e.author || '';
      await dbPut(e);
      const eDate = e.date, eId = e.id;
      editId = null;
      toast('기록을 수정했어요.');
      selDate = eDate; calYM = eDate.slice(0, 7);
      show('scr-cal');
      setTimeout(() => { const el = $(`#big-${eId}`); if (el) el.scrollIntoView({ block: 'center' }); }, 60);
      return e;
    }
    editId = null;
  }

  if (!media && !text) {
    toast('사진·영상을 찍거나, 한 줄이라도 느낌을 남겨보세요.');
    return null;
  }
  const entry = {
    id: uid(),
    diaryId: activeDiaryId(),
    date: captureDate || todayStr(),
    ts: Date.now(),
    kind: media ? media.kind : 'none',
    blob: media ? media.blob : null,
    thumb: media ? media.thumb : null,
    filter: media ? media.filter : 'none',
    durMs: media ? media.durMs : 0,
    fit: media ? media.fit : { scale: 1, x: 0, y: 0 },
    weather: weatherBtn ? weatherBtn.dataset.weather : '',
    mood: moodBtn ? moodBtn.dataset.mood : '',
    author: activeAuthor || (loadMembers()[0] ? loadMembers()[0].id : ''),
    stickers: media ? capStickers.slice() : [],
    text,
  };
  await dbPut(entry);
  entries.push(entry);
  sortEntries();
  toast('일기장에 붙였어요.');
  selDate = entry.date; calYM = entry.date.slice(0, 7);
  show('scr-cal');
  setTimeout(() => { const el = $(`#big-${entry.id}`); if (el) el.scrollIntoView({ block: 'center' }); }, 60);
  return entry;
}

/* ==================== 개별 삭제 ==================== */
async function removeEntry(id) {
  await dbDelete(id);
  const url = mediaURLCache.get(id);
  if (url) { URL.revokeObjectURL(url); mediaURLCache.delete(id); }
  entries = entries.filter((e) => e.id !== id);
  renderShelf();
  if (curScreen === 'scr-cal') renderCal();
  else if (curScreen === 'scr-grid') renderGrid();
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

/** 선택한 달의 장면 목록(포함/순서 편집용) — 사진·영상만(글만 있는 날 제외) */
function buildClipList() {
  const ym = $('#vlog-month').value;
  vlogClips = entries
    .filter((e) => e.date.startsWith(ym) && (e.kind === 'photo' || e.kind === 'video'))
    .map((e) => ({ id: e.id, on: true }));
  renderClipList();
}
function kindLabel(e) {
  return e.kind === 'video' ? '영상' : e.kind === 'photo' ? '사진' : '글';
}
function renderClipList() {
  const ul = $('#clip-list');
  if (!vlogClips.length) { ul.innerHTML = '<li class="clip-empty">이 달에는 넣을 사진·영상이 없어요. (글만 있는 날은 브이로그에서 제외돼요)</li>'; return; }
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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
/** 폴라로이드 프레임 좌표 */
function polaroidGeom(W, H) {
  const mw = 476, mh = 357, pad = 24, bottom = 92;
  const fw = mw + pad * 2, fh = mh + pad + bottom;
  const fx = Math.round((W - fw) / 2), fy = Math.round((H - fh) / 2);
  return { fx, fy, fw, fh, mx: fx + pad, my: fy + pad, mw, mh };
}
/** 배경 + 흰 폴라로이드 프레임 그리기 */
function drawPolaroidFrame(ctx, W, H, g) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#efe7d6'); bg.addColorStop(1, '#e2d7c1');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.shadowColor = 'rgba(60,45,25,.32)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 12;
  ctx.fillStyle = frameC();   // 사용자 프레임 색
  roundRect(ctx, g.fx, g.fy, g.fw, g.fh, 10); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#d8d0c0';
  ctx.fillRect(g.mx, g.my, g.mw, g.mh);
}
/** 미디어를 폴라로이드 안쪽에 cover-fit (zoom>1 이면 켄번즈 확대) */
function drawMediaCover(ctx, src, sw, sh, g, zoom, fit) {
  zoom = zoom || 1;
  const f = fit || { scale: 1, x: 0, y: 0 };
  ctx.save();
  ctx.beginPath(); ctx.rect(g.mx, g.my, g.mw, g.mh); ctx.clip();
  const base = Math.max(g.mw / sw, g.mh / sh) * zoom * (f.scale || 1);
  const dw = sw * base, dh = sh * base;
  const ox = (f.x || 0) / 100 * g.mw, oy = (f.y || 0) / 100 * g.mh;
  ctx.drawImage(src, g.mx + (g.mw - dw) / 2 + ox, g.my + (g.mh - dh) / 2 + oy, dw, dh);
  ctx.restore();
}
function polaroidStickers(ctx, g, e) {
  (e.stickers || []).forEach((s) => {
    ctx.save();
    ctx.font = `${Math.max(10, Math.round(s.s * g.mw))}px "Apple SD Gothic Neo", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(s.e, g.mx + s.x * g.mw, g.my + s.y * g.mh);
    ctx.restore();
  });
}
function polaroidCaption(ctx, g, e) {
  const dark = getFrame() === 'black';   // 검은 프레임이면 밝은 글씨
  const cy = g.my + g.mh + 40;
  ctx.fillStyle = dark ? '#f2ede2' : '#4a4238'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = '600 24px "Noto Serif KR", serif';
  ctx.fillText(`${fmtDateKo(e.date)} ${e.weather || ''}`, g.fx + g.fw / 2, cy);
  const extra = [e.mood ? moodLabel(e.mood) : '', (e.text || '').replace(/\s+/g, ' ').trim()]
    .filter(Boolean).join(' · ');
  if (extra) {
    ctx.font = '17px "Noto Serif KR", serif'; ctx.fillStyle = dark ? 'rgba(242,237,226,.75)' : '#8a8071';
    let line = extra; if (line.length > 24) line = line.slice(0, 24) + '…';
    ctx.fillText(line, g.fx + g.fw / 2, cy + 26);
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

async function buildVlog(ym, onProg = () => {}, opts = {}) {
  // 넣을 장면·순서 (편집기에서 고른 ids가 있으면 그대로, 없으면 그달 전부)
  let list;
  if (opts.ids && opts.ids.length) {
    list = opts.ids.map((id) => entries.find((e) => e.id === id)).filter(Boolean);
  } else {
    list = entries.filter((e) => e.date.startsWith(ym));
  }
  // 브이로그는 사진·영상만 사용 (글만 있는 날 제외)
  list = list.filter((e) => (e.kind === 'photo' || e.kind === 'video') && e.blob);
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
  // 마무리 한마디 — 사용자가 수정/삭제 가능(앱 이름은 항상 아래 작게, 수정 불가)
  const outro = (opts.outro !== undefined) ? String(opts.outro).trim()
    : (localStorage.getItem(LS_PREFIX + 'outro') ?? DEFAULT_OUTRO);

  const W = 720, H = 540;
  const geo = polaroidGeom(W, H);
  const now = () => (window.performance && performance.now) ? performance.now() : Date.now();
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
      const sceneStart = now();
      if (e.kind === 'video' && e.blob) {
        // 영상은 길이가 제각각 — 배정된 시간(slotMs)만큼만 보여주고 넘어감(압축)
        const v = await loadVideoBlob(e.blob);
        v.loop = true;
        await v.play().catch(() => {});
        drawFn = () => {
          drawPolaroidFrame(ctx, W, H, geo);
          drawMediaCover(ctx, v, v.videoWidth || 4, v.videoHeight || 3, geo, 1);
          polaroidStickers(ctx, geo, e); polaroidCaption(ctx, geo, e);
        };
        await sleep(slotMs);
        v.pause();
        URL.revokeObjectURL(v.src);
      } else if (e.kind === 'photo' && e.blob) {
        // 사진은 폴라로이드 안에서 천천히 확대(켄번즈)돼 "움직이는 사진"이 됨
        const img = await blobToImage(e.blob);
        drawFn = () => {
          const p = Math.min(1, (now() - sceneStart) / slotMs);
          drawPolaroidFrame(ctx, W, H, geo);
          drawMediaCover(ctx, img, img.naturalWidth || 4, img.naturalHeight || 3, geo, 1 + 0.09 * p, e.fit);
          polaroidStickers(ctx, geo, e); polaroidCaption(ctx, geo, e);
        };
        await sleep(slotMs);
        URL.revokeObjectURL(img.src);
      } else {
        // 글만 있는 날 — 폴라로이드 안에 손글씨 카드
        drawFn = () => {
          drawPolaroidFrame(ctx, W, H, geo);
          ctx.save(); ctx.beginPath(); ctx.rect(geo.mx, geo.my, geo.mw, geo.mh); ctx.clip();
          ctx.fillStyle = '#efe8d9'; ctx.fillRect(geo.mx, geo.my, geo.mw, geo.mh);
          ctx.fillStyle = '#4a4238'; ctx.textAlign = 'center';
          ctx.font = '22px "Noto Serif KR", serif';
          let line = (e.text || '').replace(/\s+/g, ' ').trim() || '기록';
          if (line.length > 18) line = line.slice(0, 18) + '…';
          ctx.fillText(line, geo.mx + geo.mw / 2, geo.my + geo.mh / 2 + 8);
          ctx.restore();
          polaroidStickers(ctx, geo, e); polaroidCaption(ctx, geo, e);
        };
        await sleep(slotMs);
      }
    } catch (err) {
      // 손상된 미디어는 건너뛰고 계속 (한 장 때문에 전체가 죽으면 안 됨)
      console.warn('vlog: 미디어 하나를 건너뜀', err);
    }
  }

  // 아웃트로 — 사용자가 정한 한마디 + 앱 이름(고정, 작게)
  onProg(list.length + 2, list.length + 2, '마무리하는 중…');
  drawFn = () => vlogTitleSlide(ctx, W, H, outro || APP_NAME, outro ? APP_NAME : '');
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
    const outro = $('#vlog-outro').value;
    localStorage.setItem(LS_PREFIX + 'outro', outro); // 다음에도 기억
    const opts = {
      bgm: $('#vlog-bgm').value,
      fx: $('#vlog-fx').checked,
      title: $('#vlog-title').value,
      outro,
      targetSec: vlogTargetSec,
      ids,
    };
    lastVlogMeta = { ym, title: $('#vlog-title').value, ids };
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
  a.download = `순간일기_${ym}_브이로그.${extForType(vlogBlob.type)}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ==================== 브이로그 보관함 ==================== */
let vlogs = [];
let lastVlogMeta = null;             // 방금 만든 브이로그 정보
const vlogURLCache = new Map();
function vlogURL(rec) {
  if (!vlogURLCache.has(rec.id)) vlogURLCache.set(rec.id, URL.createObjectURL(rec.blob));
  return vlogURLCache.get(rec.id);
}
async function loadVlogs() {
  vlogs = await vlogAll();
  vlogs.sort((a, b) => b.createdTs - a.createdTs);
}
async function saveVlogToLib() {
  if (!vlogBlob || !lastVlogMeta) { toast('먼저 브이로그를 만들어 주세요.'); return; }
  const first = entries.find((e) => (lastVlogMeta.ids || []).includes(e.id));
  const rec = {
    id: uid(), ym: lastVlogMeta.ym, title: lastVlogMeta.title || `${lastVlogMeta.ym.replace('-', '년 ')}월`,
    createdTs: Date.now(), thumb: first ? first.thumb : null, blob: vlogBlob, mime: vlogBlob.type,
  };
  await vlogPut(rec);
  await loadVlogs();
  // 보관 개수 제한 — 오래된 것부터 정리
  while (vlogs.length > VLOG_CAP) {
    const old = vlogs.pop();
    await vlogDelete(old.id);
    const u = vlogURLCache.get(old.id); if (u) { URL.revokeObjectURL(u); vlogURLCache.delete(old.id); }
  }
  toast('브이로그 보관함에 저장했어요.');
  show('scr-vloglib');
}
async function deleteVlog(id) {
  const rec = vlogs.find((v) => v.id === id);
  const ok = await confirmModal(`"${rec ? (rec.title || '브이로그') : '브이로그'}"를 보관함에서 지울까요?`);
  if (!ok) return;
  await vlogDelete(id);
  const u = vlogURLCache.get(id); if (u) { URL.revokeObjectURL(u); vlogURLCache.delete(id); }
  await loadVlogs();
  renderVlogLib();
  toast('브이로그를 지웠어요.');
}
function downloadVlogRec(id) {
  const rec = vlogs.find((v) => v.id === id);
  if (!rec) return;
  const a = document.createElement('a');
  a.href = vlogURL(rec);
  const ext = extForType(rec.mime || (rec.blob && rec.blob.type));
  a.download = `순간일기_${rec.ym.replace('-', '년')}월_브이로그.${ext}`;
  a.click();
  toast('기기에 저장했어요. 사진앱/파일에서 확인하거나 카톡으로 공유할 수 있어요.');
}
/** 브이로그 보관함 — 모아보기처럼 바둑판(그리드)으로 */
function renderVlogLib() {
  const wrap = $('#vloglib-wrap');
  if (!vlogs.length) {
    wrap.innerHTML = '<p class="empty-note">아직 만든 브이로그가 없어요.<br>위 버튼으로 첫 브이로그를 만들어 보세요.</p>';
    return;
  }
  wrap.innerHTML = vlogs.map((v) => {
    const d = new Date(v.createdTs);
    const dstr = `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
    return `<button class="vlog-tile" data-id="${v.id}" aria-label="브이로그 크게 보기">
      <span class="vlog-tile-thumb">${v.thumb ? `<img src="${v.thumb}" alt="">` : ''}<span class="vlog-play">▶</span></span>
      <span class="vlog-tile-meta">
        <b>${escapeHTML(v.title || '브이로그')}</b>
        <span>${v.ym.replace('-', '년 ')}월 · ${dstr}</span>
      </span>
    </button>`;
  }).join('');
}
/** 브이로그 큰 화면(전체) 재생 뷰어 */
let viewerVlogId = '';
function openVlogViewer(id) {
  const rec = vlogs.find((v) => v.id === id);
  if (!rec) return;
  viewerVlogId = id;
  const v = $('#vlog-viewer-video');
  v.src = vlogURL(rec); v.controls = true; v.playsInline = true;
  $('#vlog-viewer-title').textContent = `${rec.title || '브이로그'} · ${rec.ym.replace('-', '년 ')}월`;
  $('#vlog-viewer').classList.add('on');
  v.play().catch(() => {});
}
function closeVlogViewer() {
  const v = $('#vlog-viewer-video');
  v.pause(); v.removeAttribute('src'); v.load();
  $('#vlog-viewer').classList.remove('on');
  viewerVlogId = '';
}

/* ==================== 모아보기 (그리드 갤러리) ==================== */
let gridJiggle = false;
let cascading = false;
function gridSortedRefs() {
  return entries.map((e, i) => ({ e, i }))
    .filter(({ e }) => !gridFilterMood || e.mood === gridFilterMood)
    .sort((a, b) => (a.e.date === b.e.date ? b.e.ts - a.e.ts : (a.e.date < b.e.date ? 1 : -1)));
}
/** 기분별 일기 모아보기 — 통계에서 기분을 누르면 호출 */
function openMoodCollection(mood) {
  gridFilterMood = mood;
  show('scr-grid');
}
function renderGridFilterBar() {
  const bar = $('#grid-filter');
  if (gridFilterMood) {
    bar.classList.remove('hidden');
    const card = MOOD_CARD[gridFilterMood];
    $('#grid-filter-label').textContent = `「${moodLabel(gridFilterMood)}」 기분의 일기` + (card ? ` · ${card.kind}` : '');
    $('#grid-title').textContent = '기분 모아보기';
  } else {
    bar.classList.add('hidden');
    $('#grid-title').textContent = '모아보기';
  }
}
function renderGrid() {
  renderGridFilterBar();
  const wrap = $('#grid-wrap');
  const refs = gridSortedRefs();
  if (!refs.length) {
    wrap.innerHTML = gridFilterMood
      ? `<p class="empty-note">「${moodLabel(gridFilterMood)}」 기분으로 남긴 일기가 아직 없어요.</p>`
      : '<p class="empty-note">아직 기록이 없어요.<br>아래 ＋ 버튼으로 첫 순간을 담아보세요.</p>';
    wrap.classList.remove('jiggle');
    return;
  }
  wrap.innerHTML = refs.map(({ e, i }, k) => {
    const d = parseDate(e.date);
    const media = e.thumb
      ? `<img src="${e.thumb}" alt="">`
      : `<span class="grid-textcard">${escapeHTML((e.text || '기록').replace(/\s+/g, ' ').slice(0, 14))}</span>`;
    const tag = e.kind === 'video' ? '<span class="grid-vtag">영상</span>' : '';
    const am = authorTag(e) ? memberById(e.author) : null;
    const adot = am ? `<span class="grid-author" style="background:${am.color}" title="${escapeHTML(am.name)}"></span>` : '';
    return `<button class="grid-item" data-idx="${i}" data-k="${k}" style="--jd:${(k % 6) * 0.06}s">
      ${media}${tag}${adot}
      <span class="grid-date">${d.getMonth() + 1}.${d.getDate()}</span>
    </button>`;
  }).join('');
  wrap.classList.toggle('jiggle', gridJiggle);
  wrap.classList.remove('fallen');
  $('#grid-fallen-ctrl').classList.add('hidden');
}
function setJiggle(on) {
  gridJiggle = (on === undefined) ? !gridJiggle : on;
  $('#grid-wrap').classList.toggle('jiggle', gridJiggle);
  $('#grid-hint').textContent = gridJiggle
    ? '위아래로 쓸면 사진이 와르르 · 다시 길게 누르면 정리돼요'
    : '길게 눌러 편집 · 위아래로 쓸면 와르르';
}
let gridFallen = false;
let fallenPos = [];   // 위치 인덱스별 이동량 {x,y,r}
let natRect = [];     // 위치 인덱스별 원래 화면좌표 {left,top,w,h}

/** 편집 중 스와이프 → 사진이 화면 아래로 떨어져 쌓임(그대로 멈춤) */
function cascadeGrid() {
  if (cascading || !gridJiggle || gridFallen) return;
  cascading = true;
  const wrap = $('#grid-wrap');
  wrap.classList.remove('jiggle');
  const items = $$('#grid-wrap .grid-item');
  const vh = window.innerHeight;
  natRect = items.map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; });
  fallenPos = items.map((el, k) => {
    const r = natRect[k];
    const restBottom = vh - 96 - (k % 5) * 7;              // 바닥 근처, 살짝 층지게
    return { x: (((k * 13) % 17) - 8) * 5, y: Math.max(0, restBottom - (r.top + r.h)), r: (k % 2 ? 1 : -1) * (8 + (k * 11) % 22) };
  });
  items.forEach((el, k) => {
    el.style.setProperty('--ty', fallenPos[k].y + 'px');
    el.style.setProperty('--fx', fallenPos[k].x + 'px');
    el.style.setProperty('--fr', fallenPos[k].r + 'deg');
    el.style.setProperty('--fd', (k * 40) + 'ms');
    el.style.zIndex = String(10 + k);
    el.classList.add('falling');
  });
  playFx('flip');
  setTimeout(() => {
    cascading = false;
    gridFallen = true;
    applyFallen(false);   // CSS 애니메이션 → 인라인 transform으로 고정(이후 드래그 가능)
    wrap.classList.add('fallen');
    $('#grid-hint').textContent = '사진을 끌어 옮기거나, 위 「정리하기」를 눌러요';
    $('#grid-fallen-ctrl').classList.remove('hidden');
  }, 900);
}
/** fallenPos를 인라인 transform으로 적용 (smooth=true면 부드럽게 이동) */
function applyFallen(smooth) {
  $$('#grid-wrap .grid-item').forEach((el, k) => {
    el.classList.remove('falling');
    el.style.animation = 'none';
    el.style.transition = smooth ? 'transform .5s cubic-bezier(.2,.7,.3,1)' : 'none';
    const p = fallenPos[k] || { x: 0, y: 0, r: 0 };
    el.style.transform = `translate(${p.x}px, ${p.y}px) rotate(${p.r}deg)`;
  });
}
/** 쌓인/옮긴 사진을 원래대로 */
function restoreGrid() {
  gridFallen = false;
  gridJiggle = false;
  fallenPos = []; natRect = [];
  $('#grid-wrap').classList.remove('fallen');
  $$('#grid-wrap .grid-item').forEach((el) => { el.style.transition = ''; el.style.animation = ''; el.style.transform = ''; el.style.zIndex = ''; });
  renderGrid();
  $('#grid-hint').textContent = '길게 눌러 편집 · 위아래로 쓸면 와르르';
  $('#grid-fallen-ctrl').classList.add('hidden');
}
/** 그리드 제스처: 길게 누르면 편집 토글 · 편집 중 위아래로 쓸면 와르르 · 쌓인 뒤 개별 드래그 */
function bindGrid() {
  const gw = $('#grid-wrap');
  let lpTimer = 0, startY = 0, startX = 0, suppressClick = false;
  let dragK = -1, dragSX = 0, dragSY = 0, dragBX = 0, dragBY = 0, dragEl = null;

  gw.addEventListener('pointerdown', (e) => {
    startY = e.clientY; startX = e.clientX;
    clearTimeout(lpTimer);
    if (gridFallen) {
      const it = e.target.closest('.grid-item');
      if (it) {
        // 쌓인/흩어진 사진을 손으로 끌어 정리
        dragK = Number(it.dataset.k); dragEl = it;
        dragSX = e.clientX; dragSY = e.clientY;
        const p = fallenPos[dragK] || { x: 0, y: 0, r: 0 };
        dragBX = p.x; dragBY = p.y;
        it.style.transition = 'none'; it.style.zIndex = '999';
        it.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      // 빈 곳 길게 누르면 원래대로
      lpTimer = setTimeout(() => { restoreGrid(); suppressClick = true; }, 450);
      return;
    }
    lpTimer = setTimeout(() => { setJiggle(); suppressClick = true; }, 450);
  });

  gw.addEventListener('pointermove', (e) => {
    if (dragK >= 0) {
      const p = fallenPos[dragK];
      p.x = dragBX + (e.clientX - dragSX);
      p.y = dragBY + (e.clientY - dragSY);
      dragEl.style.transform = `translate(${p.x}px, ${p.y}px) rotate(${p.r}deg)`;
      return;
    }
    if (Math.abs(e.clientY - startY) > 12) clearTimeout(lpTimer);
    if (gridJiggle && !gridFallen && Math.abs(e.clientY - startY) > 45) cascadeGrid();
  });

  gw.addEventListener('touchmove', (e) => {
    if (dragK >= 0 || gridFallen) { e.preventDefault(); return; }
    if (gridJiggle) {
      const y = e.touches[0].clientY;
      if (Math.abs(y - startY) > 45) cascadeGrid();
      e.preventDefault();
    }
  }, { passive: false });

  const end = () => { clearTimeout(lpTimer); if (dragK >= 0) { suppressClick = true; dragK = -1; dragEl = null; } };
  gw.addEventListener('pointerup', end);
  gw.addEventListener('pointercancel', end);

  gw.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const it = e.target.closest('.grid-item');
    if (!it) return;
    if (gridJiggle || gridFallen) return;
    jumpToEntry(Number(it.dataset.idx));
  });
}

/* ==================== 기분 통계 ==================== */
const MOODS = ['설렘', '행복', '평온', '그저그럼', '지침', '울적', '속상'];
const MOOD_COLOR = {
  설렘: '#e0a13c', 행복: '#57b98c', 평온: '#7fae7f', 그저그럼: '#b3aa99',
  지침: '#c9895a', 울적: '#7a86b0', 속상: '#c05b5b',
};
let statsYM = '';
function shiftStatsMonth(d) {
  const [y, m] = statsYM.split('-').map(Number);
  const nd = new Date(y, m - 1 + d, 1);
  statsYM = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}`;
  renderMoodStats();
}
function renderMoodStats() {
  if (!statsYM) statsYM = todayStr().slice(0, 7);
  const [y, m] = statsYM.split('-').map(Number);
  $('#stats-title').textContent = `${y}년 ${m}월`;
  const monthEntries = entries.filter((e) => e.date.startsWith(statsYM));
  const counts = {}; MOODS.forEach((k) => (counts[k] = 0));
  let withMood = 0;
  monthEntries.forEach((e) => { if (e.mood && counts[e.mood] !== undefined) { counts[e.mood]++; withMood++; } });
  const max = Math.max(1, ...MOODS.map((k) => counts[k]));
  // 기분 막대 = 누르면 그 기분 일기 모아보기 (버튼)
  $('#mood-chart').innerHTML = MOODS.map((k) => `
    <button class="mood-bar-row" data-mood="${k}" ${counts[k] ? '' : 'disabled'}>
      <span class="mood-name">${moodLabel(k)}</span>
      <div class="mood-track"><div class="mood-fill" style="width:${Math.round(counts[k] / max * 100)}%;background:${MOOD_COLOR[k]}"></div></div>
      <span class="mood-cnt">${counts[k]}</span>
    </button>`).join('');
  if (!withMood) {
    $('#stats-summary').textContent = '이 달엔 기분을 기록한 날이 아직 없어요.';
    $('#stats-note').textContent = '기록할 때 오늘의 기분을 함께 골라보세요.';
    $('#mood-card').className = 'mood-card';
    $('#mood-card').innerHTML = '';
  } else {
    const top = MOODS.reduce((a, b) => (counts[b] > counts[a] ? b : a));
    $('#stats-summary').textContent = `이번 달 가장 많이 느낀 기분은 「${moodLabel(top)}」이에요.`;
    $('#stats-note').textContent = `기분을 남긴 날 ${withMood}일 · 이 달 기록 ${monthEntries.length}개`;
    const card = MOOD_CARD[top];
    if (card) {
      $('#mood-card').className = 'mood-card show kind-' + card.kind;
      $('#mood-card').innerHTML = `<span class="mood-card-tag">${card.kind}</span><p>${card.msg}</p>`;
    }
  }
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
  // 선택 날짜 기본값 — 보고 있는 달의 오늘(있으면) 또는 가장 최근 기록일
  if (!selDate || selDate.slice(0, 7) !== calYM) {
    if (today.slice(0, 7) === calYM && firstIdxByDay.has(today)) selDate = today;
    else {
      const withDays = Array.from(firstIdxByDay.keys()).sort();
      selDate = withDays.length ? withDays[withDays.length - 1] : '';
    }
  }
  const evDays = eventDaysInMonth(calYM);
  let html = DOW.map((d) => `<span class="cal-dow">${d}</span>`).join('');
  for (let i = 0; i < startDow; i++) html += '<span></span>';
  for (let d = 1; d <= days; d++) {
    const ds = `${calYM}-${String(d).padStart(2, '0')}`;
    const idx = firstIdxByDay.get(ds);
    const isToday = ds === today;
    const isFuture = ds > today;
    const evDot = evDays.has(ds) ? '<i class="ev-dot"></i>' : '';
    const cls = (isToday ? ' today' : '') + (ds === selDate ? ' sel' : '');
    if (idx !== undefined) {
      // 기록 있는 날 — 대표 사진이 있으면 썸네일 셀, 없으면(글만) 점 셀
      const cov = coverEntry(ds);
      if (cov && cov.thumb) {
        html += `<button class="cal-day has thumb${cls}" data-date="${ds}" style="background-image:url('${cov.thumb}')"><span class="cal-num">${d}</span>${evDot}</button>`;
      } else {
        html += `<button class="cal-day has${cls}" data-date="${ds}">${d}<i></i>${evDot}</button>`;
      }
    } else if (isFuture) {
      // 미래라도 일정이 있으면 눌러서 볼 수 있게
      html += `<button class="cal-day future${cls}" data-date="${ds}">${d}${evDot}</button>`;
    } else {
      html += `<button class="cal-day empty${cls}" data-date="${ds}">${d}${evDot}</button>`;
    }
  }
  $('#cal-grid').innerHTML = html;
  renderUpcoming();
  renderCalEntryList();
}
/** 다가오는 일정 배너 (오늘/내일/그 다음) */
function renderUpcoming() {
  const wrap = $('#upcoming');
  if (!wrap) return;
  const list = upcomingEvents(3);
  if (!list.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  const today = todayStr();
  wrap.classList.remove('hidden');
  wrap.innerHTML = list.map(({ ev, when }) => {
    const dd = ddayLabel(today, when);
    const w = parseDate(when);
    return `<button class="up-item" data-date="${when}">
      <span class="up-dday">${dd}</span>
      <span class="up-title">${escapeHTML(ev.title)}${ev.type === 'anniv' ? ' (기념일)' : ''}</span>
      <span class="up-date">${w.getMonth() + 1}.${w.getDate()}</span>
    </button>`;
  }).join('');
}

/* 일정 추가 모달 */
let eventModalDate = '';
let eventModalType = 'plan';
function openEventModal(date) {
  eventModalDate = date || selDate || todayStr();
  eventModalType = 'plan';
  const d = parseDate(eventModalDate);
  $('#event-modal-date').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 · 일정·기념일 추가`;
  $('#event-title').value = '';
  $('#event-yearly').checked = false;
  $$('#event-type-row .chip').forEach((b) => b.classList.toggle('on', b.dataset.type === 'plan'));
  $('#event-yearly-row').classList.add('hidden');
  $('#event-modal').classList.add('on');
  setTimeout(() => $('#event-title').focus(), 40);
}
function closeEventModal() { $('#event-modal').classList.remove('on'); }
function confirmEvent() {
  const title = $('#event-title').value.trim();
  if (!title) { toast('일정 이름을 입력해 주세요.'); return; }
  const yearly = eventModalType === 'anniv' && $('#event-yearly').checked;
  addEvent(eventModalDate, title, eventModalType, yearly);
  closeEventModal();
  selDate = eventModalDate; calYM = eventModalDate.slice(0, 7);
  renderCal();
  toast(eventModalType === 'anniv' ? '기념일을 저장했어요.' : '일정을 저장했어요.');
}

/** 선택한 날짜의 일정·기념일 섹션 HTML */
function eventsSectionHTML() {
  const evs = eventsOnDate(selDate);
  const today = todayStr();
  const rows = evs.length
    ? evs.map((ev) => {
        const dd = selDate >= today ? `<span class="ev-dday">${ddayLabel(today, selDate)}</span>` : '';
        return `<div class="ev-item">
          <span class="ev-type ${ev.type === 'anniv' ? 'anniv' : ''}">${ev.type === 'anniv' ? '기념일' : '일정'}${ev.yearly ? '·매년' : ''}</span>
          <b>${escapeHTML(ev.title)}</b>${dd}
          <button class="ev-del" data-ev="${ev.id}" aria-label="일정 삭제">삭제</button>
        </div>`;
      }).join('')
    : '<p class="ev-empty">이 날의 일정·기념일이 없어요.</p>';
  return `<div class="cal-events">
    <div class="cal-events-head"><b>일정·기념일</b><button class="tbtn sm" id="ev-add">＋ 추가</button></div>
    ${rows}
  </div>`;
}
/** 달력 아래 — 선택한 날짜의 일정 + 일기를 크게 보고 바로 수정 */
function renderCalEntryList() {
  const wrap = $('#cal-entry-list');
  if (!selDate) { wrap.innerHTML = '<p class="empty-note sm">날짜를 눌러 그날의 일기·일정을 보세요.</p>'; return; }
  const list = entries.filter((e) => e.date === selDate).sort((a, b) => b.ts - a.ts);
  const d = parseDate(selDate);
  const head = `<p class="entry-list-head">${d.getMonth() + 1}월 ${d.getDate()}일 ${DOW[d.getDay()]}요일 · ${list.length}개</p>`;
  const events = eventsSectionHTML();
  if (!list.length) {
    wrap.innerHTML = head + events + `<div class="be-empty"><p class="empty-note sm">이 날엔 아직 기록이 없어요.</p><button class="tbtn primary" id="be-add">이 날 채우기</button></div>`;
    return;
  }
  wrap.innerHTML = head + events + list.map(bigEntryHTML).join('');
  sizePageStickers();
}
/** 특정 기록으로 이동 = 달력에서 그 날짜를 열고 카드로 스크롤 */
function jumpToEntry(idx) {
  const e = entries[idx];
  if (!e) return;
  selDate = e.date;
  calYM = e.date.slice(0, 7);
  playFx('flip');
  show('scr-cal');
  setTimeout(() => { const el = $(`#big-${e.id}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
}

/* ==================== 설정 ==================== */
function renderDecoChips() {
  const fc = getFrame(), tc = getTape();
  $('#frame-chips').innerHTML = FRAME_COLORS.map((f) =>
    `<button class="chip swatch ${f.k === fc ? 'on' : ''}" data-frame="${f.k}"><span class="sw-dot" style="background:${f.c};border:1px solid rgba(0,0,0,.15)"></span>${f.label}</button>`).join('');
  $('#tape-chips').innerHTML = TAPE_COLORS.map((t) =>
    `<button class="chip swatch ${t.k === tc ? 'on' : ''}" data-tape="${t.k}"><span class="sw-dot" style="background:${t.c}"></span>${t.label}</button>`).join('');
}
function renderStats() {
  const photos = entries.filter((e) => e.kind === 'photo').length;
  const clips = entries.filter((e) => e.kind === 'video').length;
  $('#set-stats').textContent =
    `지금까지 순간 ${entries.length}개 (사진 ${photos} · 영상 ${clips} · 글 ${entries.length - photos - clips})`;
  renderDiaryList();
  renderTopicChips();
  renderMembers();
  renderDecoChips();
}
/** 설정: 일기장 목록 (현재 쓰는 일기장 표시 + 이름/삭제) */
function renderDiaryList() {
  const wrap = $('#diary-list'); if (!wrap) return;
  const active = activeDiaryId();
  const many = loadDiaries().length > 1;
  wrap.innerHTML = loadDiaries().map((d) => {
    const info = allTopics().find((t) => t.k === d.topic);
    const coverBtn = d.cover
      ? `<button class="tbtn diary-cover" data-cover="${d.id}">표지 바꾸기</button><button class="tbtn diary-cover-clear" data-coverclear="${d.id}">표지 없애기</button>`
      : `<button class="tbtn diary-cover" data-cover="${d.id}">표지 사진</button>`;
    return `<div class="diary-item ${d.id === active ? 'cur' : ''}">
      <div class="diary-row1">
        <button class="diary-open" data-open="${d.id}">
          ${d.cover ? `<span class="diary-cover-thumb" style="background-image:url('${d.cover}')"></span>` : ''}
          <span class="diary-open-txt"><b>${escapeHTML(d.name)}</b><span>${escapeHTML(info ? info.label : '')}${d.id === active ? ' · 쓰는 중' : ''}</span></span>
        </button>
      </div>
      <div class="diary-row2">
        <button class="tbtn diary-rename" data-rn="${d.id}">이름</button>
        ${coverBtn}
        ${many ? `<button class="tbtn danger" data-del="${d.id}">삭제</button>` : ''}
      </div>
    </div>`;
  }).join('') || '<p class="empty-note sm">아직 일기장이 없어요. 아래에서 새로 만들어 보세요.</p>';
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
  vlogURLCache.forEach((u) => URL.revokeObjectURL(u));
  vlogURLCache.clear();
  entries = [];
  vlogs = [];

  await initDB();
  saveDiaries([]);            // 일기장 목록도 초기화
  setActiveDiaryId('');
  toast('모든 기록을 지웠어요. 새 마음으로 시작해요.');
  show('scr-cover');
  maybeOnboard();            // 첫 일기장부터 다시
}

/* ==================== 주제 / 온보딩 (새 일기장 만들기) ==================== */
/** 새 일기장 만들기 창 열기 — 첫 실행 + 책장의 '＋'에서 공용 */
function openNewDiary() {
  obPick = '';
  $('#onboard-topics').innerHTML = allTopics().map((t) => `<button class="chip" data-k="${t.k}">${escapeHTML(t.label)}</button>`).join('');
  const nameInput = $('#onboard-name'); if (nameInput) nameInput.value = '';
  $('#onboard-start').disabled = true;
  $('#onboard-cancel').classList.toggle('hidden', !loadDiaries().length); // 첫 일기장은 취소 불가
  $('#onboard').classList.add('on');
}
function maybeOnboard() {
  if (loadDiaries().length) { $('#onboard').classList.remove('on'); return; }
  openNewDiary();
}
function renderTopicChips() {
  const cur = getTopic();
  $('#topic-chips').innerHTML = allTopics().map((t) =>
    `<button class="chip ${t.k === cur ? 'on' : ''}${t.custom ? ' custom' : ''}" data-k="${t.k}">${escapeHTML(t.label)}${t.custom ? '<i class="chip-del" data-del="' + t.k + '">✕</i>' : ''}</button>`).join('');
}

/* ==================== 함께 쓰기 (작성자) ==================== */
function renderAuthorChips() {
  const members = loadMembers();
  const row = $('#author-row');
  if (members.length < 2) { row.classList.add('hidden'); activeAuthor = members[0] ? members[0].id : ''; return; }
  row.classList.remove('hidden');
  if (!members.some((m) => m.id === activeAuthor)) activeAuthor = members[0].id;
  $('#author-chips').innerHTML = members.map((m) =>
    `<button class="mchip author-chip ${m.id === activeAuthor ? 'on' : ''}" data-id="${m.id}" style="--mc:${m.color}">${escapeHTML(m.name)}</button>`).join('');
}
function renderMembers() {
  const members = loadMembers();
  $('#member-list').innerHTML = members.map((m) => `
    <div class="member-item">
      <span class="member-dot" style="background:${m.color}"></span>
      <b>${escapeHTML(m.name)}</b>
      ${m.id === 'me' ? '<span class="member-me">기본</span>' : `<button class="tbtn danger member-del" data-id="${m.id}">삭제</button>`}
    </div>`).join('');
}
function addMember(name) {
  name = (name || '').trim();
  if (!name) { toast('이름을 입력해 주세요.'); return; }
  const members = loadMembers();
  if (members.length >= 6) { toast('작성자는 최대 6명까지예요.'); return; }
  const used = members.map((m) => m.color);
  const color = MEMBER_COLORS.find((c) => !used.includes(c)) || MEMBER_COLORS[members.length % MEMBER_COLORS.length];
  members.push({ id: uid(), name, color });
  saveMembers(members);
  renderMembers();
  toast(`${name} 님을 함께 쓰기에 추가했어요.`);
}
function removeMember(id) {
  saveMembers(loadMembers().filter((m) => m.id !== id));
  renderMembers();
}
function authorTag(e) {
  if (loadMembers().length < 2 || !e.author) return '';
  const m = memberById(e.author);
  return m ? m.name : '';
}

/* ==================== 교환일기 (내보내기 / 가져오기) ==================== */
function blobToDataURL(blob) {
  return new Promise((resolve) => { const f = new FileReader(); f.onload = () => resolve(f.result); f.readAsDataURL(blob); });
}
async function exportDiary() {
  toast('내보낼 파일을 준비하고 있어요…');
  const outEntries = await Promise.all(entries.map(async (e) => {
    const { blob, ...rest } = e;
    return { ...rest, media: blob ? await blobToDataURL(blob) : null };
  }));
  const data = { app: 'moment-diary', v: 1, topic: getTopic(), customTopics: loadCustomTopics(), members: loadMembers(), covers: loadCovers(), entries: outEntries };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '순간일기_내보내기.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  toast('일기를 파일로 내보냈어요. 상대에게 전달해 주세요.');
}
async function importDiary(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== 'moment-diary' || !Array.isArray(data.entries)) throw new Error('bad-file');
    const existing = new Set(entries.map((e) => e.id));
    let added = 0;
    for (const e of data.entries) {
      if (existing.has(e.id)) continue;
      const media = e.media;
      const blob = media ? await (await fetch(media)).blob() : null;
      const entry = { ...e, blob, diaryId: activeDiaryId() }; delete entry.media;
      await dbPut(entry); entries.push(entry); existing.add(e.id); added++;
    }
    // 멤버 합치기
    const mine = loadMembers(); const ids = new Set(mine.map((m) => m.id));
    (data.members || []).forEach((m) => { if (!ids.has(m.id)) { mine.push(m); ids.add(m.id); } });
    saveMembers(mine);
    // 사용자 주제 합치기 (없는 것만 추가)
    const ct = loadCustomTopics(); const ctk = new Set(ct.map((t) => t.k));
    (data.customTopics || []).forEach((t) => { if (!ctk.has(t.k)) { ct.push(t); ctk.add(t.k); } });
    saveCustomTopics(ct);
    // 대표사진 합치기 (내 것 우선)
    const cov = loadCovers();
    Object.entries(data.covers || {}).forEach(([d, id]) => { if (!cov[d]) cov[d] = id; });
    saveCovers(cov);
    sortEntries();
    renderShelf();
    toast(added ? `${added}개의 일기를 가져와 합쳤어요.` : '새로 합칠 일기가 없었어요(이미 있는 기록).');
    return added;
  } catch (err) {
    toast('가져오기에 실패했어요. 올바른 내보내기 파일인지 확인해 주세요.');
    return 0;
  }
}

/* ==================== 기록 알림 ==================== */
function remindOn() { return localStorage.getItem(LS_PREFIX + 'remindOn') === '1'; }
function remindTime() { return localStorage.getItem(LS_PREFIX + 'remindTime') || '21:00'; }
function hasEntryToday() { return entries.some((e) => e.date === todayStr()); }

function showReminderBanner() {
  if (hasEntryToday()) return;
  $('#reminder-banner').classList.add('on');
  // 시스템 알림도 가능하면 함께
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('순간일기', { body: '오늘의 순간, 아직 안 남기셨어요. 지금 한 줄 어때요?', icon: 'icon-192.png' });
    }
  } catch (e) {}
}
/** 다음 알림 시각까지 타이머를 건다 (앱이 열려 있는 동안 동작) */
function scheduleReminder() {
  if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = 0; }
  if (!remindOn()) return;
  const [hh, mm] = remindTime().split(':').map(Number);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1); // 오늘 시간이 지났으면 내일
  const ms = Math.min(next - now, 2 ** 31 - 1);
  reminderTimer = setTimeout(() => {
    showReminderBanner();
    scheduleReminder(); // 다음 날 재예약
  }, ms);
}
async function toggleReminder(on) {
  localStorage.setItem(LS_PREFIX + 'remindOn', on ? '1' : '0');
  if (on && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch (e) {}
  }
  scheduleReminder();
  toast(on ? `매일 ${remindTime()}에 기록을 알려드릴게요.` : '기록 알림을 껐어요.');
}

/* ==================== 이벤트 바인딩 ==================== */
function bind() {
  // 책장(표지): 일기장 열기 / 새 일기장. 제목 클릭 → 책장으로
  $('#shelf').addEventListener('click', (e) => {
    if (e.target.closest('#shelf-add')) { openNewDiary(); return; }
    const tile = e.target.closest('.book-tile');
    if (tile && tile.dataset.id) openDiary(tile.dataset.id);
  });
  $('#cal-home-title').onclick = () => show('scr-cover');

  // 하단 탭 (모아보기 탭은 기분 필터 해제하고 전체)
  $$('#bottomnav .navbtn').forEach((b) => {
    b.onclick = () => { if (b.dataset.scr === 'scr-grid') gridFilterMood = ''; show(b.dataset.scr); };
  });
  // 플로팅 기록 버튼
  $('#fab').onclick = () => openCaptureFor(todayStr());

  // 달력
  $('#cal-prev').onclick = () => shiftCalMonth(-1);
  $('#cal-next').onclick = () => shiftCalMonth(1);
  $('#cal-grid').addEventListener('click', (e) => {
    const day = e.target.closest('.cal-day');
    if (!day || !day.dataset.date) return;
    if (day.classList.contains('empty')) {
      openCaptureFor(day.dataset.date); // 빈 과거·오늘 → 그날 채우기
    } else {
      // 기록 있는 날 / 미래(일정 확인·추가) → 선택해서 아래에 표시
      selDate = day.dataset.date;
      renderCal();
    }
  });
  // 다가오는 일정 배너 → 그 날짜로 이동
  $('#upcoming').addEventListener('click', (e) => {
    const it = e.target.closest('.up-item');
    if (it) { selDate = it.dataset.date; calYM = it.dataset.date.slice(0, 7); renderCal(); }
  });
  // 달력 아래 (선택 날짜) — 일정 추가·삭제 + 크게보기 카드(사진/글 수정·대표선택·삭제)
  $('#cal-entry-list').addEventListener('click', (e) => {
    const editp = e.target.closest('.be-editphoto');
    const del = e.target.closest('.be-del');
    const add = e.target.closest('#be-add');
    const evAdd = e.target.closest('#ev-add');
    const evDel = e.target.closest('.ev-del');
    if (evAdd) openEventModal(selDate);
    else if (evDel) { removeEvent(evDel.dataset.ev); renderCal(); toast('일정을 지웠어요.'); }
    else if (editp) openEditEntry(editp.dataset.id);
    else if (del) deleteEntryUI(del.dataset.id);
    else if (add) openCaptureFor(selDate);
  });
  // 일정 추가 모달
  $('#event-type-row').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    eventModalType = b.dataset.type;
    $$('#event-type-row .chip').forEach((x) => x.classList.toggle('on', x === b));
    const anniv = eventModalType === 'anniv';
    $('#event-yearly-row').classList.toggle('hidden', !anniv);
    $('#event-yearly').checked = anniv; // 기념일은 매년 반복 기본 켬
  });
  $('#event-add').onclick = confirmEvent;
  $('#event-cancel').onclick = closeEventModal;
  $('#event-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmEvent(); });
  $('#event-modal').addEventListener('click', (e) => { if (e.target.id === 'event-modal') closeEventModal(); });
  $('#cal-entry-list').addEventListener('change', (e) => {
    const chk = e.target.closest('.cover-chk');
    if (chk) {
      if (chk.checked) { setCover(chk.dataset.date, chk.dataset.id); toast('이 사진을 달력 대표로 정했어요.'); }
      else { const m = loadCovers(); delete m[chk.dataset.date]; saveCovers(m); }
      renderCal();
    }
  });
  // 메모 즉시 수정 (칸을 벗어나면 저장)
  $('#cal-entry-list').addEventListener('focusout', (e) => {
    const ta = e.target.closest('.be-text');
    if (!ta) return;
    const en = entries.find((x) => x.id === ta.dataset.id);
    if (en && en.text !== ta.value) { en.text = ta.value; dbPut(en); }
  });

  // 기분 통계 — 월 이동 + 기분 눌러 모아보기
  $('#stats-prev').onclick = () => shiftStatsMonth(-1);
  $('#stats-next').onclick = () => shiftStatsMonth(1);
  $('#mood-chart').addEventListener('click', (e) => {
    const row = e.target.closest('.mood-bar-row');
    if (row && !row.disabled) openMoodCollection(row.dataset.mood);
  });

  // 모아보기 (그리드) — 롱프레스 흔들림 + 위아래 스와이프 와르르, 기분 필터 해제
  bindGrid();
  $('#grid-filter-clear').onclick = () => { gridFilterMood = ''; renderGrid(); };
  $('#btn-tidy').onclick = restoreGrid;

  // 브이로그 보관함 — 타일 누르면 큰 화면 뷰어
  $('#btn-new-vlog').onclick = () => openSub('scr-vlog');
  $('#vloglib-wrap').addEventListener('click', (e) => {
    const tile = e.target.closest('.vlog-tile');
    if (tile) openVlogViewer(tile.dataset.id);
  });
  // 브이로그 뷰어(큰 화면): 저장 / 삭제 / 닫기
  $('#vlog-viewer-dl').onclick = () => { if (viewerVlogId) downloadVlogRec(viewerVlogId); };
  $('#vlog-viewer-del').onclick = async () => {
    const id = viewerVlogId;
    if (!id) return;
    closeVlogViewer();
    await deleteVlog(id);
  };
  $('#vlog-viewer-close').onclick = closeVlogViewer;
  $('#vlog-viewer').addEventListener('click', (e) => { if (e.target.id === 'vlog-viewer') closeVlogViewer(); });

  // 하위 화면 돌아가기 (수정 취소 포함)
  $('#btn-cap-back').onclick = () => { editId = null; $('#cap-edit-banner').classList.add('hidden'); show(backTo); };
  $('#btn-vlog-back').onclick = () => show(backTo);

  // 필터 / 촬영 모드 / 날씨 / 기분
  $$('#filter-row .chip').forEach((b) => {
    b.onclick = () => {
      $$('#filter-row .chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      camFilter = b.dataset.filter;
      // 이미 찍은/가져온 사진이면 필터를 즉시 다시 적용 (갤러리 사진도 필터 반영)
      if (captured && captured.kind === 'photo' && captured.srcCanvas) {
        captured.filter = camFilter;
        renderCapturedPhoto();
      }
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
  singlePick('.mchip:not(.author-chip)');

  // 작성자 선택
  $('#author-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.author-chip');
    if (!b) return;
    activeAuthor = b.dataset.id;
    $$('#author-chips .author-chip').forEach((x) => x.classList.toggle('on', x === b));
  });

  // 온보딩 / 새 일기장 만들기 (주제 선택 → 이름 → 만들기)
  $('#onboard-topics').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    obPick = b.dataset.k;
    $$('#onboard-topics .chip').forEach((x) => x.classList.toggle('on', x === b));
    $('#onboard-start').disabled = false;
  });
  $('#onboard-start').onclick = () => {
    if (!obPick) return;
    const name = ($('#onboard-name') ? $('#onboard-name').value : '').trim();
    const id = addDiary(name, obPick);
    $('#onboard').classList.remove('on');
    openDiary(id);
    toast('새 일기장을 만들었어요.');
  };
  $('#onboard-cancel').onclick = () => { $('#onboard').classList.remove('on'); };
  // 온보딩: 직접 주제 만들기 → 그 주제를 선택 상태로
  const onboardCreate = () => {
    const name = $('#onboard-custom-name').value.trim();
    if (!name) { toast('주제 이름을 입력해 주세요.'); return; }
    obPick = addCustomTopic(name);
    $('#onboard-custom-name').value = '';
    $('#onboard-topics').innerHTML = allTopics().map((t) =>
      `<button class="chip ${t.k === obPick ? 'on' : ''}" data-k="${t.k}">${escapeHTML(t.label)}</button>`).join('');
    $('#onboard-start').disabled = false;
  };
  $('#onboard-custom-add').onclick = onboardCreate;
  $('#onboard-custom-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') onboardCreate(); });

  // 설정: 주제 변경 / 사용자 주제 삭제
  $('#topic-chips').addEventListener('click', (e) => {
    const del = e.target.closest('.chip-del');
    if (del) { e.stopPropagation(); removeCustomTopic(del.dataset.del); renderTopicChips(); renderShelf(); return; }
    const b = e.target.closest('.chip');
    if (!b) return;
    setTopic(b.dataset.k);
    renderTopicChips();
    renderShelf();
    toast('일기장 주제를 바꿨어요.');
  });
  const addTopicUI = () => {
    const name = $('#custom-topic-name').value.trim();
    if (!name) { toast('주제 이름을 입력해 주세요.'); return; }
    setTopic(addCustomTopic(name));
    $('#custom-topic-name').value = '';
    renderTopicChips();
    renderShelf();
    toast(`'${name}' 주제를 만들었어요.`);
  };
  $('#btn-add-topic').onclick = addTopicUI;
  $('#custom-topic-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTopicUI(); });

  // 설정: 일기장 관리 (열기 / 이름 바꾸기 / 삭제 / 새로 만들기)
  $('#btn-new-diary').onclick = () => openNewDiary();
  $('#diary-cover-input').onchange = async (e) => {
    const file = e.target.files[0];
    if (file && coverTargetId) await setDiaryCover(coverTargetId, file);
    e.target.value = ''; coverTargetId = '';
  };
  $('#diary-list').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    const rn = e.target.closest('[data-rn]');
    const save = e.target.closest('[data-save]');
    const del = e.target.closest('[data-del]');
    const cover = e.target.closest('[data-cover]');
    const coverClear = e.target.closest('[data-coverclear]');
    if (cover) { coverTargetId = cover.dataset.cover; $('#diary-cover-input').click(); return; }
    if (coverClear) { clearDiaryCover(coverClear.dataset.coverclear); return; }
    if (open) { openDiary(open.dataset.open); return; }
    if (rn) {
      const item = rn.closest('.diary-item');
      const d = loadDiaries().find((x) => x.id === rn.dataset.rn);
      if (!d || !item) return;
      item.innerHTML = `<input type="text" class="diary-name-input" maxlength="20" value="${escapeHTML(d.name)}">
        <button class="tbtn primary diary-save" data-save="${d.id}">저장</button>`;
      const inp = item.querySelector('.diary-name-input'); if (inp) { inp.focus(); inp.select(); }
      return;
    }
    if (save) {
      const inp = save.closest('.diary-item').querySelector('.diary-name-input');
      renameDiary(save.dataset.save, inp ? inp.value : '');
      renderDiaryList();
      return;
    }
    if (del) {
      const d = loadDiaries().find((x) => x.id === del.dataset.del);
      const ok = await confirmModal(`'${d ? d.name : ''}' 일기장을 지울까요? 이 일기장의 사진·영상·글이 모두 사라져요.`);
      if (!ok) return;
      const wasActive = activeDiaryId() === del.dataset.del;
      await removeDiary(del.dataset.del);
      if (wasActive) {
        const first = loadDiaries()[0];
        if (first) { setActiveDiaryId(first.id); entries = (await dbAll()).filter((x) => x.diaryId === first.id); sortEntries(); }
        else { setActiveDiaryId(''); entries = []; }
      }
      renderStats();
      toast('일기장을 지웠어요.');
    }
  });
  $('#diary-list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const save = e.target.closest('.diary-name-input'); if (save) { const btn = e.target.closest('.diary-item').querySelector('.diary-save'); if (btn) btn.click(); } }
  });

  // 설정: 사진 꾸미기 (프레임/테이프 색)
  $('#frame-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-frame]'); if (!b) return;
    localStorage.setItem(LS_PREFIX + 'frame', b.dataset.frame);
    applyDecoVars(); renderDecoChips();
  });
  $('#tape-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tape]'); if (!b) return;
    localStorage.setItem(LS_PREFIX + 'tape', b.dataset.tape);
    applyDecoVars(); renderDecoChips();
  });
  // 설정: 함께 쓰기(멤버)
  $('#btn-add-member').onclick = () => { addMember($('#member-name').value); $('#member-name').value = ''; };
  $('#member-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { addMember($('#member-name').value); $('#member-name').value = ''; } });
  $('#member-list').addEventListener('click', (e) => {
    const del = e.target.closest('.member-del');
    if (del) removeMember(del.dataset.id);
  });
  // 설정: 교환(내보내기/가져오기)
  $('#btn-export').onclick = exportDiary;
  $('#btn-import').onclick = () => $('#import-input').click();
  $('#import-input').onchange = async (e) => {
    const file = e.target.files[0];
    await importDiary(file);
    e.target.value = '';
    renderStats();
  };

  $('#btn-shutter').onclick = shutter;
  $('#btn-retake').onclick = retake;
  $('#btn-mic').onclick = () => { playFx('mic'); toggleSpeech(); };
  $('#btn-save-entry').onclick = saveEntry;
  $('#btn-make-vlog').onclick = makeVlogUI;
  $('#btn-vlog-keep').onclick = saveVlogToLib;
  $('#btn-vlog-save').onclick = downloadVlog;
  $('#btn-wipe').onclick = wipeAll;

  // 사진 크기 조절 (버튼 + 핀치)
  const setScale = (mul) => { fitState.scale = Math.min(4, Math.max(0.3, fitState.scale * mul)); applyFitPreview(); };
  $('#fit-in').onclick = () => setScale(1.15);
  $('#fit-out').onclick = () => setScale(1 / 1.15);
  $('#fit-reset').onclick = () => { fitState = { scale: 1, x: 0, y: 0 }; applyFitPreview(); };
  bindPhotoPinch();

  // 갤러리에서 가져오기 (지난 날 채우기)
  $('#btn-gallery').onclick = () => $('#gallery-input').click();
  $('#gallery-input').onchange = (e) => {
    const file = e.target.files[0];
    importFromGallery(file);
    e.target.value = ''; // 같은 파일 다시 고를 수 있게
  };

  // 전체 버튼 효과음 (비눗방울) — 자체 사운드가 따로 있는 버튼은 제외
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'btn-shutter' || b.id === 'btn-mic') return; // 고유 소리
    if (b.closest('#sticker-layer')) return;
    playFx('bubble');
  }, true);

  // 알림 배너
  $('#reminder-go').onclick = () => { $('#reminder-banner').classList.remove('on'); openCaptureFor(todayStr()); };
  $('#reminder-dismiss').onclick = () => $('#reminder-banner').classList.remove('on');

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

  // 효과음 설정 (켜기/끄기 + 음량)
  const soundChk = $('#set-sound');
  soundChk.checked = soundOn();
  soundChk.onchange = () => {
    localStorage.setItem(LS_PREFIX + 'sound', soundChk.checked ? 'on' : 'off');
    if (soundChk.checked) playFx('bubble');
  };
  const vol = $('#set-volume');
  vol.value = Math.round(fxVolume() * 100);
  $('#volume-val').textContent = vol.value;
  vol.oninput = () => { $('#volume-val').textContent = vol.value; };
  vol.onchange = () => {
    localStorage.setItem(LS_PREFIX + 'volume', vol.value);
    playFx('bubble');
  };

  // 알림 설정
  const remindChk = $('#set-remind');
  const remindTimeInput = $('#set-remind-time');
  remindChk.checked = remindOn();
  remindTimeInput.value = remindTime();
  $('#remind-time-row').classList.toggle('hidden', !remindOn());
  remindChk.onchange = () => {
    $('#remind-time-row').classList.toggle('hidden', !remindChk.checked);
    toggleReminder(remindChk.checked);
  };
  remindTimeInput.onchange = () => {
    localStorage.setItem(LS_PREFIX + 'remindTime', remindTimeInput.value || '21:00');
    scheduleReminder();
    if (remindOn()) toast(`매일 ${remindTime()}에 알려드릴게요.`);
  };

  // 브이로그 마무리 한마디 — 저장된 값 불러오기
  const savedOutro = localStorage.getItem(LS_PREFIX + 'outro');
  $('#vlog-outro').value = savedOutro === null ? DEFAULT_OUTRO : savedOutro;

  window.addEventListener('resize', () => { sizePageStickers(); });
}

/* ==================== 초기화 ==================== */
async function init() {
  bind();
  await initDB();
  await migrateToDiaries();
  const active = activeDiaryId();
  entries = active ? (await dbAll()).filter((e) => e.diaryId === active) : [];
  sortEntries();
  await loadVlogs();
  applyDecoVars();
  show('scr-cover');   // 책장부터
  await renderShelf(); // 책장 렌더 완료 보장 (dbAll 비동기)
  maybeOnboard();      // 일기장이 하나도 없으면 첫 일기장 만들기 창
  scheduleReminder();
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
  show,
  saveEntry,
  deleteEntry: removeEntry, // 테스트용 — UI 확인 모달 없이 즉시 삭제
  openEditEntry,
  getFrame, getTape,
  setFrame: (k) => { localStorage.setItem(LS_PREFIX + 'frame', k); applyDecoVars(); },
  setTape: (k) => { localStorage.setItem(LS_PREFIX + 'tape', k); applyDecoVars(); },
  editText: async (id, text) => { const e = entries.find((x) => x.id === id); if (e) { e.text = text; await dbPut(e); } },

  buildVlog,
  speechSupported,
  camState: () => ({ hasStream: !!camStream, filter: camFilter, mode: camMode, recording, captured: (captured && (captured.blob || captured._work)) ? captured.kind : null }),
  // 사진 크기조절 훅
  getFit: () => ({ ...fitState }),
  setFit: (s, x, y) => { fitState = { scale: s, x: x || 0, y: y || 0 }; applyFitPreview(); },
  // 시드용: dataURL을 blob으로 바꿔 엔트리 저장
  async addEntry({ date, text = '', weather = '', mood = '', filter = 'none', kind = 'none', dataURL = null, stickers = [], durMs = 0, author = '' }) {
    let blob = null, thumb = null;
    if (dataURL) {
      blob = await (await fetch(dataURL)).blob();
      thumb = dataURL;
      if (kind === 'none') kind = 'photo';
    }
    const entry = { id: uid(), diaryId: activeDiaryId(), date: date || todayStr(), ts: Date.now(), kind, blob, thumb, filter, durMs, weather, mood, author, stickers, text };
    await dbPut(entry);
    entries.push(entry);
    sortEntries();
    return entry.id;
  },
  // 여러 일기장(책장) 훅
  getDiaries: loadDiaries, activeDiaryId, addDiary, renameDiary, removeDiary,
  // 표지 사진 (테스트: dataURL 직접 지정)
  setDiaryCoverData: (id, dataURL) => { const a = loadDiaries(); const d = a.find((x) => x.id === id); if (d) { d.cover = dataURL; saveDiaries(a); renderShelf(); renderDiaryList(); } },
  getDiaryCover: (id) => { const d = loadDiaries().find((x) => x.id === id); return d ? (d.cover || null) : null; },
  clearDiaryCover,
  // 일정·기념일
  getEvents: loadEvents, addEvent: (date, title, type, yearly) => { addEvent(date, title, type, yearly); if (curScreen === 'scr-cal') renderCal(); },
  removeEvent: (id) => { removeEvent(id); if (curScreen === 'scr-cal') renderCal(); },
  eventsOnDate, upcomingEvents, ddayLabel, openEventModal, nextOccurrence,
  // 브이로그 뷰어·확장자
  openVlogViewer, closeVlogViewer, viewerVlogId: () => viewerVlogId, extForType, pickMime,
  openDiary, renderShelf,
  ensureDiary: async (topic = 'daily', name = '') => {
    if (activeDiaryId() && loadDiaries().some((d) => d.id === activeDiaryId())) return activeDiaryId();
    if (localStorage.getItem(LS_PREFIX + 'diaries') === null) saveDiaries([]);
    const id = addDiary(name, topic);
    await openDiary(id);
    return id;
  },
  // 주제·멤버·교환 훅
  getTopic, setTopic: (k) => { setTopic(k); renderShelf(); },
  allTopics, addCustomTopic, loadCustomTopics,
  maybeOnboard, openNewDiary, onboardVisible: () => $('#onboard').classList.contains('on'),
  getMembers: loadMembers, addMember, setActiveAuthor: (id) => { activeAuthor = id; },
  exportData: async () => {
    const outEntries = await Promise.all(entries.map(async (e) => { const { blob, ...r } = e; return { ...r, media: blob ? await blobToDataURL(blob) : null }; }));
    return { app: 'moment-diary', v: 1, topic: getTopic(), customTopics: loadCustomTopics(), members: loadMembers(), covers: loadCovers(), entries: outEntries };
  },
  importData: async (obj) => importDiary(new Blob([JSON.stringify(obj)], { type: 'application/json' })),
  // 꾸미기·달력·소리 훅
  addSticker,
  getStickers: () => capStickers.slice(),
  goCalendar,
  jumpToEntry,
  openCaptureFor,
  getCaptureDate: () => captureDate,
  importFile: (file) => importFromGallery(file),
  setFilter: (f) => { camFilter = f; },
  bubbleSample: async () => {
    const oc = new OfflineAudioContext(1, 44100, 44100);
    playFx('bubble', oc, oc.destination);
    const b = await oc.startRendering(); const d = b.getChannelData(0);
    let s = 0; for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i]); return s / (d.length / 4);
  },
  fxSample: async (name) => {
    const oc = new OfflineAudioContext(1, 44100, 44100);
    playFx(name, oc, oc.destination);
    const b = await oc.startRendering(); const d = b.getChannelData(0);
    let s = 0; for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i]); return s / (d.length / 4);
  },
  reminder: { on: remindOn, time: remindTime, show: showReminderBanner, schedule: scheduleReminder },
  // 모아보기·통계·브이로그 보관함 훅
  setJiggle, isJiggling: () => gridJiggle, cascadeGrid, restoreGrid, isFallen: () => gridFallen,
  fallenPosOf: (k) => (fallenPos[k] ? { ...fallenPos[k] } : null),
  dragItemBy: (k, dx, dy) => { // 테스트용: k번째 사진을 (dx,dy) 만큼 손으로 옮긴 것처럼
    if (!gridFallen || !fallenPos[k]) return;
    fallenPos[k].x += dx; fallenPos[k].y += dy;
    const el = $(`#grid-wrap .grid-item[data-k="${k}"]`);
    if (el) el.style.transform = `translate(${fallenPos[k].x}px, ${fallenPos[k].y}px) rotate(${fallenPos[k].r}deg)`;
  },
  gridCount: () => $$('#grid-wrap .grid-item').length,
  selectDate: (d) => { selDate = d; renderCal(); }, getSelDate: () => selDate,
  statsCounts: (ym) => { statsYM = ym; renderMoodStats();
    const c = {}; MOODS.forEach((k) => (c[k] = 0));
    entries.filter((e) => e.date.startsWith(ym)).forEach((e) => { if (c[e.mood] !== undefined) c[e.mood]++; });
    return c; },
  saveVlogToLib, getVlogs: () => vlogs.map((v) => ({ id: v.id, ym: v.ym, title: v.title, size: v.blob ? v.blob.size : 0 })),
  deleteVlogNow: async (id) => { await vlogDelete(id); await loadVlogs(); renderVlogLib(); },
  // 대표 사진·기분 모아보기·달력 훅
  setCover, coverEntryId: (date) => { const c = coverEntry(date); return c ? c.id : null; },
  openMoodCollection, gridFilter: () => gridFilterMood,
  // 폴라로이드 프레임 렌더 검증 (영상 재생 없이 한 장면 그려 픽셀 확인)
  async renderPolaroidTest(dataURL) {
    const W = 720, H = 540;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const geo = polaroidGeom(W, H);
    const img = await blobToImage(dataURL);
    drawPolaroidFrame(ctx, W, H, geo);
    drawMediaCover(ctx, img, img.naturalWidth || 4, img.naturalHeight || 3, geo, 1.05);
    const px = (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3));
    return {
      frameBottom: px(geo.fx + geo.fw / 2, geo.my + geo.mh + 45), // 폴라로이드 아래 흰 여백
      outside: px(6, 6),                                          // 프레임 밖 배경
      geo: { fx: geo.fx, fy: geo.fy, fw: geo.fw, fh: geo.fh },
    };
  },
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
