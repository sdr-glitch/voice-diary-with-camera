# 순간일기 — 프로젝트 규약

음성+카메라 일기 앱. 스토어 판매 목표. 사용자는 코딩을 모르므로 모든 결정은 "링크 하나로 바로 쓸 수 있는가" 기준.

## 철칙

1. **무의존성 정적 앱**: 빌드 도구·프레임워크·npm 금지. 순수 HTML/CSS/JS (`index.html` + `app.js` + `style.css`).
2. **렌더링을 막는 외부 리소스 금지**: 외부 폰트는 비차단 로드(`media="print" onload`)만 허용.
3. **한국어 UI, 초보자 눈높이**: 에러 메시지는 "무엇을 하면 되는지"까지 안내. `window.prompt/confirm` 금지 — 전용 모달(`#modal-back`) 사용.
4. **안전망 우선**: 카메라·마이크·음성인식·녹화가 실패해도 앱이 죽지 않고 대안(직접 입력, 글만 저장)을 안내해야 함.
5. **3D CSS 변환 금지**: 페이지 넘김은 2D `scaleX` 애니메이션 유지 (3D rotate는 환경에 따라 납작하게 뭉개지는 사고 이력).
6. **색은 `:root` 토큰으로만**: 디자인은 추후 전면 교체 예정이므로 하드코딩 금지.
7. **기능을 추가/변경할 때마다 반드시 스모크 테스트 실행·통과** (아래). 새 기능에는 테스트 단계도 함께 추가.

## 저장 구조

- IndexedDB `moment-diary` / store `entries` — `{ id, date(YYYY-MM-DD), ts, kind: photo|video|none, blob, thumb, filter, weather, text }`
- localStorage는 `momentDiary:` 접두사 (작은 상태만)
- 전체 초기화는 IndexedDB 삭제 + `momentDiary:*` 키 삭제 둘 다 필요

## 테스트

```bash
NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/smoke.js
```

- headless Chromium + `--use-fake-device-for-media-stream`(가짜 카메라)으로 전 구간 검증
- **테스트 훅** `window.__diary`: `ready() getEntries() getPageIndex() show(id) flip(dir) saveEntry() deleteEntry(id) buildVlog(ym) addEntry({date,text,weather,filter,kind,dataURL}) camState() testFilter(name) speechSupported()`
- 큰 기록은 IndexedDB에 있으므로 localStorage 직접 읽기/시드 금지 — 훅 사용
- 음성 받아쓰기는 headless에서 실제 변환 불가 → 안내 문구 + 직접 입력 경로만 검증

## 핵심 흐름

촬영: `openCapture()` → 실시간 필터 루프(`drawFiltered`) → `shutter()` = 사진(`toBlob`) 또는 2초 영상(`captureStream`+MediaRecorder) → `saveEntry()`.
필터: `vintage`(ctx.filter 세피아 + 비네트 + 그레인, 미지원 브라우저는 `applyPixelFilter` 폴백) · `colorpop` · `fisheye`(좌표맵 캐시 `buildFisheyeMap`).
브이로그: `buildVlog(ym)` — 인트로 → 엔트리별 슬라이드(사진 1.3초/영상 최대 2.4초, 손상 미디어는 건너뜀) → 아웃트로, canvas 녹화로 webm 반환.
책: `entries` 날짜순 정렬, 데스크톱 2쪽/모바일(≤720px) 1쪽, `flip()`은 2D scaleX.
