// 고정 배치 문서(hwp·ppt)를 쪽 단위로 그린다.
// 모든 쪽의 자리만 크기에 맞춰 먼저 잡고, 화면 근처에 온 쪽만 그린다. 멀어진 쪽은 지워 메모리를 아낀다.
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
  const rendered = new Set();

  const show = (index) => {
    if (rendered.has(index)) return;
    pages[index].innerHTML = renderPage(index);
    rendered.add(index);
    if (rendered.size <= KEEP_RENDERED) return;
    const farthest = [...rendered].sort((a, b) => Math.abs(b - index) - Math.abs(a - index))[0];
    pages[farthest].replaceChildren();
    rendered.delete(farthest);
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) show(Number(entry.target.dataset.index));
    },
    { rootMargin: '100% 0px' },
  );
  pages.forEach((el) => observer.observe(el));
  if (pages.length > 0) show(0);
  return () => observer.disconnect();
}
