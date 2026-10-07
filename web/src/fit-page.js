// HTML로 그린 쪽(doc·docx)을 쪽 칸 폭에 맞춰 줄여 단다.
// zoom으로 줄이면 작은 글자로 줄을 다시 나눠 쪽이 재 둔 크기보다 길어지고 끝이 잘린다(docx 130개 중 10개, 최대 444px).
// 그래서 배치는 그대로 두고 그림만 줄이는 transform을 쓴다. 단 뒤에도 글꼴·그림이 늦게 자리 잡아 쪽 크기가 바뀌면
// (문서에 담긴 글꼴은 나중에 적용된다) 칸을 다시 맞춘다.

const fitters = new WeakMap(); // 쪽 요소 → 지금 단 칸에 다시 맞추는 함수
const resized = new ResizeObserver((entries) => {
  for (const { target } of entries) fitters.get(target)?.();
});

/** 쪽 크기는 배치 크기로 잰다. transform으로 줄여도 그대로이므로 칸 안에서 재도 된다. */
export const sizeOf = (page) => ({ width: page.offsetWidth, height: page.offsetHeight });

/** page를 쪽 칸 el에 줄여 단다. sizes[index]를 실제 크기로 바꾸고 쪽 뷰어(viewer)의 칸도 바로잡는다. */
export function placePage(page, index, el, sizes, viewer) {
  el.replaceChildren(page);
  const fit = () => {
    sizes[index] = sizeOf(page);
    viewer?.resizePage(index, sizes[index]); // 연속 스크롤 칸
    // 한 쪽씩·두 쪽씩 칸은 쪽 뷰어가 잡은 크기라 높이만 같은 비율로 바로잡는다.
    if (viewer && viewer.mode !== 'scroll') el.style.height = `${Math.floor((sizes[index].height * el.clientWidth) / sizes[index].width)}px`;
    page.style.transformOrigin = '0 0';
    page.style.transform = `scale(${el.clientWidth / sizes[index].width})`;
  };
  fit();
  fitters.set(page, () => {
    if (page.parentNode !== el) {
      // 칸에서 떼어 냈다(화면에서 멀어진 쪽). 더 지켜보지 않아 쪽 요소를 붙들지 않는다.
      resized.unobserve(page);
      fitters.delete(page);
    } else if (page.offsetWidth !== sizes[index].width || page.offsetHeight !== sizes[index].height) {
      fit();
    }
  });
  resized.observe(page);
}
