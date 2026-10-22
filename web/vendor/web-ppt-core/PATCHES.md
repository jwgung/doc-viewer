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
윈도우 앱(`desktop/`)은 `pnpm build:front`가 `web`을 빌드해 그 번들을 담는다.

## 업스트림 0.4.5 대비 변경

전체 차이는 [upstream-0.4.5.diff](upstream-0.4.5.diff)에 있다(업스트림 저장소 루트에서 `git apply upstream-0.4.5.diff`).
고친 곳은 대부분 .ppt(PowerPoint 97~2003) 경로인 `src/ppt/`이고, pptx 경로는 XML 파서(열기 속도)·발표자 노트·레이아웃 도형·OLE 미리보기·TIFF 그림을 고쳤다. 코드에는 `[doc-viewer]` 표시를 달았다.

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
| TIFF 그림은 브라우저가 그리지 못해 빈칸이었다. 흔한 경우(무압축·LZW·Deflate·PackBits, 흑백·회색·RGB·팔레트·CMYK, 스트립·타일, 예측기)를 PNG로 바꾼다. 앱의 docx·엑셀 경로도 같은 변환기를 쓴다. | 새 파일 `image/tiff.ts`, `image/index.ts`, `pptx/parser.ts` `store`, `ppt/parser.ts` `parsePpt` |
| pptx의 OLE 개체를 Office 2010+가 `mc:AlternateContent`로 감싸면(Choice에는 spid, Fallback에는 미리보기 `p:pic`) 감싼 것을 찾지 못해 'OLE 개체' 자리 표시만 그렸다. Fallback·Choice의 oleObj에서 미리보기를 찾는다. | `pptx/parser.ts` OLE 분기 |
| 레이아웃의 `showMasterSp="0"`(마스터 도형 숨김)을 레이아웃 자신의 도형까지 숨기는 것으로 읽어, 제목 슬라이드 레이아웃의 배경 그림·띠·로고가 빠졌다. 슬라이드의 값은 레이아웃·마스터 도형을, 레이아웃의 값은 마스터 도형만 숨긴다. | `pptx/parser.ts` `parseSlide` |
| EMF 글자(`EXTTEXTOUT`)의 글자 간격(dx)에 `exScale`을 곱했다. `exScale`은 페이지 단위를 0.01mm로 바꾸는 참고값(GM_COMPATIBLE에서 대개 25~30)이고 dx는 이미 논리 단위라, 글자 폭이 수십 배로 늘어 `textLength`로 눌린 검은 덩어리가 됐다(차트·표 미리보기, OLE 개체 이름 등). 곱하지 않는다. 시험 문서의 pptx·xlsx·docx EMF 중 해당 글자가 있는 12개를 전후 비교해 모두 원래 글자로 나옴을 확인. | `image/emf.ts` `extTextOut` |
| GDI 기록 없이 EMF+(GDI+) 주석만 든 EMF(PowerPoint가 비트맵 그림을 EMF로 감싸 붙일 때)를 GDI로만 해석해 빈칸이었다. 이런 파일은 안의 첫 그림 객체(압축 PNG·JPEG·GIF·TIFF 또는 32·24비트 화소)를 꺼내 틀 크기로 그린다. GDI 기록이 함께 있는 이중 파일은 그대로 GDI로 그린다. 실제 보고 문서의 3.9MB·4.7MB EMF 두 개가 나옴을 확인. | `image/emf.ts` `emfPlusOnlyImage`, `emfPlusImageUri` |

### 글꼴

| 원인 | 고친 곳 |
|---|---|
| 문서 글꼴이 없을 때의 대체 글꼴을 중국어 글꼴(PingFang SC·Hiragino Sans GB·Microsoft YaHei)로 정해 두어, Windows에서 영문·숫자는 중국어 글꼴로, 한글은 다른 글꼴로 섞여 그려지고 폭이 틀어졌다. 시스템 글꼴(`sans-serif`)에 맡긴다(언어에 맞는 글꼴을 OS가 고른다). 문서가 품은 글꼴(MTX 압축 EOT)은 풀지 않는다: 큰 글꼴(맑은 고딕 6MB) 하나에 수십 초가 걸렸다(2026-10-22 결정). | `render/text-svg.ts` `FALLBACK`, `render/svg.ts` `FONT_FALLBACK`·루트 `font-family`, `image/gdi.ts` `GENERIC` |
| 글상자 자동 맞춤을 슬라이드 → 레이아웃 → 마스터 순으로 찾을 때 `noAutofit`을 건너뛰어, 레이아웃이 '자동 맞춤 안 함'인 자리표시자가 마스터의 `normAutofit`을 물려받아 머리글이 1/3로 줄었다. 가까운 쪽의 `noAutofit`도 상속을 끊는다. | `pptx/text.ts` `parseTextBody` |
| 자동 맞춤으로 글자를 줄여도 자간(`spc`)은 그대로 둬 글자가 포개졌다. 자간도 같은 비율로 줄인다. | `render/svg.ts` `runStyle`, `render/text-svg.ts` `measure`·`spanSvg` |
| 크기를 바꾼 그룹(`chExt`와 `ext`가 다름) 안의 도형 글을 그룹의 확대 변환 안에서 그려 글자까지 그룹 비율로 줄었다(53%로 줄인 그룹의 8pt 글이 4pt로). PowerPoint는 도형 모양만 늘이고 줄이며 글자 크기는 그대로 둔다. 그룹 비율을 되돌린 좌표계에서 실제 크기의 글상자로 배치한다. | `render/svg.ts` `renderGroup`(누적 비율 `Ctx.groupScale`), `shapeText` |

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

### 발표자 노트

| 원인 | 고친 곳 |
|---|---|
| pptx 메모 페이지의 글을 모두 이어 붙여, 쪽 번호·머리글·바닥글·날짜 자리표시자 글자(쪽 번호 '1' 등)가 메모 끝에 붙었다. 이 자리표시자 도형은 빼고 메모 글만 남긴다. | `pptx/parser.ts` `notesText` |

### 패키지 진입점

| 원인 | 고친 곳 |
|---|---|
| 엑셀 그림 중 EMF·WMF를 SVG로 바꾸려고 메타파일 변환기만 따로 불러온다. 패키지 진입점(`.`)은 렌더러 전체를 불러온다. 변환기만 내보내는 `./image` 진입점을 더한다. | `package.json` `exports` |
| xls 그림은 ppt와 같은 OfficeArt(Escher) 구조라 속성 표(`parseOpt`)·그림 저장소(`blipsFromStore`) 읽기를 함께 쓴다. `./escher` 진입점을 더한다. | `package.json` `exports` |
| 엑셀 시트 차트는 pptx 차트와 같은 DrawingML이라 차트 해석·SVG 그리기를 함께 쓴다. chart XML·테마 XML을 받아 독립 SVG를 돌려주는 `chartToSvg`(시트에는 마스터가 없어 clrMap은 엑셀 기본값)와 `./chart` 진입점을 더한다. | 새 파일 `chart-svg.ts`, `package.json` `exports` |
| 엑셀 그리기 파트의 도형(xdr:sp·cxnSp·grpSp)도 p:sp와 구조가 같아 슬라이드 도형 해석기를 쓴다. 마스터·자리표시자 없이 엑셀 기본값(글자 11pt, clrMap 기본)으로 읽는 `parseSheetShapes`와, 앵커 하나의 도형을 화면 크기에 맞춰 SVG로 그리는 `shapesToSvg`(선 굵기·화살촉용 여백 포함)를 더한다. | `pptx/parser.ts` `parseSheetShapes`, `chart-svg.ts` `shapesToSvg` |

### 차트

| 원인 | 고친 곳 |
|---|---|
| 이름 없는 계열의 기본 이름이 중국어('系列 1')였다. 표시 언어가 한국어면 '계열1', 아니면 'Series1'(오피스와 같음). | `chart/model.ts` `parseSer` |
| 공백으로 자릿수를 나누는 숫자 형식(`"$"#\ ##0`, 핀란드·프랑스 등)에서 `\` 앞에서 숫자 자리 패턴이 끊겨 '$3750 ##0'으로 나왔다. 쉼표 묶기로 읽고 묶음 기호를 공백으로 바꾼다('$3 750'). | `chart/util.ts` `applySection` |
| 항목 이름표가 칸보다 넓으면 줄바꿈 모드로 그렸는데, 띄어 쓴 곳이 없는 이름표(날짜 '1/10/00' 등)는 줄이 안 바뀌어 서로 겹쳤다. 띄어 쓴 곳이 없으면 줄바꿈 대신 엑셀 자동 간격처럼 몇 개씩 건너뛰어 그린다. | `chart/frame.ts` `needWrap`, `renderAxes` |

## 검증 방법

- 업스트림 자체 테스트: 포크(`/home/capalace/Git/web-ppt-fork`)의 `packages/core/src`를 이 사본으로 맞춘 뒤 `node tooling/test-core.mjs`(1873항목). ppt 표본 3개의 렌더링 스냅숏은 글 상자 여백 변경으로 다시 만들었고, 전후 화면을 비교해 의도한 차이임을 확인했다.
- 실제 문서: `spike/renderer-eval`에서 `node scripts/run-eval.mjs --only ppt,pptx --renderer web-ppt` 후 `python3 -I scripts/report.py`.

## 아직 못 한 것

- 개요(SlideListWithText) 글의 자동 번호(`OutlineTextProps9`)는 읽지 않는다. 번호 목록이 글머리표로 나온다.
- 채우기·선을 아예 정하지 않은 도형에 [MS-ODRAW] 기본값(흰 채움·검은 선)을 쓰지 않는다(원본 동작 유지). 기본값에 기대는 글상자 테두리가 빠진다(govdocs1-019 등).
- 호(msosptArc)의 조절값, 세로 글, 그림 안 글자(OLE 미리보기 메타파일 속 글자)는 손대지 않았다.
- PowerPoint 95·4.0은 글자만 보여 준다.
