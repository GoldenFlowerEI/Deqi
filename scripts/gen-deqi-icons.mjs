// Generate Deqi app icons (PNG, ICO) without any image library deps.
// All assets go to packages/desktop/src-tauri/icons/.
//
// Design: a dark-navy rounded square with a gold diamond outline and an
// orange dot in the center — a tiny "phi/spark" mark. Reads cleanly at
// 16x16 (favicon) and 512x512 (macOS retina). One script, no deps.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "packages", "desktop", "src-tauri", "icons");
mkdirSync(OUT, { recursive: true });

// --- minimal PNG encoder (RGBA 8-bit, non-interlaced) -------------------

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function ihdr(width, height) {
  const buf = Buffer.alloc(13);
  buf.writeUInt32BE(width, 0);
  buf.writeUInt32BE(height, 4);
  buf[8] = 8;   // bit depth
  buf[9] = 6;   // colour type: RGBA
  buf[10] = 0;  // compression
  buf[11] = 0;  // filter
  buf[12] = 0;  // interlace
  return chunk("IHDR", buf);
}

function makePng(width, height) {
  // 1. compute pixels
  const px = new Uint8Array(width * height * 4);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const r = Math.min(width, height) * 0.42;          // diamond outer
  const dotR = Math.max(1.5, Math.min(width, height) * 0.07);
  const lineHalf = Math.max(1, Math.min(width, height) * 0.04);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // distance to rounded-square edge (rounded corners, radius ~14% of size)
      const cornerR = Math.min(width, height) * 0.16;
      const ax = Math.abs(x - cx) - (width / 2 - cornerR);
      const ay = Math.abs(y - cy) - (height / 2 - cornerR);
      const outsideCorner = Math.hypot(Math.max(ax, 0), Math.max(ay, 0)) > cornerR;
      const outsideRect = Math.abs(x - cx) > width / 2 || Math.abs(y - cy) > height / 2;
      if (outsideRect || outsideCorner) {
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0;
        continue;
      }
      // bg: dark navy with a subtle radial gradient toward center
      const dx = (x - cx) / (width / 2);
      const dy = (y - cy) / (height / 2);
      const d = Math.min(1, Math.hypot(dx, dy));
      const t = 1 - d; // 0 at edge, 1 at center
      const bgR = 14 + Math.round(8 * t);
      const bgG = 16 + Math.round(10 * t);
      const bgB = 28 + Math.round(16 * t);
      // diamond outline (gold)
      // diamond (rotated square): |x-cx| + |y-cy| = r
      const manhattan = Math.abs(x - cx) + Math.abs(y - cy);
      const onDiamond = Math.abs(manhattan - r) < lineHalf;
      // inner accent dot (orange)
      const distDot = Math.hypot(x - cx, y - cy);
      const onDot = distDot < dotR;
      if (onDiamond) {
        px[i] = 230; px[i + 1] = 200; px[i + 2] = 90; px[i + 3] = 255;
      } else if (onDot) {
        px[i] = 255; px[i + 1] = 130; px[i + 2] = 60; px[i + 3] = 255;
      } else {
        px[i] = bgR; px[i + 1] = bgG; px[i + 2] = bgB; px[i + 3] = 255;
      }
    }
  }
  // 2. build raw scanlines (filter byte 0 per row)
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(px.buffer, px.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  // 3. compress & assemble
  const idat = chunk("IDAT", deflateSync(raw));
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([PNG_SIG, ihdr(width, height), idat, iend]);
}

// --- minimal ICO encoder (wraps PNG frames, Vista+) ---------------------

function makeIco(pngs /* Array<{size, buf}> */) {
  // ICONDIR
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type: 1 = icon
  header.writeUInt16LE(pngs.length, 4); // count
  // ICONDIRENTRY[] (16 bytes each)
  const dirSize = 16 * pngs.length;
  const dir = Buffer.alloc(dirSize);
  let offset = 6 + dirSize;
  const frames = [];
  for (let i = 0; i < pngs.length; i++) {
    const { size, buf } = pngs[i];
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size;     // width
    dir[e + 1] = size >= 256 ? 0 : size; // height
    dir[e + 2] = 0;                      // colors
    dir[e + 3] = 0;                      // reserved
    dir.writeUInt16LE(1, e + 4);        // planes
    dir.writeUInt16LE(32, e + 6);       // bpp
    dir.writeUInt32LE(buf.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += buf.length;
    frames.push(buf);
  }
  return Buffer.concat([header, dir, ...frames]);
}

// --- write everything ----------------------------------------------------

const sizes = [
  { name: "32x32.png", size: 32 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "icon.png", size: 512 },
];
const written = [];
for (const { name, size } of sizes) {
  const buf = makePng(size, size);
  const path = join(OUT, name);
  writeFileSync(path, buf);
  written.push(`${name} (${size}x${size}, ${buf.length} bytes)`);
}

// ICO containing 16, 32, 48, 64, 128, 256
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoFrames = icoSizes.map((s) => ({ size: s, buf: makePng(s, s) }));
const icoBuf = makeIco(icoFrames);
writeFileSync(join(OUT, "icon.ico"), icoBuf);
written.push(`icon.ico (${icoSizes.join("/")}, ${icoBuf.length} bytes)`);

// We also drop a placeholder .icns (macOS) — empty stub, harmless
// Tauri build will skip it on non-mac. The real .icns requires
// `iconutil` on macOS only, so we just don't ship it here.
writeFileSync(join(OUT, "icon.icns"), Buffer.alloc(0));

console.log("[deqi-icons] wrote:");
for (const w of written) console.log("  -", w);
console.log(`[deqi-icons] -> ${OUT}`);
