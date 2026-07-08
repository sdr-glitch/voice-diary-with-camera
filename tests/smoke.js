/* 순간일기 스모크 테스트 — headless Chromium + 가짜 카메라
   실행: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/smoke.js
   (playwright 전역 설치 + Chromium 필요. 기능을 추가/변경할 때마다 반드시 실행할 것) */
const path = require('path');
const { chromium } = require('playwright');

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
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
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  console.log('\n[1] 로드 & 표지');
  await page.goto(URL);
  await page.evaluate(() => window.__diary.ready());
  ok(await page.isVisible('#scr-cover'), '표지 화면 표시');
  ok((await page.textContent('#cover-count')).includes('첫 순간'), '빈 상태 문구');

  console.log('\n[2] 책 펼치기 (빈 상태)');
  await page.click('#btn-open-book');
  ok(await page.isVisible('#scr-book'), '책 화면 전환');
  ok((await page.textContent('#page-right')).includes('비어 있어요') ||
     (await page.textContent('#page-left')).includes('비어 있어요'), '빈 페이지 안내');

  console.log('\n[3] 필터 단위 검증');
  const f = await page.evaluate(() => ({
    none: window.__diary.testFilter('none'),
    vintage: window.__diary.testFilter('vintage'),
    colorpop: window.__diary.testFilter('colorpop'),
    fisheye: window.__diary.testFilter('fisheye'),
  }));
  const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
  ok(diff(f.none.q1, f.vintage.q1) > 10, `빈티지 필터가 색을 바꿈 (차이 ${diff(f.none.q1, f.vintage.q1)})`);
  ok(diff(f.none.q1, f.colorpop.q1) > 10, `색감강조 필터가 색을 바꿈 (차이 ${diff(f.none.q1, f.colorpop.q1)})`);
  ok(diff(f.none.corner, f.fisheye.corner) > 10, `볼록거울 필터가 왜곡함 (차이 ${diff(f.none.corner, f.fisheye.corner)})`);

  console.log('\n[4] 카메라 — 사진 촬영 → 저장');
  await page.click('#btn-new');
  await page.waitForFunction(() => window.__diary.camState().hasStream, null, { timeout: 8000 });
  ok(true, '가짜 카메라 스트림 시작');
  await page.click('#filter-row .chip[data-filter="vintage"]');
  await page.click('#btn-shutter');
  await page.waitForFunction(() => window.__diary.camState().captured === 'photo', null, { timeout: 5000 });
  ok(await page.isVisible('#cap-preview-img'), '사진 미리보기 표시');
  await page.fill('#diary-text', '노을이 유난히 붉었던 날. 필터 테스트 중.');
  await page.click('.wchip[data-weather="☀️"]');
  await page.click('#btn-save-entry');
  await page.waitForSelector('#scr-book:not(.hidden)');
  let list = await page.evaluate(() => window.__diary.getEntries());
  ok(list.length === 1 && list[0].kind === 'photo' && list[0].blobSize > 500, `사진 엔트리 저장 (blob ${list[0].blobSize}B)`);
  ok(list[0].weather === '☀️' && list[0].filter === 'vintage', '날씨·필터 메타 저장');
  ok(await page.isVisible('#page-left img, #page-right img'), '페이지에 사진 렌더링');

  console.log('\n[5] 카메라 — 2초 영상 촬영 → 저장');
  await page.click('#btn-new');
  await page.waitForFunction(() => window.__diary.camState().hasStream, null, { timeout: 8000 });
  await page.click('#mode-toggle button[data-mode="video"]');
  await page.click('#filter-row .chip[data-filter="fisheye"]');
  await page.click('#btn-shutter');
  await page.waitForFunction(() => window.__diary.camState().captured === 'video', null, { timeout: 10000 });
  ok(await page.isVisible('#cap-preview-video'), '영상 미리보기 표시');
  await page.fill('#diary-text', '바람 소리를 담아본 2초.');
  await page.click('#btn-save-entry');
  await page.waitForSelector('#scr-book:not(.hidden)');
  list = await page.evaluate(() => window.__diary.getEntries());
  const vid = list.find((e) => e.kind === 'video');
  ok(!!vid && vid.blobSize > 1000, `영상 엔트리 저장 (blob ${vid ? vid.blobSize : 0}B)`);

  console.log('\n[6] 음성 안전망 (headless는 받아쓰기 불가 → 안내 후 직접 입력)');
  await page.click('#btn-new');
  await page.waitForFunction(() => window.__diary.camState().hasStream, null, { timeout: 8000 });
  await page.click('#btn-mic');
  await page.waitForTimeout(1200);
  const vs = await page.textContent('#voice-status');
  ok(vs.length > 0, `음성 상태 안내 표시: "${vs.slice(0, 40)}…"`);
  await page.fill('#diary-text', '직접 입력도 잘 된다.');
  await page.click('#btn-save-entry'); // 미디어 없이 글만 저장
  await page.waitForSelector('#scr-book:not(.hidden)');
  list = await page.evaluate(() => window.__diary.getEntries());
  ok(list.some((e) => e.kind === 'none' && e.text.includes('직접 입력')), '글만 있는 일기 저장');

  console.log('\n[7] 페이지 넘김');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGklEQVR4nGP8z8Dwn4GBgYGJAQowMdAXAABrqgEDOA0cRwAAAABJRU5ErkJggg==';
  await page.evaluate(async (png) => {
    await window.__diary.addEntry({ date: '2026-06-03', text: '유월의 산책', weather: '⛅', dataURL: png });
    await window.__diary.addEntry({ date: '2026-06-15', text: '비 오는 창가', weather: '🌧️', dataURL: png });
  }, png);
  await page.evaluate(() => window.__diary.show('scr-book'));
  const before = await page.evaluate(() => window.__diary.getPageIndex());
  await page.evaluate(() => window.__diary.flip(-1));
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => window.__diary.getPageIndex());
  ok(after < before, `이전으로 넘김 (${before} → ${after})`);
  await page.click('#btn-next');
  await page.waitForTimeout(600);
  const after2 = await page.evaluate(() => window.__diary.getPageIndex());
  ok(after2 === before, `다음으로 넘김 (${after} → ${after2})`);
  ok((await page.textContent('#pg-indicator')).includes('쪽'), '쪽수 표시');

  console.log('\n[8] 월말 브이로그 생성 (webm 합성)');
  await page.click('#btn-go-vlog');
  const opts = await page.$$eval('#vlog-month option', (o) => o.map((x) => x.value));
  ok(opts.includes('2026-06'), `월 목록: ${opts.join(', ')}`);
  await page.selectOption('#vlog-month', '2026-06');
  await page.click('#btn-make-vlog');
  await page.waitForSelector('#vlog-result.on', { timeout: 40000 });
  const vlogSize = await page.evaluate(async () => {
    const v = document.querySelector('#vlog-video');
    const b = await (await fetch(v.src)).blob();
    return b.size;
  });
  ok(vlogSize > 5000, `브이로그 webm 생성 (${vlogSize}B)`);

  console.log('\n[9] 새로고침 후 데이터 유지 (IndexedDB)');
  await page.reload();
  await page.evaluate(() => window.__diary.ready());
  list = await page.evaluate(() => window.__diary.getEntries());
  ok(list.length === 5, `새로고침 후 ${list.length}/5개 유지`);
  ok(list.filter((e) => e.blobSize > 0).length >= 4, '미디어 blob 유지');

  console.log('\n[10] 기록 한 개 삭제');
  await page.evaluate(() => window.__diary.show('scr-book'));
  const delTarget = list.find((e) => e.text.includes('유월의 산책'));
  await page.evaluate((id) => window.__diary.deleteEntry(id), delTarget.id);
  await page.waitForTimeout(300);
  list = await page.evaluate(() => window.__diary.getEntries());
  ok(list.length === 4 && !list.some((e) => e.text.includes('유월의 산책')), '개별 기록 삭제');
  await page.reload();
  await page.evaluate(() => window.__diary.ready());
  list = await page.evaluate(() => window.__diary.getEntries());
  ok(list.length === 4, '삭제가 저장소에도 반영');

  console.log('\n[11] 전체 삭제');
  await page.evaluate(() => window.__diary.show('scr-settings'));
  await page.click('#btn-wipe');
  await page.waitForSelector('#modal-back.on');
  await page.click('#modal-ok');
  await page.waitForSelector('#scr-cover:not(.hidden)');
  list = await page.evaluate(() => window.__diary.getEntries());
  ok(list.length === 0, '모든 기록 삭제');

  console.log('\n[12] PWA 구성 (manifest·아이콘·서비스 워커)');
  const fs = require('fs');
  const root = path.resolve(__dirname, '..');
  ok(await page.$('link[rel="manifest"]') !== null, 'manifest 링크 존재');
  const mf = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  ok(mf.name && mf.icons && mf.icons.length >= 2 && mf.display === 'standalone', 'manifest 필수 필드');
  ok(fs.existsSync(path.join(root, 'icon-192.png')) && fs.existsSync(path.join(root, 'icon-512.png')), '앱 아이콘 파일 존재');
  ok(fs.existsSync(path.join(root, 'sw.js')), '서비스 워커 파일 존재 (file://에선 등록 스킵)');

  console.log('\n[13] 달력에서 날짜 점프');
  await page.evaluate(async (png) => {
    await window.__diary.addEntry({ date: '2026-06-03', text: '유월 첫 기록', weather: '⛅', dataURL: png });
    await window.__diary.addEntry({ date: '2026-06-15', text: '비 오는 창가', weather: '🌧️', dataURL: png });
    await window.__diary.addEntry({ date: '2026-07-02', text: '칠월의 시작', weather: '☀️', dataURL: png, stickers: [{ e: '⭐', x: 0.3, y: 0.3, s: 0.2 }] });
  }, png);
  await page.evaluate(() => window.__diary.show('scr-book'));
  await page.click('#btn-cal');
  ok(await page.isVisible('#cal-back.on'), '달력 열림');
  ok((await page.textContent('#cal-title')).includes('2026년 6월'), '보고 있는 달(6월) 표시');
  ok((await page.$$eval('.cal-day.has', (b) => b.length)) === 2, '기록 있는 날 2개 표시');
  await page.click('.cal-day.has'); // 6월 3일
  await page.waitForTimeout(300);
  const jumped = await page.evaluate(() => window.__diary.getPageIndex());
  ok(jumped === 0, `해당 날짜 페이지로 점프 (index ${jumped})`);
  ok((await page.textContent('#page-left')).includes('유월 첫 기록'), '점프한 페이지 내용 확인');
  // 다음 달로 넘겨 7월 기록으로 점프
  await page.click('#btn-cal');
  await page.click('#cal-next');
  ok((await page.textContent('#cal-title')).includes('2026년 7월'), '다음 달로 이동');
  await page.click('.cal-day.has'); // 7월 2일
  await page.waitForTimeout(300);
  const jumped2 = await page.evaluate(() => window.__diary.getPageIndex());
  ok(jumped2 === 2, `7월 기록으로 점프 (index ${jumped2})`);
  ok(await page.isVisible('#page-left .stk'), '시드한 스티커가 페이지에 렌더링');

  console.log('\n[14] 스티커 꾸미기 (촬영 → 부착 → 이동 → 저장)');
  await page.click('#btn-new');
  await page.waitForFunction(() => window.__diary.camState().hasStream, null, { timeout: 8000 });
  await page.click('#btn-shutter');
  await page.waitForFunction(() => window.__diary.camState().captured === 'photo', null, { timeout: 5000 });
  ok(await page.isVisible('#deco-box'), '촬영 후 꾸미기 도구 표시');
  await page.click('#sticker-palette .schip'); // ⭐
  let stks = await page.evaluate(() => window.__diary.getStickers());
  ok(stks.length === 1 && stks[0].e === '⭐', '스티커 부착 (가운데)');
  // 드래그로 왼쪽 위로 이동
  const lay = await page.$('#sticker-layer');
  const lb = await lay.boundingBox();
  await page.mouse.move(lb.x + lb.width * 0.5, lb.y + lb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(lb.x + lb.width * 0.25, lb.y + lb.height * 0.25, { steps: 6 });
  await page.mouse.up();
  stks = await page.evaluate(() => window.__diary.getStickers());
  ok(stks[0].x < 0.35 && stks[0].y < 0.35, `드래그로 이동 (x=${stks[0].x.toFixed(2)}, y=${stks[0].y.toFixed(2)})`);
  await page.click('#stk-bigger');
  stks = await page.evaluate(() => window.__diary.getStickers());
  ok(stks[0].s > 0.16, `크기 키우기 (s=${stks[0].s.toFixed(2)})`);
  await page.fill('#diary-text', '스티커 테스트한 날');
  await page.click('#btn-save-entry');
  await page.waitForSelector('#scr-book:not(.hidden)');
  const saved = (await page.evaluate(() => window.__diary.getEntries())).find((e) => e.text.includes('스티커 테스트'));
  ok(saved && saved.stickers.length === 1, '스티커가 일기와 함께 저장');
  ok(await page.isVisible('.pg-media .stk'), '페이지 위에 스티커 렌더링');

  console.log('\n[15] 브이로그 배경음악 (자체 합성 검증)');
  const rmsP = await page.evaluate(() => window.__diary.bgmSample('piano'));
  const rmsM = await page.evaluate(() => window.__diary.bgmSample('musicbox'));
  ok(rmsP > 0.0005, `피아노 음원이 실제 소리를 냄 (진폭 ${rmsP.toFixed(4)})`);
  ok(rmsM > 0.0005, `오르골 음원이 실제 소리를 냄 (진폭 ${rmsM.toFixed(4)})`);
  const vA = await page.evaluate(async () => {
    const b = await window.__diary.buildVlog('2026-06', () => {}, { bgm: 'piano', fx: true });
    return { size: b.size, tracks: window.__diary._lastVlogAudioTracks };
  });
  ok(vA.tracks === 1, '브이로그에 소리 트랙 포함');
  ok(vA.size > 5000, `배경음악 브이로그 생성 (${vA.size}B)`);

  console.log('\n[16] 내 음원 파일 사용');
  // 0.5초 440Hz 사인파 wav 생성 (16bit PCM)
  const sr = 44100, n = sr / 2;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000), 44 + i * 2);
  const wavPath = path.join(__dirname, 'tmp-tone.wav');
  fs.writeFileSync(wavPath, wav);
  await page.evaluate(() => window.__diary.show('scr-vlog'));
  await page.selectOption('#vlog-bgm', 'user');
  ok(await page.isVisible('#user-audio-row'), '음원 파일 선택칸 표시');
  await page.setInputFiles('#vlog-user-audio', wavPath);
  await page.waitForFunction(() => window.__diary.userAudioLoaded(), null, { timeout: 5000 });
  ok(true, '사용자 음원 로드');
  const vU = await page.evaluate(async () => {
    const b = await window.__diary.buildVlog('2026-06', () => {}, { bgm: 'user', fx: false });
    return { size: b.size, tracks: window.__diary._lastVlogAudioTracks };
  });
  ok(vU.tracks === 1 && vU.size > 5000, `내 음원으로 브이로그 생성 (${vU.size}B)`);
  fs.unlinkSync(wavPath);

  console.log('\n[콘솔/페이지 에러]');
  // 외부 네트워크 차단(폰트 등)은 앱 오류 아님 — 비차단 로드라 렌더링 영향 없음
  const realErrors = errors.filter((e) =>
    !e.includes('favicon') && !e.includes('fonts.googleapis') &&
    !e.includes('ERR_CONNECTION_RESET') && !e.includes('ERR_NAME_NOT_RESOLVED') &&
    !e.includes('ERR_INTERNET_DISCONNECTED'));
  ok(realErrors.length === 0, realErrors.length ? '에러: ' + realErrors.join(' | ') : 'JS 에러 없음');

  await browser.close();
  console.log(`\n결과: ✅ ${passed}  ❌ ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('테스트 실행 실패:', e); process.exit(2); });
