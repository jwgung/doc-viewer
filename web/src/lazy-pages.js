// 고정 배치 문서(hwp·ppt)를 쪽 단위로 그린다.
// 모든 쪽의 자리만 크기에 맞춰 먼저 잡고, 화면 근처에 온 쪽만 그린다. 멀어진 쪽은 지워 메모리를 아낀다.
// renderPage는 SVG 문자열이나 그 Promise를 돌려준다. 첫 쪽이 그려지면 resolve한다.
const KEEP_RENDERED = 8;

export function mountLazyPages(container, sizes, renderPage) {
  const pages = sizes.map(({ width, height }, index) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.style.aspectRatio = `${width} / ${height}`;
    el.dataset.index = String(index);
    container.appendChild(el);
    return el;
  });
  const wanted = new Set();
  const rendered = new Set();

  const show = async (index) => {
    if (wanted.has(index)) return;
    wanted.add(index);
    const svg = await renderPage(index);
    if (!wanted.has(index)) return; // 그리는 사이 화면에서 멀어졌다.
    pages[index].innerHTML = svg;
    rendered.add(index);
    if (wanted.size <= KEEP_RENDERED) return;
    const farthest = [...wanted].sort((a, b) => Math.abs(b - index) - Math.abs(a - index))[0];
    wanted.delete(farthest);
    if (rendered.delete(farthest)) pages[farthest].replaceChildren();
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) show(Number(entry.target.dataset.index));
    },
    { rootMargin: '100% 0px' },
  );
  pages.forEach((el) => observer.observe(el));
  addEventListener('pagehide', () => observer.disconnect(), { once: true });
  return pages.length > 0 ? show(0) : Promise.resolve();
}
