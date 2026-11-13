import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = new URL('../src/renderers/sheet-grid.js', import.meta.url);
const css = new URL('../src/renderers/sheet.css', import.meta.url);
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', req.url === '/grid.js' ? 'text/javascript' : req.url === '/grid.css' ? 'text/css' : 'text/html');
  res.end(req.url === '/grid.js' ? await readFile(source) : req.url === '/grid.css' ? await readFile(css) : `<!doctype html><link rel="stylesheet" href="/grid.css"><style>
    body { margin: 0 } .sheet-body { width: 500px; height: 300px }
  </style><div class="sheet-body"></div><script type="module">
    import { SheetGrid } from '/grid.js';
    const scroller = document.querySelector('.sheet-body');
    const grid = new SheetGrid(scroller, { fetchBlock: async () => ({ error: 'unused' }) });
    const sparse = () => ({ index: [], value: [] });
    await grid.show(0, { meta: {
      rowCount: 1, colCount: 1, defaultRowHeight: 20, defaultColWidth: 64,
      rowHeights: sparse(), colWidths: sparse(), rowStyles: sparse(), colStyles: sparse(),
      customRows: [], merges: [], freezeRows: 0, freezeCols: 0, showGrid: true,
      pictures: [], blockRows: 64,
    }, blocks: [], styles: {}, media: [] });
    window.grid = grid;
  </script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.grid);
  await page.mouse.move(250, 150);
  await page.mouse.wheel(200, 200);
  await page.waitForFunction(() => document.querySelector('.sheet-body').scrollTop >= 180);
  const scroll = await page.evaluate(() => ({ x: document.querySelector('.sheet-body').scrollLeft, y: document.querySelector('.sheet-body').scrollTop }));
  assert.ok(scroll.x >= 180 && scroll.y >= 180, `빈 셀 방향으로 계속 스크롤할 수 없음: ${JSON.stringify(scroll)}`);
  await page.evaluate(() => document.querySelector('.sheet-body').scrollTo(0, 0));
  const col = page.locator('.sg-hc').first();
  const beforeCol = await col.boundingBox();
  await page.mouse.move(beforeCol.x + beforeCol.width - 2, beforeCol.y + beforeCol.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeCol.x + beforeCol.width + 40, beforeCol.y + beforeCol.height / 2, { steps: 4 });
  await page.mouse.up();
  const afterCol = await page.locator('.sg-hc').first().boundingBox();
  assert.ok(afterCol.width > beforeCol.width + 20, `열 너비가 바뀌지 않음: ${beforeCol.width} → ${afterCol.width}`);
  const row = page.locator('.sg-hr').first();
  const beforeRow = await row.boundingBox();
  await page.mouse.move(beforeRow.x + beforeRow.width / 2, beforeRow.y + beforeRow.height - 2);
  await page.mouse.down();
  await page.mouse.move(beforeRow.x + beforeRow.width / 2, beforeRow.y + beforeRow.height + 30, { steps: 4 });
  await page.mouse.up();
  const afterRow = await page.locator('.sg-hr').first().boundingBox();
  assert.ok(afterRow.height > beforeRow.height + 15, `행 높이가 바뀌지 않음: ${beforeRow.height} → ${afterRow.height}`);
  const initialRows = await page.evaluate(() => window.grid.geo.nRows);
  await page.evaluate(() => {
    const el = document.querySelector('.sheet-body');
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForFunction((count) => window.grid.geo.nRows > count, initialRows);
  assert.equal(await page.locator('.sg-hc').first().evaluate((el) => el.getBoundingClientRect().width), afterCol.width);
  console.log('sheet scroll and row/column resize: ok');
} finally {
  await browser.close();
  server.close();
}
