// MPO (Multi Picture Object, CIPA DC-007) splitter.
// Standard 3D MPO = JPEG #1 + JPEG #2 concatenated. JPEG #1 carries an APP2 "MPF" marker
// listing the offsets to all images. We split by reading MP Index, with a fallback that
// scans for SOI (FFD8) / EOI (FFD9) byte markers at JPEG segment boundaries.

const SOI = 0xFFD8;
const EOI = 0xFFD9;
const APP2 = 0xFFE2;

export function parseMpo(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  if (dv.getUint16(0, false) !== SOI) throw new Error('JPEG/MPO形式ではありません');

  const segments = scanJpegSegments(u8, dv, 0);
  const mpfSeg = segments.find(s => s.marker === APP2 && isMpfApp2(u8, s));
  let imageOffsets = null;

  // Always prefer SOI/EOI scan: in MPO files we simply walk JPEG boundaries.
  // It's robust and avoids MPF DataOffset interpretation pitfalls (TIFF-relative vs file-relative).
  imageOffsets = scanJpegBoundaries(u8);

  if (imageOffsets.length < 2) {
    // Fallback: single JPEG (treat as 2D, both eyes identical).
    imageOffsets = [
      { offset: 0, size: u8.length },
      { offset: 0, size: u8.length },
    ];
  }

  // Validate each starts with FFD8.
  for (const o of imageOffsets) {
    if (u8[o.offset] !== 0xFF || u8[o.offset + 1] !== 0xD8) {
      throw new Error('MPO構造異常: 画像境界がSOIで始まっていません');
    }
  }

  const left = u8.subarray(imageOffsets[0].offset, imageOffsets[0].offset + imageOffsets[0].size);
  const right = u8.subarray(imageOffsets[1].offset, imageOffsets[1].offset + imageOffsets[1].size);

  // Image dimensions from SOFn marker of left.
  const dims = readJpegDimensions(left);

  return {
    width: dims.width,
    height: dims.height,
    leftJpeg: left,
    rightJpeg: right,
    imageCount: imageOffsets.length,
    rawBuffer: u8,
  };
}

export function jpegBlob(bytes) {
  return new Blob([bytes], { type: 'image/jpeg' });
}

function scanJpegSegments(u8, dv, start) {
  const segs = [];
  let p = start;
  if (dv.getUint16(p, false) !== SOI) return segs;
  p += 2;
  while (p < u8.length - 1) {
    if (u8[p] !== 0xFF) break;
    let marker = u8[p+1];
    while (marker === 0xFF && p < u8.length - 2) { p++; marker = u8[p+1]; }
    if (marker === 0xD9) { segs.push({ marker: 0xFFD9, offset: p, size: 2 }); break; }
    if (marker === 0xDA) {
      // Start of scan — consume entropy-coded data until next non-RST marker.
      const segLen = dv.getUint16(p + 2, false);
      p += 2 + segLen;
      // Now scan compressed data for FFD9 (or any non-restart marker).
      while (p < u8.length - 1) {
        if (u8[p] === 0xFF && u8[p+1] !== 0x00 && (u8[p+1] < 0xD0 || u8[p+1] > 0xD7)) break;
        p++;
      }
      continue;
    }
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01 || marker === 0xD8) {
      p += 2;
      continue;
    }
    const segLen = dv.getUint16(p + 2, false);
    segs.push({ marker: 0xFF00 | marker, offset: p, size: 2 + segLen });
    p += 2 + segLen;
  }
  return segs;
}

function isMpfApp2(u8, seg) {
  // APP2 starts with "MPF\0" identifier
  const i = seg.offset + 4;
  return u8[i] === 0x4D && u8[i+1] === 0x50 && u8[i+2] === 0x46 && u8[i+3] === 0x00;
}

function readMpfIndex(u8, dv, seg) {
  const tiffStart = seg.offset + 8; // after FFE2 + len(2) + "MPF\0" + reserved? Actually "MPF\0" is 4 bytes.
  // Spec: APP2 = FFE2 + LEN(2) + 'MPF\0' (4) + TIFF header.
  // Byte order: II=little, MM=big.
  const bom = dv.getUint16(tiffStart, false);
  const little = bom === 0x4949;
  const ifdOffset = readU32(dv, tiffStart + 4, little);
  const ifdAt = tiffStart + ifdOffset;
  const numEntries = readU16(dv, ifdAt, little);

  let mpEntryOffset = 0;
  let mpEntryCount = 0;
  let mpVersion = '';
  let numberOfImages = 0;

  for (let i = 0; i < numEntries; i++) {
    const e = ifdAt + 2 + i * 12;
    const tag = readU16(dv, e, little);
    const type = readU16(dv, e + 2, little);
    const count = readU32(dv, e + 4, little);
    const valOff = readU32(dv, e + 8, little);
    if (tag === 0xB000) {
      // MP Format Version (4 ASCII bytes inline)
      mpVersion = String.fromCharCode(u8[e+8], u8[e+9], u8[e+10], u8[e+11]);
    } else if (tag === 0xB001) {
      numberOfImages = valOff;
    } else if (tag === 0xB002) {
      // MP Entry — count*16 bytes UNDEFINED, value at valOff (relative to TIFF start)
      mpEntryOffset = tiffStart + valOff;
      mpEntryCount = count / 16;
    }
  }

  if (!mpEntryCount || mpEntryCount < 2) return null;

  const entries = [];
  for (let i = 0; i < mpEntryCount; i++) {
    const off = mpEntryOffset + i * 16;
    const flagsAttr = readU32(dv, off, little);
    const size = readU32(dv, off + 4, little);
    const dataOffset = readU32(dv, off + 8, little);
    // First image has dataOffset == 0; absolute offsets are from start of file (per spec, MP Endian Field
    // says it's "from beginning of MP File"). For 3DS MPO this is from start of file.
    entries.push({
      offset: i === 0 ? 0 : dataOffset,
      size,
      flags: flagsAttr,
    });
  }
  return entries;
}

function findEoiSoiSplit(u8) {
  for (let i = 1; i < u8.length - 3; i++) {
    if (u8[i] === 0xFF && u8[i+1] === 0xD9 && u8[i+2] === 0xFF && u8[i+3] === 0xD8) {
      return i + 2;
    }
  }
  return -1;
}

// Walk JPEG segments to find the byte ranges of all concatenated JPEGs.
function scanJpegBoundaries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  let p = 0;
  while (p < u8.length - 1) {
    // Find next SOI.
    if (u8[p] !== 0xFF || u8[p+1] !== 0xD8) { p++; continue; }
    const start = p;
    p += 2; // past SOI
    // Walk markers until EOI.
    while (p < u8.length - 1) {
      if (u8[p] !== 0xFF) { p++; continue; }
      const marker = u8[p+1];
      if (marker === 0xFF) { p++; continue; } // fill bytes
      if (marker === 0xD9) { p += 2; out.push({ offset: start, size: p - start }); break; } // EOI
      if (marker === 0xD8) { p += 2; continue; } // SOI (shouldn't happen mid-image)
      if (marker === 0x00 || (marker >= 0xD0 && marker <= 0xD7)) { p += 2; continue; }
      if (marker === 0xDA) {
        // SOS — read length, skip header, then scan compressed data for next non-RST marker.
        const segLen = dv.getUint16(p + 2, false);
        p += 2 + segLen;
        while (p < u8.length - 1) {
          if (u8[p] === 0xFF && u8[p+1] !== 0x00 && (u8[p+1] < 0xD0 || u8[p+1] > 0xD7)) break;
          p++;
        }
        continue;
      }
      // Variable-length segment.
      if (p + 4 > u8.length) { p = u8.length; break; }
      const segLen = dv.getUint16(p + 2, false);
      p += 2 + segLen;
    }
  }
  return out;
}

function readJpegDimensions(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint16(0, false) !== SOI) return { width: 0, height: 0 };
  let p = 2;
  while (p < u8.length - 8) {
    if (u8[p] !== 0xFF) return { width: 0, height: 0 };
    const marker = u8[p+1];
    // SOFn markers (start of frame): C0..CF except C4, C8, CC
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      const height = dv.getUint16(p + 5, false);
      const width = dv.getUint16(p + 7, false);
      return { width, height };
    }
    if (marker === 0xD8 || marker === 0xD9 || marker === 0x01) { p += 2; continue; }
    const segLen = dv.getUint16(p + 2, false);
    p += 2 + segLen;
  }
  return { width: 0, height: 0 };
}

function readU16(dv, off, little) { return dv.getUint16(off, little); }
function readU32(dv, off, little) { return dv.getUint32(off, little); }
