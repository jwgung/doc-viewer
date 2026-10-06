// 텍스트 파일(CSV·마크다운) 디코딩. 한국에서 만든 파일은 엑셀·메모장 기본값 때문에 EUC-KR(CP949)인 경우가 많아,
// UTF-8로 읽히지 않으면 EUC-KR로 읽는다. 브라우저의 'euc-kr' 디코더는 CP949 확장 글자까지 처리한다.
export function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}
