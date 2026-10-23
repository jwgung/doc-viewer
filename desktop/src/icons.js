// 셸 아이콘(SVG). 그림 파일을 따로 두지 않고 코드로 그린다.
// 문서 아이콘은 Android FileIconDrawable과 같은 모양·색이다: 귀퉁이가 접힌 문서에 형식 색과 확장자 글자.

const SVG = 'http://www.w3.org/2000/svg';

/** 형식별 색(FileIconDrawable.COLORS와 함께 고친다) */
const COLORS = {
  pdf: '#E0352B',
  hwp: '#1C8AD8',
  hwpx: '#1C8AD8',
  doc: '#2E5FA8',
  docx: '#2E5FA8',
  xls: '#1E7A46',
  xlsx: '#1E7A46',
  csv: '#2E9A5C',
  ppt: '#D2542A',
  pptx: '#D2542A',
  md: '#5F6368',
  txt: '#80868B',
  json: '#B8860B',
  xml: '#7E57C2',
  toml: '#8D6E63',
  yaml: '#C2185B',
  log: '#546E7A',
  image: '#00897B',
};

/** 형식 이름과 다른 아이콘 글자 */
const LABELS = { image: 'IMG' };

/** 흰색과 섞은 색(접힌 귀퉁이) */
function lighten(hex, ratio) {
  const mix = (i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - ratio) + 255 * ratio);
  return `rgb(${mix(1)} ${mix(3)} ${mix(5)})`;
}

function svg(viewBox, inner, className) {
  const el = document.createElementNS(SVG, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', className);
  el.innerHTML = inner;
  return el;
}

/**
 * 문서 아이콘의 SVG 내용(viewBox 0 0 24 30). label은 보통 파일의 형식(fmt) 이름이다.
 * 운영체제 파일 아이콘(scripts/make-file-icons.js)도 이 그림을 쓴다. labelY는 글자 기준선(앱 배지를 얹으면 위로 올린다).
 */
export function fileIconMarkup(fmt, { labelY = 21.5, font = 'Segoe UI, system-ui, sans-serif' } = {}) {
  const color = COLORS[fmt] ?? COLORS.txt;
  const label = LABELS[fmt] ?? (fmt ?? '').toUpperCase().slice(0, 4);
  // 24×30 문서: 오른쪽 위 7만큼 접힘, 모서리 반지름 2. 글자는 접힌 귀퉁이 아래 가운데.
  const size = label.length > 3 ? 7.4 : 8.6;
  return (
    `<path d="M2 0H17L24 7V28Q24 30 22 30H2Q0 30 0 28V2Q0 0 2 0Z" fill="${color}"/>` +
    `<path d="M17 0V5.5Q17 7 18.5 7H24Z" fill="${lighten(color, 0.45)}"/>` +
    `<text x="12" y="${labelY}" text-anchor="middle" font-family="${font}" font-weight="700" font-size="${size}" fill="#fff">${label}</text>`
  );
}

/** 목록용 문서 아이콘 */
export function fileIcon(fmt) {
  return svg('0 0 24 30', fileIconMarkup(fmt), 'file-icon');
}

export function folderIcon() {
  return svg(
    '0 0 24 24',
    '<path d="M2 6.5A2.5 2.5 0 0 1 4.5 4H9l2 2.5h8.5A2.5 2.5 0 0 1 22 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5Z" fill="#E8A93A"/>' +
      '<path d="M2 9.5h20v8a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5Z" fill="#F4C25B"/>',
    'folder-icon',
  );
}

/** 선으로 그린 단추 아이콘(currentColor) */
const LINE = {
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M7 10l5 5 5-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  viewScroll: '<rect x="6" y="2" width="12" height="9" rx="1.5"/><rect x="6" y="13" width="12" height="9" rx="1.5"/>',
  viewPage: '<rect x="6" y="3" width="12" height="18" rx="1.5"/>',
  viewSpread: '<rect x="2.5" y="5" width="9" height="14" rx="1.5"/><rect x="12.5" y="5" width="9" height="14" rx="1.5"/>',
  fitWidth: '<path d="M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  fitPage: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 9h6v6H9Z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  openFolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7Z"/>',
  outline: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  notes: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18M7 17h7"/>',
  close: '<path d="M7 7l10 10M17 7L7 17"/>',
  minus: '<path d="M6 12h12"/>',
  plus: '<path d="M6 12h12M12 6v12"/>',
};

export function lineIcon(name) {
  return svg('0 0 24 24', `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${LINE[name]}</g>`, 'line-icon');
}
