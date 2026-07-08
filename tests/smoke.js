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
