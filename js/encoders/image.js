// Image encoder: JPEG (with EXIF) and MPO re-pack.
//
// Pipeline:
//   parseMpo -> ImageBitmap×2 -> Renderer (mode/transform/filter) -> canvas.toBlob(jpeg) -> writeJpegExif
//
// MPO output is two separately-rendered JPEGs with an MPF APP2 marker injected into the first.

import { parseMpo } from '../parsers/mpo.js?v=20';
import { Renderer } from '../render/gl.js?v=20';
import { writeJpegExif, buildMpfApp2 } from '../parsers/exif.js?v=20';

export async function encodeImageJob({ buffer, settings, onProgress }) {
  const parsed = parseMpo(buffer);
  const left = await createImageBitmap(new Blob([parsed.leftJpeg], { type: 'image/jpeg' }));
  const right = await createImageBitmap(new Blob([parsed.rightJpeg], { type: 'image/jpeg' }));
  onProgress?.(0.2);

  try {
    if (settings.outputFormat === 'mpo') {
      const out = await encodeMpoReposition(parsed, left, right, settings, onProgress);
      return out;
    }
    return await encodeSingleJpeg(parsed, left, right, settings, onProgress);
  } finally {
    left.close?.();
    right.close?.();
  }
}

async function encodeSingleJpeg(parsed, left, right, settings, onProgress) {
  const renderer = new Renderer();
  try {
    renderer.setBaseSize(parsed.width, parsed.height);
    renderer.setSource(left, right);
    renderer.setMode(settings.outputFormat);
    renderer.setTransform(settings.transform);
    renderer.setFilter(settings.filter);
    renderer.render();
    onProgress?.(0.7);

    const quality = (settings.jpegQuality ?? 92) / 100;
    const jpegBlob = await canvasToBlob(renderer.getCanvas(), 'image/jpeg', quality);
    const u8 = new Uint8Array(await jpegBlob.arrayBuffer());

    // Inject EXIF: start from original left-eye EXIF (preserving 3DS MakerNote when keepMaker),
    // overlay user-edited fields.
    const exifData = mergeExif(parsed.leftExif, settings.exif);
    const withExif = writeJpegExif(u8, exifData);
    onProgress?.(1);
    return new Blob([withExif], { type: 'image/jpeg' });
  } finally {
    renderer.dispose();
  }
}

async function encodeMpoReposition(parsed, leftBm, rightBm, settings, onProgress) {
  const renderer = new Renderer();
  try {
    renderer.setBaseSize(parsed.width, parsed.height);
    renderer.setTransform(settings.transform);
    renderer.setFilter(settings.filter);
    const quality = (settings.jpegQuality ?? 92) / 100;
    const swap = !!settings.transform.swapLR;

    // Render and encode left eye (mode 2d-l).
    renderer.setMode('2d-l');
    renderer.setSource(swap ? rightBm : leftBm, null);
    renderer.render();
    let leftJpegBlob = await canvasToBlob(renderer.getCanvas(), 'image/jpeg', quality);
    let leftU8 = new Uint8Array(await leftJpegBlob.arrayBuffer());
    onProgress?.(0.5);

    // Right eye (mode 2d-l reusing right as left source).
    renderer.setSource(swap ? leftBm : rightBm, null);
    renderer.render();
    let rightJpegBlob = await canvasToBlob(renderer.getCanvas(), 'image/jpeg', quality);
    let rightU8 = new Uint8Array(await rightJpegBlob.arrayBuffer());
    onProgress?.(0.85);

    // Inject EXIF into each.
    const exifData = mergeExif(parsed.leftExif, settings.exif);
    leftU8 = writeJpegExif(leftU8, exifData);
    rightU8 = writeJpegExif(rightU8, parsed.rightExif
      ? mergeExif(parsed.rightExif, settings.exif)
      : exifData);

    // Insert MPF APP2 into left JPEG right after EXIF APP1.
    // Layout: SOI + APP1(EXIF) + APP2(MPF) + rest.
    const mpf = buildMpfApp2([
      { size: 0, offset: 0, flags: 0x20000000 },           // First Image
      { size: rightU8.length, offset: 0, flags: 0x00080000 } // Disparity Type
    ]);
    leftU8 = insertApp2AfterApp1(leftU8, mpf, rightU8.length);

    // Concat: left + right.
    const total = leftU8.length + rightU8.length;
    const out = new Uint8Array(total);
    out.set(leftU8, 0);
    out.set(rightU8, leftU8.length);
    onProgress?.(1);
    return new Blob([out], { type: 'image/jpeg' });
  } finally {
    renderer.dispose();
  }
}

function insertApp2AfterApp1(jpegU8, app2Bytes, _secondImageSize) {
  // Find first non-SOI segment. If it's APP1, insert APP2 after it; else insert after SOI.
  let p = 2; // skip SOI
  // Walk APP segments until we hit a non-APP marker.
  while (p < jpegU8.length - 4 && jpegU8[p] === 0xFF) {
    const marker = jpegU8[p + 1];
    if (marker === 0xE1) {
      // APP1 — read length and insert AFTER this segment.
      const segLen = (jpegU8[p + 2] << 8) | jpegU8[p + 3];
      const insertAt = p + 2 + segLen;
      const out = new Uint8Array(jpegU8.length + app2Bytes.length);
      out.set(jpegU8.subarray(0, insertAt), 0);
      out.set(app2Bytes, insertAt);
      out.set(jpegU8.subarray(insertAt), insertAt + app2Bytes.length);
      return out;
    }
    if (marker >= 0xE0 && marker <= 0xEF) {
      // Other APPn — skip.
      const segLen = (jpegU8[p + 2] << 8) | jpegU8[p + 3];
      p += 2 + segLen;
      continue;
    }
    break;
  }
  // No APP1 found — insert right after SOI.
  const out = new Uint8Array(jpegU8.length + app2Bytes.length);
  out.set(jpegU8.subarray(0, 2), 0);
  out.set(app2Bytes, 2);
  out.set(jpegU8.subarray(2), 2 + app2Bytes.length);
  return out;
}

function mergeExif(originalExif, edits) {
  const base = originalExif ? deepClone(originalExif) : { ifd0: {}, exif: {}, gps: {} };
  if (!edits) return base;
  base.ifd0 = base.ifd0 || {};
  base.exif = base.exif || {};
  base.gps = base.gps || {};
  if (edits.make != null && edits.make !== '') base.ifd0.Make = edits.make;
  if (edits.model != null && edits.model !== '') base.ifd0.Model = edits.model;
  if (edits.software != null && edits.software !== '') base.ifd0.Software = edits.software;
  if (edits.description != null && edits.description !== '') base.ifd0.ImageDescription = edits.description;
  if (edits.artist != null && edits.artist !== '') base.ifd0.Artist = edits.artist;
  if (edits.copyright != null && edits.copyright !== '') base.ifd0.Copyright = edits.copyright;
  if (edits.orientation != null && edits.orientation !== '') base.ifd0.Orientation = parseInt(edits.orientation, 10);
  if (edits.dateTimeOriginal) {
    // datetime-local "YYYY-MM-DDTHH:mm" -> EXIF "YYYY:MM:DD HH:mm:ss"
    const exifStr = edits.dateTimeOriginal.replace('T', ' ').replace(/-/g, ':') + ':00';
    base.exif.DateTimeOriginal = exifStr;
    base.ifd0.DateTime = exifStr;
  }
  if (edits.gps) {
    if (edits.gps.lat != null) base.gps.lat = edits.gps.lat;
    if (edits.gps.lon != null) base.gps.lon = edits.gps.lon;
    if (edits.gps.alt != null) base.gps.alt = edits.gps.alt;
  }
  // 3DS MakerNote pass-through controlled by keepMaker flag.
  if (edits.keepMaker === false) base.makerNote = null;
  return base;
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o, (k, v) => v instanceof Uint8Array ? Array.from(v) : v));
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob failed')), type, quality);
  });
}
