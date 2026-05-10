// 3DS AVI (RIFF) demuxer.
// 3DS records 3 streams: video left (00dc, MJPEG), audio (01wb, ADPCM IMA), video right (02dc, MJPEG).
// Output: byte-range index into the original buffer — no JPEG decode here.

const FOURCC = (s) => s.charCodeAt(0) | (s.charCodeAt(1)<<8) | (s.charCodeAt(2)<<16) | (s.charCodeAt(3)<<24);
const fcc = (v) => String.fromCharCode(v & 0xff, (v>>8) & 0xff, (v>>16) & 0xff, (v>>24) & 0xff);

export function parseAvi(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  if (dv.getUint32(0, false) !== 0x52494646) throw new Error('RIFFヘッダがありません');
  if (dv.getUint32(8, true) !== FOURCC('AVI ')) throw new Error('AVI形式ではありません');

  const fileSize = dv.getUint32(4, true) + 8;
  let pos = 12;

  const streams = [];     // indexed by stream number
  let mainHeader = null;
  let movieDataStart = 0;
  let movieDataEnd = 0;
  let idx1 = null;

  const readChunk = (off) => ({
    id: dv.getUint32(off, true),
    size: dv.getUint32(off + 4, true),
  });

  // Walk top-level chunks.
  while (pos < fileSize - 8 && pos < u8.length - 8) {
    const id = dv.getUint32(pos, true);
    const size = dv.getUint32(pos + 4, true);
    const idStr = fcc(id);

    if (idStr === 'LIST') {
      const listType = dv.getUint32(pos + 8, true);
      const listTypeStr = fcc(listType);
      if (listTypeStr === 'hdrl') {
        parseHdrl(pos + 12, size - 4, streams, (m) => mainHeader = m);
      } else if (listTypeStr === 'movi') {
        movieDataStart = pos + 12;
        movieDataEnd = pos + 8 + size;
      }
    } else if (idStr === 'idx1') {
      idx1 = { offset: pos + 8, size };
    }
    pos += 8 + size + (size & 1);
  }

  if (!mainHeader) throw new Error('avih ヘッダ不在');

  function parseHdrl(start, len, streams, setMain) {
    let p = start;
    const end = start + len;
    let streamIdx = -1;
    while (p < end - 8) {
      const id = dv.getUint32(p, true);
      const size = dv.getUint32(p + 4, true);
      const idStr = fcc(id);
      if (idStr === 'avih') {
        setMain({
          microSecPerFrame: dv.getUint32(p + 8, true),
          maxBytesPerSec: dv.getUint32(p + 12, true),
          flags: dv.getUint32(p + 20, true),
          totalFrames: dv.getUint32(p + 24, true),
          streams: dv.getUint32(p + 32, true),
          width: dv.getUint32(p + 48, true),
          height: dv.getUint32(p + 52, true),
        });
      } else if (idStr === 'LIST') {
        const subType = fcc(dv.getUint32(p + 8, true));
        if (subType === 'strl') {
          streamIdx++;
          parseStrl(p + 12, size - 4, streamIdx, streams);
        }
      }
      p += 8 + size + (size & 1);
    }
  }

  function parseStrl(start, len, idx, streams) {
    let p = start;
    const end = start + len;
    const stream = { index: idx };
    while (p < end - 8) {
      const id = dv.getUint32(p, true);
      const size = dv.getUint32(p + 4, true);
      const idStr = fcc(id);
      if (idStr === 'strh') {
        stream.fccType = fcc(dv.getUint32(p + 8, true));
        stream.fccHandler = fcc(dv.getUint32(p + 12, true));
        stream.scale = dv.getUint32(p + 28, true);
        stream.rate = dv.getUint32(p + 32, true);
        stream.length = dv.getUint32(p + 40, true);
        stream.sampleSize = dv.getUint32(p + 44, true);
      } else if (idStr === 'strf' && stream.fccType === 'auds') {
        stream.audioFormat = {
          formatTag: dv.getUint16(p + 8, true),
          channels: dv.getUint16(p + 10, true),
          sampleRate: dv.getUint32(p + 12, true),
          avgBytesPerSec: dv.getUint32(p + 16, true),
          blockAlign: dv.getUint16(p + 20, true),
          bitsPerSample: dv.getUint16(p + 22, true),
        };
      } else if (idStr === 'strf' && stream.fccType === 'vids') {
        stream.videoFormat = {
          width: dv.getInt32(p + 12, true),
          height: dv.getInt32(p + 16, true),
          bitCount: dv.getUint16(p + 22, true),
          compression: fcc(dv.getUint32(p + 24, true)),
        };
      }
      p += 8 + size + (size & 1);
    }
    streams[idx] = stream;
  }

  const videoLeft = [];
  const videoRight = [];
  const audio = [];

  // Decide stream tags. Convention for 3DS: 00=L video, 01=audio, 02=R video.
  const tagFor = (idx, kind) => {
    const idStr = String(idx).padStart(2, '0');
    const suf = kind === 'vids' ? 'dc' : 'wb';
    return idStr + suf;
  };

  const leftTag = streams[0]?.fccType === 'vids' ? tagFor(0, 'vids') : null;
  const audioTag = streams.findIndex(s => s?.fccType === 'auds');
  const rightTag = streams[2]?.fccType === 'vids' ? tagFor(2, 'vids') : null;

  if (idx1) {
    const entryCount = idx1.size / 16;
    for (let i = 0; i < entryCount; i++) {
      const e = idx1.offset + i * 16;
      const tag = '' +
        String.fromCharCode(u8[e], u8[e+1], u8[e+2], u8[e+3]);
      const offset = dv.getUint32(e + 8, true);
      const length = dv.getUint32(e + 12, true);
      // idx1 offsets are relative to movi start (or file start in some files); detect.
      let dataOff;
      // Try movi-relative first: movieDataStart + 4 brings us past 'movi' fourcc; idx1 offset usually points at chunk header.
      const candA = movieDataStart - 4 + offset;
      // Some encoders write absolute offsets. Detect by checking RIFF marker.
      if (candA + 4 <= u8.length && u8[candA] === tag.charCodeAt(0) && u8[candA+1] === tag.charCodeAt(1)) {
        dataOff = candA + 8;
      } else {
        dataOff = offset + 8;
      }
      const entry = { offset: dataOff, length };
      if (tag === leftTag) videoLeft.push(entry);
      else if (tag === rightTag) videoRight.push(entry);
      else if (audioTag >= 0 && tag === tagFor(audioTag, 'auds')) audio.push(entry);
    }
  } else {
    // Fallback: linear scan of movi.
    let p = movieDataStart + 4;
    while (p < movieDataEnd - 8) {
      const tagBytes = [u8[p], u8[p+1], u8[p+2], u8[p+3]];
      const tag = String.fromCharCode(...tagBytes);
      const size = dv.getUint32(p + 4, true);
      const entry = { offset: p + 8, length: size };
      if (tag === leftTag) videoLeft.push(entry);
      else if (tag === rightTag) videoRight.push(entry);
      else if (audioTag >= 0 && tag === tagFor(audioTag, 'auds')) audio.push(entry);
      p += 8 + size + (size & 1);
    }
  }

  // 3DS sanity: must have BOTH left and right video streams to be 3D AVI.
  if (videoLeft.length === 0 || videoRight.length === 0) {
    throw new Error('3DSの3D AVI(2映像ストリーム)ではありません');
  }
  // Frame counts may differ by ±1 between L/R: clamp to min.
  const frameCount = Math.min(videoLeft.length, videoRight.length);
  videoLeft.length = frameCount;
  videoRight.length = frameCount;

  const fps = mainHeader.microSecPerFrame > 0
    ? 1e6 / mainHeader.microSecPerFrame
    : (streams[0]?.rate / streams[0]?.scale || 20);

  const audioFmt = streams[audioTag]?.audioFormat || null;

  return {
    width: streams[0]?.videoFormat?.width || mainHeader.width,
    height: streams[0]?.videoFormat?.height || mainHeader.height,
    fps,
    frameCount,
    durationSec: frameCount / fps,
    videoLeft,
    videoRight,
    audio,
    audioFmt,
    rawBuffer: u8,
  };
}

export function jpegBlobAt(parsed, entry) {
  return new Blob([parsed.rawBuffer.subarray(entry.offset, entry.offset + entry.length)], { type: 'image/jpeg' });
}
