// 그림 파일(png·jpg·gif·webp·bmp·ico·svg). 탭 하나에 그림 하나를 <img>(blob: 주소)로 띄운다.
// SVG도 반드시 <img>로만 띄운다: 그림으로 쓰인 SVG는 브라우저가 스크립트를 돌리지 않고 SMIL·CSS 애니메이션만 재생한다
// (inline SVG·innerHTML로 넣으면 스크립트·외부 참조가 살아난다). 움직이는 gif·webp도 <img>가 그대로 재생한다.
// 처음엔 창에 맞추고(작은 그림은 원래 크기보다 키우지 않는다) 가운데에 둔다. 셸의 확대·축소는 맞춘 크기를 1로 해
// 그림 크기를 바꾸고(ctx.setZoomer), 화면보다 커지면 마우스로 끌어 옮긴다(터치는 브라우저 스크롤에 맡긴다).
// 디코드는 img.decode()로 화면 밖에서 끝낸 뒤 붙여, 아주 큰 그림도 화면을 멈추지 않는다. 깨진 그림은 decode가 실패해 오류 안내로 간다.

/** 맞춘 크기 대비 확대 상한. 원래 크기의 MAX_PIXEL_SCALE배가 이보다 크면 그만큼까지(큰 그림의 픽셀 확인). */
const MAX_ZOOM = 4;
const MAX_PIXEL_SCALE = 4;
const MIN_ZOOM = 0.5;
/** 그림과 창 가장자리 사이 여백(px, 한쪽) */
const MARGIN = 8;

/** 앞부분 서명으로 MIME을 정한다. SVG는 형식을 밝혀야 <img>가 그린다(래스터 그림은 브라우저가 내용으로 알아본다). */
function mimeOf(bytes) {
  const starts = (...sig) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (starts(0x42, 0x4d)) return 'image/bmp';
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  return 'image/svg+xml';
}

export async function render(bytes, container, ctx) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(bytes) }));
  const img = new Image();
  img.className = 'image-view';
  img.alt = ctx.name ?? '';
  img.draggable = false; // 끌어 옮기기가 그림 끌어다 놓기로 바뀌지 않게
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('그림을 디코드하지 못했습니다');
  }
  // 움직이는 그림은 주소가 살아 있어야 계속 재생되므로 탭이 닫힐 때까지 둔다.
  const stage = document.createElement('div');
  stage.className = 'image-stage';
  stage.appendChild(img);
  container.appendChild(stage);

  // 크기 없이 viewBox만 있는 SVG는 원래 크기가 0이라 창 크기에 맞춘다(object-fit: contain).
  const natural = () => ({ width: img.naturalWidth || innerWidth - 2 * MARGIN, height: img.naturalHeight || innerHeight - 2 * MARGIN });
  const fitScale = () => {
    const { width, height } = natural();
    return Math.min(1, (innerWidth - 2 * MARGIN) / width, (innerHeight - 2 * MARGIN) / height);
  };
  let zoom = 1;
  const layout = () => {
    const { width, height } = natural();
    const scale = fitScale() * zoom;
    img.style.width = `${width * scale}px`;
    img.style.height = `${height * scale}px`;
    // 화면보다 크면 스크롤 막대를 보이고 끌어 옮길 수 있게 한다.
    const pannable = width * scale + 2 * MARGIN > innerWidth || height * scale + 2 * MARGIN > innerHeight;
    if (pannable) container.dataset.zoomed = '';
    else delete container.dataset.zoomed;
    stage.toggleAttribute('data-pannable', pannable);
  };
  layout();
  addEventListener('resize', layout);

  ctx.setZoomer((value, focusX = innerWidth / 2, focusY = innerHeight / 2) => {
    const max = Math.max(MAX_ZOOM, MAX_PIXEL_SCALE / fitScale());
    const next = Math.min(max, Math.max(MIN_ZOOM, value));
    if (next === zoom) return zoom;
    // focusX·focusY 아래의 그림 자리를 그대로 둔다.
    const before = img.getBoundingClientRect();
    const rx = Math.min(1, Math.max(0, (focusX - before.left) / before.width));
    const ry = Math.min(1, Math.max(0, (focusY - before.top) / before.height));
    zoom = next;
    layout();
    const after = img.getBoundingClientRect();
    scrollTo(scrollX + after.left + rx * after.width - focusX, scrollY + after.top + ry * after.height - focusY);
    return zoom;
  });

  bindPan(stage);
  ctx.markFirstPage();
  return { pages: null, extra: { width: img.naturalWidth, height: img.naturalHeight } };
}

/** 마우스·펜으로 끌면 창을 스크롤한다. 터치는 브라우저가 스크롤하므로 건드리지 않는다. */
function bindPan(stage) {
  let last = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0 || !stage.hasAttribute('data-pannable')) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('panning');
    last = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!last) return;
    scrollBy(last.x - e.clientX, last.y - e.clientY);
    last = { x: e.clientX, y: e.clientY };
  });
  const end = () => {
    last = null;
    stage.classList.remove('panning');
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}
