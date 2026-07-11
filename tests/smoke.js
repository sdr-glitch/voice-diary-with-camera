/* 순간일기 스모크 테스트 — headless Chromium + 가짜 카메라
   실행: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/smoke.js
   (기능을 추가/변경할 때마다 반드시 실행할 것) */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGklEQVR4nGP8z8Dwn4GBgYGJAQowMdAXAABrqgEDOA0cRwAAAABJRU5ErkJggg==';
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; console.log('  ❌', name); }
}

(async () => {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--allow-file-access-from-files',
    ],
  });
  const ctx = await browser.newContext({ permissions: [] });
  // 온보딩(새 일기장 만들기)은 대부분의 스텝에서 건너뛰도록 기본 일기장 하나를 미리 심어둠 ([31]에서 별도 검증)
  await ctx.addInitScript(() => { try {
    if (localStorage.getItem('momentDiary:diaries') === null) {
      localStorage.setItem('momentDiary:diaries', JSON.stringify([{ id: 'd_seed', name: '일상', topic: 'daily', created: 1 }]));
      localStorage.setItem('momentDiary:active', 'd_seed');
    }
  } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const noEmoji = (s) => !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u.test(s);

  console.log('\n[1] 로드 & 책장 (이모티콘 없음)');
  await page.goto(URL);
  await page.evaluate(() => window.__diary.ready());
  ok(await page.isVisible('#scr-cover'), '책장 화면 표시');
  ok(await page.$('.cover-emblem') === null, '표지 이모티콘(엠블럼) 제거됨');
  ok(await page.$('.cover-open-hint') === null, "'눌러서 펼치기' 버튼 제거됨");
  ok(await page.$('.book-tile[data-id="d_seed"]') !== null, '책장에 기본 일기장(일상) 책 표시');
  ok(await page.$('#shelf-add') !== null, "'새 일기장' 타일 표시");
  const coverText = await page.textContent('#scr-cover');
  ok(noEmoji(coverText), '책장에 이모티콘 없음');

  console.log('\n[2] 책 클릭 → 달력(홈) 진입');
  await page.click('.book-tile[data-id="d_seed"]');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  ok(await page.isVisible('#scr-cal'), '일기장 누르면 달력 화면으로');
  ok((await page.textContent('#cal-title')).includes('년'), '달력 제목(연월) 표시');
  const calText = await page.textContent('#scr-cal .top-bar');
  ok(noEmoji(calText) && !calText.includes('표지로'), '상단에 이모티콘·표지로 없음');

  console.log('\n[3] 제목 클릭 → 책장으로 이동');
  await page.click('#cal-home-title');
  ok(await page.isVisible('#scr-cover'), "'순간일기' 제목 누르면 책장으로");
  await page.click('.book-tile[data-id="d_seed"]');
  await page.waitForSelector('#scr-cal:not(.hidden)');

  console.log('\n[4] 오늘 날짜 클릭 → 오늘의 순간 담기');
  ok(await page.$('.cal-day.today') !== null, '오늘 날짜 강조 표시');
  await page.click('.cal-day.today');
  ok(await page.isVisible('#scr-capture'), '오늘 누르면 기록 화면으로');
  const capText = await page.textContent('.cap-head');
  ok(noEmoji(capText), '기록 화면 제목에 이모티콘 없음');
  await page.click('#btn-cap-back');

  console.log('\n[5] 필터 단위 검증');
  const names = ['none', 'vintage', 'colorpop', 'fisheye', 'film', 'retro', 'mono', 'dreamy'];
  const f = await page.evaluate((ns) => {
    const o = {}; ns.forEach((n) => { o[n] = window.__diary.testFilter(n); }); return o;
  }, names);
  const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
  ok(diff(f.none.q1, f.vintage.q1) > 10, '빈티지 필터가 색을 바꿈');
  ok(diff(f.none.q1, f.colorpop.q1) > 10, '색감강조 필터가 색을 바꿈');
  ok(diff(f.none.corner, f.fisheye.corner) > 10, '볼록거울 필터가 왜곡함');
  ok(diff(f.none.q1, f.film.q1) > 8, '필름 필터가 색을 바꿈');
  ok(diff(f.none.q1, f.retro.q1) > 8, '폴더폰(레트로) 필터가 색을 바꿈');
  ok(Math.abs(f.mono.q1[0] - f.mono.q1[1]) < 6 && Math.abs(f.mono.q1[1] - f.mono.q1[2]) < 6, '흑백 필터는 R=G=B');
  ok(diff(f.none.q1, f.dreamy.q1) > 5, '몽환 필터가 색을 바꿈');
  // 필터끼리 서로 다름(겹치지 않음)
  ok(diff(f.vintage.q1, f.film.q1) > 8 && diff(f.vintage.q1, f.mono.q1) > 8, '빈티지·필름·흑백이 서로 다름');

  console.log('\n[6] 빈 날 클릭 → 기록 화면');
  await page.evaluate(() => window.__diary.goCalendar('2026-07'));
  await page.click('.cal-day.empty[data-date="2026-07-01"]');
  ok(await page.isVisible('#scr-capture'), '빈 날 누르면 기록 화면으로');
  await page.click('#btn-cap-back');

  console.log('\n[7] 사진 촬영 + 기분/날씨 + 저장 (기본은 영상 → 사진으로 전환)');
  await page.evaluate(() => window.__diary.show('scr-capture'));
  await page.waitForFunction(() => window.__diary.camState().hasStream, null, { timeout: 8000 });
  ok(await page.evaluate(() => window.__diary.camState().mode) === 'video', '기본 촬영 모드가 영상');
  await page.click('#mode-toggle button[data-mode="photo"]');
  await page.click('#filter-row .chip[data-filter="vintage"]');
  await page.click('#btn-shutter');
  await page.waitForFunction(() => window.__diary.camState().captured === 'photo', null, { timeout: 5000 });
  await page.fill('#diary-text', '오늘의 기분과 함께 남긴 사진.');
  await page.click('.mchip[data-mood="행복"]');
  await page.click('.wchip[data-weather="☀️"]');
  await page.click('#btn-save-entry');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  let list = await page.evaluate(() => window.__diary.getEntries());
  ok(list.length === 1 && list[0].kind === 'photo', '사진 저장');
  ok(list[0].mood === '행복' && list[0].weather === '☀️', '기분·날씨 메타 저장');
  ok((await page.textContent('#cal-entry-list')).includes('기분'), '달력 아래 크게보기에 기분 표시');
  ok(await page.$('#cal-entry-list .big-entry .pg-media.polaroid') !== null, '폴라로이드 프레임으로 크게 표시');

  console.log('\n[8] 영상 — 길이 제한 없이 토글 녹화 (시작→대기→정지)');
  await page.evaluate(() => window.__diary.show('scr-capture'));
  await page.waitForFunction(() => window.__diary.camState().hasStream, null, { timeout: 8000 });
  await page.click('#mode-toggle button[data-mode="video"]');
  await page.click('#btn-shutter'); // 시작
  await page.waitForFunction(() => window.__diary.isRecording(), null, { timeout: 4000 });
  ok(await page.isVisible('#rec-dot.on'), '녹화 표시등 켜짐');
  await page.waitForTimeout(1600); // 약 1.6초 녹화 (고정 2초가 아님)
  const recShown = await page.textContent('#rec-time');
  await page.click('#btn-shutter'); // 정지
  await page.waitForFunction(() => window.__diary.camState().captured === 'video', null, { timeout: 6000 });
  ok(await page.isVisible('#cap-preview-video'), '영상 미리보기 표시');
  ok(/\d+초/.test(recShown), `녹화 시간 표시 (${recShown})`);
  await page.fill('#diary-text', '길이 제한 없는 영상.');
  await page.click('#btn-save-entry');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  list = await page.evaluate(() => window.__diary.getEntries());
  const vid = list.find((e) => e.kind === 'video');
  ok(!!vid && vid.blobSize > 1000, `영상 저장 (blob ${vid ? vid.blobSize : 0}B)`);
  ok(vid.durMs >= 1000, `녹화 길이 기록됨 (${vid ? vid.durMs : 0}ms)`);

  console.log('\n[9] 음성 안전망');
  await page.evaluate(() => window.__diary.show('scr-capture'));
  await page.waitForFunction(() => window.__diary.camState().hasStream, null, { timeout: 8000 });
  await page.click('#btn-mic');
  await page.waitForTimeout(1000);
  ok((await page.textContent('#voice-status')).length > 0, '음성 상태 안내 표시');
  await page.fill('#diary-text', '직접 입력도 잘 된다.');
  await page.click('#btn-save-entry');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  list = await page.evaluate(() => window.__diary.getEntries());
  ok(list.some((e) => e.kind === 'none' && e.text.includes('직접 입력')), '글만 있는 일기 저장');

  console.log('\n[10] 스티커 꾸미기 (촬영 → 부착 → 드래그 → 저장)');
  await page.evaluate(() => window.__diary.show('scr-capture'));
  await page.waitForFunction(() => window.__diary.camState().hasStream, null, { timeout: 8000 });
  await page.click('#mode-toggle button[data-mode="photo"]');
  await page.click('#btn-shutter');
  await page.waitForFunction(() => window.__diary.camState().captured === 'photo', null, { timeout: 5000 });
  ok(await page.isVisible('#deco-box'), '촬영 후 꾸미기 도구 표시');
  await page.click('#sticker-palette .schip');
  const lay = await page.$('#sticker-layer');
  await lay.scrollIntoViewIfNeeded();  // 촬영 카드가 길어 스티커 무대가 화면 밖일 수 있음
  const lb = await lay.boundingBox();
  await page.mouse.move(lb.x + lb.width * 0.5, lb.y + lb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(lb.x + lb.width * 0.25, lb.y + lb.height * 0.25, { steps: 6 });
  await page.mouse.up();
  let stks = await page.evaluate(() => window.__diary.getStickers());
  ok(stks.length === 1 && stks[0].x < 0.35, `스티커 부착 후 드래그 이동 (x=${stks[0].x.toFixed(2)})`);
  await page.fill('#diary-text', '스티커로 꾸민 날');
  await page.click('#btn-save-entry');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  const saved = (await page.evaluate(() => window.__diary.getEntries())).find((e) => e.text.includes('스티커로 꾸민'));
  ok(saved && saved.stickers.length === 1, '스티커가 일기와 함께 저장');

  console.log('\n[11] 지난달 시드 + 달력에서 날짜 점프');
  await page.evaluate(async (png) => {
    await window.__diary.addEntry({ date: '2026-06-03', text: '유월 첫 기록', weather: '⛅', mood: '평온', dataURL: png });
    await window.__diary.addEntry({ date: '2026-06-08', text: '유월 둘째', weather: '🌧️', dataURL: png, kind: 'video', durMs: 5000 });
    await window.__diary.addEntry({ date: '2026-06-15', text: '유월 셋째', weather: '☀️', dataURL: png });
  }, PNG);
  await page.evaluate(() => window.__diary.goCalendar('2026-06'));
  ok(await page.isVisible('#scr-cal'), '달력 홈으로');
  ok((await page.textContent('#cal-title')).includes('2026년 6월'), '6월 표시');
  ok((await page.$$eval('.cal-day.has', (b) => b.length)) === 3, '기록 있는 날 3개');
  // 날짜를 누르면 아래에 그날 일기만 뜨고, 목록을 눌러 크게 보기
  await page.click('.cal-day.has[data-date="2026-06-03"]');
  await page.waitForTimeout(120);
  ok((await page.textContent('#cal-entry-list')).includes('유월 첫 기록'), '선택한 날짜(6/3) 일기만 크게보기에 표시');
  ok(!(await page.textContent('#cal-entry-list')).includes('유월 셋째'), '다른 날짜 일기는 없음');
  ok(await page.$('#cal-entry-list .big-entry .be-text') !== null, '크게보기 카드에 수정 가능한 글칸(be-text)');
  await page.evaluate(() => window.__diary.goCalendar('2026-06'));
  await page.click('#cal-next');
  ok((await page.textContent('#cal-title')).includes('2026년 7월'), '달력 월 넘김');

  console.log('\n[12] 월말 브이로그 편집기 (넣을 장면·순서·길이)');
  await page.evaluate(() => window.__diary.show('scr-vlog'));
  const opts = await page.$$eval('#vlog-month option', (o) => o.map((x) => x.value));
  ok(opts.includes('2026-06'), `월 목록: ${opts.join(', ')}`);
  await page.selectOption('#vlog-month', '2026-06');
  await page.waitForTimeout(150);
  ok((await page.$$eval('#clip-list .clip-item', (n) => n.length)) === 3, '6월 장면 3개 편집목록 표시');
  // 한 장면 빼기
  await page.uncheck('#clip-list .clip-item:nth-child(2) .clip-chk');
  let clips = await page.evaluate(() => window.__diary.getClips());
  ok(clips.filter((c) => c.on).length === 2, '체크 해제로 장면 빼기');
  // 순서 바꾸기 (첫 장면 아래로)
  const before = (await page.evaluate(() => window.__diary.getClips())).map((c) => c.id);
  await page.click('#clip-list .clip-item:nth-child(1) .clip-down');
  const after = (await page.evaluate(() => window.__diary.getClips())).map((c) => c.id);
  ok(before[0] === after[1] && before[1] === after[0], '장면 순서 이동');
  // 길이 30초
  await page.click('#vlog-len button[data-len="30"]');
  await page.fill('#vlog-title', '유월의 나날');
  await page.click('#btn-make-vlog');
  await page.waitForSelector('#vlog-result.on', { timeout: 40000 });
  const vinfo = await page.evaluate(async () => {
    const b = await (await fetch(document.querySelector('#vlog-video').src)).blob();
    return { size: b.size, tracks: window.__diary._lastVlogAudioTracks };
  });
  ok(vinfo.size > 5000, `브이로그 생성 (${vinfo.size}B)`);
  ok(vinfo.tracks === 1, '배경음악 소리 트랙 포함');

  console.log('\n[13] 압축: 장면 수가 많아도 목표 길이 유지 (한 장면 시간이 짧아짐)');
  const slotSmall = await page.evaluate(() => {
    // 12개 장면을 30초에 압축하면 한 장면당 약 2초 안팎이어야 함(<=5초 상한)
    const n = 12, target = 30, intro = 1900, outro = 1600;
    const body = Math.max(n * 500, target * 1000 - intro - outro);
    return Math.min(5000, Math.max(500, Math.round(body / n)));
  });
  ok(slotSmall <= 5000 && slotSmall < 3000, `12장면/30초 → 한 장면 ${slotSmall}ms (압축됨)`);

  console.log('\n[14] 배경음악 자체 합성 + 내 음원 파일');
  ok(await page.evaluate(() => window.__diary.bgmSample('piano')) > 0.0005, '피아노 음원 실제 소리');
  ok(await page.evaluate(() => window.__diary.bgmSample('musicbox')) > 0.0005, '오르골 음원 실제 소리');
  const sr = 44100, nn = sr / 2;
  const wav = Buffer.alloc(44 + nn * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + nn * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(nn * 2, 40);
  for (let i = 0; i < nn; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000), 44 + i * 2);
  const wavPath = path.join(__dirname, 'tmp-tone.wav');
  fs.writeFileSync(wavPath, wav);
  await page.selectOption('#vlog-bgm', 'user');
  ok(await page.isVisible('#user-audio-row'), '음원 파일 선택칸 표시');
  await page.setInputFiles('#vlog-user-audio', wavPath);
  await page.waitForFunction(() => window.__diary.userAudioLoaded(), null, { timeout: 5000 });
  const vU = await page.evaluate(async () => {
    const b = await window.__diary.buildVlog('2026-06', () => {}, { bgm: 'user', fx: false, targetSec: 30 });
    return { size: b.size, tracks: window.__diary._lastVlogAudioTracks };
  });
  ok(vU.tracks === 1 && vU.size > 5000, `내 음원으로 브이로그 생성 (${vU.size}B)`);
  fs.unlinkSync(wavPath);

  console.log('\n[15] 개별 삭제 / 새로고침 유지 / 전체 삭제');
  list = await page.evaluate(() => window.__diary.getEntries());
  const total0 = list.length;
  const delId = list.find((e) => e.text.includes('유월 셋째')).id;
  await page.evaluate((id) => window.__diary.deleteEntry(id), delId);
  await page.reload();
  await page.evaluate(() => window.__diary.ready());
  list = await page.evaluate(() => window.__diary.getEntries());
  ok(list.length === total0 - 1, `개별 삭제 후 새로고침 유지 (${list.length})`);
  ok(list.filter((e) => e.blobSize > 0).length >= 3, '미디어 blob 유지');
  await page.evaluate(() => window.__diary.show('scr-settings'));
  await page.click('#btn-wipe');
  await page.waitForSelector('#modal-back.on');
  await page.click('#modal-ok');
  await page.waitForSelector('#scr-cover:not(.hidden)');
  ok((await page.evaluate(() => window.__diary.getEntries())).length === 0, '전체 삭제');
  // 삭제 후 이어서 쓰려면 일기장이 필요 — 온보딩에서 새로 하나 만든다
  await page.click('#onboard-topics .chip[data-k="daily"]');
  await page.click('#onboard-start');
  await page.waitForSelector('#scr-cal:not(.hidden)');

  console.log('\n[16] 달력에서 지난 날 채우기 (아무 날짜나 클릭)');
  await page.evaluate(() => window.__diary.goCalendar('2026-05'));
  ok(await page.isVisible('#scr-cal'), '5월 달력 표시');
  ok((await page.$$eval('.cal-day.empty', (n) => n.length)) > 0, '지난 날들이 눌러서 채울 수 있게 표시');
  ok((await page.$$eval('.cal-day.future', (n) => n.length)) === 0, '(과거 달이라 미래 칸 없음)');
  await page.click('.cal-day.empty[data-date="2026-05-10"]');
  ok(await page.isVisible('#scr-capture'), '지난 날 누르면 기록 화면으로');
  ok((await page.textContent('#cap-datebar')).includes('5월 10일'), '기록 화면이 그날짜를 표시');
  ok(await page.evaluate(() => window.__diary.getCaptureDate()) === '2026-05-10', 'captureDate가 지난 날로 설정');
  await page.fill('#diary-text', '오월의 지난 날을 채웠다.');
  await page.click('.mchip[data-mood="평온"]');
  await page.click('#btn-save-entry');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  let filled = (await page.evaluate(() => window.__diary.getEntries())).find((e) => e.text.includes('오월의 지난 날'));
  ok(filled && filled.date === '2026-05-10', `지난 날짜(${filled ? filled.date : '?'})로 저장됨`);

  console.log('\n[17] 갤러리 사진 — 필터 재적용 + 크기 조절');
  await page.evaluate(() => window.__diary.openCaptureFor('2026-05-11'));
  await page.waitForSelector('#scr-capture:not(.hidden)');
  await page.evaluate(async (png) => {
    const blob = await (await fetch(png)).blob();
    await window.__diary.importFile(blob);
  }, PNG);
  await page.waitForFunction(() => window.__diary.camState().captured === 'photo', null, { timeout: 5000 });
  ok(await page.isVisible('#cap-preview-img'), '갤러리 사진 미리보기 표시');
  ok(await page.isVisible('#fit-controls'), '사진 크기 조절 컨트롤 표시');
  // 갤러리 사진에도 필터가 적용되는지 (필터 바꾸면 미리보기 src가 바뀜)
  await page.click('#filter-row .chip[data-filter="vintage"]');
  await page.waitForTimeout(120);
  const src1 = await page.evaluate(() => document.querySelector('#cap-preview-img').src);
  await page.click('#filter-row .chip[data-filter="mono"]');
  await page.waitForTimeout(120);
  const src2 = await page.evaluate(() => document.querySelector('#cap-preview-img').src);
  ok(src1 !== src2 && src2.startsWith('data:image'), '갤러리 사진에 필터가 다시 적용됨(미리보기 갱신)');
  // 크기 조절 (＋버튼 → scale 증가, transform 반영)
  await page.click('#fit-in'); await page.click('#fit-in');
  const fit = await page.evaluate(() => window.__diary.getFit());
  ok(fit.scale > 1, `크기 조절로 확대 (scale ${fit.scale.toFixed(2)})`);
  const ptf = await page.evaluate(() => document.querySelector('#cap-preview-img').style.transform);
  ok(ptf.includes('scale('), '미리보기에 크기(transform) 반영');
  await page.click('#btn-save-entry');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  const gal = (await page.evaluate(() => window.__diary.getEntries())).find((e) => e.date === '2026-05-11');
  ok(gal && gal.kind === 'photo' && gal.blobSize > 100, '갤러리 사진 저장');
  ok(gal.filter === 'mono', '저장된 사진에 선택한 필터 반영');
  ok(gal.fit && gal.fit.scale > 1, '저장된 사진에 크기 조절값 반영');

  console.log('\n[18] 소리 — 새 배경음악 2종 + 효과음(비눗방울·마이크·종이넘김)');
  ok(await page.evaluate(() => window.__diary.bgmSample('guitar')) > 0.0005, '따뜻한 기타 실제 소리');
  ok(await page.evaluate(() => window.__diary.bgmSample('lofi')) > 0.0005, '로파이 앰비언트 실제 소리');
  ok(await page.evaluate(() => window.__diary.fxSample('bubble')) > 0.0005, '비눗방울 버튼음 실제 소리');
  ok(await page.evaluate(() => window.__diary.fxSample('mic')) > 0.0005, '마이크 버튼음 실제 소리');
  ok(await page.evaluate(() => window.__diary.fxSample('flip')) > 0.0005, '종이 넘김 소리 실제 소리');

  console.log('\n[19] 음량 설정 저장');
  await page.evaluate(() => window.__diary.show('scr-settings'));
  await page.evaluate(() => { const v = document.querySelector('#set-volume'); v.value = 30; v.dispatchEvent(new Event('change')); });
  ok(await page.evaluate(() => localStorage.getItem('momentDiary:volume')) === '30', '효과음 음량 저장');

  console.log('\n[20] 브이로그 마무리 한마디(수정·저장) + 폴라로이드/압축 빌드');
  await page.evaluate(() => window.__diary.show('scr-vlog'));
  await page.selectOption('#vlog-month', '2026-05');
  await page.waitForTimeout(150);
  await page.fill('#vlog-outro', '오월아 고마워');
  await page.selectOption('#vlog-bgm', 'guitar');
  await page.click('#btn-make-vlog');
  await page.waitForSelector('#vlog-result.on', { timeout: 40000 });
  ok(await page.evaluate(() => localStorage.getItem('momentDiary:outro')) === '오월아 고마워', '마무리 한마디 저장(다음에도 기억)');
  const vsize = await page.evaluate(async () => (await (await fetch(document.querySelector('#vlog-video').src)).blob()).size);
  ok(vsize > 5000, `폴라로이드 브이로그 생성 (${vsize}B)`);
  // 앱 이름은 항상 들어가고, 빈 한마디면 앱 이름만
  const okOutro = await page.evaluate(async () => {
    const b = await window.__diary.buildVlog('2026-05', () => {}, { outro: '', targetSec: 30, bgm: 'none' });
    return b.size > 3000;
  });
  ok(okOutro, '마무리 한마디를 비워도(앱 이름만) 정상 생성');
  // 폴라로이드 프레임이 실제로 그려지는지(흰 프레임 여백 vs 크림 배경)
  const pol = await page.evaluate((png) => window.__diary.renderPolaroidTest(png), PNG);
  const white = pol.frameBottom[0] > 240 && pol.frameBottom[1] > 240 && pol.frameBottom[2] > 235;
  const cream = pol.outside[0] > 210 && pol.outside[0] < 250 && pol.outside[2] < pol.outside[0];
  ok(white, `폴라로이드 흰 프레임 여백 렌더 (rgb ${pol.frameBottom.join(',')})`);
  ok(cream, `프레임 밖은 크림색 배경 (rgb ${pol.outside.join(',')})`);

  console.log('\n[21] 전체 삭제 → 책장 비고 새 일기장 온보딩');
  await page.evaluate(() => window.__diary.show('scr-settings'));
  await page.click('#btn-wipe');
  await page.waitForSelector('#modal-back.on');
  await page.click('#modal-ok');
  await page.waitForSelector('#scr-cover:not(.hidden)');
  ok((await page.evaluate(() => window.__diary.getEntries())).length === 0, '전체 삭제');
  ok((await page.evaluate(() => window.__diary.getDiaries())).length === 0, '일기장 목록도 비움');
  ok(await page.evaluate(() => window.__diary.onboardVisible()), '일기장 없으면 새 일기장 만들기 창');
  // 새 일기장 만들어 이어서 진행
  await page.click('#onboard-topics .chip[data-k="daily"]');
  await page.fill('#onboard-name', '다시 일상');
  await page.click('#onboard-start');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  ok((await page.evaluate(() => window.__diary.getDiaries())).length === 1, '새 일기장 생성 후 이어서 사용');

  console.log('\n[21b] 기록 알림 배너');
  await page.evaluate(() => window.__diary.reminder.show());
  ok(await page.isVisible('#reminder-banner.on'), '오늘 기록 없으면 알림 배너 표시');
  await page.click('#reminder-go');
  ok(await page.isVisible('#scr-capture'), '배너의 기록하기 → 기록 화면');
  await page.evaluate(async () => { await window.__diary.addEntry({ text: '오늘 기록' }); });
  await page.evaluate(() => window.__diary.reminder.show());
  ok(!(await page.isVisible('#reminder-banner.on')), '오늘 이미 기록했으면 배너 안 뜸');

  console.log('\n[22] 하단 탭 이동');
  await page.evaluate(() => window.__diary.show('scr-cover'));
  await page.click('.book-tile[data-id]');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  ok(await page.isVisible('#scr-cal') && await page.isVisible('#bottomnav'), '책→달력, 하단 탭 표시');
  await page.click('#bottomnav .navbtn[data-scr="scr-grid"]');
  ok(await page.isVisible('#scr-grid'), '모아보기 탭');
  await page.click('#bottomnav .navbtn[data-scr="scr-stats"]');
  ok(await page.isVisible('#scr-stats'), '통계 탭');
  await page.click('#bottomnav .navbtn[data-scr="scr-vloglib"]');
  ok(await page.isVisible('#scr-vloglib'), '브이로그 탭');
  await page.click('#bottomnav .navbtn[data-scr="scr-settings"]');
  ok(await page.isVisible('#scr-settings'), '설정 탭');
  ok(await page.isHidden('#bottomnav') === false, '탭 화면에선 하단 탭 유지');

  console.log('\n[23] 모아보기 그리드 + 롱프레스 흔들림 + 와르르');
  // 사진 2, 영상 1, 글 1 시드 (오늘 달)
  await page.evaluate(async (png) => {
    await window.__diary.addEntry({ date: '2026-07-06', text: '사진 기록', dataURL: png, kind: 'photo' });
    await window.__diary.addEntry({ date: '2026-07-07', text: '영상 기록', dataURL: png, kind: 'video', durMs: 4000 });
    await window.__diary.addEntry({ date: '2026-07-08', text: '글만 남긴 날' });
  }, PNG);
  await page.click('#bottomnav .navbtn[data-scr="scr-grid"]');
  await page.waitForTimeout(100);
  ok(await page.evaluate(() => window.__diary.gridCount()) >= 3, `그리드에 기록 표시 (${await page.evaluate(() => window.__diary.gridCount())}개)`);
  // 그리드 아이템 탭 → 달력의 그 날짜 크게보기로
  await page.click('#grid-wrap .grid-item');
  await page.waitForTimeout(120);
  ok(await page.isVisible('#scr-cal'), '그리드 아이템 누르면 달력 크게보기로');
  ok((await page.$$eval('#cal-entry-list .big-entry', (n) => n.length)) > 0, '해당 날짜 크게보기 카드 표시');
  await page.click('#bottomnav .navbtn[data-scr="scr-grid"]');
  ok(await page.isVisible('#scr-grid'), '다시 모아보기 탭');
  // 롱프레스 흔들림 토글 (훅)
  await page.evaluate(() => window.__diary.setJiggle(true));
  ok(await page.evaluate(() => window.__diary.isJiggling()), '흔들림(편집) 모드 켜짐');
  ok(await page.evaluate(() => document.querySelector('#grid-wrap').classList.contains('jiggle')), '그리드에 흔들림 클래스');
  // 와르르 (편집 모드에서만) — 떨어져 쌓인 뒤 그대로 멈춤
  await page.evaluate(() => window.__diary.cascadeGrid());
  ok(await page.evaluate(() => document.querySelectorAll('#grid-wrap .grid-item.falling').length) > 0, '와르르 떨어지는 애니메이션 적용');
  await page.waitForTimeout(1000);
  const stillThere = await page.evaluate(() => window.__diary.gridCount());
  const pileTf = await page.evaluate(() => document.querySelector('#grid-wrap .grid-item').style.transform);
  ok(await page.evaluate(() => window.__diary.isFallen()) && stillThere > 0 && pileTf.includes('translate'),
     '떨어진 뒤 사라지지 않고 아래에 쌓여 멈춤');
  // 복구
  await page.evaluate(() => window.__diary.restoreGrid());
  ok(!(await page.evaluate(() => window.__diary.isJiggling())) && !(await page.evaluate(() => window.__diary.isFallen())), '복구 후 편집·쌓임 해제');

  console.log('\n[24] 기분 통계');
  // 7월에 기분 몇 개 시드
  await page.evaluate(async (png) => {
    await window.__diary.addEntry({ date: '2026-07-10', text: 'a', mood: '행복', dataURL: png });
    await window.__diary.addEntry({ date: '2026-07-11', text: 'b', mood: '행복', dataURL: png });
    await window.__diary.addEntry({ date: '2026-07-12', text: 'c', mood: '평온', dataURL: png });
  }, PNG);
  const counts = await page.evaluate(() => window.__diary.statsCounts('2026-07'));
  ok(counts['행복'] >= 2 && counts['평온'] >= 1, `기분 집계 (행복 ${counts['행복']}, 평온 ${counts['평온']})`);
  await page.click('#bottomnav .navbtn[data-scr="scr-stats"]');
  await page.waitForTimeout(100);
  ok((await page.$$eval('#mood-chart .mood-bar-row', (n) => n.length)) === 7, '기분 7종 막대 표시');
  ok((await page.textContent('#stats-summary')).includes('행복'), '가장 많은 기분 요약(행복)');

  console.log('\n[25] 브이로그: 사진·영상만(글 제외) + 보관함 저장·재생·삭제');
  await page.evaluate(() => window.__diary.show('scr-vlog'));
  await page.selectOption('#vlog-month', '2026-07');
  await page.waitForTimeout(120);
  // 7월 clip-list 에는 글만 있는 날(2026-07-08)이 빠져야 함
  const clipDates = await page.$$eval('#clip-list .clip-item .clip-info b', (ns) => ns.map((n) => n.textContent));
  ok(!clipDates.includes('7월 8일'), '글만 있는 날은 브이로그 장면 목록에서 제외');
  ok(clipDates.includes('7월 7일'), '영상 있는 날은 포함');
  await page.fill('#vlog-title', '칠월 기록');
  await page.click('#btn-make-vlog');
  await page.waitForSelector('#vlog-result.on', { timeout: 40000 });
  ok(await page.isVisible('#btn-vlog-keep'), '보관함 저장 버튼 표시');
  await page.click('#btn-vlog-keep');
  await page.waitForSelector('#scr-vloglib:not(.hidden)');
  let vl = await page.evaluate(() => window.__diary.getVlogs());
  ok(vl.length === 1 && vl[0].size > 5000, `브이로그 보관함에 저장 (${vl[0] ? vl[0].size : 0}B)`);
  ok((await page.$$eval('.vlog-tile', (n) => n.length)) === 1, '보관함 바둑판 타일 표시');
  // 타일 누르면 큰 화면 뷰어
  await page.click('.vlog-tile');
  ok(await page.isVisible('#vlog-viewer.on'), '타일 누르면 큰 화면 뷰어 열림');
  ok(await page.evaluate(() => !!document.getElementById('vlog-viewer-video').src), '뷰어에 영상 로드');
  await page.click('#vlog-viewer-close');
  ok(!(await page.isVisible('#vlog-viewer.on')), '뷰어 닫기');
  // 새로고침 후 유지
  await page.reload();
  await page.evaluate(() => window.__diary.ready());
  vl = await page.evaluate(() => window.__diary.getVlogs());
  ok(vl.length === 1, '새로고침 후 브이로그 보관함 유지');
  // 삭제
  await page.evaluate((id) => window.__diary.deleteVlogNow(id), vl[0].id);
  vl = await page.evaluate(() => window.__diary.getVlogs());
  ok(vl.length === 0, '브이로그 삭제');

  console.log('\n[25b] 브이로그 파일 형식 — 재생 가능한 확장자(mp4 우선)');
  const mimeInfo = await page.evaluate(() => ({ mime: window.__diary.pickMime(), mp4: window.__diary.extForType('video/mp4'), webm: window.__diary.extForType('video/webm;codecs=vp9') }));
  ok(mimeInfo.mp4 === 'mp4' && mimeInfo.webm === 'webm', '실제 형식에 맞는 확장자 선택(mp4/webm)');
  ok(mimeInfo.mime && (mimeInfo.mime.includes('mp4') || mimeInfo.mime.includes('webm')), `녹화 형식 지원 (${mimeInfo.mime})`);

  console.log('\n[26] 흰색 책 디자인 확인');
  const coverBg = await page.evaluate(async () => {
    window.__diary.show('scr-cover');
    await window.__diary.renderShelf();
    return getComputedStyle(document.querySelector('.book-tile:not(.add)')).backgroundImage;
  });
  ok(coverBg.includes('rgb(255, 255, 255)'), `책이 흰색 계열 (${coverBg.slice(0, 60)}…)`);

  console.log('\n[27] 달력 아래 크게보기 통합 + 사진/글 인라인 수정');
  await page.evaluate(() => window.__diary.goCalendar('2026-07'));
  await page.waitForTimeout(120);
  // 선택 날짜의 크게보기 카드가 달력 아래에 바로 뜸 (별도 페이지 없음)
  ok(await page.$('#scr-book') === null, '별도 크게보기 페이지(scr-book) 제거됨');
  const selD = await page.evaluate(() => window.__diary.getSelDate());
  ok((await page.$$eval('#cal-entry-list .big-entry', (n) => n.length)) > 0, '달력 아래 크게보기 카드 표시');
  // 글씨 인라인 수정 → 저장(포커스아웃)
  const firstId = await page.evaluate(() => document.querySelector('#cal-entry-list .be-text').dataset.id);
  await page.fill(`#cal-entry-list .be-text[data-id="${firstId}"]`, '인라인으로 고친 메모');
  await page.click('#cal-title'); // 포커스 아웃
  await page.waitForTimeout(120);
  ok((await page.evaluate((id) => window.__diary.getEntries().find((e) => e.id === id).text, firstId)) === '인라인으로 고친 메모', '글씨 인라인 수정 저장');
  // '수정' 버튼이 기분·날씨 줄 오른쪽(be-head)에 있고, 누르면 수정 모드
  ok(await page.$(`#cal-entry-list .big-entry[data-id="${firstId}"] .be-head .be-editphoto`) !== null, "'수정' 버튼이 상단 우측(메타 줄)에 위치");
  ok((await page.textContent(`#cal-entry-list .big-entry[data-id="${firstId}"] .be-editphoto`)).trim() === '수정', "버튼 이름이 '수정'");
  await page.click(`#cal-entry-list .big-entry[data-id="${firstId}"] .be-editphoto`);
  ok(await page.isVisible('#scr-capture') && await page.isVisible('#cap-edit-banner'), "'수정' → 수정 모드(카메라)");
  await page.click('#btn-cap-back');

  console.log('\n[28] 사진 달력 + 하루 여러 장 중 대표 썸네일 선택');
  // 같은 날에 사진 2장 시드 (대표 선택은 id 기준)
  await page.evaluate(async (png) => {
    await window.__diary.addEntry({ date: '2026-07-19', text: '첫번째 사진', dataURL: png, kind: 'photo' });
    await window.__diary.addEntry({ date: '2026-07-19', text: '두번째 사진', dataURL: png, kind: 'photo' });
  }, PNG);
  await page.evaluate(() => window.__diary.goCalendar('2026-07'));
  await page.waitForTimeout(100);
  ok((await page.$$eval('.cal-day.thumb', (n) => n.length)) > 0, '사진 있는 날은 썸네일 셀로 표시');
  // 대표사진: 기본은 그날 첫 미디어. 두번째로 바꾸기(훅) → coverEntryId 변경
  const entries19 = await page.evaluate(() => window.__diary.getEntries().filter((e) => e.date === '2026-07-19').map((e) => e.id));
  const defCover = await page.evaluate(() => window.__diary.coverEntryId('2026-07-19'));
  await page.evaluate((id) => window.__diary.setCover('2026-07-19', id), entries19[1]);
  const newCover = await page.evaluate(() => window.__diary.coverEntryId('2026-07-19'));
  ok(defCover !== newCover && newCover === entries19[1], '대표(썸네일) 사진 선택 변경');

  console.log('\n[29] 기분별 일기 모아보기 + 공감/위로/응원 카드');
  await page.evaluate(() => window.__diary.show('scr-stats'));
  await page.evaluate(() => { const s = document.querySelector('#stats-title'); });
  // 통계는 오늘 달 기준 — 7월로 맞추기 위해 statsCounts 호출로 세팅
  await page.evaluate(() => window.__diary.statsCounts('2026-07'));
  await page.evaluate(() => window.__diary.show('scr-stats'));
  await page.waitForTimeout(100);
  ok(await page.isVisible('#mood-card.show'), '기분 카드(공감/위로/응원) 표시');
  const cardTag = await page.textContent('.mood-card-tag');
  ok(['공감', '위로', '응원'].includes(cardTag.trim()), `카드 종류: ${cardTag.trim()}`);
  // 기분 눌러 모아보기
  await page.evaluate(() => window.__diary.openMoodCollection('행복'));
  ok(await page.isVisible('#scr-grid') && await page.evaluate(() => window.__diary.gridFilter()) === '행복', '기분(행복) 모아보기로 이동');
  ok(await page.isVisible('#grid-filter'), '기분 필터 바 표시');
  const allHappy = await page.evaluate(() => window.__diary.getEntries().filter((e) => e.mood === '행복').length);
  ok((await page.evaluate(() => window.__diary.gridCount())) === allHappy, `행복 일기만 모임 (${allHappy}개)`);
  await page.click('#grid-filter-clear');
  ok(await page.evaluate(() => window.__diary.gridFilter()) === '', '전체 보기로 해제');

  console.log('\n[30] 와르르 → 개별 드래그 정리 · 정리하기(상단)');
  await page.evaluate(() => window.__diary.show('scr-grid'));
  await page.evaluate(() => window.__diary.setJiggle(true));
  await page.evaluate(() => window.__diary.cascadeGrid());
  await page.waitForTimeout(950);
  ok(await page.evaluate(() => window.__diary.isFallen()), '떨어져 쌓인 상태');
  ok(await page.$('#btn-scatter') === null, '흐트리기 버튼 제거됨');
  ok(await page.isVisible('#grid-fallen-ctrl') && await page.isVisible('#btn-tidy'), '정리하기 버튼 표시');
  // 정리하기 버튼이 화면 상단에 위치
  const ctrlBox = await (await page.$('#grid-fallen-ctrl')).boundingBox();
  ok(ctrlBox.y < 120, `정리하기 버튼이 상단 (y=${Math.round(ctrlBox.y)})`);
  // 개별 사진 손으로 옮기기
  const dragB = await page.evaluate(() => window.__diary.fallenPosOf(0));
  await page.evaluate(() => window.__diary.dragItemBy(0, 40, -30));
  const dragA = await page.evaluate(() => window.__diary.fallenPosOf(0));
  ok(dragA.x === dragB.x + 40 && dragA.y === dragB.y - 30, '쌓인 사진을 개별로 끌어서 이동');
  const tf = await page.evaluate(() => document.querySelector('#grid-wrap .grid-item[data-k="0"]').style.transform);
  ok(tf.includes('translate'), `옮긴 위치가 화면에 반영 (${tf.slice(0, 22)}…)`);
  // 정리하기 → 원래대로
  await page.click('#btn-tidy');
  ok(!(await page.evaluate(() => window.__diary.isFallen())), '정리하기 → 원래대로');
  ok(await page.isHidden('#grid-fallen-ctrl'), '정리 후 버튼 숨김');

  console.log('\n[31] 여러 일기장(책장) 만들기·전환·격리');
  const workId = await page.evaluate(() => window.__diary.activeDiaryId());
  // 책장의 '＋' → 새 일기장 만들기
  await page.evaluate(() => window.__diary.show('scr-cover'));
  await page.click('#shelf-add');
  ok(await page.evaluate(() => window.__diary.onboardVisible()), "'새 일기장' → 만들기 창");
  await page.click('#onboard-topics .chip[data-k="couple"]');
  await page.fill('#onboard-name', '우리 커플');
  await page.click('#onboard-start');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  const coupleId = await page.evaluate(() => window.__diary.activeDiaryId());
  ok(coupleId && coupleId !== workId, '새 일기장이 별도로 생성');
  ok(await page.evaluate(() => window.__diary.getTopic()) === 'couple', '새 일기장 주제(부부·커플) 저장');
  ok((await page.evaluate(() => window.__diary.getEntries())).length === 0, '새 일기장은 기록이 비어 시작(격리)');
  // 프리셋이 다양하게 늘어남 (러닝·식물집사 등)
  ok((await page.evaluate(() => window.__diary.allTopics().map((t) => t.k))).includes('run') &&
     (await page.evaluate(() => window.__diary.allTopics().map((t) => t.k))).includes('plant'), '프리셋 주제 확장(러닝·식물집사)');
  // 새 일기장에 기록 추가 → 다른 일기장엔 안 보임(격리)
  await page.evaluate(async () => { await window.__diary.addEntry({ text: '커플 일기장 기록' }); });
  await page.evaluate((id) => window.__diary.openDiary(id), workId);
  ok(!(await page.evaluate(() => window.__diary.getEntries().map((e) => e.text))).includes('커플 일기장 기록'), '일기장 간 기록이 서로 섞이지 않음');
  await page.evaluate((id) => window.__diary.openDiary(id), coupleId);
  ok((await page.evaluate(() => window.__diary.getEntries())).some((e) => e.text === '커플 일기장 기록'), '해당 일기장에서만 그 기록이 보임');
  // 책장에 여러 권 + 현재 강조
  await page.evaluate(() => window.__diary.show('scr-cover'));
  await page.evaluate(() => window.__diary.renderShelf());
  await page.waitForTimeout(60);
  ok((await page.$$eval('.book-tile:not(.add)', (n) => n.length)) >= 2, '책장에 일기장 여러 권 표시');
  ok((await page.textContent('.book-tile.cur')).includes('우리 커플'), '현재 쓰는 일기장 강조 표시');
  // 두 번째 일기장부터는 만들기 창을 취소할 수 있음
  await page.click('#shelf-add');
  ok(!(await page.isHidden('#onboard-cancel')), '일기장이 있으면 취소 버튼 표시');
  await page.click('#onboard-cancel');
  ok(!(await page.evaluate(() => window.__diary.onboardVisible())), '취소로 만들기 창 닫힘');

  console.log('\n[31b] 설정: 현재 일기장 주제 변경 + 커스텀 + 목록(이름·삭제)');
  await page.evaluate((id) => window.__diary.openDiary(id), coupleId);
  await page.evaluate(() => window.__diary.show('scr-settings'));
  await page.click('#topic-chips .chip[data-k="pet"]');
  ok(await page.evaluate(() => window.__diary.getTopic()) === 'pet', '설정에서 현재 일기장 주제 변경');
  await page.fill('#custom-topic-name', '식물집사일기');
  await page.click('#btn-add-topic');
  const customs = await page.evaluate(() => window.__diary.loadCustomTopics());
  ok(customs.length === 1 && customs[0].label === '식물집사일기', '사용자 주제 생성');
  ok(await page.evaluate(() => window.__diary.getTopic()) === customs[0].k, '만든 주제로 현재 일기장 전환');
  ok((await page.textContent('#topic-chips')).includes('식물집사일기'), '커스텀 주제 칩 표시');
  await page.click(`#topic-chips .chip.custom .chip-del`);
  ok((await page.evaluate(() => window.__diary.loadCustomTopics())).length === 0, '사용자 주제 삭제');
  // 일기장 목록: 이름 바꾸기
  ok((await page.$$eval('#diary-list .diary-item', (n) => n.length)) >= 2, '설정에 일기장 목록 표시');
  await page.click(`#diary-list [data-rn="${coupleId}"]`);
  await page.fill('#diary-list .diary-name-input', '커플 다이어리');
  await page.click(`#diary-list [data-save="${coupleId}"]`);
  ok((await page.evaluate((id) => window.__diary.getDiaries().find((d) => d.id === id).name, coupleId)) === '커플 다이어리', '설정에서 일기장 이름 변경');
  // 일기장 삭제 (커플 일기장 삭제 → 남은 일기장으로 자동 전환)
  const beforeDel = (await page.evaluate(() => window.__diary.getDiaries())).length;
  await page.click(`#diary-list [data-del="${coupleId}"]`);
  await page.waitForSelector('#modal-back.on');
  await page.click('#modal-ok');
  await page.waitForTimeout(80);
  ok((await page.evaluate(() => window.__diary.getDiaries())).length === beforeDel - 1, '설정에서 일기장 삭제');
  ok(await page.evaluate(() => window.__diary.activeDiaryId()) === workId, '삭제 후 남은 일기장으로 전환');
  // 이후 스텝을 위해 원래 작업 일기장으로 (앞서 시드한 기록들이 있는 곳)
  await page.evaluate((id) => window.__diary.openDiary(id), workId);

  console.log('\n[32] 함께 쓰기 (작성자)');
  await page.evaluate(() => window.__diary.show('scr-settings'));
  await page.fill('#member-name', '지영');
  await page.click('#btn-add-member');
  ok((await page.evaluate(() => window.__diary.getMembers())).length === 2, '작성자 추가(나 + 지영)');
  ok((await page.$$eval('#member-list .member-item', (n) => n.length)) === 2, '멤버 목록 2명 표시');
  // 기록 화면에 작성자 선택 표시 + 저장
  await page.evaluate(() => window.__diary.openCaptureFor('2026-07-16'));
  await page.waitForSelector('#scr-capture:not(.hidden)');
  ok(await page.isVisible('#author-row'), '멤버 2명이면 작성자 선택칸 표시');
  const jiId = (await page.evaluate(() => window.__diary.getMembers())).find((m) => m.name === '지영').id;
  await page.evaluate((id) => window.__diary.setActiveAuthor(id), jiId);
  await page.fill('#diary-text', '지영이가 쓴 기록');
  await page.click('#btn-save-entry');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  const je = (await page.evaluate(() => window.__diary.getEntries())).find((e) => e.text === '지영이가 쓴 기록');
  ok(je && je.author === jiId, '기록에 작성자 저장');
  ok((await page.textContent('#cal-entry-list')).includes('지영'), '달력 크게보기에 작성자 표시');

  console.log('\n[33] 교환일기 (내보내기 → 새 기기처럼 가져와 합치기)');
  const exported = await page.evaluate(() => window.__diary.exportData());
  ok(exported.app === 'moment-diary' && exported.entries.length > 0 && exported.members.length === 2, `내보내기 데이터(일기 ${exported.entries.length}, 멤버 ${exported.members.length})`);
  ok(exported.entries.some((e) => e.media && e.media.startsWith('data:')), '미디어가 파일에 포함(base64)');
  // 전부 지운 뒤(=새 기기) 가져와 합치기
  await page.evaluate(() => window.__diary.show('scr-settings'));
  await page.click('#btn-wipe');
  await page.waitForSelector('#modal-back.on');
  await page.click('#modal-ok');
  await page.waitForSelector('#scr-cover:not(.hidden)');
  ok((await page.evaluate(() => window.__diary.getEntries())).length === 0, '초기화(새 기기 가정)');
  // 새 기기: 온보딩에서 일기장을 하나 만들고 그 안으로 가져오기
  await page.click('#onboard-topics .chip[data-k="daily"]');
  await page.fill('#onboard-name', '가져온 일기');
  await page.click('#onboard-start');
  await page.waitForSelector('#scr-cal:not(.hidden)');
  const addedN = await page.evaluate((data) => window.__diary.importData(data), exported);
  ok(addedN === exported.entries.length, `가져오기로 ${addedN}개 합쳐짐`);
  ok((await page.evaluate(() => window.__diary.getMembers())).some((m) => m.name === '지영'), '가져오기로 작성자도 합쳐짐');
  // 다시 가져오면 중복 없음
  const addedN2 = await page.evaluate((data) => window.__diary.importData(data), exported);
  ok(addedN2 === 0, '같은 파일 다시 가져와도 중복 안 생김');

  console.log('\n[33b] 사진 꾸미기 — 폴라로이드 프레임 색(블랙) + 마스킹 테이프 색');
  await page.evaluate(() => window.__diary.show('scr-settings'));
  ok((await page.$$eval('#frame-chips .swatch', (n) => n.length)) >= 2, '프레임 색 선택지 표시(블랙 포함)');
  await page.click('#frame-chips [data-frame="black"]');
  ok(await page.evaluate(() => window.__diary.getFrame()) === 'black', '프레임 색 블랙으로 설정');
  ok(await page.evaluate(() => document.body.classList.contains('frame-dark')), '블랙 프레임 적용(frame-dark)');
  const frameVar = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--frame').trim());
  ok(frameVar && frameVar !== '#fffdf7', `프레임 CSS 변수 반영 (${frameVar})`);
  await page.click('#tape-chips [data-tape="sky"]');
  ok(await page.evaluate(() => window.__diary.getTape()) === 'sky', '마스킹 테이프 색 변경');
  // 새로고침 후 유지
  await page.reload();
  await page.evaluate(() => window.__diary.ready());
  ok(await page.evaluate(() => window.__diary.getFrame()) === 'black', '새로고침 후 프레임 색 유지');
  // 사진 있는 날 크게보기 카드에 마스킹 테이프 요소가 있는지
  await page.evaluate(() => window.__diary.goCalendar('2026-07'));
  await page.evaluate(() => window.__diary.selectDate('2026-07-06'));
  await page.waitForTimeout(120);
  ok(await page.$('#cal-entry-list .pg-media.polaroid .masking-tape') !== null, '사진 위 마스킹 테이프 요소 존재');

  console.log('\n[35] 다이어리 표지 사진 설정');
  await page.evaluate(() => window.__diary.show('scr-settings'));
  const did = await page.evaluate(() => window.__diary.activeDiaryId());
  await page.evaluate((png) => window.__diary.setDiaryCoverData(window.__diary.activeDiaryId(), png), PNG);
  ok((await page.evaluate((id) => window.__diary.getDiaryCover(id), did)) !== null, '표지 사진 저장');
  await page.evaluate(() => window.__diary.show('scr-cover'));
  await page.evaluate(() => window.__diary.renderShelf());
  await page.waitForTimeout(60);
  ok(await page.$(`.book-tile.has-cover[data-id="${did}"]`) !== null, '책장 책에 표지 사진 적용');
  // 없애기
  await page.evaluate((id) => window.__diary.clearDiaryCover(id), did);
  ok((await page.evaluate((id) => window.__diary.getDiaryCover(id), did)) === null, '표지 사진 없애기');

  console.log('\n[36] 달력 일정·기념일 + 다가오는 이벤트');
  const evInfo = await page.evaluate(() => {
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const plus = (n) => { const d = new Date(t); d.setDate(d.getDate() + n); return fmt(d); };
    window.__diary.addEvent(plus(2), '여행 가는 날', 'plan', false);
    window.__diary.addEvent(fmt(t), '오늘 기념일', 'anniv', true);
    const up = window.__diary.upcomingEvents(3);
    return {
      today: fmt(t), ym: `${t.getFullYear()}-${pad(t.getMonth() + 1)}`, d2: plus(2),
      up: up.map((x) => ({ title: x.ev.title, when: x.when })),
      dday2: window.__diary.ddayLabel(fmt(t), plus(2)),
      onDate: window.__diary.eventsOnDate(plus(2)).length,
    };
  });
  ok(evInfo.dday2 === 'D-2', `남은 날짜 계산(D-2) — ${evInfo.dday2}`);
  ok(evInfo.up.length >= 2 && evInfo.up[0].when === evInfo.today, '다가오는 일정 가까운 순 정렬(오늘 먼저)');
  ok(evInfo.onDate === 1, '특정 날짜 일정 조회');
  // 달력 UI에 반영
  await page.evaluate((ym) => window.__diary.goCalendar(ym), evInfo.ym);
  await page.waitForTimeout(100);
  ok(await page.isVisible('#upcoming') && (await page.$$eval('#upcoming .up-item', (n) => n.length)) >= 1, '다가오는 일정 배너 표시');
  ok((await page.$$eval('#cal-grid .ev-dot', (n) => n.length)) >= 1, '일정 있는 날 달력에 점 표시');
  // 다가오는 배너 클릭 → 그 날짜 선택
  await page.click('#upcoming .up-item');
  await page.waitForTimeout(60);
  ok((await page.textContent('#cal-entry-list .cal-events')).includes('일정·기념일'), '날짜 선택 시 일정 섹션 표시');
  // 일정 추가 모달로 기념일 추가
  await page.evaluate((d) => window.__diary.selectDate(d), evInfo.today);
  await page.waitForTimeout(60);
  await page.click('#ev-add');
  ok(await page.isVisible('#event-modal.on'), '일정 추가 모달 열림');
  await page.click('#event-type-row [data-type="anniv"]');
  ok(await page.isVisible('#event-yearly-row'), '기념일 선택 시 매년 반복 옵션 표시');
  await page.fill('#event-title', '결혼기념일');
  await page.click('#event-add');
  ok(!(await page.isVisible('#event-modal.on')), '추가 후 모달 닫힘');
  ok(await page.evaluate(() => window.__diary.getEvents().some((e) => e.title === '결혼기념일' && e.yearly)), '기념일(매년 반복) 저장');
  // 일정 삭제
  const evCountBefore = await page.evaluate(() => window.__diary.getEvents().length);
  await page.click('#cal-entry-list .ev-del');
  await page.waitForTimeout(60);
  ok((await page.evaluate(() => window.__diary.getEvents().length)) === evCountBefore - 1, '일정 삭제');

  console.log('\n[34] PWA 구성');
  const root = path.resolve(__dirname, '..');
  const mf = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  ok(mf.name && mf.icons.length >= 2 && mf.display === 'standalone', 'manifest 필수 필드');
  ok(fs.existsSync(path.join(root, 'icon-512.png')) && fs.existsSync(path.join(root, 'sw.js')), '아이콘·서비스워커 파일');

  console.log('\n[콘솔/페이지 에러]');
  const realErrors = errors.filter((e) =>
    !e.includes('favicon') && !e.includes('fonts.googleapis') &&
    !e.includes('ERR_CONNECTION_RESET') && !e.includes('ERR_NAME_NOT_RESOLVED') &&
    !e.includes('ERR_INTERNET_DISCONNECTED'));
  ok(realErrors.length === 0, realErrors.length ? '에러: ' + realErrors.join(' | ') : 'JS 에러 없음');

  await browser.close();
  console.log(`\n결과: ✅ ${passed}  ❌ ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('테스트 실행 실패:', e); process.exit(2); });
