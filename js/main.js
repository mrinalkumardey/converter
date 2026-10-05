import * as pdfjsLib from '../lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const V = new URL(import.meta.url).searchParams.get('v') || '0';
const imgWorker = new Worker(new URL('./workers/image.worker.js?v=' + V, import.meta.url));
const pdfWorker = new Worker(new URL('./workers/pdfbuild.worker.js?v=' + V, import.meta.url));

/* ---------- Worker calls ---------- */
let nextId = 1;
const pending = new Map();
for (const w of [imgWorker, pdfWorker]) {
  w.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
  };
}
function call(w, msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id }, transfer);
  });
}

/* ---------- Helpers ---------- */
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImg = (f) => f.type.startsWith('image/');
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const baseName = (n) => n.replace(/\.[^.]+$/, '');

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

/* ---------- State ---------- */
let items = [];
let running = false;
let cancelled = false;
const prog = { start: 0 };
let thumbChain = Promise.resolve();

/* ---------- File list ---------- */
function addFiles(list) {
  for (const f of list) {
    if (!(isPdf(f) || isImg(f))) continue;
    const it = { file: f, status: 'Waiting', outs: [], note: '', thumb: '', pages: 0, done: false, frac: 0 };
    items.push(it);
    makeThumb(it);
  }
  render();
}

function makeThumb(it) {
  thumbChain = thumbChain.then(async () => {
    try {
      const S = 96;
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      if (isImg(it.file)) {
        const bmp = await createImageBitmap(it.file, { resizeWidth: S, resizeQuality: 'low' });
        const k = Math.min(S / bmp.width, S / bmp.height, 1);
        c.width = Math.max(1, Math.round(bmp.width * k));
        c.height = Math.max(1, Math.round(bmp.height * k));
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close();
      } else {
        const pdf = await pdfjsLib.getDocument({ data: await it.file.arrayBuffer() }).promise;
        it.pages = pdf.numPages;
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(S / base.width, S / base.height) });
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        page.cleanup();
        pdf.destroy();
      }
      it.thumb = c.toDataURL('image/jpeg', 0.7);
    } catch (err) {
      it.thumb = '';
    }
    render();
  });
}

function updateProgress() {
  const n = items.length;
  if (!n) return;
  const sum = items.reduce((a, i) => a + (i.done ? 1 : i.frac || 0), 0);
  const pct = Math.min(100, Math.round((sum / n) * 100));
  $('progBar').style.width = pct + '%';
  const doneCount = items.filter((i) => i.done).length;
  const elapsed = (performance.now() - prog.start) / 1000;
  let text = `${doneCount} of ${n} files - ${pct}%`;
  if (sum > 0.05 && pct < 100) text += ` - about ${Math.ceil((elapsed / sum) * (n - sum))} s left`;
  $('progText').textContent = text;
}

function render() {
  const tb = $('list');
  tb.innerHTML = '';
  items.forEach((it, i) => {
    const outs = it.outs.map((o) => `<a href="${o.url}" download="${esc(o.name)}">${esc(o.name)} (${kb(o.size)})</a>`).join('<br>');
    const thumb = it.thumb
      ? `<img class="thumb" src="${it.thumb}">`
      : `<div class="thumb ph">${isPdf(it.file) ? 'PDF' : 'IMG'}</div>`;
    const pages = it.pages ? ` <small>(${it.pages} pages)</small>` : '';
    const dlCell = it.outs.length
      ? `<button class="dl" data-a="dl" data-i="${i}">⬇ ${it.outs.length > 1 ? 'Download ZIP (' + it.outs.length + ')' : 'Download'}</button>`
      : '-';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}</td><td>${thumb}</td><td>${esc(it.file.name)}${pages}</td><td>${kb(it.file.size)}</td><td>${outs || '-'}</td><td>${dlCell}</td><td>${esc(it.status)}</td>
      <td><button class="small" data-a="up" data-i="${i}" ${running ? 'disabled' : ''}>▲</button>
          <button class="small" data-a="down" data-i="${i}" ${running ? 'disabled' : ''}>▼</button>
          <button class="small" data-a="del" data-i="${i}" ${running ? 'disabled' : ''}>✕</button></td>`;
    tb.appendChild(tr);
  });
}

function saveBlobUrl(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$('list').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const i = +b.dataset.i;

  if (b.dataset.a === 'dl') {
    const it = items[i];
    if (!it || !it.outs.length) return;
    if (it.outs.length === 1) { saveBlobUrl(it.outs[0].url, it.outs[0].name); return; }
    const files = [];
    for (const o of it.outs) {
      files.push({ name: o.name, data: new Uint8Array(await (await fetch(o.url)).arrayBuffer()) });
    }
    saveBlobUrl(URL.createObjectURL(makeZip(files)), baseName(it.file.name) + '_files.zip');
    return;
  }

  if (running) return;
  if (b.dataset.a === 'up' && i > 0) [items[i - 1], items[i]] = [items[i], items[i - 1]];
  if (b.dataset.a === 'down' && i < items.length - 1) [items[i + 1], items[i]] = [items[i], items[i + 1]];
  if (b.dataset.a === 'del') items.splice(i, 1);
  render();
});

/* ---------- Drop zone and buttons ---------- */
const drop = $('drop');
drop.onclick = () => $('picker').click();
$('picker').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };

document.querySelectorAll('[data-kb]').forEach((b) => {
  b.onclick = () => { $('target').value = b.dataset.kb; $('useTarget').checked = true; };
});
$('quality').oninput = () => { $('qv').textContent = $('quality').value; };
$('cancel').onclick = () => { cancelled = true; };
$('clear').onclick = () => {
  if (running) return;
  items = [];
  $('merged').innerHTML = '';
  $('progWrap').style.display = 'none';
  render();
};

/* ---------- ZIP ---------- */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0, cdSize = 0;
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, nameB.length, true); h.setUint16(28, 0, true);
    chunks.push(h.buffer, nameB, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, nameB.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, nameB);
    cdSize += 46 + nameB.length;
    offset += 30 + nameB.length + size;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], { type: 'application/zip' });
}
$('dlall').onclick = async () => {
  const links = [...document.querySelectorAll('#list td a, #merged a')];
  if (!links.length) return;
  const used = new Set(), files = [];
  for (const a of links) {
    let name = a.download, n = 1;
    while (used.has(name)) name = a.download.replace(/(\.[^.]+)$/, `_${n++}$1`);
    used.add(name);
    files.push({ name, data: new Uint8Array(await (await fetch(a.href)).arrayBuffer()) });
  }
  saveBlobUrl(URL.createObjectURL(makeZip(files)), 'converted_files.zip');
};

/* ---------- Settings ---------- */
function settings() {
  let rz = null;
  if ($('useResize').checked) {
    const u = $('runit').value, d = +$('rdpi').value;
    const conv = (v) => {
      v = +v;
      if (!v) return 0;
      return u === 'px' ? Math.round(v) : Math.round((v / (u === 'cm' ? 2.54 : 25.4)) * d);
    };
    rz = { w: conv($('rw').value), h: conv($('rh').value), mode: $('rmode').value };
    if (!rz.w && !rz.h) rz = null;
  }
  return {
    out: $('fmt').value,
    useTarget: $('useTarget').checked,
    targetKB: +$('target').value || 0,
    quality: +$('quality').value / 100,
    dpi: +$('dpi').value,
    page: $('page').value,
    range: $('range').value,
    pad: $('sizeMode').value === 'fill',
    rz,
  };
}

function addOut(it, name, blob) {
  it.outs.push({ name, size: blob.size, url: URL.createObjectURL(blob) });
}

function encode(src, type, s, targetBytes, pad = false) {
  return call(
    imgWorker,
    { src, type, targetBytes, quality: s.quality, rz: s.rz, pad },
    src instanceof ImageBitmap ? [src] : []
  );
}

/* ---------- PDF helpers ---------- */
async function openPdf(file) {
  try {
    return await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new Error('PDF is password protected');
    throw err;
  }
}

async function renderPage(pdf, n, dpi) {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  let vp = page.getViewport({ scale });
  const maxPixels = 40e6;
  if (vp.width * vp.height > maxPixels) {
    scale *= Math.sqrt(maxPixels / (vp.width * vp.height));
    vp = page.getViewport({ scale });
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const bmp = await createImageBitmap(canvas);
  page.cleanup();
  canvas.width = 0; canvas.height = 0;
  return { bmp, pw: base.width, ph: base.height };
}

/* ---------- Conversions ---------- */
async function toImages(it, s) {
  const type = MIME[s.out];
  const tb = s.useTarget ? s.targetKB * 1024 : 0;
  const base = baseName(it.file.name);
  if (isImg(it.file)) {
    const r = await encode(it.file, type, s, tb, s.pad);
    addOut(it, `${base}_converted.${s.out}`, r.blob);
    it.note = r.note;
  } else {
    const pdf = await openPdf(it.file);
    const idx = parseRange(s.range, pdf.numPages);
    for (let k = 0; k < idx.length; k++) {
      if (cancelled) break;
      it.status = `Page ${k + 1}/${idx.length}`;
      it.frac = k / idx.length;
      updateProgress();
      render();
      const { bmp } = await renderPage(pdf, idx[k] + 1, s.dpi);
      const r = await encode(bmp, type, s, tb, s.pad);
      addOut(it, `${base}_page${idx[k] + 1}.${s.out}`, r.blob);
      if (r.note) it.note = r.note;
    }
    pdf.destroy();
  }
}

async function buildPdf(list, s) {
  const imgs = list.filter((i) => isImg(i.file));
  const fixed = list.filter((i) => isPdf(i.file)).reduce((a, i) => a + i.file.size, 0);
  const T = s.useTarget ? s.targetKB * 1024 : 0;
  let factor = 1, blob = null, note = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    list.forEach((i) => (i.frac = 0));
    const budget = T && imgs.length
      ? Math.max(1500, ((T * 0.95 - fixed - 2000 - 1000 * imgs.length) / imgs.length) * factor)
      : 0;
    const parts = [];
    for (const it of list) {
      if (cancelled) throw new Error('Cancelled');
      if (isImg(it.file)) {
        const r = await encode(it.file, 'image/jpeg', s, budget);
        parts.push({ kind: 'img', bytes: await r.blob.arrayBuffer(), w: r.w, h: r.h });
      } else {
        parts.push({ kind: 'pdf', bytes: await it.file.arrayBuffer() });
      }
      it.frac = ((list.indexOf(it) + 1) / list.length) * 0.95;
      updateProgress();
    }
    const res = await call(pdfWorker, { op: 'build', parts, page: s.page, range: s.range }, parts.map((p) => p.bytes));
    blob = new Blob([res.bytes], { type: 'application/pdf' });
    if (!T || !imgs.length || blob.size <= T) break;
    factor *= (0.9 * T) / blob.size;
  }
  if (T && blob.size > T) note = 'Could not reach target - best effort';
  return { blob, note };
}

async function pdfTool(it, s) {
  if (!isPdf(it.file)) throw new Error('This option needs a PDF input');
  const bytes = await it.file.arrayBuffer();
  const res = await call(pdfWorker, { op: 'extract', bytes, range: s.range, split: s.out === 'split' }, [bytes]);
  const base = baseName(it.file.name);
  res.files.forEach((b, i) => {
    const name = s.out === 'split' ? `${base}_page${res.pages[i]}.pdf` : `${base}_extract.pdf`;
    addOut(it, name, new Blob([b], { type: 'application/pdf' }));
  });
}

async function compressPdf(it, s) {
  if (!isPdf(it.file)) throw new Error('This option needs a PDF input');
  const pdf = await openPdf(it.file);
  const idx = parseRange(s.range, pdf.numPages);
  const T = s.useTarget ? s.targetKB * 1024 : 0;
  const s2 = { ...s, rz: null };
  let factor = 1, blob = null, note = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const budget = T ? Math.max(1500, ((T * 0.95 - 2000 - 1000 * idx.length) / idx.length) * factor) : 0;
    const parts = [];
    for (let k = 0; k < idx.length; k++) {
      if (cancelled) throw new Error('Cancelled');
      it.status = `Pass ${attempt + 1}: page ${k + 1}/${idx.length}`;
      it.frac = k / idx.length;
      updateProgress();
      render();
      const { bmp, pw, ph } = await renderPage(pdf, idx[k] + 1, s.dpi);
      const r = await encode(bmp, 'image/jpeg', s2, budget);
      parts.push({ kind: 'img', bytes: await r.blob.arrayBuffer(), w: r.w, h: r.h, pw, ph });
    }
    const res = await call(pdfWorker, { op: 'build', parts, page: 'fit', range: '' }, parts.map((p) => p.bytes));
    blob = new Blob([res.bytes], { type: 'application/pdf' });
    if (!T || blob.size <= T) break;
    factor *= (0.9 * T) / blob.size;
  }
  pdf.destroy();
  if (T && blob.size > T) note = 'Could not reach target - best effort';
  else if (blob.size >= it.file.size) note = 'Result is not smaller than the original';
  else note = 'Text becomes image (not selectable)';
  addOut(it, baseName(it.file.name) + '_compressed.pdf', blob);
  it.note = note;
}

/* ---------- Run ---------- */
async function runAll() {
  const s = settings();
  items.forEach((i) => { i.outs = []; i.status = 'Waiting'; i.note = ''; i.done = false; i.frac = 0; });
  $('merged').innerHTML = '';
  prog.start = performance.now();
  $('progWrap').style.display = 'block';
  $('progBar').style.width = '0%';
  updateProgress();
  render();

  if (s.out === 'merge') {
    items.forEach((i) => (i.status = 'Merging...'));
    render();
    try {
      const { blob, note } = await buildPdf(items, s);
      const url = URL.createObjectURL(blob);
      $('merged').innerHTML = `✅ Merged PDF ready (${kb(blob.size)}) <a class="dlbtn" href="${url}" download="merged.pdf">⬇ Download merged.pdf</a> ${esc(note)}`;
      items.forEach((i) => (i.status = 'Merged'));
    } catch (err) {
      items.forEach((i) => (i.status = 'Error: ' + err.message));
    }
    items.forEach((i) => (i.done = true));
    updateProgress();
    return;
  }

  for (const it of items) {
    if (cancelled) { it.status = 'Cancelled'; it.done = true; continue; }
    it.status = 'Working...';
    render();
    const t0 = performance.now();
    try {
      if (s.out === 'pdf') {
        if (!isImg(it.file)) throw new Error('PDF input: choose Merge or another PDF option');
        const { blob, note } = await buildPdf([it], s);
        addOut(it, baseName(it.file.name) + '.pdf', blob);
        it.note = note;
      } else if (s.out === 'extract' || s.out === 'split') {
        await pdfTool(it, s);
      } else if (s.out === 'compress') {
        await compressPdf(it, s);
      } else {
        await toImages(it, s);
      }
      it.status = 'Done (' + ((performance.now() - t0) / 1000).toFixed(1) + ' s)' + (it.note ? ' - ' + it.note : '');
    } catch (err) {
      it.status = 'Error: ' + err.message;
    }
    it.done = true;
    updateProgress();
    render();
  }
}

$('go').onclick = async () => {
  if (running || !items.length) return;
  running = true; cancelled = false;
  $('go').disabled = true;
  try {
    await runAll();
  } finally {
    running = false;
    $('go').disabled = false;
    const secs = ((performance.now() - prog.start) / 1000).toFixed(1);
    const errs = items.filter((i) => i.status.startsWith('Error')).length;
    if (!cancelled) $('progBar').style.width = '100%';
    $('progText').textContent =
      `${cancelled ? 'Cancelled' : 'Finished'} - ${items.filter((i) => i.done).length} of ${items.length} files in ${secs} s` +
      (errs ? ` - ${errs} error(s)` : '');
    render();
  }
};

/* ---------- Size slider ---------- */
const MINKB = 5, MAXKB = 4000;
const sliderToKB = (v) => Math.round(MINKB * Math.pow(MAXKB / MINKB, v / 1000));
const kbToSlider = (k) =>
  Math.round(1000 * Math.log(Math.max(MINKB, Math.min(MAXKB, k)) / MINKB) / Math.log(MAXKB / MINKB));

function updateLabels() {
  const on = $('useTarget').checked;
  $('sizeLabel').textContent = (+$('target').value || 0) + ' KB' + (on ? '' : ' (off)');
  $('qmode').textContent = on ? '(maximum allowed quality)' : '(exact quality - controls size)';
}
function syncFromKB() {
  $('sizeSlider').value = kbToSlider(+$('target').value || MINKB);
  updateLabels();
}

$('sizeSlider').addEventListener('input', () => {
  $('target').value = sliderToKB(+$('sizeSlider').value);
  $('useTarget').checked = true;
  updateLabels();
});
$('target').addEventListener('input', syncFromKB);
$('useTarget').addEventListener('change', updateLabels);
document.querySelectorAll('[data-kb]').forEach((b) => b.addEventListener('click', syncFromKB));
syncFromKB();