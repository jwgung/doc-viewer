# @file-viewer/doc 포크 (doc-viewer)

구형 Word(.doc) 렌더러 `@file-viewer/doc`을 앱에 맞게 고친 사본이다. 라이선스는 원본과 같은 MIT(`LICENSE`)다.

## 출처

- 기준: [flyfish-dev/file-viewer](https://github.com/flyfish-dev/file-viewer) `v3.1.2` 태그의 `packages/renderers/doc`
  - npm `@file-viewer/doc@3.1.2`와 같은 코드다. 이 소스를 `tsc -b`로 빌드한 결과가 npm 패키지의 `dist/`와 파일 단위로 같음을 확인했다.
  - 단독 저장소 [flyfish-dev/docjs](https://github.com/flyfish-dev/docjs)는 2.2.7에 머물러 있어 기준으로 쓰지 않는다.
- 포크 작업 폴더: `/home/capalace/Git/docjs-fork` (docjs 저장소를 받아 v3.1.2 패키지를 덮어쓴 것. upstream의 `scripts/verify-*.mjs`와 `test/fixtures/`가 있어 회귀 확인에 쓴다)

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

## 원본 대비 바뀐 점

### 패키지 구성

- `package.json`: 이름은 그대로 두고 버전을 `3.1.2-docviewer.N`으로 올림. `exports`/`main`이 `src/*.ts`를 가리키게 함.
  `./core` 진입점 추가. `dompurify` 의존성을 앱과 같은 3.4.16으로 맞춤(번들에 두 벌 들어가지 않게). npm 배포용 스크립트 제거.
- `src/core.ts` 추가: `parseMsDoc`, `renderMsDoc`, `defaultMsDocCss`, `sanitizeMsDocLinkHref`와 타입만 내보낸다.
