// Video encoder: 3DS AVI -> MP4 (H.264 + AAC) via WebCodecs + mp4-muxer.

import { parseAvi, jpegBlobAt } from '../parsers/avi.js?v=20';
import { decodeImaAdpcmAviChunks } from '../parsers/adpcm.js?v=20';
import { Renderer } from '../render/gl.js?v=20';
import { Muxer, ArrayBufferTarget } from '../../vendor/mp4-muxer.mjs';

export async function encodeVideoJob({ buffer, settings, onProgress }) {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('このブラウザはWebCodecsをサポートしていません (Chrome 94+/Safari 16.4+/Firefox 130+)');
  }

  const parsed = parseAvi(buffer);
  const renderer = new Renderer();
  renderer.setBaseSize(parsed.width, parsed.height);
  renderer.setMode(settings.outputFormat);
  renderer.setTransform(settings.transform);
  renderer.setFilter(settings.filter);

  // First render of frame 0 to lock output dimensions.
  const firstLeft = await createImageBitmap(jpegBlobAt(parsed, parsed.videoLeft[0]));
  const firstRight = await createImageBitmap(jpegBlobAt(parsed, parsed.videoRight[0]));
  renderer.setSource(firstLeft, firstRight);
  renderer.render();
  const { width: outW, height: outH } = { width: renderer.outputSize().w, height: renderer.outputSize().h };

  // Decode audio upfront.
  const decoded = decodeImaAdpcmAviChunks(parsed.rawBuffer.buffer, parsed.audio, parsed.audioFmt);

  // --- Pick supported audio codec ---
  let audioCodec = null;
  for (const cand of ['mp4a.40.2', 'mp4a.40.5', 'mp4a.67']) {
    try {
      const sup = await AudioEncoder.isConfigSupported({
        codec: cand,
        sampleRate: 48000,
        numberOfChannels: 1,
        bitrate: 96000,
      });
      if (sup?.supported) { audioCodec = cand; break; }
    } catch {}
  }
  if (!audioCodec) {
    // Fall back to no-audio if AAC isn't supported on this browser.
    console.warn('[video] AAC encoding not supported — output will have no audio');
  }

  // --- Pick supported video codec ---
  const tryVideoCodecs = [pickH264Codec(outW, outH), 'avc1.42E01F', 'avc1.42001F', 'avc1.42E020'];
  let videoCodec = null;
  for (const cand of tryVideoCodecs) {
    try {
      const sup = await VideoEncoder.isConfigSupported({
        codec: cand,
        width: outW,
        height: outH,
        bitrate: settings.videoBitrate || 8_000_000,
        framerate: parsed.fps,
        avc: { format: 'avc' },
      });
      if (sup?.supported) { videoCodec = cand; break; }
    } catch {}
  }
  if (!videoCodec) throw new Error('H.264 エンコーダがサポートされていません');

  // Configure muxer.
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: outW, height: outH, frameRate: parsed.fps },
    audio: audioCodec ? { codec: 'aac', sampleRate: 48000, numberOfChannels: 1 } : undefined,
    fastStart: 'in-memory',
  });

  // Video encoder.
  let encoderError = null;
  const vEnc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; console.error('[video encoder]', e); },
  });
  vEnc.configure({
    codec: videoCodec,
    width: outW,
    height: outH,
    bitrate: settings.videoBitrate || 8_000_000,
    framerate: parsed.fps,
    avc: { format: 'avc' },
  });
  if (vEnc.state !== 'configured') throw new Error('VideoEncoder の構成に失敗');

  // Audio encoder.
  let aEnc = null;
  if (audioCodec) {
    aEnc = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { encoderError = e; console.error('[audio encoder]', e); },
    });
    aEnc.configure({
      codec: audioCodec,
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: 96000,
    });
    if (aEnc.state !== 'configured') {
      console.warn('[video] AudioEncoder config failed — proceeding without audio');
      try { aEnc.close(); } catch {}
      aEnc = null;
    }
  }

  // Encode video frames.
  const frameDurationUs = Math.round(1e6 / parsed.fps);
  let prevLeft = firstLeft, prevRight = firstRight;
  for (let i = 0; i < parsed.frameCount; i++) {
    let leftBm, rightBm;
    if (i === 0) {
      leftBm = firstLeft; rightBm = firstRight;
    } else {
      leftBm = await createImageBitmap(jpegBlobAt(parsed, parsed.videoLeft[i]));
      rightBm = await createImageBitmap(jpegBlobAt(parsed, parsed.videoRight[i]));
    }
    renderer.setSource(leftBm, rightBm);
    renderer.render();

    const vf = new VideoFrame(renderer.getCanvas(), {
      timestamp: i * frameDurationUs,
      duration: frameDurationUs,
    });
    const isKey = (i % Math.round(parsed.fps * 2) === 0);
    vEnc.encode(vf, { keyFrame: isKey });
    vf.close();

    if (i > 0) {
      prevLeft.close?.();
      prevRight.close?.();
    }
    prevLeft = leftBm; prevRight = rightBm;

    onProgress?.(0.05 + 0.85 * (i + 1) / parsed.frameCount);
    // Back-pressure: yield to event loop occasionally.
    if (i % 30 === 29) await new Promise(r => setTimeout(r, 0));
  }
  prevLeft.close?.();
  prevRight.close?.();

  // Encode audio: resample 16k mono -> 48k mono (linear interpolation).
  const srcPcm = decoded.samples[0].subarray(0, decoded.length);
  const dstSampleRate = 48000;
  const srcSampleRate = decoded.sampleRate;
  const dstLen = Math.floor(decoded.length * dstSampleRate / srcSampleRate);
  const dstPcm = new Float32Array(dstLen);
  const ratio = srcSampleRate / dstSampleRate;
  for (let i = 0; i < dstLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const frac = srcIdx - i0;
    const v0 = srcPcm[i0] || 0;
    const v1 = srcPcm[Math.min(i0 + 1, decoded.length - 1)] || 0;
    dstPcm[i] = v0 + (v1 - v0) * frac;
  }

  // Split into AudioData chunks (~1024 samples).
  if (aEnc && aEnc.state === 'configured') {
    const audioChunkSize = 1024;
    for (let off = 0; off < dstLen; off += audioChunkSize) {
      const chunkLen = Math.min(audioChunkSize, dstLen - off);
      const ts = Math.round((off / dstSampleRate) * 1e6);
      const ad = new AudioData({
        format: 'f32-planar',
        sampleRate: dstSampleRate,
        numberOfFrames: chunkLen,
        numberOfChannels: 1,
        timestamp: ts,
        data: dstPcm.subarray(off, off + chunkLen),
      });
      aEnc.encode(ad);
      ad.close();
    }
  }

  await vEnc.flush();
  if (aEnc) await aEnc.flush();
  vEnc.close();
  if (aEnc) aEnc.close();
  if (encoderError) throw encoderError;
  muxer.finalize();
  renderer.dispose();

  onProgress?.(1);
  return new Blob([target.buffer], { type: 'video/mp4' });
}

// Choose an AVC profile/level that fits the output resolution.
function pickH264Codec(w, h) {
  const mbps = (w * h) / 256;
  // Baseline profile (avc1.42E0xx) — level chosen to cover macroblock count.
  if (mbps <= 396) return 'avc1.42E01E';   // Level 3.0
  if (mbps <= 1620) return 'avc1.42E01F';  // Level 3.1
  if (mbps <= 3600) return 'avc1.42E028';  // Level 4.0
  return 'avc1.42E032';                    // Level 5.0
}
