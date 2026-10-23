// 확장자 → 웹 렌더러 형식(viewer.html?fmt=). Android DocFormat.kt의 key·VARIANTS·PLAIN_TEXT_EXTENSIONS를 옮긴 것이라 함께 고친다.
// 형식은 Rust가 내용으로 먼저 가리고(src-tauri/src/detect.rs), 내용으로 못 정하면 이 표의 확장자를 쓴다.

const KEYS = ['pdf', 'hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'md', 'txt', 'json', 'xml', 'toml', 'yaml', 'log'];

/** 같은 렌더러로 여는 변형 확장자 */
const VARIANTS = {
  markdown: 'md',
  yml: 'yaml',
  jsonc: 'json',
  docm: 'docx',
  dotx: 'docx',
  dotm: 'docx',
  dot: 'doc',
  xlsm: 'xlsx',
  xltx: 'xlsx',
  xltm: 'xlsx',
  xlt: 'xls',
  pptm: 'pptx',
  ppsx: 'pptx',
  potx: 'pptx',
  pps: 'ppt',
  pot: 'ppt',
  hwt: 'hwp',
  tsv: 'csv',
};

/** 색 없이 텍스트로 여는 글자 파일 */
const PLAIN_TEXT = [
  // 설정
  'ini', 'cfg', 'conf', 'config', 'properties', 'env', 'editorconfig',
  // 소스 코드·스크립트
  'py', 'js', 'mjs', 'cjs', 'tsx', 'jsx', 'kt', 'kts', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs', 'go', 'rs', 'rb',
  'php', 'swift', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'sql', 'lua', 'pl', 'r', 'dart', 'scala', 'groovy', 'gradle',
  'css', 'scss', 'less', 'vue', 'svelte',
  // 문서·자막·차이
  'text', 'nfo', 'rst', 'tex', 'bib', 'srt', 'vtt', 'diff', 'patch',
];

/** 그림 파일(renderers/image.js). 데스크톱만 연다: 파일 연결(tauri.conf.json)에는 넣지 않아 사진 앱의 기본 앱을 가져가지 않는다. */
const IMAGES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'];

const BY_EXTENSION = new Map([
  ...KEYS.map((key) => [key, key]),
  ...Object.entries(VARIANTS),
  ...PLAIN_TEXT.map((ext) => [ext, 'txt']),
  ...IMAGES.map((ext) => [ext, 'image']),
]);

/** 폴더 탐색기에 보이는 확장자 */
export const EXTENSIONS = [...BY_EXTENSION.keys()];

const SLIDES = new Set(['ppt', 'pptx']);
/** 쪽 구분이 있는 형식만 보기 방식·맞춤을 고른다(ViewSettings.supports와 같다). */
const PAGED = new Set([...SLIDES, 'pdf', 'hwp', 'hwpx', 'docx', 'doc']);

/** @returns {string | null} 웹 렌더러 형식, 모르는 확장자면 null */
export function formatOf(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? null : (BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null);
}

export const isPaged = (fmt) => PAGED.has(fmt);

/** 처음 여는 문서의 보기 설정을 기억하는 묶음: 발표 자료와 나머지 문서 */
export const settingsGroup = (fmt) => (SLIDES.has(fmt) ? 'slides' : 'document');

/** 고른 적이 없을 때의 보기 설정: 발표 자료는 한 쪽씩·용지 맞춤, 나머지는 연속 스크롤·화면 가득 */
export const defaultSettings = (fmt) => (SLIDES.has(fmt) ? { mode: 'page', fit: 'page' } : { mode: 'scroll', fit: 'width' });
