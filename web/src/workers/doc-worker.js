// 구형 Word(.doc) 파싱과 HTML 만들기는 큰 문서에서 몇 초가 걸려 워커에서 돌린다. 화면 스레드는 스피너와 다른 탭을 계속 처리한다.
// 쪽(쪽 나누기·구역 나누기 단위)을 하나씩 그려 바로 보내므로, 앱은 앞쪽부터 받아 첫 쪽을 먼저 보이고 나머지를 받는 대로 나눈다.
// 메시지
//   open(buffer) → meta{css, sectionHeaders, sections, count, warnings, wordVersion}, page{page}…, end
//                  실패하면 error{message}
import { createMsDocRenderer, parseMsDoc } from '@file-viewer/doc/core';

self.onmessage = ({ data }) => {
  if (data.type !== 'open') return;
  try {
    const parsed = parseMsDoc(data.buffer);
    const renderer = createMsDocRenderer(parsed);
    self.postMessage({
      type: 'meta',
      css: renderer.css,
      sectionHeaders: renderer.sectionHeaders,
      sections: (parsed.sections ?? []).map(settingsOf),
      count: renderer.count,
      warnings: parsed.warnings?.length ?? 0,
      wordVersion: parsed.meta?.fib?.version ?? null,
    });
    for (let page = renderer.next(); page; page = renderer.next()) self.postMessage({ type: 'page', page });
    self.postMessage({ type: 'end' });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

/** 구역 설정 중 앱이 쓰는 값(용지·여백·쪽 번호)만 보낸다. 머리말·꼬리말 블록은 sectionHeaders에 HTML로 따로 간다. */
function settingsOf(section) {
  return Object.fromEntries(Object.entries(section).filter(([, value]) => value === null || typeof value !== 'object'));
}
