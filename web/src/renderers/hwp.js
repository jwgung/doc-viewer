import { PagedViewer } from '../paged-viewer.js';
import { connect } from '../worker-client.js';

export async function render(bytes, container, ctx) {
  const worker = new Worker(new URL('../workers/hwp-worker.js', import.meta.url), { type: 'module' });
  const request = connect(worker);
  let opened = await request({ type: 'open', bytes: bytes.buffer }, 'opened', [bytes.buffer]);
  // 암호 문서: 암호를 묻고, 틀리면 다시 묻는다. 취소하면 askPassword가 실패를 던진다.
  for (let incorrect = false; opened.needsPassword || opened.wrongPassword; incorrect = true) {
    const password = await ctx.askPassword(incorrect);
    opened = await request({ type: 'unlock', password }, 'opened');
  }
  const renderInto = async (index, el) => {
    el.innerHTML = (await request({ type: 'page', index }, 'page')).svg;
  };
  const viewer = new PagedViewer(container, { count: opened.pages, sizes: opened.sizes, renderInto }, { mode: ctx.mode, fit: ctx.fit });
  ctx.setViewer(viewer);
  // 검색: 쪽 SVG의 글자(화면에 그린 글자와 같은 방식). 큰 문서는 쪽마다 조판 결과를 그려야 해서 시간이 걸린다.
  ctx.setTextSource(async (index) => (await request({ type: 'text', index }, 'text')).text);
  await viewer.render();
  ctx.markFirstPage();
  // 첫 쪽을 그린 뒤에 묻는다(워커는 요청을 차례로 처리하므로 첫 쪽 앞에 끼어들지 않게).
  // 목차: 개요 번호가 붙은 문단. 가장 높은 단계를 0으로 맞춘다.
  request({ type: 'outline' }, 'outline')
    .then(({ items }) => {
      if (!items.length) return;
      const top = Math.min(...items.map((item) => item.level));
      ctx.setOutline(async () =>
        items.map((item) => ({
          title: `${item.number ?? ''} ${item.title ?? ''}`.trim(),
          level: item.level - top,
          page: item.page + 1,
          go: () => viewer.goTo(item.page),
        })),
      );
    })
    .catch(() => {});
  addEventListener('pagehide', () => worker.terminate(), { once: true });
  return { pages: opened.pages, extra: { wasmMemoryBytes: opened.wasmMemoryBytes } };
}
