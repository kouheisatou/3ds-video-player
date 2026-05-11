/**
 * exif.js — Pure-JS EXIF reader/writer (zero external dependencies).
 *
 * Supports:
 *   IFD0:      Make, Model, Software, Orientation, DateTime, ImageDescription,
 *              Artist, Copyright, XResolution, YResolution, ResolutionUnit,
 *              ExifIFDPointer (0x8769), GPSInfoIFDPointer (0x8825)
 *   Exif SubIFD: DateTimeOriginal, DateTimeDigitized, UserComment,
 *                ColorSpace, ExifImageWidth, ExifImageHeight
 *   GPS IFD:   GPSLatitudeRef/GPSLatitude, GPSLongitudeRef/GPSLongitude,
 *              GPSAltitudeRef, GPSAltitude
 *   MakerNote: raw bytes preserved for round-trip; parsed fields when possible
 *   MPF APP2:  readMpfApp2 / buildMpfApp2
 */

// ── TIFF data types ─────────────────────────────────────────────────────────
const TYPES = {
  BYTE: 1,      // 1-byte unsigned
  ASCII: 2,     // null-terminated ASCII string
  SHORT: 3,     // 2-byte unsigned
  LONG: 4,      // 4-byte unsigned
  RATIONAL: 5,  // 8-byte: numerator(LONG) / denominator(LONG)
  SBYTE: 6,     // 1-byte signed
  UNDEFINED: 7, // arbitrary bytes
  SSHORT: 8,    // 2-byte signed
  SLONG: 9,     // 4-byte signed
  SRATIONAL: 10,// 8-byte signed rational
  FLOAT: 11,    // 4-byte IEEE float
  DOUBLE: 12,   // 8-byte IEEE double
};

const TYPE_SIZE = [0,1,1,2,4,8,1,2,2,4,8,4,8];

// ── Low-level DataView helpers ───────────────────────────────────────────────
function u8(dv, off)      { return dv.getUint8(off); }
function u16(dv, off, le) { return dv.getUint16(off, le); }
function u32(dv, off, le) { return dv.getUint32(off, le); }
function s32(dv, off, le) { return dv.getInt32(off, le); }

function readASCII(u8arr, off, count) {
  let s = '';
  for (let i = 0; i < count && u8arr[off + i] !== 0; i++) {
    s += String.fromCharCode(u8arr[off + i]);
  }
  return s.trim();
}

function readRational(dv, off, le) {
  const num = u32(dv, off, le);
  const den = u32(dv, off + 4, le);
  return den === 0 ? 0 : num / den;
}

function readSRational(dv, off, le) {
  const num = s32(dv, off, le);
  const den = s32(dv, off + 4, le);
  return den === 0 ? 0 : num / den;
}

// ── IFD entry value reader ───────────────────────────────────────────────────
/**
 * Read a single IFD entry value. Returns scalar or array.
 * @param {Uint8Array} u8arr   — full APP1 TIFF block (from TIFF header start)
 * @param {DataView}   dv      — DataView wrapping u8arr
 * @param {number}     entryOff — byte offset of the 12-byte IFD entry (from tiffStart)
 * @param {number}     tiffStart — byte offset of the TIFF header in dv
 * @param {boolean}    le      — little-endian flag
 */
function readIfdValue(u8arr, dv, entryOff, tiffStart, le) {
  const type  = u16(dv, entryOff + 2, le);
  const count = u32(dv, entryOff + 4, le);
  const sz    = TYPE_SIZE[type] || 1;
  const totalBytes = sz * count;

  // Value / offset field starts at entryOff + 8.
  // If total bytes <= 4 they are stored inline; otherwise at the offset.
  let dataOff;
  if (totalBytes <= 4) {
    dataOff = entryOff + 8;
  } else {
    const offset = u32(dv, entryOff + 8, le);
    dataOff = tiffStart + offset;
  }

  if (type === TYPES.ASCII) {
    return readASCII(u8arr, dataOff, count);
  }

  const read1 = (off) => {
    switch (type) {
      case TYPES.BYTE:      return u8(dv, off);
      case TYPES.SHORT:     return u16(dv, off, le);
      case TYPES.LONG:      return u32(dv, off, le);
      case TYPES.RATIONAL:  return readRational(dv, off, le);
      case TYPES.SBYTE:     return dv.getInt8(off);
      case TYPES.UNDEFINED: return u8(dv, off);
      case TYPES.SSHORT:    return dv.getInt16(off, le);
      case TYPES.SLONG:     return s32(dv, off, le);
      case TYPES.SRATIONAL: return readSRational(dv, off, le);
      default:              return u8(dv, off);
    }
  };

  if (count === 1 && type !== TYPES.RATIONAL && type !== TYPES.SRATIONAL) {
    return read1(dataOff);
  }

  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(read1(dataOff + i * sz));
  }
  return out;
}

/**
 * Read rational pair as [numerator, denominator] for writing back.
 */
function readRationalPair(dv, off, le) {
  return [u32(dv, off, le), u32(dv, off + 4, le)];
}

// ── IFD scanner ─────────────────────────────────────────────────────────────
/**
 * Walk an IFD and return a map of tag → raw value.
 * @param {Uint8Array} u8arr
 * @param {DataView}   dv
 * @param {number}     ifdOff   — absolute offset of IFD entry count in dv
 * @param {number}     tiffStart
 * @param {boolean}    le
 * @returns {{ tags: Map<number,*>, nextIfdOff: number }}
 */
function scanIfd(u8arr, dv, ifdOff, tiffStart, le) {
  const tags = new Map();
  if (ifdOff + 2 > dv.byteLength) return { tags, nextIfdOff: 0 };
  const count = u16(dv, ifdOff, le);
  if (count > 512) return { tags, nextIfdOff: 0 }; // sanity
  for (let i = 0; i < count; i++) {
    const eOff = ifdOff + 2 + i * 12;
    if (eOff + 12 > dv.byteLength) break;
    const tag = u16(dv, eOff, le);
    try {
      const val = readIfdValue(u8arr, dv, eOff, tiffStart, le);
      tags.set(tag, val);
    } catch (_) { /* skip unreadable entry */ }
  }
  let nextIfdOff = 0;
  const nextOff = ifdOff + 2 + count * 12;
  if (nextOff + 4 <= dv.byteLength) {
    nextIfdOff = u32(dv, nextOff, le);
  }
  return { tags, nextIfdOff };
}

// ── GPS helpers ──────────────────────────────────────────────────────────────
function dmsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const deg = dms[0], min = dms[1], sec = dms[2];
  let val = deg + min / 60 + sec / 3600;
  if (ref === 'S' || ref === 'W') val = -val;
  return val;
}

// ── 3DS MakerNote parser ─────────────────────────────────────────────────────
/**
 * Try to extract known 3DS MakerNote fields.
 * The 3DS MakerNote is a TIFF-like IFD with no standard identifier prefix.
 * Known tags (from community reverse-engineering / exiftool):
 *   0x0001 = ModelID (ASCII, e.g. "3DS1")
 *   0x0101 = InternalSerialNumber (ASCII)
 *   0x0201 = TimeStamp (LONG pair, seconds since some epoch)
 *   0x0301 = Parallax (SSHORT or SRATIONAL — varies by firmware)
 */
function parseMakerNote3DS(raw, le) {
  try {
    if (!raw || raw.length < 8) return {};
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    // Heuristic: first 2 bytes are entry count (small number)
    let ifdStart = 0;
    // Some firmware versions have a 4-byte "Nint" header or other prefix.
    // Try IFD at offset 0, and also at 4 / 8 if the count looks wrong.
    for (const tryOff of [0, 4, 8]) {
      if (tryOff + 2 > raw.length) continue;
      const cnt = dv.getUint16(tryOff, le);
      if (cnt >= 1 && cnt <= 64 && tryOff + 2 + cnt * 12 <= raw.length) {
        ifdStart = tryOff;
        break;
      }
    }
    const { tags } = scanIfd(raw, dv, ifdStart, 0, le);
    const parsed = {};
    if (tags.has(0x0001)) parsed.modelID = tags.get(0x0001);
    if (tags.has(0x0101)) parsed.serialNumber = tags.get(0x0101);
    if (tags.has(0x0201)) {
      const ts = tags.get(0x0201);
      parsed.timeStamp = Array.isArray(ts) ? ts[0] : ts;
    }
    if (tags.has(0x0301)) {
      let p = tags.get(0x0301);
      if (Array.isArray(p)) p = p[0];
      parsed.parallax = p;
    }
    // Tag 0x0002 sometimes contains parallax as SSHORT.
    if (tags.has(0x0002) && parsed.parallax === undefined) {
      let p = tags.get(0x0002);
      if (Array.isArray(p)) p = p[0];
      parsed.parallax = p;
    }
    return parsed;
  } catch (_) {
    return {};
  }
}

// ── JPEG APP1 locator ────────────────────────────────────────────────────────
/**
 * Find the first APP1 Exif segment in a JPEG Uint8Array.
 * Returns { offset, size } where offset is the byte position of FFE1 marker.
 */
function findApp1(u8arr) {
  if (u8arr[0] !== 0xFF || u8arr[1] !== 0xD8) return null;
  let p = 2;
  while (p < u8arr.length - 3) {
    if (u8arr[p] !== 0xFF) { p++; continue; }
    const marker = u8arr[p + 1];
    if (marker === 0xD9) break; // EOI
    if (marker === 0xDA) break; // SOS — no more metadata after this
    if (marker === 0x00 || (marker >= 0xD0 && marker <= 0xD8)) { p += 2; continue; }
    if (p + 4 > u8arr.length) break;
    const segLen = (u8arr[p + 2] << 8) | u8arr[p + 3]; // big-endian per JPEG spec
    if (marker === 0xE1) {
      // Check for "Exif\0\0" identifier
      if (p + 10 <= u8arr.length &&
          u8arr[p+4] === 0x45 && u8arr[p+5] === 0x78 &&
          u8arr[p+6] === 0x69 && u8arr[p+7] === 0x66 &&
          u8arr[p+8] === 0x00 && u8arr[p+9] === 0x00) {
        return { offset: p, size: 2 + segLen };
      }
    }
    p += 2 + segLen;
  }
  return null;
}

// ── Public: readJpegExif ─────────────────────────────────────────────────────
/**
 * Parse EXIF from a JPEG Uint8Array.
 * @param {Uint8Array} jpegU8
 * @returns {{ ifd0, exif, gps, makerNote, app1 } | null}
 */
export function readJpegExif(jpegU8) {
  try {
    const app1Info = findApp1(jpegU8);
    if (!app1Info) return null;

    // APP1 content: marker(2) + length(2) + "Exif\0\0"(6) + TIFF
    const tiffStart = app1Info.offset + 10; // absolute offset in jpegU8
    const tiffEnd   = app1Info.offset + app1Info.size;
    if (tiffStart >= tiffEnd) return null;

    const tiffBuf = jpegU8.buffer.slice
      ? jpegU8.buffer.slice(jpegU8.byteOffset + tiffStart, jpegU8.byteOffset + tiffEnd)
      : jpegU8.buffer;

    // We build a sub-DataView over the TIFF region, so all offsets inside
    // the TIFF are relative to tiffStart.
    const tiffU8 = new Uint8Array(jpegU8.buffer, jpegU8.byteOffset + tiffStart, tiffEnd - tiffStart);
    const dv = new DataView(tiffU8.buffer, tiffU8.byteOffset, tiffU8.byteLength);

    const bomWord = u16(dv, 0, false);
    if (bomWord !== 0x4949 && bomWord !== 0x4D4D) return null;
    const le = (bomWord === 0x4949);
    const magic = u16(dv, 2, le);
    if (magic !== 42) return null;

    const ifd0Off = u32(dv, 4, le);
    const { tags: ifd0Tags } = scanIfd(tiffU8, dv, ifd0Off, 0, le);

    // ── IFD0 fields ────────────────────────────────────────────────────────
    const ifd0 = {};
    const ifd0Map = {
      0x010E: 'ImageDescription',
      0x010F: 'Make',
      0x0110: 'Model',
      0x0112: 'Orientation',
      0x011A: 'XResolution',
      0x011B: 'YResolution',
      0x0128: 'ResolutionUnit',
      0x0131: 'Software',
      0x0132: 'DateTime',
      0x013B: 'Artist',
      0x8298: 'Copyright',
    };
    for (const [tag, name] of Object.entries(ifd0Map)) {
      if (ifd0Tags.has(Number(tag))) ifd0[name] = ifd0Tags.get(Number(tag));
    }

    // ── Exif SubIFD ────────────────────────────────────────────────────────
    const exif = {};
    const exifPtr = ifd0Tags.get(0x8769);
    if (exifPtr) {
      const { tags: exifTags } = scanIfd(tiffU8, dv, exifPtr, 0, le);
      const exifMap = {
        0x9003: 'DateTimeOriginal',
        0x9004: 'DateTimeDigitized',
        0xA001: 'ColorSpace',
        0xA002: 'ExifImageWidth',
        0xA003: 'ExifImageHeight',
      };
      for (const [tag, name] of Object.entries(exifMap)) {
        if (exifTags.has(Number(tag))) exif[name] = exifTags.get(Number(tag));
      }
      // UserComment (UNDEFINED, 8-byte charset prefix + data)
      if (exifTags.has(0x9286)) {
        const uc = exifTags.get(0x9286);
        if (Array.isArray(uc)) {
          // charset prefix: "ASCII\0\0\0" or "UNICODE\0" or "\0\0\0\0\0\0\0\0"
          const bytes = new Uint8Array(uc);
          const prefix = String.fromCharCode(...bytes.slice(0, 8));
          if (prefix.startsWith('ASCII')) {
            exif.UserComment = readASCII(bytes, 8, bytes.length - 8);
          } else {
            exif.UserComment = prefix + '...';
          }
        }
      }

      // MakerNote raw bytes (0x927C)
      if (exifTags.has(0x927C)) {
        const mnVal = exifTags.get(0x927C);
        // We need raw bytes — re-read directly from tiffU8.
        const mnEntry = findIfdEntryRaw(tiffU8, dv, exifPtr, 0x927C, le);
        if (mnEntry) {
          exif._makerNoteRaw = mnEntry;
          exif._makerNoteParsed = parseMakerNote3DS(mnEntry, le);
        }
      }
    }

    // ── GPS IFD ────────────────────────────────────────────────────────────
    const gps = {};
    const gpsPtr = ifd0Tags.get(0x8825);
    if (gpsPtr) {
      const { tags: gpsTags } = scanIfd(tiffU8, dv, gpsPtr, 0, le);
      const latRef = gpsTags.get(0x0001); // GPSLatitudeRef
      const latDMS = gpsTags.get(0x0002); // GPSLatitude (3 RATIONAL)
      const lonRef = gpsTags.get(0x0003); // GPSLongitudeRef
      const lonDMS = gpsTags.get(0x0004); // GPSLongitude (3 RATIONAL)
      const altRef = gpsTags.get(0x0005); // GPSAltitudeRef
      const altVal = gpsTags.get(0x0006); // GPSAltitude (RATIONAL)

      if (latRef && latDMS) gps.lat = dmsToDecimal(latDMS, latRef);
      if (lonRef && lonDMS) gps.lon = dmsToDecimal(lonDMS, lonRef);
      if (altVal !== undefined) {
        const sign = (altRef === 1) ? -1 : 1;
        gps.alt = sign * (typeof altVal === 'number' ? altVal : 0);
      }
    }

    return {
      ifd0,
      exif,
      gps: (Object.keys(gps).length > 0) ? gps : null,
      makerNote: exif._makerNoteParsed
        ? { raw: exif._makerNoteRaw, parsed: exif._makerNoteParsed }
        : null,
      app1: app1Info,
      _le: le, // keep endianness for writer
    };
  } catch (err) {
    console.warn('[exif] readJpegExif error:', err);
    return null;
  }
}

/** Helper: re-read raw bytes for an UNDEFINED IFD entry. */
function findIfdEntryRaw(tiffU8, dv, ifdOff, targetTag, le) {
  try {
    const count = u16(dv, ifdOff, le);
    for (let i = 0; i < count; i++) {
      const eOff = ifdOff + 2 + i * 12;
      const tag  = u16(dv, eOff, le);
      if (tag !== targetTag) continue;
      const type  = u16(dv, eOff + 2, le);
      const cnt   = u32(dv, eOff + 4, le);
      const sz    = TYPE_SIZE[type] || 1;
      const total = sz * cnt;
      let dataOff;
      if (total <= 4) {
        dataOff = eOff + 8;
      } else {
        dataOff = u32(dv, eOff + 8, le);
      }
      const slice = new Uint8Array(total);
      for (let j = 0; j < total; j++) slice[j] = tiffU8[dataOff + j];
      return slice;
    }
    return null;
  } catch (_) { return null; }
}

// ── EXIF Writer ──────────────────────────────────────────────────────────────
/**
 * Build a new APP1 Exif segment Uint8Array from an exifData object.
 * Uses little-endian TIFF encoding.
 *
 * exifData fields:
 *   ifd0: { Make, Model, Software, Orientation, DateTime, ImageDescription, Artist, Copyright }
 *   exif: { DateTimeOriginal, DateTimeDigitized, UserComment }
 *   gps:  { lat, lon, alt } (decimal degrees)
 *   makerNote: { raw: Uint8Array } — inserted into Exif SubIFD if keepMaker=true
 *   keepMaker: boolean
 */
function buildApp1(exifData) {
  // We build into a growable byte array then copy to final Uint8Array.
  const buf = new GrowableBuffer();

  // Placeholder for APP1 header: FFE1 + length(2) + "Exif\0\0"
  // We'll fill length at the end.
  buf.writeU8(0xFF); buf.writeU8(0xE1); // APP1 marker
  const lenPos = buf.length;
  buf.writeU16BE(0); // placeholder length (covers everything after marker)
  buf.writeBytes([0x45,0x78,0x69,0x66,0x00,0x00]); // "Exif\0\0"

  // TIFF header (little-endian)
  const tiffBase = buf.length; // absolute byte index where TIFF starts
  buf.writeBytes([0x49,0x49]); // "II" = little-endian
  buf.writeU16LE(42);          // TIFF magic
  buf.writeU32LE(8);           // IFD0 offset from TIFF start = 8 (immediately after header)

  // We need to build IFDs in order, with value areas after.
  // Strategy: collect IFD entries, then compute offsets.

  const le = true;
  const ifd0Entries = [];
  const exifEntries = [];
  const gpsEntries  = [];

  const ifd0Data = exifData.ifd0 || {};
  const exifSubData = exifData.exif || {};
  const gpsData  = exifData.gps  || null;
  const keepMaker = exifData.keepMaker !== false;
  const makerRaw  = exifData.makerNote?.raw || null;

  // ── IFD0 entries ────────────────────────────────────────────────────────
  function addAscii(entries, tag, str) {
    if (!str && str !== '') return;
    const bytes = asciiBytes(str);
    entries.push({ tag, type: TYPES.ASCII, count: bytes.length + 1, data: [...bytes, 0] });
  }
  function addShort(entries, tag, val) {
    entries.push({ tag, type: TYPES.SHORT, count: 1, data: val });
  }
  function addLong(entries, tag, val) {
    entries.push({ tag, type: TYPES.LONG, count: 1, data: val });
  }
  function addRational(entries, tag, num, den) {
    const d = new Uint8Array(8);
    const dv2 = new DataView(d.buffer);
    dv2.setUint32(0, num, true); dv2.setUint32(4, den, true);
    entries.push({ tag, type: TYPES.RATIONAL, count: 1, data: [...d] });
  }
  function addRational3(entries, tag, triples) {
    // triples: [[num,den],[num,den],[num,den]]
    const d = new Uint8Array(24);
    const dv2 = new DataView(d.buffer);
    for (let i = 0; i < 3; i++) {
      dv2.setUint32(i*8,   triples[i][0], true);
      dv2.setUint32(i*8+4, triples[i][1], true);
    }
    entries.push({ tag, type: TYPES.RATIONAL, count: 3, data: [...d] });
  }
  function addUndefined(entries, tag, bytes) {
    entries.push({ tag, type: TYPES.UNDEFINED, count: bytes.length, data: [...bytes] });
  }

  if (ifd0Data.ImageDescription) addAscii(ifd0Entries, 0x010E, ifd0Data.ImageDescription);
  if (ifd0Data.Make)              addAscii(ifd0Entries, 0x010F, ifd0Data.Make);
  if (ifd0Data.Model)             addAscii(ifd0Entries, 0x0110, ifd0Data.Model);
  if (ifd0Data.Orientation != null) addShort(ifd0Entries, 0x0112, ifd0Data.Orientation);
  // XResolution, YResolution, ResolutionUnit (defaults if not present)
  addRational(ifd0Entries, 0x011A, 72, 1); // XResolution
  addRational(ifd0Entries, 0x011B, 72, 1); // YResolution
  addShort(ifd0Entries, 0x0128, 2);         // ResolutionUnit = inch
  if (ifd0Data.Software)          addAscii(ifd0Entries, 0x0131, ifd0Data.Software);
  if (ifd0Data.DateTime)          addAscii(ifd0Entries, 0x0132, ifd0Data.DateTime);
  if (ifd0Data.Artist)            addAscii(ifd0Entries, 0x013B, ifd0Data.Artist);
  if (ifd0Data.Copyright)         addAscii(ifd0Entries, 0x8298, ifd0Data.Copyright);

  // ExifIFD pointer (placeholder, filled after layout)
  const exifPtrIdx = ifd0Entries.length;
  addLong(ifd0Entries, 0x8769, 0); // placeholder

  // GPS pointer (if we have gps data)
  let gpsPtrIdx = -1;
  if (gpsData && (gpsData.lat != null || gpsData.lon != null || gpsData.alt != null)) {
    gpsPtrIdx = ifd0Entries.length;
    addLong(ifd0Entries, 0x8825, 0); // placeholder
  }

  // Sort IFD0 by tag (required by TIFF spec)
  ifd0Entries.sort((a,b) => a.tag - b.tag);

  // ── Exif SubIFD entries ──────────────────────────────────────────────────
  if (exifSubData.DateTimeOriginal)  addAscii(exifEntries, 0x9003, exifSubData.DateTimeOriginal);
  if (exifSubData.DateTimeDigitized) addAscii(exifEntries, 0x9004, exifSubData.DateTimeDigitized);
  if (exifSubData.ColorSpace != null) addShort(exifEntries, 0xA001, exifSubData.ColorSpace);
  if (exifSubData.ExifImageWidth  != null) addLong(exifEntries, 0xA002, exifSubData.ExifImageWidth);
  if (exifSubData.ExifImageHeight != null) addLong(exifEntries, 0xA003, exifSubData.ExifImageHeight);
  // MakerNote
  if (keepMaker && makerRaw && makerRaw.length > 0) {
    addUndefined(exifEntries, 0x927C, [...makerRaw]);
  }
  exifEntries.sort((a,b) => a.tag - b.tag);

  // ── GPS IFD entries ──────────────────────────────────────────────────────
  if (gpsPtrIdx >= 0) {
    // GPSVersionID
    gpsEntries.push({ tag: 0x0000, type: TYPES.BYTE, count: 4, data: [2,3,0,0] });

    if (gpsData.lat != null) {
      const lat = Math.abs(gpsData.lat);
      const latRef = gpsData.lat >= 0 ? 'N' : 'S';
      addAscii(gpsEntries, 0x0001, latRef);
      addRational3(gpsEntries, 0x0002, decimalToDMS(lat));
    }
    if (gpsData.lon != null) {
      const lon = Math.abs(gpsData.lon);
      const lonRef = gpsData.lon >= 0 ? 'E' : 'W';
      addAscii(gpsEntries, 0x0003, lonRef);
      addRational3(gpsEntries, 0x0004, decimalToDMS(lon));
    }
    if (gpsData.alt != null) {
      gpsEntries.push({ tag: 0x0005, type: TYPES.BYTE, count: 1, data: gpsData.alt < 0 ? 1 : 0 });
      const altAbs = Math.abs(gpsData.alt);
      const altNum = Math.round(altAbs * 1000);
      addRational(gpsEntries, 0x0006, altNum, 1000);
    }
    gpsEntries.sort((a,b) => a.tag - b.tag);
  }

  // ── Layout calculation ───────────────────────────────────────────────────
  // IFD0 starts at TIFF offset 8.
  // Layout (all offsets relative to tiffBase):
  //   [8]  IFD0: 2 + n*12 + 4
  //   [?]  ExifIFD: 2 + m*12 + 4
  //   [?]  GPS IFD (optional)
  //   [?]  value areas for each IFD (data > 4 bytes)
  //   then sub-IFDs' value areas

  const ifd0EntryCount  = ifd0Entries.length;
  const exifEntryCount  = exifEntries.length;
  const gpsEntryCount   = gpsEntries.length;

  const ifd0Size  = 2 + ifd0EntryCount  * 12 + 4;
  const exifSize  = 2 + exifEntryCount  * 12 + 4;
  const gpsSize   = (gpsPtrIdx >= 0) ? (2 + gpsEntryCount * 12 + 4) : 0;

  // Offsets from TIFF start:
  const ifd0Offset  = 8;
  const exifOffset  = ifd0Offset + ifd0Size;
  const gpsOffset   = exifOffset + exifSize;
  const valueAreaStart = gpsOffset + gpsSize; // where big values start

  // ── Patch ExifIFD and GPS pointer in ifd0Entries ────────────────────────
  for (const e of ifd0Entries) {
    if (e.tag === 0x8769) e.data = exifOffset;
    if (e.tag === 0x8825) e.data = gpsOffset;
  }

  // ── Serialise IFDs into buf ──────────────────────────────────────────────
  // We'll use a separate value buffer that we append after all IFDs.
  const valueBuf = new GrowableBuffer();

  function writeIfd(entries, nextIfdOff) {
    buf.writeU16LE(entries.length);
    for (const e of entries) {
      buf.writeU16LE(e.tag);
      buf.writeU16LE(e.type);
      buf.writeU32LE(e.count);
      const sz = TYPE_SIZE[e.type] || 1;
      const total = sz * e.count;
      if (typeof e.data === 'number') {
        // Inline LONG pointer value
        buf.writeU32LE(e.data);
      } else if (total <= 4) {
        // Inline bytes — pad to 4
        const bytes = Array.isArray(e.data) ? e.data : [e.data];
        let written = 0;
        if (e.type === TYPES.SHORT && e.count === 1) {
          buf.writeU16LE(bytes[0]); written = 2;
        } else if (e.type === TYPES.BYTE && e.count <= 4) {
          bytes.forEach(b => buf.writeU8(b)); written = bytes.length;
        } else if (e.type === TYPES.ASCII && total <= 4) {
          bytes.forEach(b => buf.writeU8(b)); written = bytes.length;
        } else {
          bytes.slice(0,4).forEach(b => buf.writeU8(b)); written = Math.min(bytes.length, 4);
        }
        for (let pad = written; pad < 4; pad++) buf.writeU8(0);
      } else {
        // Value in value area; offset = valueAreaStart + valueBuf.length
        const vOffset = valueAreaStart + valueBuf.length;
        buf.writeU32LE(vOffset);
        const bytes = Array.isArray(e.data) ? e.data : [e.data];
        bytes.forEach(b => valueBuf.writeU8(b));
        // Pad to even byte boundary
        if (valueBuf.length % 2 !== 0) valueBuf.writeU8(0);
      }
    }
    buf.writeU32LE(nextIfdOff); // next IFD offset (0 = none)
  }

  // Ensure buf is positioned right at tiffBase + ifd0Offset
  writeIfd(ifd0Entries, 0); // IFD0, no next IFD
  writeIfd(exifEntries, 0); // Exif SubIFD
  if (gpsPtrIdx >= 0) {
    writeIfd(gpsEntries, 0); // GPS IFD
  }

  // Append value areas
  for (let i = 0; i < valueBuf.length; i++) buf.writeU8(valueBuf.get(i));

  // Patch APP1 length field (covers everything after the 2-byte marker)
  const app1ContentLen = buf.length - 2; // exclude FFE1 marker itself
  buf.setU16BE(lenPos, app1ContentLen);

  return buf.toUint8Array();
}

/** Convert decimal degrees to DMS rational triples [[d_num,1],[m_num,1],[s_num,10000]] */
function decimalToDMS(dec) {
  const d = Math.floor(dec);
  const mFrac = (dec - d) * 60;
  const m = Math.floor(mFrac);
  const s = (mFrac - m) * 60;
  const sNum = Math.round(s * 10000);
  return [[d, 1], [m, 1], [sNum, 10000]];
}

function asciiBytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xFF);
  return out;
}

// ── GrowableBuffer ────────────────────────────────────────────────────────────
class GrowableBuffer {
  constructor() { this._bytes = []; }
  get length() { return this._bytes.length; }
  writeU8(v)  { this._bytes.push(v & 0xFF); }
  writeU16LE(v) { this._bytes.push(v & 0xFF, (v >> 8) & 0xFF); }
  writeU16BE(v) { this._bytes.push((v >> 8) & 0xFF, v & 0xFF); }
  writeU32LE(v) {
    const lo = v >>> 0;
    this._bytes.push(lo & 0xFF, (lo >> 8) & 0xFF, (lo >> 16) & 0xFF, (lo >>> 24) & 0xFF);
  }
  writeBytes(arr) { for (const b of arr) this._bytes.push(b & 0xFF); }
  setU16BE(pos, v) {
    this._bytes[pos]   = (v >> 8) & 0xFF;
    this._bytes[pos+1] = v & 0xFF;
  }
  get(pos) { return this._bytes[pos]; }
  toUint8Array() { return new Uint8Array(this._bytes); }
}

// ── Public: writeJpegExif ────────────────────────────────────────────────────
/**
 * Replace (or insert) the APP1 Exif segment in a JPEG and return a new Uint8Array.
 * @param {Uint8Array} jpegU8
 * @param {object}     exifData  — same shape as readJpegExif output + keepMaker
 * @returns {Uint8Array}
 */
export function writeJpegExif(jpegU8, exifData) {
  try {
    const newApp1 = buildApp1(exifData);
    const existing = findApp1(jpegU8);

    // Build new JPEG: SOI + newApp1 + [rest without old APP1]
    const soi = jpegU8.slice(0, 2); // FFD8

    let bodyStart, bodyEnd;
    if (existing) {
      // Keep everything before old APP1 (usually just SOI) and after it.
      bodyStart = 2; // skip SOI
      // Splice out the old APP1 [existing.offset .. existing.offset+existing.size)
      const before = jpegU8.slice(2, existing.offset); // segments before APP1 (e.g. nothing, or APP0)
      const after  = jpegU8.slice(existing.offset + existing.size); // rest of JPEG

      const total = soi.length + newApp1.length + before.length + after.length;
      const out = new Uint8Array(total);
      let p = 0;
      out.set(soi, p); p += soi.length;
      out.set(newApp1, p); p += newApp1.length;
      out.set(before, p); p += before.length;
      out.set(after, p);
      return out;
    } else {
      // Insert new APP1 right after SOI
      const rest = jpegU8.slice(2);
      const total = soi.length + newApp1.length + rest.length;
      const out = new Uint8Array(total);
      let p = 0;
      out.set(soi, p); p += soi.length;
      out.set(newApp1, p); p += newApp1.length;
      out.set(rest, p);
      return out;
    }
  } catch (err) {
    console.warn('[exif] writeJpegExif error:', err);
    return jpegU8; // return original on error
  }
}

// ── Public: readMpfApp2 ──────────────────────────────────────────────────────
/**
 * Parse an MPF APP2 segment (starting from FFE2 marker).
 * @param {Uint8Array} u8arr — the full JPEG or just the APP2 segment starting at FFE2
 * @returns {Array<{offset:number, size:number, flags:number}>|null}
 */
export function readMpfApp2(u8arr) {
  try {
    // Locate APP2 with MPF identifier: FFE2 + len(2) + "MPF\0"
    let segStart = -1;
    let p = 0;
    // If called with full JPEG, scan for APP2.
    if (u8arr[0] === 0xFF && u8arr[1] === 0xD8) {
      p = 2;
      while (p < u8arr.length - 3) {
        if (u8arr[p] !== 0xFF) { p++; continue; }
        const marker = u8arr[p+1];
        if (marker === 0xDA || marker === 0xD9) break;
        if (p + 4 > u8arr.length) break;
        const segLen = (u8arr[p+2] << 8) | u8arr[p+3];
        if (marker === 0xE2) {
          // Check MPF identifier
          if (p + 8 <= u8arr.length &&
              u8arr[p+4] === 0x4D && u8arr[p+5] === 0x50 &&
              u8arr[p+6] === 0x46 && u8arr[p+7] === 0x00) {
            segStart = p;
            break;
          }
        }
        p += 2 + segLen;
      }
    } else if (u8arr[0] === 0xFF && u8arr[1] === 0xE2) {
      segStart = 0;
    }

    if (segStart < 0) return null;

    // APP2: FFE2(2) + length(2) + "MPF\0"(4) + TIFF
    const tiffStart = segStart + 8;
    const dv = new DataView(u8arr.buffer, u8arr.byteOffset, u8arr.byteLength);
    const bom = dv.getUint16(tiffStart, false);
    const le  = (bom === 0x4949);
    const ifdOff = u32(dv, tiffStart + 4, le);
    const ifdAt  = tiffStart + ifdOff;
    const numEntries = u16(dv, ifdAt, le);

    let mpEntryOffset = 0;
    let mpEntryCount  = 0;

    for (let i = 0; i < numEntries; i++) {
      const eOff = ifdAt + 2 + i * 12;
      const tag  = u16(dv, eOff, le);
      const cnt  = u32(dv, eOff + 4, le);
      const vOff = u32(dv, eOff + 8, le);
      if (tag === 0xB002) {
        mpEntryOffset = tiffStart + vOff;
        mpEntryCount  = cnt / 16;
      }
    }

    if (mpEntryCount < 1) return null;

    const entries = [];
    for (let i = 0; i < mpEntryCount; i++) {
      const off      = mpEntryOffset + i * 16;
      const flagAttr = u32(dv, off,     le);
      const size     = u32(dv, off + 4, le);
      const dataOff  = u32(dv, off + 8, le);
      entries.push({
        offset: i === 0 ? 0 : dataOff,
        size,
        flags: flagAttr,
      });
    }
    return entries;
  } catch (err) {
    console.warn('[exif] readMpfApp2 error:', err);
    return null;
  }
}

// ── Public: buildMpfApp2 ─────────────────────────────────────────────────────
/**
 * Build an MPF APP2 segment.
 * @param {Array<{offset:number, size:number, flags?:number}>} entries
 *   entry[0].offset must be 0 (first image). entry[1..n].offset = byte offset
 *   from start of the first image's APP1 (i.e. tiffBase for MPF).
 *   In practice for 3DS: offset of second image from start of file.
 *   Per CIPA DC-007: dataOffset in MP Entry is from the TIFF header of the MPF
 *   segment. For image[0] it's always 0. For image[1] it should be the byte
 *   distance from the start of the MPF TIFF header to the start of image[1] JPEG.
 *   Caller is responsible for computing correct offset.
 * @returns {Uint8Array} — full APP2 segment including FFE2 marker and length
 */
export function buildMpfApp2(entries) {
  try {
    // Layout (little-endian TIFF):
    //  FFE2(2) + LEN(2) + "MPF\0"(4) + TIFF_HEADER(8) + IFD(2+3*12+4) + MP_ENTRIES(16*n)
    // IFD has 3 tags: B000 (version), B001 (numberOfImages), B002 (mpEntry)
    // The MP Entry data is at the end of the TIFF block.

    const n = entries.length;
    // TIFF header: 8 bytes (II + 42 + ifdOffset=8)
    // IFD: 2 + 3*12 + 4 = 42 bytes
    // MP entries: n * 16
    const mpEntriesOffset = 8 + 42; // relative to TIFF start, i.e. offset for B002 value
    const tiffSize = 8 + 42 + n * 16;
    const segContentSize = 4 + tiffSize; // "MPF\0" + TIFF
    const totalSize = 2 + 2 + segContentSize; // FFE2 + LEN(2) + content

    const buf = new Uint8Array(totalSize);
    const dv  = new DataView(buf.buffer);
    let p = 0;

    // APP2 marker
    buf[p++] = 0xFF; buf[p++] = 0xE2;
    // Length (2 + content, where content excludes the 2-byte marker)
    dv.setUint16(p, 2 + segContentSize, false); p += 2;
    // "MPF\0"
    buf[p++] = 0x4D; buf[p++] = 0x50; buf[p++] = 0x46; buf[p++] = 0x00;

    // TIFF header (little-endian)
    const tiffBase = p;
    buf[p++] = 0x49; buf[p++] = 0x49; // "II"
    dv.setUint16(p, 42, true); p += 2; // TIFF magic
    dv.setUint32(p, 8, true);  p += 4; // IFD offset = 8 from TIFF start

    // IFD entry count
    dv.setUint16(p, 3, true); p += 2;

    // Tag B000: MPVersion = "0100"
    dv.setUint16(p, 0xB000, true); p += 2;
    dv.setUint16(p, TYPES.UNDEFINED, true); p += 2;
    dv.setUint32(p, 4, true); p += 4;
    buf[p++] = 0x30; buf[p++] = 0x31; buf[p++] = 0x30; buf[p++] = 0x30; // "0100"

    // Tag B001: NumberOfImages
    dv.setUint16(p, 0xB001, true); p += 2;
    dv.setUint16(p, TYPES.LONG, true); p += 2;
    dv.setUint32(p, 1, true); p += 4;
    dv.setUint32(p, n, true); p += 4;

    // Tag B002: MPEntry — count = n*16, offset = mpEntriesOffset from TIFF start
    dv.setUint16(p, 0xB002, true); p += 2;
    dv.setUint16(p, TYPES.UNDEFINED, true); p += 2;
    dv.setUint32(p, n * 16, true); p += 4;
    dv.setUint32(p, mpEntriesOffset, true); p += 4;

    // Next IFD offset = 0
    dv.setUint32(p, 0, true); p += 4;

    // MP Entries (16 bytes each)
    for (let i = 0; i < n; i++) {
      const e = entries[i];
      const flags = e.flags !== undefined ? e.flags :
        (i === 0 ? 0x20030000 : 0x00000000); // primary image or dependent
      dv.setUint32(p, flags,          true); p += 4;
      dv.setUint32(p, e.size || 0,    true); p += 4;
      dv.setUint32(p, i === 0 ? 0 : (e.offset || 0), true); p += 4;
      dv.setUint16(p, 0, true); p += 2; // DependentImage1EntryNumber
      dv.setUint16(p, 0, true); p += 2; // DependentImage2EntryNumber
    }

    return buf;
  } catch (err) {
    console.warn('[exif] buildMpfApp2 error:', err);
    return new Uint8Array(0);
  }
}
