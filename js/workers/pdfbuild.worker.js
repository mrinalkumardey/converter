importScripts('../../lib/pdf-lib.min.js');

function parseRange(str, n) {
  str = (str || '').trim();
  if (!str || str.toLowerCase() === 'all') return [...Array(n).keys()];
  const out = [];
  for (const part of str.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error('Bad page range: ' + part);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b < a || b > n) throw new Error('Pages must be between 1 and ' + n);
    for (let i = a; i <= b; i++) out.push(i - 1);
  }
  return out;
}

self.onmessage = async (e) => {
  const { id, op, range } = e.data;
  try {
    if (op === 'extract') {
      const src = await PDFLib.PDFDocument.load(e.data.bytes);
      const idx = parseRange(range, src.getPageCount());
      const groups = e.data.split ? idx.map((i) => [i]) : [idx];
      const files = [], pages = [];
      for (const g of groups) {
        const doc = await PDFLib.PDFDocument.create();
        const pgs = await doc.copyPages(src, g);
        pgs.forEach((x) => doc.addPage(x));
        files.push(await doc.save());
        pages.push(g[0] + 1);
      }
      self.postMessage({ id, files, pages }, files.map((f) => f.buffer));
      return;
    }

    const { parts, page } = e.data;
    const doc = await PDFLib.PDFDocument.create();
    for (const p of parts) {
      if (p.kind === 'img') {
        const img = await doc.embedJpg(p.bytes);
        if (page === 'a4') {
          const W = 595.28, H = 841.89;
          const pg = doc.addPage([W, H]);
          const sc = Math.min(W / img.width, H / img.height);
          pg.drawImage(img, { x: (W - img.width * sc) / 2, y: (H - img.height * sc) / 2, width: img.width * sc, height: img.height * sc });
        } else {
          const pw = p.pw || p.w * 0.75, ph = p.ph || p.h * 0.75;
          const pg = doc.addPage([pw, ph]);
          pg.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
        }
      } else {
        const src = await PDFLib.PDFDocument.load(p.bytes);
        const idx = parseRange(range, src.getPageCount());
        const pgs = await doc.copyPages(src, idx);
        pgs.forEach((x) => doc.addPage(x));
      }
    }
    const bytes = await doc.save();
    self.postMessage({ id, bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};