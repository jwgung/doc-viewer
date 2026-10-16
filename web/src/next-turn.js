/**
 * 다음 차례. 낮은 우선순위 작업으로 미뤄 터치·스크롤·화면 그리기를 먼저 하게 한다. requestIdleCallback은
 * 저사양 기기에서 좀처럼 한가해지지 않아 매번 최대 대기까지 기다렸다(238쪽 문서에서 대기만 22초).
 * 뒤에서 쪽을 나누는 paginate.js와 큰 설정 파일을 조각내 넣는 renderers/code.js가 함께 쓴다.
 */
export const nextTurn = () =>
  globalThis.scheduler?.postTask
    ? scheduler.postTask(() => {}, { priority: 'background' })
    : new Promise((resolve) => setTimeout(resolve, 0));
