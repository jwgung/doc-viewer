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

아직 없음.
