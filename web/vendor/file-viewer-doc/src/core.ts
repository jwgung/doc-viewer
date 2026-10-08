// doc-viewer 포크에서 더한 진입점: 파서와 HTML 렌더러만 내보낸다.
// index.ts는 워커 클라이언트(new URL('./worker.js', import.meta.url))와 DOMPurify 뷰어까지 끌고 와서
// 번들러가 쓰지 않는 워커 파일을 따로 내보내므로, 앱은 이 진입점을 쓴다.
export { parseMsDoc } from './msdoc/parser.js';
export { renderMsDoc, defaultMsDocCss, sanitizeMsDocLinkHref } from './render/html.js';
// doc-viewer: 앱이 자동 쪽 나눔으로 매기는 쪽 번호를 구역 서식(로마 숫자 등)으로 쓰려고 내보낸다.
export { formatListNumber as formatPageNumber } from './msdoc/lists.js';
export type * from './types.js';
