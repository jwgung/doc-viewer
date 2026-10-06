// 스프레드시트 워커: 문서를 읽어 압축 저장소로 들고 있다가, 화면이 요청하는 행 묶음만 표시 문자열로 만들어 보낸다.
// 메시지
//   open { fmt, bytes }        → opened { reader, sheets, initial, parseMs, sheet: 시트 내용 }
//   sheet { index }            → sheet { index, ...시트 내용 }
//   rows { index(요청 번호), sheet, block } → rows { index, sheet, block: 행 묶음, styles }
// 시트 내용 = { meta(배치 정보), blocks(처음 화면의 행 묶음), styles(새 서식 CSS), baseCss }
import { openWorkbook } from '../spreadsheet/workbook.js';

const FIRST_BLOCKS = 2;
const KEEP_SHEETS = 2;

let book = null;
const loading = new Map(); // 시트 번호 → Promise<SheetModel>

function loadSheet(index) {
  let promise = loading.get(index);
  if (!promise) {
    promise = Promise.resolve(book.load(index));
    loading.set(index, promise);
    // 최근 시트 몇 개만 들고 있는다(큰 시트 여러 개를 다 들고 있지 않게).
    while (loading.size > KEEP_SHEETS) loading.delete(loading.keys().next().value);
  } else {
    loading.delete(index);
    loading.set(index, promise);
  }
  return promise;
}

function blockPayload(model, index) {
  const block = model.block(index);
  return { block, styles: book.styles.take(model.usedXfs(block)), transfer: [block.offsets.buffer, block.cols.buffer, block.xfs.buffer, block.kinds.buffer] };
}

function sheetPayload(model) {
  const meta = model.meta();
  meta.cellCount = model.cellCount;
  const blocks = [];
  const styles = {};
  const transfer = [meta.merges.buffer];
  const blockCount = Math.ceil(model.rowCount / meta.blockRows);
  for (let i = 0; i < Math.min(FIRST_BLOCKS, blockCount); i++) {
    const p = blockPayload(model, i);
    blocks.push(p.block);
    Object.assign(styles, p.styles);
    transfer.push(...p.transfer);
  }
  // 행·열 기본 서식(빈 칸 채우기)도 미리 보낸다.
  Object.assign(styles, book.styles.take([...meta.rowStyles.value, ...meta.colStyles.value]));
  return { payload: { meta, blocks, styles, baseCss: book.styles.baseCss() }, transfer };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'open') {
      const t0 = performance.now();
      book = await openWorkbook(new Uint8Array(data.bytes), data.fmt);
      const visible = book.sheets.findIndex((s) => !s.hidden);
      const initial = book.sheets[book.active] && !book.sheets[book.active].hidden ? book.active : Math.max(0, visible);
      const model = await loadSheet(initial);
      const parseMs = Math.round(performance.now() - t0);
      const { payload, transfer } = sheetPayload(model);
      self.postMessage({ type: 'opened', reader: book.reader, sheets: book.sheets, initial, parseMs, sheet: payload }, transfer);
    } else if (data.type === 'sheet') {
      const model = await loadSheet(data.index);
      const { payload, transfer } = sheetPayload(model);
      self.postMessage({ type: 'sheet', index: data.index, ...payload }, transfer);
    } else if (data.type === 'rows') {
      try {
        const model = await loadSheet(data.sheet);
        const { block, styles, transfer } = blockPayload(model, data.block);
        self.postMessage({ type: 'rows', index: data.index, sheet: data.sheet, block, styles }, transfer);
      } catch (error) {
        self.postMessage({ type: 'rows', index: data.index, sheet: data.sheet, error: String(error?.message ?? error) });
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) });
  }
};
