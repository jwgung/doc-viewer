// 스프레드시트 파싱을 워커에서 한다. 큰 파일도 화면이 멈추지 않게 하고,
// dense 모드와 행 수 상한으로 메모리를 줄인다(28MB xls를 통째로 읽으면 2GB를 넘게 쓴다).
import * as XLSX from 'xlsx';
import { decodeText } from '../text.js';

const MAX_ROWS = 2000;
let workbook = null;

function sheetView(index) {
  const sheet = workbook.Sheets[workbook.SheetNames[index]];
  const full = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1:A1');
  return {
    html: XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' }),
    totalRows: full.e.r - full.s.r + 1,
    shownRows: MAX_ROWS,
  };
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'open') {
      const bytes = new Uint8Array(data.bytes);
      const options = { dense: true, sheetRows: MAX_ROWS };
      workbook =
        data.fmt === 'csv'
          ? XLSX.read(decodeText(bytes), { ...options, type: 'string', raw: true })
          : XLSX.read(bytes, { ...options, type: 'array', cellDates: true });
      self.postMessage({ type: 'opened', names: workbook.SheetNames, first: sheetView(0) });
    } else if (data.type === 'sheet') {
      self.postMessage({ type: 'sheet', index: data.index, ...sheetView(data.index) });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) });
  }
};
