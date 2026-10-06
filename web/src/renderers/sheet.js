import * as XLSX from 'xlsx';

// 화면에 그리는 행 수 상한. 큰 시트는 이후 보이는 행만 그리는 방식으로 바꾼다.
const MAX_ROWS = 2000;

// 한국 CSV는 엑셀 기본 저장 형식 때문에 EUC-KR(CP949)인 경우가 많다. UTF-8이 아니면 EUC-KR로 읽는다.
function decodeCsv(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}

function sheetHtml(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1:A1');
  const totalRows = range.e.r - range.s.r + 1;
  if (totalRows > MAX_ROWS) {
    sheet = { ...sheet, '!ref': XLSX.utils.encode_range({ s: range.s, e: { r: range.s.r + MAX_ROWS - 1, c: range.e.c } }) };
  }
  return { html: XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' }), totalRows };
}

export async function render(bytes, container, ctx) {
  const workbook =
    ctx.fmt === 'csv'
      ? XLSX.read(decodeCsv(bytes), { type: 'string', raw: true })
      : XLSX.read(bytes, { type: 'array', cellDates: true });

  const tabs = document.createElement('nav');
  tabs.className = 'sheet-tabs';
  const body = document.createElement('div');
  body.className = 'sheet-body';
  const note = document.createElement('p');
  note.className = 'sheet-note';
  container.append(tabs, body, note);

  const select = (name) => {
    for (const button of tabs.children) button.setAttribute('aria-selected', String(button.textContent === name));
    const { html, totalRows } = sheetHtml(workbook.Sheets[name]);
    body.innerHTML = html;
    note.textContent = totalRows > MAX_ROWS ? `처음 ${MAX_ROWS.toLocaleString()}행만 표시합니다 (전체 ${totalRows.toLocaleString()}행).` : '';
  };
  for (const name of workbook.SheetNames) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.addEventListener('click', () => select(name));
    tabs.appendChild(button);
  }
  tabs.hidden = workbook.SheetNames.length < 2;
  select(workbook.SheetNames[0]);
  ctx.markFirstPage();
  return { pages: workbook.SheetNames.length };
}
