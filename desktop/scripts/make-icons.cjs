// Renders brand/facet-icon.svg into build/icon.png (1024×1024) and build/icon.ico (16–256 px),
// using Chromium's SVG renderer at each size so small sizes stay crisp. Run: `npm run icons`.
// ICO entries: 32-bit BMP for sizes below 256 (best compatibility with NSIS and Explorer), PNG for 256.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const svgPath = path.resolve(root, '..', 'brand', 'facet-icon.svg');
const outDir = path.join(root, 'build');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

// A compact PNG encoder (Chromium's toDataURL favors speed over size): adaptive row filters + zlib level 9.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const stride = size * 4;
  const out = Buffer.alloc((stride + 1) * size);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < size; y++) {
    let best = null;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const row = Buffer.alloc(stride);
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const cur = rgba[y * stride + x];
        const a = x >= 4 ? rgba[y * stride + x - 4] : 0;
        const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
        const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur - pred) & 0xff;
        row[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = { f, row };
      }
    }
    out[y * (stride + 1)] = best.f;
    best.row.copy(out, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // width
  header.writeInt32LE(size * 2, 8); // height (XOR + AND masks)
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bit count
  header.writeUInt32LE(0, 16); // BI_RGB
  const maskRow = Math.ceil(size / 32) * 4;
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2]; // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s]; // R
      pixels[d + 3] = rgba[s + 3]; // A
    }
  }
  const mask = Buffer.alloc(maskRow * size); // all zero: alpha decides
  return Buffer.concat([header, pixels, mask]);
}

function buildIco(images) {
  const count = images.length;
  const dir = Buffer.alloc(6 + 16 * count);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // icon
  dir.writeUInt16LE(count, 4);
  let offset = dir.length;
  const blobs = [];
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
    blobs.push(data);
  });
  return Buffer.concat([dir, ...blobs]);
}

app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(svgPath, 'utf8');
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
    const sizes = [1024, ...ICO_SIZES];
    const result = await win.webContents.executeJavaScript(`(async () => {
      const svg = ${JSON.stringify(svg)};
      const out = {};
      for (const size of ${JSON.stringify(sizes)}) {
        // Render the vector at the target size (not a downscale of one big bitmap).
        const sized = svg.replace('<svg ', '<svg width="' + size + '" height="' + size + '" ');
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, size, size);
        out[size] = Array.from(ctx.getImageData(0, 0, size, size).data);
      }
      return out;
    })()`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'icon.png'), encodePng(1024, Buffer.from(result[1024])));
    const images = ICO_SIZES.map((size) => ({
      size,
      data: size >= 256 ? encodePng(size, Buffer.from(result[size])) : bmpEntry(size, Buffer.from(result[size])),
    }));
    fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(images));
    console.log(`Wrote build/icon.png and build/icon.ico (${ICO_SIZES.join(', ')})`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  app.quit();
});
