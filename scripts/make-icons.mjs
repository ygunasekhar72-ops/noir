/**
 * Generates monochrome PWA icons (192/512) with a tiny hand-rolled PNG encoder.
 * Zero dependencies — pure zlib + CRC32.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "src", "web", "icons");
mkdirSync(outDir, { recursive: true });

/* -------- PNG encoding -------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // raw scanlines: filter byte 0 + RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/* -------- draw a bold monochrome "N" glyph on black -------- */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [0, 0, 0, 255];
  const fg = [255, 255, 255, 255];
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
    rgba[i + 3] = c[3];
  };
  // background
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, bg);

  const m = Math.round(size * 0.22); // margin
  const top = m;
  const bottom = size - 1 - m;
  const left = m;
  const right = size - 1 - m;
  const w = Math.max(2, Math.round(size * 0.075)); // stroke width

  const fillRect = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, fg);
  };

  // left vertical stroke of the N
  fillRect(left, top, left + w - 1, bottom);
  // right vertical stroke
  fillRect(right - w + 1, top, right, bottom);
  // diagonal from top-left to bottom-right
  const steps = bottom - top;
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(left + ((right - left - w) * s) / steps);
    for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < w; dy++) {
      const yy = top + s + dy;
      if (yy <= bottom) set(x + dx, yy, fg);
    }
  }
  return encodePng(size, size, rgba);
}

for (const size of [192, 512]) {
  const png = drawIcon(size);
  const path = join(outDir, `icon-${size}.png`);
  writeFileSync(path, png);
  console.log(`icon written: ${path} (${png.length} bytes)`);
}
