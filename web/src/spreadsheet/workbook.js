// 통합 문서 열기: xls(BIFF8)·xlsx는 직접 읽고, 그 밖의 형식이나 직접 읽기에 실패하면 SheetJS로 읽는다.
// 돌려주는 모양: { reader, sheets: [{ name, hidden, kind }], active, styles, load(index) → SheetModel | Promise }
import { readWithSheetJs } from './sheetjs.js';
import { readXls } from './xls.js';
import { readXlsx } from './xlsx.js';

export async function openWorkbook(bytes, fmt) {
  if (fmt !== 'csv') {
    try {
      const book = readXls(bytes) ?? (await readXlsx(bytes));
      if (book) return withFallback(book, bytes, fmt);
    } catch (error) {
      console.warn('[sheet] direct reader failed, using SheetJS', error);
    }
  }
  return readWithSheetJs(bytes, fmt);
}

/** 직접 읽기로 연 문서에서 시트 하나를 못 읽으면 그 시트만 SheetJS로 다시 읽는다. */
function withFallback(book, bytes, fmt) {
  let fallback = null;
  const load = book.load;
  return {
    ...book,
    load: async (index) => {
      try {
        return await load(index);
      } catch (error) {
        console.warn('[sheet] sheet reader failed, using SheetJS', error);
        fallback ??= readWithSheetJs(bytes, fmt);
        const name = book.sheets[index]?.name;
        const k = fallback.sheets.findIndex((s) => s.name === name);
        return fallback.load(k >= 0 ? k : index);
      }
    },
  };
}
