self.window = self;
let pngReady = false;
function loadPng() {
  if (!pngReady) { importScripts('../../lib/pako.min.js', '../../lib/UPNG.js'); pngReady = true; }
}
function crc32(u8) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) {
    c = (crc ^ u8[i]) & 255;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function padBlob(blob, type, size) {
  let need = size - blob.size;
  if (need <= 0) return blob;
  const buf = new Uint8Array(await blob.arrayBuffer());

  if (type === 'image/jpeg') {
    let pos = 2;
    if (buf[2] === 0xFF && buf[3] === 0xE0) pos = 4 + ((buf[4] << 8) | buf[5]);
    const segs = [];
    while (need >= 5) {
      let total = Math.min(need, 65537);
      const rem = need - total;
      if (rem > 0 && rem < 5) total -= (5 - rem);
      const seg = new Uint8Array(total);
      const payload = total - 4;
      seg[0] = 0xFF; seg[1] = 0xFE;
      seg[2] = ((payload + 2) >> 8) & 255; seg[3] = (payload + 2) & 255;
      segs.push(seg);
      need -= total;
    }
    return new Blob([buf.subarray(0, pos), ...segs, buf.subarray(pos)], { type });
  }

  if (type === 'image/png') {
    if (need < 20) return blob;
    const dataLen = need - 12;
    const chunk = new Uint8Array(need);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, dataLen);
    chunk.set([0x74, 0x45, 0x58, 0x74], 4);
    chunk.set([67, 111, 109, 109, 101, 110, 116, 0], 8);
    dv.setUint32(8 + dataLen, crc32(chunk.subarray(4, 8 + dataLen)));
    const cut = buf.length - 12;
    return new Blob([buf.subarray(0, cut), chunk, buf.subarray(cut)], { type });
  }

  if (type === 'image/webp') {
    const payload = (need - 8) & ~1;
    if (payload < 2) return blob;
    const chunk = new Uint8Array(8 + payload);
    chunk.set([0x4A, 0x55, 0x4E, 0x4B], 0);
    new DataView(chunk.buffer).setUint32(4, payload, true);
    const out = new Uint8Array(buf.length + chunk.length);
    out.set(buf, 0); out.set(chunk, buf.length);
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    return new Blob([out], { type });
  }
  return blob;
}

self.onmessage = async (e) => {
    const { id, src, type, targetBytes, quality, rz, pad } = e.data;
  try {
    const bmp = (src instanceof Blob) ? await createImageBitmap(src) : src;

    const rw = (rz && rz.w) || 0, rh = (rz && rz.h) || 0;
    let BW = bmp.width, BH = bmp.height;
    if (rw && rh) {
      if (rz.mode === 'fit') {
        const k = Math.min(rw / bmp.width, rh / bmp.height);
        BW = Math.round(bmp.width * k); BH = Math.round(bmp.height * k);
      } else { BW = rw; BH = rh; }
    } else if (rw) { BW = rw; BH = Math.round(bmp.height * rw / bmp.width); }
    else if (rh) { BH = rh; BW = Math.round(bmp.width * rh / bmp.height); }
    const lock = !!(rw || rh);

    function draw(scale, white) {
      const w = Math.max(1, Math.round(BW * scale));
      const h = Math.max(1, Math.round(BH * scale));
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d', { willReadFrequently: !white });
      if (white) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(bmp, 0, 0, w, h);
      return { c, ctx, w, h };
    }
    async function enc(scale, q) {
      const { c, w, h } = draw(scale, type === 'image/jpeg');
      const blob = await c.convertToBlob({ type, quality: q });
      return { blob, w, h };
    }
    function pngEnc(scale, cnum) {
      const { ctx, w, h } = draw(scale, false);
      const d = ctx.getImageData(0, 0, w, h);
      const buf = UPNG.encode([d.data.buffer], w, h, cnum);
      return { blob: new Blob([buf], { type: 'image/png' }), w, h };
    }
    const LOCKNOTE = 'Cannot reach target at this exact size - smallest used';

    let best = null, note = '';
    if (type === 'image/png' && targetBytes) {
      loadPng();
      const levels = [0, 256, 192, 128, 96, 64, 48, 32, 16];
      let scale = 1;
      for (let a = 0; a < (lock ? 1 : 16) && !best; a++) {
        const smallest = pngEnc(scale, 16);
        if (smallest.blob.size > targetBytes) {
          if (lock) { best = smallest; note = LOCKNOTE; break; }
          scale *= 0.85; continue;
        }
        for (const cn of levels) {
          const r = cn === 16 ? smallest : pngEnc(scale, cn);
          if (r.blob.size <= targetBytes) {
            best = r;
            if (cn > 0) note = 'Colours reduced to ' + cn;
            if (scale < 1) note += (note ? ', ' : '') + 'resized to ' + Math.round(scale * 100) + '%';
            break;
          }
        }
      }
      if (!best) { best = pngEnc(0.05, 16); note = 'Target too small - best effort'; }
    } else if (!targetBytes || type === 'image/png') {
      best = await enc(1, quality);
    } else {
      let scale = 1;
      for (let a = 0; a < (lock ? 1 : 14) && !best; a++) {
        const lowest = await enc(scale, 0.01);
        if (lowest.blob.size > targetBytes) {
          if (lock) { best = lowest; note = LOCKNOTE; break; }
          scale *= 0.85; continue;
        }
        let lo = 0.01, hi = quality;
        best = lowest;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          const r = await enc(scale, mid);
          if (r.blob.size <= targetBytes) { best = r; lo = mid; } else { hi = mid; }
        }
        if (scale < 1) note = 'Resized to ' + Math.round(scale * 100) + '%';
      }
      if (!best) { best = await enc(0.05, 0.01); note = 'Target too small - best effort'; }
    }
    
        if (pad && targetBytes) {
      const goal = Math.floor(targetBytes * 0.99);
      if (best.blob.size < goal) {
        best = { ...best, blob: await padBlob(best.blob, type, goal) };
        note += (note ? ', ' : '') + 'padded to ~' + Math.round(goal / 1024) + ' KB';
      }
    }
    if (bmp.close) bmp.close();
    self.postMessage({ id, blob: best.blob, w: best.w, h: best.h, note });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};