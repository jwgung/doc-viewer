// 웹 렌더러가 화면에 띄우는 문구. 언어를 더할 때는 여기에 묶음을 더하고, 앱의 res/values-<언어>도 함께 만든다.
// WebView의 navigator.language는 기기 언어를 따른다.
const STRINGS = {
  ko: {
    renderFailed: '이 문서를 표시하지 못했습니다.',
    fallbackNotice: '원래 모양으로 표시하지 못해 본문 글자만 보여 드립니다.',
    fallbackSlide: (n) => `슬라이드 ${n}`,
    encryptedUnsupported: '암호가 걸린 문서입니다. 이 형식의 암호 문서는 아직 열 수 없습니다.',
    passwordRequired: '암호를 입력해야 볼 수 있는 문서입니다.',
    rowsLimited: (shown, total) => `처음 ${shown}행만 표시합니다 (전체 ${total}행).`,
    passwordTitle: '암호 입력',
    passwordPrompt: '암호가 걸린 문서입니다.',
    passwordWrong: '암호가 맞지 않습니다. 다시 입력하세요.',
    unlocking: '암호를 푸는 중…',
    searchPlaceholder: '문서에서 찾기',
    searching: '찾는 중',
    searchNone: '없음',
    searchPrev: '이전 결과',
    searchNext: '다음 결과',
    searchClose: '검색 닫기',
    goToPageTitle: '쪽 이동',
    go: '이동',
    ok: '확인',
    cancel: '취소',
  },
};

STRINGS.en = {
  renderFailed: "Couldn't display this document.",
  fallbackNotice: "This document couldn't be shown in its original layout, so only its text is shown.",
  fallbackSlide: (n) => `Slide ${n}`,
  encryptedUnsupported: "This document is password-protected. Password-protected files of this type can't be opened yet.",
  passwordRequired: 'A password is required to view this document.',
  rowsLimited: (shown, total) => `Showing the first ${shown} rows (of ${total}).`,
  passwordTitle: 'Password',
  passwordPrompt: 'This document is password-protected.',
  passwordWrong: 'Wrong password. Try again.',
  unlocking: 'Unlocking…',
  searchPlaceholder: 'Find in document',
  searching: 'Searching',
  searchNone: 'No results',
  searchPrev: 'Previous result',
  searchNext: 'Next result',
  searchClose: 'Close search',
  goToPageTitle: 'Go to page',
  go: 'Go',
  ok: 'OK',
  cancel: 'Cancel',
};

// 한국어가 아니면 영어로 보인다(앱의 기본 문구와 같은 규칙).
export const t = STRINGS[navigator.language?.slice(0, 2)] ?? STRINGS.en;
