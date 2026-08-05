#!/usr/bin/env node
/**
 * Generiert PNG-Icons (192x192, 512x512) fuer die Feld-Erfassung-PWA.
 * Reiner Node (zlib fuer die PNG-Kompression), keine Abhaengigkeiten,
 * kein Canvas noetig. Bei Bedarf erneut ausfuehren, wenn sich
 * Farbe/Motiv aendern sollen:
 *
 *   node generate-icons.mjs
 *
 * Motiv: simple "W"-Bitmap auf farbigem Grund. Bewusst schlicht --
 * das hier ist ein privates Erfassungswerkzeug, kein Produkt-Icon.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BG = [37, 99, 235]; // #2563eb
const FG = [255, 255, 255];

// Grobe 7x5-Pixel-Font fuer "W", skaliert beim Rendern hoch.
const GLYPH_W = [
  '1,0,0,0,1',
  '1,0,0,0,1',
  '1,0,0,0,1',
  '1,0,1,0,1',
  '1,0,1,0,1',
  '1,1,0,1,1',
  '1,0,0,0,1',
].map((row) => row.split(',').map(Number));

function crc32(buf) {
  const table =
    crc32.table ||
    (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      pixels[idx] = BG[0];
      pixels[idx + 1] = BG[1];
      pixels[idx + 2] = BG[2];
      pixels[idx + 3] = 255;
    }
  }

  const rows = GLYPH_W.length;
  const cols = GLYPH_W[0].length;
  const block = Math.floor((size * 0.6) / cols);
  const glyphW = block * cols;
  const glyphH = block * rows;
  const offX = Math.floor((size - glyphW) / 2);
  const offY = Math.floor((size - glyphH) / 2);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!GLYPH_W[r][c]) continue;
      for (let by = 0; by < block; by++) {
        for (let bx = 0; bx < block; bx++) {
          const x = offX + c * block + bx;
          const y = offY + r * block + by;
          const idx = (y * size + x) * 4;
          pixels[idx] = FG[0];
          pixels[idx + 1] = FG[1];
          pixels[idx + 2] = FG[2];
          pixels[idx + 3] = 255;
        }
      }
    }
  }

  // Scanlines mit Filter-Byte 0 (None) vor jede Zeile.
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const idatData = deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const png = renderIcon(size);
  const path = join(__dirname, `icon-${size}.png`);
  writeFileSync(path, png);
  console.log(`geschrieben: icon-${size}.png (${png.length} bytes)`);
}
