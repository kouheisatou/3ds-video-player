// IMA ADPCM decoder (Microsoft variant used in WAV/AVI). Mono/stereo block-aligned.
// Each block: per-channel header (predictor int16, stepIdx uint8, reserved 0), then 4-bit nibbles.

const STEP_TABLE = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,
  50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,
  230,253,279,307,337,371,408,449,494,544,598,658,724,796,
  876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,
  2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,
  7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,
  18500,20350,22385,24623,27086,29794,32767
];

const INDEX_TABLE = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];

export function decodeImaAdpcmAviChunks(buffer, chunks, fmt) {
  const channels = fmt.channels;
  const blockAlign = fmt.blockAlign;
  const samplesPerBlock = ((blockAlign - channels * 4) * 8 / (channels * 4)) + 1;

  // Pre-compute total samples.
  let totalBlocks = 0;
  for (const c of chunks) totalBlocks += Math.floor(c.length / blockAlign);
  const totalSamples = totalBlocks * samplesPerBlock;

  const out = channels === 1
    ? [new Float32Array(totalSamples)]
    : [new Float32Array(totalSamples), new Float32Array(totalSamples)];

  let outIdx = 0;
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  for (const c of chunks) {
    const blocks = Math.floor(c.length / blockAlign);
    for (let b = 0; b < blocks; b++) {
      const blockOff = c.offset + b * blockAlign;
      const predictors = new Int32Array(channels);
      const stepIdx = new Int32Array(channels);
      // Header: predictor int16 LE + stepIdx uint8 + reserved
      for (let ch = 0; ch < channels; ch++) {
        const h = blockOff + ch * 4;
        predictors[ch] = dv.getInt16(h, true);
        stepIdx[ch] = u8[h + 2];
        if (stepIdx[ch] > 88) stepIdx[ch] = 88;
        if (stepIdx[ch] < 0) stepIdx[ch] = 0;
        out[ch][outIdx] = predictors[ch] / 32768;
      }
      // Decode samples after header.
      const dataOff = blockOff + channels * 4;
      const dataLen = blockAlign - channels * 4;

      if (channels === 1) {
        let predictor = predictors[0];
        let idx = stepIdx[0];
        let sampleN = 1;
        for (let i = 0; i < dataLen; i++) {
          const byte = u8[dataOff + i];
          const n0 = byte & 0x0F;
          const n1 = (byte >> 4) & 0x0F;
          ({ predictor, idx } = stepDecode(predictor, idx, n0));
          out[0][outIdx + sampleN++] = clip16(predictor) / 32768;
          ({ predictor, idx } = stepDecode(predictor, idx, n1));
          out[0][outIdx + sampleN++] = clip16(predictor) / 32768;
        }
      } else {
        // Stereo: 8-byte interleaved (4B left + 4B right per group, 8 samples each)
        let pL = predictors[0], pR = predictors[1];
        let iL = stepIdx[0], iR = stepIdx[1];
        let sN = 1;
        for (let p = 0; p < dataLen; p += 8) {
          // Left 4 bytes (8 nibbles)
          for (let k = 0; k < 4; k++) {
            const byte = u8[dataOff + p + k];
            const n0 = byte & 0x0F, n1 = (byte >> 4) & 0x0F;
            ({ predictor: pL, idx: iL } = stepDecode(pL, iL, n0));
            out[0][outIdx + sN + k*2] = clip16(pL) / 32768;
            ({ predictor: pL, idx: iL } = stepDecode(pL, iL, n1));
            out[0][outIdx + sN + k*2 + 1] = clip16(pL) / 32768;
          }
          // Right 4 bytes
          for (let k = 0; k < 4; k++) {
            const byte = u8[dataOff + p + 4 + k];
            const n0 = byte & 0x0F, n1 = (byte >> 4) & 0x0F;
            ({ predictor: pR, idx: iR } = stepDecode(pR, iR, n0));
            out[1][outIdx + sN + k*2] = clip16(pR) / 32768;
            ({ predictor: pR, idx: iR } = stepDecode(pR, iR, n1));
            out[1][outIdx + sN + k*2 + 1] = clip16(pR) / 32768;
          }
          sN += 8;
        }
      }
      outIdx += samplesPerBlock;
    }
  }

  return { sampleRate: fmt.sampleRate, channels, samples: out, length: outIdx };
}

function stepDecode(predictor, idx, nibble) {
  const step = STEP_TABLE[idx];
  let diff = step >> 3;
  if (nibble & 1) diff += step >> 2;
  if (nibble & 2) diff += step >> 1;
  if (nibble & 4) diff += step;
  if (nibble & 8) diff = -diff;
  predictor += diff;
  idx += INDEX_TABLE[nibble];
  if (idx < 0) idx = 0;
  if (idx > 88) idx = 88;
  if (predictor > 32767) predictor = 32767;
  if (predictor < -32768) predictor = -32768;
  return { predictor, idx };
}

function clip16(v) {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}
