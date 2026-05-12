// Minimal ZIP encoder (STORED mode, no compression). Sufficient for already-compressed
// outputs like MP4 and JPEG — adding deflate would barely shrink them.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const encoder = new TextEncoder();

// DOS time/date for current timestamp.
function dosDateTime(d = new Date()) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date: date & 0xFFFF, time: time & 0xFFFF };
}

// Build a ZIP blob from a list of { name, bytes (Uint8Array) }.
export function buildZip(entries) {
  const { date, time } = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, bytes } of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(bytes);
    const size = bytes.length;

    // Local file header (30 bytes + name).
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);   // signature
    dv.setUint16(4, 20, true);           // version needed
    dv.setUint16(6, 0, true);            // flags
    dv.setUint16(8, 0, true);            // method (0=stored)
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local);
    parts.push(bytes);

    // Central directory entry (46 bytes + name).
    const cent = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cent.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);          // version made by
    cdv.setUint16(6, 20, true);          // version needed
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, time, true);
    cdv.setUint16(14, date, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);          // extra
    cdv.setUint16(32, 0, true);          // comment
    cdv.setUint16(34, 0, true);          // disk
    cdv.setUint16(36, 0, true);          // internal attrs
    cdv.setUint32(38, 0, true);          // external attrs
    cdv.setUint32(42, offset, true);
    cent.set(nameBytes, 46);
    central.push(cent);

    offset += local.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  // End of central directory record.
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralStart, true);
  edv.setUint16(20, 0, true);

  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}
