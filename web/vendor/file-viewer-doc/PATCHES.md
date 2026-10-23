# @file-viewer/doc 포크 (doc-viewer)

구형 Word(.doc) 렌더러 `@file-viewer/doc`을 앱에 맞게 고친 사본이다. 라이선스는 원본과 같은 MIT(`LICENSE`)다.

## 출처

- 기준: [flyfish-dev/file-viewer](https://github.com/flyfish-dev/file-viewer) `v3.1.2` 태그의 `packages/renderers/doc`
  - npm `@file-viewer/doc@3.1.2`와 같은 코드다. 이 소스를 `tsc -b`로 빌드한 결과가 npm 패키지의 `dist/`와 파일 단위로 같음을 확인했다.
  - 단독 저장소 [flyfish-dev/docjs](https://github.com/flyfish-dev/docjs)는 2.2.7에 머물러 있어 기준으로 쓰지 않는다.
- 포크 작업 폴더: `/home/capalace/Git/docjs-fork`
  - docjs 저장소를 받은 뒤 v3.1.2 패키지(소스·`scripts/verify-*.mjs`·`test/fixtures/`)를 덮어쓰고, 이 폴더의 `src/`를 맞춰 둔 것이다.
  - 타입 검사와 upstream 회귀 확인(`pnpm build && node scripts/verify-*.mjs`)을 여기서 한다.
  - `scripts/verify-github-171.mjs`는 글상자를 고정 위치(`shape` 블록)에 두게 바뀐 동작에 맞춰 고쳤다.

## 왜 빌드 산출물이 아니라 TypeScript 소스를 두는가

- 고칠 곳이 파서 깊숙한 곳(FIB·조각 표·FKP·sprm)이라 사람이 읽고 고치는 대상은 소스다. 빌드 산출물을 두면 소스(포크 폴더)와 산출물(앱 저장소)을 늘 함께 맞춰야 하고, 둘이 어긋나도 알아채기 어렵다.
- 소스를 두면 이 저장소의 git 기록만으로 원본(v3.1.2) 대비 바뀐 점이 그대로 보인다. upstream 새 버전을 들일 때도 소스끼리 비교하면 된다.
- Vite가 `.ts`를 바로 변환하므로 별도 빌드 단계가 없다. `package.json`의 `exports`가 `src/*.ts`를 가리킨다.
- 대신 Vite는 타입 검사를 하지 않는다. 소스를 고친 뒤에는 포크 폴더에서 `pnpm build`(tsc)로 타입을 확인한다.

## 쓰는 법

- 앱(`web/package.json`)과 검증 하네스(`spike/renderer-eval/package.json`)는 `file:` 의존성으로 이 폴더를 쓴다.
- **pnpm은 `file:` 의존성을 node_modules 안에 하드 링크 사본으로 넣는다.** 편집기가 파일을 새로 쓰면 링크가 끊기므로,
  vendor 소스를 고친 뒤에는 `web/`(과 하네스 폴더)에서 `pnpm install`을 다시 실행해 사본을 맞춘다.
- 앱은 `@file-viewer/doc/core` 진입점(파서와 HTML 렌더러만)을 쓴다. 기본 진입점(`index.ts`)은 워커 클라이언트의
  `new URL('./worker.js', import.meta.url)` 때문에 쓰지 않는 워커 파일이 번들에 따로 들어간다.
- 타입 검사: `rsync -a --delete web/vendor/file-viewer-doc/src/ /home/capalace/Git/docjs-fork/src/` 뒤 포크 폴더에서 `pnpm build`.

## 원본 대비 바뀐 점

고친 곳에는 `doc-viewer:` 주석을 달았다.

### 패키지 구성

- `package.json`: 이름은 그대로 두고 버전을 `3.1.2-docviewer.N`으로 올림. `exports`/`main`이 `src/*.ts`를 가리키게 함.
  `./core` 진입점 추가. `dompurify` 의존성을 앱과 같은 3.4.16으로 맞춤(번들에 두 벌 들어가지 않게). npm 배포용 스크립트 제거.
- `src/core.ts` 추가: `parseMsDoc`, `renderMsDoc`, `defaultMsDocCss`, `sanitizeMsDocLinkHref`와 타입만 내보낸다.

### 복합 문서(OLE) 견고성 — `core/cfb.ts`

- 스트림 이름을 대소문자 구분 없이 찾는다([MS-CFB] 2.6.4). `worddocument`처럼 저장된 파일이 열리지 않았다.
- 헤더 DIFAT는 `numFatSectors`개만 읽는다. 범위를 벗어난 섹터·순환 체인은 예외 대신 잘라 읽고 경고를 남긴다.
- 디렉터리 트리 순환 참조에 무한 재귀하지 않게, 빈 디렉터리 항목도 자리를 지키게 했다.

### 옛 형식 — Word 6.0/95, Word 2.0, OLE가 아닌 Mac·DOS Word

- `msdoc/fib.ts`: 고정 배치 FIB(Word 6/95, Word 2) 읽기와 형식 세대 판별(`version` 2·6·8). 필드 위치는
  LibreOffice `WW8Fib`(sw/source/filter/ww8/ww8scan.cxx)와 실제 파일로 확인했다.
- `msdoc/sprm6.ts`(새 파일): 1바이트 sprm(Word 6/95·Word 2)을 Word 97 경로와 같은 이름의 속성으로 해석.
  피연산자 길이 표는 LibreOffice `GetWW6SprmSearcher`·`GetWW2SprmSearcher`와 같다.
- `msdoc/codepage.ts`(새 파일): 8비트 본문을 글꼴 문자 집합(chs)·글자 언어(lid)에 맞는 코드 페이지(1250~1258, 874, 949,
  932, 936, 950, Mac Roman)로 푼다. 2바이트 문자(cp949 한글 등)는 CP 두 칸을 차지하므로 둘째 칸에 채움 문자(U+FFFF)를 둔다.
  동아시아판 Word 95(FIB `fExtChar`)는 CP마다 16비트 값이고 0x3000 이상이면 2바이트 문자 코드다(LibreOffice와 같은 처리).
  ANSI(0) 글꼴은 '알 수 없음'으로 보고 언어로 정하며, 영어로 저장된 문서라도 글꼴 표에 한글 글꼴이 있고 바이트가 cp949로 맞으면 cp949로 읽는다.
- `msdoc/fkp.ts`: 세대별 FKP 구조(PN 2·4바이트, BX 1·7·13바이트, PAPX 길이), BTE 표가 실제 FKP 수보다 짧은 Word 6 파일의 보정,
  Word 2 CHPX(CHP 차분 구조) 해석, CHPX FKP 최대 개수 0x65 허용(원본은 101개짜리 페이지를 버렸다).
- `msdoc/clx.ts`: Word 6/95 조각 표(fc가 바이트 위치, 8비트 또는 fExtChar면 16비트), 조각 표가 없는 문서용 단일 조각.
- `msdoc/styles.ts`·`msdoc/fonts.ts`: Word 6/95 스타일 시트(이름 1바이트 길이 + 8비트 글자, UPX 짝수 정렬)와 글꼴 표(FFN 6바이트 머리).
- `msdoc/nonole.ts`(새 파일): Word for Macintosh 4/5(FE 37, 큰 끝), Word for Windows 1.x, Word for DOS는 본문 글자만 복구한다.
- `msdoc/objects.ts`: Word 6/95 그림(PIC 머리 58바이트 + 배치 정보 없는 WMF) 처리, 비트맵만 담은 WMF에서 DIB를 꺼내 BMP로 보여 준다.
- 표 스트림이 없거나(fWhichTblStm이 가리키는 쪽이 없으면 다른 쪽) 조각 표를 못 읽으면 fcMin부터 글자만이라도 읽는다.

### 구역·쪽·머리말·꼬리말 — `msdoc/sections.ts`(새 파일), `msdoc/parser.ts`, `render/html.ts`

- PlcfSed·SEPX로 구역 경계와 속성(나누기 종류 bkc, 첫 쪽 다름, 용지·여백, 쪽 번호 시작)을 읽는다.
- PlcfHdd로 구역별 머리말·꼬리말(기본·첫 쪽·짝수 쪽)을 만든다. Word 97은 구역마다 6칸이고 비면 앞 구역 것을 잇는다.
  Word 6/95는 DOP·구역의 grpfIhdt로 있는 것만 차례로 센다(LibreOffice `WW8PLCF_HdFt`와 같다).
- 렌더러가 명시적 쪽 나누기(0x0C, 문단 앞 쪽 나눔)와 새 쪽 구역 나누기로 쪽을 나눠 `pages`로 돌려준다.
  쪽마다 머리말 + 본문 + 그 쪽 각주 + 꼬리말을 그린다. 구역 끝 0x0C는 쪽 나누기로 그리지 않는다.
  PAGE·NUMPAGES 필드는 쪽 번호로 채운다. 머리말·꼬리말의 '왼쪽\t가운데\t오른쪽' 줄은 세 칸으로 나눈다.
- 글자 흐름에 따른 자동 쪽 나눔은 하지 않는다(화면 폭에 맞춰 줄이 다시 흐른다).

### 각주·미주 — `msdoc/parser.ts`, `render/html.ts`

- PlcffndRef/PlcffndTxt, PlcfendRef/PlcfendTxt로 참조 위치와 본문을 짝짓는다. 자동 번호는 DOP의 시작 번호·형식(각주 아라비아,
  미주 로마 소문자 기본)·구역별 다시 매기기를 따른다. 본문에는 위첨자 번호 링크, 쪽 끝에 각주, 마지막 쪽에 미주를 그린다.

### 번호 매기기 — `msdoc/lists.ts`(새 파일)

- PlfLst(LSTF + LVL)·PlfLfo(LFO + LFOLVL)를 읽고 문서 순서대로 수준별 번호를 센다. 번호 형식은 [MS-OSHARED] MSONFC를 따르며
  가나다·ㄱㄴㄷ·①·한자·로마 숫자·알파벳 등을 지원한다. 목록 수준의 문단 속성(들여쓰기)과 글자 속성(번호 글꼴)을 적용한다.
- Word 6/95의 번호(sprmPAnld의 ANLD + sprmPNLvlAnm)는 앞뒤 글자와 번호 형식으로 만든다.

### 떠 있는 글상자·그림 — `msdoc/drawing.ts`(새 파일)

- PlcSpaMom/PlcSpaHdr(FSPA)의 고정 위치, OfficeArt 도형 트리(묶음 도형의 자식, lTxid, 그림 번호, 채우기·선),
  PlcftxbxTxt(FTXBXS)로 글상자 내용을 고정 문단 바로 앞에 블록(`shape`)으로 둔다. 원본은 글상자 내용을 본문 뒤에 몰아서 붙였다.
  연결된 글상자는 첫 상자에만 내용을 그린다. 한 문단에 여러 도형이 고정되면 위→아래, 왼→오른쪽 순서로 놓고,
  세로 위치가 비슷한 도형은 한 줄(flex)에 놓아 넓은 화면에서는 나란히, 좁은 화면에서는 아래로 이어지게 한다.
- 떠 있는 그림(BStore FBSE, BLIP이 WordDocument 스트림의 foDelay에 있는 경우 포함)도 같은 자리에 그린다.
- 고정 위치를 찾지 못한 글상자(Word 6/95 등)는 원본처럼 본문 뒤에 붙인다.

### 글자 모양

- 토글 속성 값 0x80(스타일 값)·0x81(스타일 값 반대)을 푼다. 원본은 둘 다 '켜짐'으로 봐서 굵게·기울임이 뒤집히곤 했다.
- 위첨자·아래첨자(sprmCIss)를 그린다(각주 번호 스타일 등).
- 기호 글꼴(Symbol·Wingdings)의 U+F0xx 글자를 유니코드 글자(•, ■, ✓, 그리스 문자 등)로 바꾼다(`render/symbols.ts`, 새 파일).
  기호 삽입(sprmCSymbol)의 자리표시 문자 '('를 실제 기호로 바꾼다.
- 풀지 못한 그림의 자리 표시에 MIME 이름 대신 그림 아이콘만 남긴다.

### 그 밖

- PAPX가 덮지 못한 본문 구간을 문단 표시로 나눠 채운다(예전에는 그 글자가 사라졌다).
- 글상자 고정 문자(0x08)를 지우면서 글자 위치가 한 칸씩 밀려 서식이 어긋나던 문제를 고쳤다(문자는 두고 그릴 때 건너뛴다).
- 목록·도형·머리말·각주를 읽다가 실패해도 본문은 그린다(경고 `MSDOC_PARTIAL_FAILURE`).

### 앱의 자동 쪽 나눔을 위한 출력(3.1.2-docviewer.2)

앱(`web/src/paginate.js`)이 렌더러가 나눈 쪽(쪽 나누기·구역 나누기 단위)을 다시 용지 높이로 나누므로, 나눈 쪽마다
머리말·꼬리말과 쪽 번호를 새로 넣을 수 있게 출력을 더했다.

- 쪽 번호 필드(PAGE·NUMPAGES·SECTIONPAGES)를 `<span class="msdoc-field" data-field="page|numpages">`로 감싼다.
- `pages[i]`에 `bodyHtml`(본문 + 그 쪽 각주·미주), `headerHtml`, `footerHtml`, `firstOfSection`을 더한다. `html`은 그대로다.
- 결과에 `sectionHeaders`(구역마다 머리말·꼬리말의 첫 쪽·기본·짝수 쪽 HTML과 `titlePage`)를 더한다.
- `core.ts`에서 번호 서식 함수 `formatListNumber`를 `formatPageNumber`로 내보낸다(구역의 쪽 번호 서식: 로마 숫자 등).

### 큰 문서 읽기 속도

수백 쪽짜리 문서는 같은 서식이 수만 번 나와 같은 계산을 되풀이했다. 결과는 같고 계산만 줄였다.

- `msdoc/styles.ts`: 스타일 상속을 푼 결과(`resolveStyle`)를 스타일 번호마다 한 번만 계산한다.
- `msdoc/fkp.ts`: 바이트가 같은 CHPX는 한 번만 풀고 그 속성 배열을 함께 쓴다.
- `msdoc/parser.ts`: 문단 기본 글자 모양과 CHPX 속성 배열이 같으면 글자 상태(스타일 병합·글꼴 해석 포함)를 다시 쓴다.
- 이웃 조각을 합칠지 정하는 비교(`shallowEqual`)는 상태 안의 객체 값을 참조로 비교한다. 상태를 함께 쓰므로, 예전에는
  참조가 달라 따로 남던 같은 모양의 이웃 글자 묶음이 하나의 `<span>`으로 합쳐질 수 있다. 글자마다의 모양은 같다.

### 쪽을 하나씩 그리기

- `render/html.ts`: `createMsDocRenderer(parsed, options)`를 더했다. 쪽(쪽 나누기·구역 나누기 단위)을 `next()`로 하나씩
  그리고, CSS·구역별 머리말·꼬리말(`sectionHeaders`)·쪽 수(`count`)는 먼저 준다. 앱은 워커에서 앞쪽부터 받아 첫 쪽을
  먼저 보인다. 각주는 처음 참조한 쪽에 붙으므로 앞에서부터 차례로만 그린다.
- `renderMsDoc`은 이 렌더러로 모든 쪽을 그려 예전과 같은 결과를 낸다. 구역 안 쪽 번호를 셀 때 앞쪽 전체를 다시 훑던 것은
  구역마다 센 수를 들고 간다.
- `core.ts`에서 `createMsDocRenderer`를, `types.ts`에서 `MsDocPageRenderer`를 내보낸다.
