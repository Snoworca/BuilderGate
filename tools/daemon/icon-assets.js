const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICON_SVG_NAME = 'BuilderGate.svg';
const ICON_ICO_NAME = 'BuilderGate.ico';
const ICON_ICNS_NAME = 'BuilderGate.icns';

let crcTable = null;

function getCrcTable() {
  if (crcTable) {
    return crcTable;
  }

  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(buffer) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function clamp(value, min = 0, max = 255) {
  return Math.max(min, Math.min(max, value));
}

function blendPixel(buffer, width, x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= width || y >= width || alpha <= 0) {
    return;
  }

  const index = (y * width + x) * 4;
  const inv = 1 - alpha;
  buffer[index] = Math.round(buffer[index] * inv + color[0] * alpha);
  buffer[index + 1] = Math.round(buffer[index + 1] * inv + color[1] * alpha);
  buffer[index + 2] = Math.round(buffer[index + 2] * inv + color[2] * alpha);
  buffer[index + 3] = 255;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(px - ax, py - ay);
  }

  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function addGlowLine(buffer, width, start, end) {
  const glowColor = [103, 232, 249];
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = distanceToSegment(x + 0.5, y + 0.5, start[0], start[1], end[0], end[1]);
      if (distance < 24) {
        blendPixel(buffer, width, x, y, glowColor, (24 - distance) / 24 * 0.30);
      }
      if (distance < 9) {
        blendPixel(buffer, width, x, y, glowColor, 0.95);
      }
    }
  }
}

function renderLogoPng(size = 256) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const center = size / 2;
  const radius = size * 0.45;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const distance = Math.hypot(dx, dy);
      if (distance > radius + 6) {
        continue;
      }

      const index = (y * size + x) * 4;
      const radial = clamp(1 - distance / radius, 0, 1);
      let r = 2 + 13 * radial;
      let g = 6 + 17 * radial;
      let b = 23 + 24 * radial;

      const purple = Math.max(0, 1 - Math.hypot(x - size * 0.30, y - size * 0.30) / (size * 0.42)) * 0.60;
      const cyan = Math.max(0, 1 - Math.hypot(x - size * 0.70, y - size * 0.70) / (size * 0.42)) * 0.60;
      const green = Math.max(0, 1 - Math.hypot(x - size * 0.30, y - size * 0.70) / (size * 0.35)) * 0.40;

      r += 109 * purple + 8 * cyan + 5 * green;
      g += 40 * purple + 145 * cyan + 150 * green;
      b += 217 * purple + 178 * cyan + 105 * green;

      if (distance > radius * 0.86) {
        const shadow = (distance - radius * 0.86) / (radius * 0.14);
        r *= 1 - shadow * 0.8;
        g *= 1 - shadow * 0.8;
        b *= 1 - shadow * 0.8;
      }

      pixels[index] = clamp(Math.round(r));
      pixels[index + 1] = clamp(Math.round(g));
      pixels[index + 2] = clamp(Math.round(b));
      pixels[index + 3] = 255;

      if (distance > radius - 6 && distance <= radius) {
        const alpha = 1 - Math.abs(distance - (radius - 3)) / 3;
        blendPixel(pixels, size, x, y, [31, 41, 55], clamp(alpha, 0, 1));
      }
    }
  }

  addGlowLine(pixels, size, [90, 80], [135, 128]);
  addGlowLine(pixels, size, [135, 128], [90, 176]);
  addGlowLine(pixels, size, [145, 176], [190, 176]);

  const stride = size * 4 + 1;
  const scanlines = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride;
    scanlines[rowStart] = 0;
    pixels.copy(scanlines, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIcoFromPng(pngBuffer) {
  const headerSize = 6;
  const entrySize = 16;
  const imageOffset = headerSize + entrySize;
  const icon = Buffer.alloc(imageOffset + pngBuffer.length);

  icon.writeUInt16LE(0, 0);
  icon.writeUInt16LE(1, 2);
  icon.writeUInt16LE(1, 4);
  icon[6] = 0;
  icon[7] = 0;
  icon[8] = 0;
  icon[9] = 0;
  icon.writeUInt16LE(1, 10);
  icon.writeUInt16LE(32, 12);
  icon.writeUInt32LE(pngBuffer.length, 14);
  icon.writeUInt32LE(imageOffset, 18);
  pngBuffer.copy(icon, imageOffset);

  return icon;
}

function createIcnsChunk(type, data) {
  if (!/^[A-Za-z0-9 ]{4}$/.test(type)) {
    throw new Error(`Invalid ICNS chunk type: ${type}`);
  }

  const chunk = Buffer.alloc(8 + data.length);
  chunk.write(type, 0, 4, 'ascii');
  chunk.writeUInt32BE(chunk.length, 4);
  data.copy(chunk, 8);
  return chunk;
}

function createIcnsFromPngs(entries = [
  ['ic08', renderLogoPng(256)],
  ['ic09', renderLogoPng(512)],
]) {
  const chunks = entries.map(([type, data]) => createIcnsChunk(type, data));
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

function copyIconAssets(outputDir, options = {}) {
  const sourceSvgPath = options.sourceSvgPath;
  if (!sourceSvgPath || !fs.existsSync(sourceSvgPath)) {
    throw new Error(`Browser tab icon missing: ${sourceSvgPath}`);
  }

  const svgTarget = path.join(outputDir, ICON_SVG_NAME);
  const icoTarget = path.join(outputDir, ICON_ICO_NAME);
  const icnsTarget = path.join(outputDir, ICON_ICNS_NAME);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(sourceSvgPath, svgTarget);
  fs.writeFileSync(icoTarget, createIcoFromPng(renderLogoPng()));
  fs.writeFileSync(icnsTarget, createIcnsFromPngs());
  return {
    svgPath: svgTarget,
    icoPath: icoTarget,
    icnsPath: icnsTarget,
  };
}

module.exports = {
  ICON_ICO_NAME,
  ICON_ICNS_NAME,
  ICON_SVG_NAME,
  copyIconAssets,
  createIcnsFromPngs,
  createIcoFromPng,
  renderLogoPng,
};
