# @web-ppt/core 사본(vendor)

ppt·pptx 렌더러 [`@web-ppt/core`](https://github.com/unStone/web-ppt)(MIT) 0.4.5의 core 패키지 소스를 그대로 가져와 구형 .ppt 보강 패치를 얹은 사본이다.

- 출처: `https://github.com/unStone/web-ppt` 태그 `v0.4.5`(커밋 `6285c655367bd4cd3b9c5c429b04b6368160aa1f`)의 `packages/core/src`
- 라이선스: [LICENSE](LICENSE)(MIT, 원문 그대로)
- 사용처: `web/package.json`(앱)과 `spike/renderer-eval/package.json`(검증 하네스)이 `file:` 의존성으로 같은 사본을 쓴다.

## 소스(TypeScript)를 두는 이유

빌드한 dist 대신 TypeScript 소스를 두고 Vite가 앱과 함께 빌드하게 했다.

- 고칠 곳이 소스 한 벌뿐이다. dist를 두면 포크에서 고치고 빌드한 뒤 복사하는 단계가 늘고, 둘이 어긋나도 알아채기 어렵다.
- 업스트림 대비 변경이 읽을 수 있는 소스 diff로 남는다. 압축된 dist는 diff를 읽을 수 없다.
- Vite가 이미 앱 번들을 만들고 있어 TS 변환 비용이 따로 들지 않는다. 번들 크기는 npm 0.4.5 dist와 거의 같다(slides 청크 gzip 104.5KB → 104.1KB).
- 타입 검사는 빌드에서 하지 않는다(Vite는 타입만 지운다). 필요하면 포크에서 `tsc`로 확인한다.

## 고친 뒤 할 일

`file:` 의존성은 pnpm이 `node_modules/.pnpm/` 아래에 하드 링크 사본을 만든다. 편집기가 파일을 새로 써서 링크가 끊기면 사본이 옛 내용으로 남으므로, 소스를 고친 뒤에는 쓰는 곳마다 `pnpm install`을 다시 실행한다.

```bash
pnpm --dir web install && pnpm --dir web build
pnpm --dir spike/renderer-eval install && pnpm --dir spike/renderer-eval build
```

Android의 `buildWebViewer` 작업은 `web/vendor/`도 입력으로 보므로 소스가 바뀌면 웹 번들을 다시 만든다(이때도 위 `pnpm install`은 먼저 해 둔다).

## 업스트림 0.4.5 대비 변경

전체 차이는 [upstream-0.4.5.diff](upstream-0.4.5.diff)에 있다(업스트림 저장소 루트에서 `git apply upstream-0.4.5.diff`).
고친 곳은 모두 .ppt(PowerPoint 97~2003) 경로인 `src/ppt/`뿐이고 pptx 경로는 건드리지 않았다. 코드에는 `[doc-viewer]` 표시를 달았다.

### 글자 누락

| 원인 | 고친 곳 |
|---|---|
| PowerPoint 97~2003이 저장한 제목·본문 자리표시자는 글자를 `SlideListWithText`에 두고 도형에는 순번(`OutlineTextRefAtom`)만 남기는데, 이 순번을 읽지 않았다. 실제 문서에서 글자가 통째로 빠진 가장 큰 원인이다. | `parser.ts` `persistList`(슬라이드별 텍스트 묶음 수집), `styledText`, `parseSpContainer` |
| '빠른 저장' 파일은 저장할 때마다 Document·Slide·디렉터리가 스트림 뒤에 덧붙는다. 스트림의 첫(가장 오래된) Document를 써서 슬라이드 목록과 글자가 옛 판으로 나왔다(쪽 수 12/71 같은 불일치). `Current User` → `UserEditAtom` 사슬로 지속성 디렉터리와 현재 Document를 찾고, 레코드는 디렉터리 오프셋에서 바로 읽는다. | `parser.ts` `editChain`, `recAt`, `parsePpt` |
| 마스터의 바닥글·쪽 번호·날짜 자리표시자를 그리지 않았다. 문서·슬라이드의 `HeadersFooters` 설정에 따라 그리고, 글 속 필드 자리 문자(`*` + `*MCAtom`)를 실제 값으로 바꾼다. 날짜 필드는 필드마다 정한 형식(`DateTimeMCAtom.index`)으로 오늘 날짜를 쓴다. | `parser.ts` `hfPlaceholders`, `readHeadersFooters`, `spliceField`, `formatToday`, `parseSlide` |
| 메모가 `SlideListWithText`(메모 목록)에만 있는 파일은 메모 글을 놓쳤다. | `parser.ts` `outlineNotes` |

### 글자 모양

| 원인 | 고친 곳 |
|---|---|
| 글자 색(`ColorIndexStruct`)을 도형 색 규칙으로 풀어 구성표 1번(본문 글자색)이 0번(배경색)으로, 2~7번이 검정으로 나왔다(어두운 배경에서 글자가 안 보임). | `parser.ts` `textColor` |
| 마스터 글자 스타일을 해당 단계 하나만 봤다. 아래 단계와 기준 종류(가운데 제목 → 제목, 가운데 본문 → 본문)에서 물려받게 했다. 제목 마스터는 기본 마스터의 스타일을 쓴다. | `parser.ts` `levelStyleOf`, `TX_BASE`, `parseMaster` |
| 슬라이드 자리표시자가 마스터 도형(`hspMaster`)의 세로 정렬·여백·채우기를 물려받지 않았다. 글 상자 여백도 고정값 대신 도형 속성을 쓴다. `anchorText` 5·6번 해석도 바로잡았다. | `escher.ts` `inheritProps`, `parser.ts` `textBoxProps`, `buildTextBody` |
| 글머리표 글꼴(Wingdings 'l' → ●)·색·크기, 줄 간격·문단 앞뒤 간격, 첫 줄 들여쓰기를 읽지 않았다. 줄 바꿈(`\v`)으로 이어진 줄에도 글머리표를 붙였다. | `parser.ts` `readParaProps`, `bulletLook`, `bulletChar`, `buildTextBody` |

### 마스터·배경 깨짐

| 원인 | 고친 곳 |
|---|---|
| 배열 속성(꼭짓점·구간 등)의 길이에 6바이트 머리가 빠진 파일(PowerPoint·LibreOffice 모두 그렇게 쓴다)에서 뒤따르는 복합 속성 위치가 밀렸고, 원소 크기 0xFFF0(4바이트)을 음수로 써서 꼭짓점을 거꾸로 읽었다. 자유형 도형이 사각형 조각으로 그려진 원인이다. | `escher.ts` `parseOpt`, `arrayElementSize`, `parser.ts` `customPath` |
| 경로 구간을 잘못 풀었다(곡선 `0x2001`을 직선으로, 꼭짓점 종류 표시 `0xB300`을 곡선으로). [MS-ODRAW] MSOPATHINFO대로 풀고 타원 사분호·2차 베지어도 그린다. | `parser.ts` `customPath` |
| `fSysIndex` 색(채우기색을 어둡게·밝게 등)을 RGB로 읽어 그라데이션 끝색이 자주색으로 나왔다. LibreOffice `MSO_CLR_ToColor`와 같은 규칙으로 푼다. | `escher.ts` `colorRgb`, `propColorRef` |
| 그라데이션 각도·초점을 무시하고 늘 위→아래로 그렸다. LibreOffice `ImportGradientColor`와 같은 방향·색 순서(축 대칭·사각형형 포함)로 그린다. | `escher.ts` `gradientFill` |
| 슬라이드 색 구성표가 마스터와 다를 때도 마스터 도형·배경을 마스터 구성표로 칠했다. 구성표마다 마스터를 따로 해석한다. | `parser.ts` `masterFor` |
| '마스터 구성표 따름'(SlideFlags bit 1) 플래그를 보지 않고 슬라이드에 남은 ColorSchemeAtom(대개 기본 흰 구성표)을 써서 파란 배경·흰 글자 디자인이 흰 배경·검은 글자로 나왔다. 플래그가 켜져 있으면 마스터(제목 마스터는 다시 그 마스터) 구성표를 쓴다(LibreOffice `GetColorFromPalette`와 같다). | `parser.ts` `parseSlide`, `parseMaster` |
| 배경 도형이 '채움'을 명시했는데 색이 없으면 건너뛰어 구성표 0번 색으로 칠했다. [MS-ODRAW] 기본 채우기색인 흰색으로 칠한다. | `parser.ts` `drawingBackground` |
| 빈 문단에도 글머리표를 그렸다. | `parser.ts` `buildTextBody` |

### 그림

| 원인 | 고친 곳 |
|---|---|
| 도형의 그림 번호(pib)는 BStore의 BSE 순번인데 Pictures 스트림의 n번째 그림으로 읽었다. 지운 그림의 빈 BSE가 남은 파일에서 번호가 밀려 다른 그림(다른 OLE 미리보기 등)이 나왔다. BSE의 `foDelay` 위치에서 읽는다. | `escher.ts` `blipsFromStore`, `parser.ts` `parsePpt` |
| DIB 그림을 BMP 파일 머리 없이 `image/bmp`로 넘겨 브라우저가 그리지 못했다. 14바이트 머리를 붙인다. | `escher.ts` `dibToBmp` |

### 열지 못하던 파일

| 원인 | 고친 곳 |
|---|---|
| 문서 구조는 멀쩡한데 슬라이드가 없는 빈 프레젠테이션(`empty.ppt`)을 오류로 처리했다. Document 안 레코드가 끝까지 온전하면 마스터 배경의 빈 슬라이드 한 장으로 연다. 중간이 깨진 파일은 지금처럼 오류로 둔다. | `parser.ts` `parsePpt`, `wellFormed` |
| 중간 레코드 길이가 깨져 순차 탐색이 멈춘 파일은 슬라이드를 찾지 못했다. 지속성 디렉터리 오프셋에서 바로 읽는다. | `parser.ts` `recAt`, `parsePpt` |
| PowerPoint 95/97 이중 저장 파일은 루트에 95 형식, `PP97_DUALSTORAGE` 저장소 안에 97 형식 스트림을 같은 이름으로 둔다. 이름만으로 찾아 95 형식을 잡았다. 저장소 안 스트림을 먼저 쓴다. | `cfb.ts` `hasStorage`, `streamIn` |
| PowerPoint 95(레코드 머리 16바이트)와 4.0(`PP40` 스트림)은 읽지 못했다. 글자만이라도 보여 준다. 95는 슬라이드별 글 상자 위치와 글자를, 4.0은 길이가 붙은 글자 레코드를 골라 레코드 사이 간격으로 슬라이드를 나눈다(공개 명세가 없어 도형·서식은 읽지 않는다). | 새 파일 `legacy.ts`, `parser.ts` `parsePpt` |

### 열기 속도

| 원인 | 고친 곳 |
|---|---|
| 브라우저에서는 XML을 내장 `DOMParser`로 읽었는데, Android WebView에서 슬라이드가 많은 pptx를 열 때 대부분의 시간을 썼다(28장 2MB 파일: 크롬 프로파일에서 `parseXml` 0.78초, SM-P200에서 첫 슬라이드 3.2초). 워커용으로 이미 들어 있는 최소 파서(`xml-lite`)를 늘 쓴다. | `xml.ts` `parseXml` |
| `xml-lite`는 `trim()`으로 공백뿐인 글자를 걸러 탭·NBSP만 든 글자 조각(`<a:t>\t</a:t>`)을 버렸다(`DOMParser`는 남긴다). 줄바꿈이 없는 공백 글자는 남긴다. | `xml-lite.ts` `parseXmlLite` |

두 파서 결과가 같은지는 `spike/renderer-eval/corpus`의 ppt·pptx와 시험 문서 332개를 크롬에서 두 파서로 열어 모든 슬라이드 SVG를 비교해 확인했다(같지 않은 1개는 날짜·시각 필드라 같은 파서로 두 번 열어도 달라지는 파일).

## 검증 방법

- 업스트림 자체 테스트: 포크(`/home/capalace/Git/web-ppt-fork`)의 `packages/core/src`를 이 사본으로 맞춘 뒤 `node tooling/test-core.mjs`(1873항목). ppt 표본 3개의 렌더링 스냅숏은 글 상자 여백 변경으로 다시 만들었고, 전후 화면을 비교해 의도한 차이임을 확인했다.
- 실제 문서: `spike/renderer-eval`에서 `node scripts/run-eval.mjs --only ppt,pptx --renderer web-ppt` 후 `python3 -I scripts/report.py`.

## 아직 못 한 것

- 개요(SlideListWithText) 글의 자동 번호(`OutlineTextProps9`)는 읽지 않는다. 번호 목록이 글머리표로 나온다.
- 채우기·선을 아예 정하지 않은 도형에 [MS-ODRAW] 기본값(흰 채움·검은 선)을 쓰지 않는다(원본 동작 유지). 기본값에 기대는 글상자 테두리가 빠진다(govdocs1-019 등).
- 호(msosptArc)의 조절값, 세로 글, 그림 안 글자(OLE 미리보기 메타파일 속 글자)는 손대지 않았다.
- PowerPoint 95·4.0은 글자만 보여 준다.
