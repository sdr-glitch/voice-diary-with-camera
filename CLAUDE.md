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

8. **음원·효과음은 자체 합성만**: 외부 무료 음원 파일을 저장소에 넣지 말 것 — "무료" 표기여도 상업 재배포 라이선스 위반 위험. 기본 소리는 전부 WebAudio 합성(`scheduleBgmBar`, `playFx`), 사용자 음원은 업로드 방식(책임 안내 문구 유지).

## 화면 흐름

표지(누르면 진입) → **달력(홈)** → (기록 있는 날 클릭 → 책 / 오늘 클릭 → 기록) → 기록(카메라·음성) → 저장 시 책. 상단 '순간일기' 제목은 항상 표지로. 하위 화면(기록·브이로그·설정)은 `openSub()`가 돌아갈 화면(`backTo`)을 기억.

## UI 규칙

- **장식용 이모티콘 금지**: 제목·버튼·라벨·토스트에 이모지를 넣지 말 것(스토어 대비 깔끔함). 단 **콘텐츠 선택용 이모지 피커는 허용** — 스티커 팔레트(꾸미기 기능), 날씨 칩. 기분은 텍스트 칩.
- 페이지는 평면 종이(줄무늬·테두리 드리운 그림자 "커튼" 제거). 글이 밀려 보이지 않게 미디어→텍스트 자연 흐름.

## 저장 구조

- IndexedDB `moment-diary` / store `entries` — `{ id, date(YYYY-MM-DD), ts, kind: photo|video|none, blob, thumb, filter, durMs, weather, mood, stickers:[{e,x,y,s}], text }`
  (스티커는 미디어에 굽지 않고 메타데이터로 저장 → 페이지에선 오버레이, 브이로그에선 캔버스에 그림)
- 영상은 **길이 제한 없음**: 셔터로 녹화 시작/정지 토글(`startVideoRec`/`stopVideoRec`), `durMs` 저장. 녹화 중에도 캔버스가 갱신돼야 captureStream에 담김(`!(captured&&captured.blob)`일 때 draw).
- localStorage는 `momentDiary:` 접두사 (작은 상태만)
- 전체 초기화는 IndexedDB 삭제 + `momentDiary:*` 키 삭제 둘 다 필요

## 테스트

```bash
NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/smoke.js
```

- headless Chromium + `--use-fake-device-for-media-stream`(가짜 카메라)으로 전 구간 검증
- **테스트 훅** `window.__diary`: `ready() getEntries() getPageIndex() show(id) flip(dir) saveEntry() deleteEntry(id) buildVlog(ym,onProg,{bgm,fx,title,targetSec,ids}) addEntry({date,text,weather,mood,filter,kind,dataURL,stickers,durMs}) camState()(recording 포함) testFilter(name) speechSupported() addSticker(emoji) getStickers() goCalendar(ym) jumpToEntry(idx) startVideoRec()/stopVideoRec()/isRecording() getClips()/moveClip(i,dir)/toggleClip(i,on)/setTarget(sec) bgmSample(name) userAudioLoaded() _lastVlogAudioTracks`
- 큰 기록은 IndexedDB에 있으므로 localStorage 직접 읽기/시드 금지 — 훅 사용
- 음성 받아쓰기는 headless에서 실제 변환 불가 → 안내 문구 + 직접 입력 경로만 검증

## 핵심 흐름

촬영: `openCapture()` → 실시간 필터 루프(`drawFiltered`) → `shutter()` = 사진(`toBlob`) 또는 2초 영상(`captureStream`+MediaRecorder) → `saveEntry()`.
필터: `vintage`(ctx.filter 세피아 + 비네트 + 그레인, 미지원 브라우저는 `applyPixelFilter` 폴백) · `colorpop` · `fisheye`(좌표맵 캐시 `buildFisheyeMap`).
브이로그: `buildVlog(ym, onProg, opts)` — opts.ids(편집기에서 고른 장면 순서)·targetSec(기본 60)로 **전체를 목표 길이에 압축**(한 장면 slotMs = clamp(body/장면수, 0.5~5초)), 영상은 slotMs만큼만 보여줌(loop). 인트로(opts.title) → 스티커·자막 오버레이 → 아웃트로. 소리는 `MediaStreamAudioDestinationNode` 트랙을 canvas 스트림에 합쳐 녹화(소리 실패 시 무음). BGM은 소절 예약 스케줄러(500ms pump).
간단 편집기: `#clip-list`(체크로 포함/제외, ▲▼ 순서), `#vlog-len`(30/60/90초), `#vlog-title`. 상태 `vlogClips`/`vlogTargetSec`.
스티커: 촬영 후 `#sticker-layer`에서 부착·드래그(포인터 캡처)·크기 조절, `capStickers` → entry.stickers. 페이지 렌더 후 `sizePageStickers()`가 컨테이너 폭 기준 픽셀 크기 계산.
책: `entries` 날짜순 정렬, 데스크톱 2쪽/모바일(≤720px) 1쪽, `flip()`은 2D scaleX. 빈 페이지 클릭 → 기록. 달력(홈, `renderCal`)은 날짜별 첫 엔트리 인덱스로 `jumpToEntry`, 오늘 셀은 기록으로.
