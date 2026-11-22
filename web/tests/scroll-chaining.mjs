// overflow가 걸린 상자(PDF 쪽 .page, 마크다운 코드 블록·표) 위에서 시작한 세로 스크롤이 문서 스크롤로 이어지는지 본다.
// 모든 요소에 overscroll-behavior: none을 걸면 이 상자들이 스크롤을 막아, 쪽 위를 끌어도 문서가 움직이지 않았다.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

/** 글자 한 줄씩 있는 count쪽짜리 최소 PDF */
function makePdf(count) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let i = 0; i < count; i++) {
    const text = `BT /F1 24 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`;
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const filler = (word, n) => Array.from({ length: n }, (_, i) => `${word} ${i} ${'lorem ipsum '.repeat(30)}`).join('\n\n');
const markdown = [
  '# scroll',
  filler('before', 30),
  '```',
  ...Array.from({ length: 30 }, () => 'x'.repeat(300)),
  '```',
  filler('middle', 30),
  '| a | b |\n|---|---|',
  ...Array.from({ length: 30 }, (_, i) => `| ${'w'.repeat(200)} | ${i} |`),
  '',
  filler('after', 30),
].join('\n\n');

const fixtures = {
  '/fixture.pdf': ['application/pdf', makePdf(6)],
  '/fixture.md': ['text/markdown; charset=utf-8', Buffer.from(markdown)],
};
const server = await createServer({
  logLevel: 'error',
  server: { port: 0 },
  plugins: [{ name: 'scroll-chaining-fixtures', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      const fixture = fixtures[req.url];
      if (!fixture) return next();
      res.setHeader('Content-Type', fixture[0]);
      res.end(fixture[1]);
    });
  } }],
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/viewer.html`;
const browser = await chromium.launch({ headless: true });

const scrollTop = (page) => page.evaluate(() => document.scrollingElement.scrollTop);

/** (x, y)에서 손가락을 대고 위로 distance만큼 끈다. */
async function touchDrag(page, cdp, x, y, distance) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - (distance * i) / 10 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
}

/** 상자를 화면 가운데에 두고, 상자 위의 점(x, 화면 가운데)을 돌려준다. */
async function pointOn(page, selector) {
  await page.locator(selector).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  const x = 300;
  const y = page.viewportSize().height / 2;
  const hit = await page.evaluate(([px, py, sel]) => !!document.elementFromPoint(px, py)?.closest(sel), [x, y, selector]);
  assert.ok(hit, `${selector} 위의 점을 찾지 못함`);
  return { x, y };
}

try {
  // 터치: PDF 연속 스크롤의 쪽 위, 마크다운 코드 블록·표 위
  const touch = await browser.newContext({ viewport: { width: 800, height: 600 }, hasTouch: true, isMobile: true });
  const pdf = await touch.newPage();
  await pdf.goto(url);
  await pdf.evaluate(() => window.viewer.open({ fmt: 'pdf', src: '/fixture.pdf', mode: 'scroll' }));
  await pdf.locator('.page canvas').first().waitFor();
  const pdfCdp = await touch.newCDPSession(pdf);
  const { x, y } = await pointOn(pdf, '.page');
  const before = await scrollTop(pdf);
  await touchDrag(pdf, pdfCdp, x, y, 250);
  const after = await scrollTop(pdf);
  assert.ok(after - before > 100, `PDF 쪽 위를 끌어도 스크롤되지 않음: ${before} → ${after}`);
  console.log('touch drag on a PDF page scrolls the document: ok');

  // 한 쪽씩 + 화면 가득: 쪽이 화면보다 길어 #doc가 스스로 세로 스크롤한다.
  const flip = await touch.newPage();
  await flip.goto(url);
  await flip.evaluate(() => window.viewer.open({ fmt: 'pdf', src: '/fixture.pdf', mode: 'page', fit: 'width' }));
  await flip.locator('.page canvas').first().waitFor();
  const flipCdp = await touch.newCDPSession(flip);
  const docTop = () => flip.evaluate(() => document.getElementById('doc').scrollTop);
  const flipBefore = await docTop();
  await touchDrag(flip, flipCdp, 300, 400, 200);
  const flipAfter = await docTop();
  assert.ok(flipAfter - flipBefore > 100, `한 쪽씩·화면 가득에서 쪽 위를 끌어도 스크롤되지 않음: ${flipBefore} → ${flipAfter}`);
  console.log('touch drag on a page in page/width mode scrolls #doc: ok');

  const md = await touch.newPage();
  await md.goto(url);
  await md.evaluate(() => window.viewer.open({ fmt: 'md', src: '/fixture.md' }));
  await md.locator('pre').first().waitFor();
  const mdCdp = await touch.newCDPSession(md);
  for (const selector of ['pre', 'table']) {
    const point = await pointOn(md, selector);
    const start = await scrollTop(md);
    await touchDrag(md, mdCdp, point.x, point.y, 250);
    const end = await scrollTop(md);
    assert.ok(end - start > 100, `마크다운 ${selector} 위를 끌어도 스크롤되지 않음: ${start} → ${end}`);
    console.log(`touch drag on a markdown ${selector} scrolls the document: ok`);
  }

  // 휠(데스크톱): 마크다운 코드 블록·표 위
  const desktop = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await desktop.goto(url);
  await desktop.evaluate(() => window.viewer.open({ fmt: 'md', src: '/fixture.md' }));
  await desktop.locator('pre').first().waitFor();
  for (const selector of ['pre', 'table']) {
    const point = await pointOn(desktop, selector);
    await desktop.mouse.move(point.x, point.y);
    const start = await scrollTop(desktop);
    await desktop.mouse.wheel(0, 300);
    await desktop.waitForTimeout(500);
    const end = await scrollTop(desktop);
    assert.ok(end - start > 100, `마크다운 ${selector} 위에서 휠을 굴려도 스크롤되지 않음: ${start} → ${end}`);
    console.log(`wheel on a markdown ${selector} scrolls the document: ok`);
  }
} finally {
  await browser.close();
  await server.close();
}
