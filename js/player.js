// Preview player. Decodes JPEG frames on demand, renders to canvas, plays audio via Web Audio.
// Filters/transforms are applied via a CSS filter on the canvas for cheap preview;
// destructive rendering for export is handled by render/compose.js + WebGL.

import { jpegBlobAt } from './parsers/avi.js?v=20';
import { decodeImaAdpcmAviChunks } from './parsers/adpcm.js?v=20';

export class Player {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.media = null;       // 'video' | 'image'
    this.parsed = null;
    this.imageBitmaps = null; // for MPO
    this.frameCache = new Map();
    this.audioBuffer = null;
    this.audioCtx = null;
    this.source = null;
    this.startTime = 0;
    this.pauseAt = 0;
    this.playing = false;
    this.mode = '2d';
    this.transform = { rotate: 0, flipH: false, flipV: false };
    this.filter = { brightness:0, contrast:0, saturation:0, gamma:1, hue:0 };
    this.rafId = 0;
    this.onTime = null;
    this.onEnd = null;
  }

  async loadVideo(parsed) {
    this.media = 'video';
    this.parsed = parsed;
    this.frameCache.clear();
    this._setupAudio();
    this._applyMode();
    await this._renderFrameAt(0);
  }

  async loadImage(mpo) {
    this.media = 'image';
    this.parsed = mpo;
    this.imageBitmaps = {
      left: await createImageBitmap(new Blob([mpo.leftJpeg], {type:'image/jpeg'})),
      right: await createImageBitmap(new Blob([mpo.rightJpeg], {type:'image/jpeg'})),
    };
    this._applyMode();
    this._drawImageStatic();
  }

  setMode(mode) {
    this.mode = mode;
    this._applyMode();
    if (this.media === 'image') this._drawImageStatic();
    else if (this.media === 'video') this._renderFrameAt(this.currentTime());
  }

  setTransform(t) {
    this.transform = { ...this.transform, ...t };
    this._applyCss();
    this._applyMode();
    if (this.media === 'image') this._drawImageStatic();
    else if (this.media === 'video') this._renderFrameAt(this.currentTime());
  }

  setFilter(f) {
    this.filter = { ...this.filter, ...f };
    this._applyCss();
  }

  _applyCss() {
    // Color filters via CSS for cheap preview. Rotation/flip are baked into canvas drawing.
    const f = this.filter;
    const css = [
      `brightness(${1 + f.brightness/100})`,
      `contrast(${1 + f.contrast/100})`,
      `saturate(${1 + f.saturation/100})`,
      `hue-rotate(${f.hue}deg)`,
    ].join(' ');
    this.canvas.style.filter = css;
    this.canvas.style.transform = ''; // we no longer use CSS transform
  }

  _baseSize() {
    const w = this.parsed.width;
    const h = this.parsed.height;
    return this.mode === 'sbs' ? { w: w * 2, h } : { w, h };
  }

  _applyMode() {
    if (!this.parsed) return;
    const { w, h } = this._baseSize();
    const rot = (this.transform.rotate || 0) % 360;
    if (rot === 90 || rot === 270) {
      this.canvas.width = h;
      this.canvas.height = w;
    } else {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // Reset inline size so the next measurement reads true stage size, not stretched by old style.
    this.canvas.style.width = '';
    this.canvas.style.height = '';
    this._fitToStage();
    // Also rAF in case the stage hadn't laid out yet (initial load case).
    requestAnimationFrame(() => this._fitToStage());
  }

  _fitToStage() {
    const stage = this.canvas.parentElement;
    if (!stage) return;
    const cs = getComputedStyle(stage);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    // Temporarily collapse the canvas inline size so the parent's intrinsic size
    // is not influenced by the canvas's drawing-buffer dimensions.
    this.canvas.style.width = '0px';
    this.canvas.style.height = '0px';
    const sw = Math.max(0, stage.clientWidth - pl - pr);
    const sh = Math.max(0, stage.clientHeight - pt - pb);
    if (sw === 0 || sh === 0) {
      this.canvas.style.width = '';
      this.canvas.style.height = '';
      return;
    }
    const ratio = this.canvas.width / this.canvas.height;
    const stageRatio = sw / sh;
    let w, h;
    if (ratio > stageRatio) { w = sw; h = sw / ratio; }
    else { h = sh; w = sh * ratio; }
    this.canvas.style.width = Math.round(w) + 'px';
    this.canvas.style.height = Math.round(h) + 'px';
  }

  refit() { this._fitToStage(); }

  _drawWithTransform(drawer) {
    const { w, h } = this._baseSize();
    const rot = (this.transform.rotate || 0) % 360;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // Move origin to canvas center, rotate, flip, then translate back to base-size top-left.
    ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
    if (rot) ctx.rotate(rot * Math.PI / 180);
    const sx = this.transform.flipH ? -1 : 1;
    const sy = this.transform.flipV ? -1 : 1;
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
    ctx.translate(-w / 2, -h / 2);
    drawer(ctx);
    ctx.restore();
  }

  async _renderFrameAt(timeSec) {
    if (this.media !== 'video') return;
    const idx = Math.min(this.parsed.frameCount - 1, Math.max(0, Math.floor(timeSec * this.parsed.fps)));
    const left = await this._decodeFrame('L', idx);
    const right = this.mode === 'sbs' ? await this._decodeFrame('R', idx) : null;
    const w = this.parsed.width, h = this.parsed.height;
    const swap = !!this.transform.swapLR;
    this._drawWithTransform((ctx) => {
      ctx.drawImage(swap ? (right || left) : left, 0, 0, w, h);
      if (right) ctx.drawImage(swap ? left : right, w, 0, w, h);
    });
  }

  async _decodeFrame(side, idx) {
    const key = side + idx;
    if (this.frameCache.has(key)) return this.frameCache.get(key);
    const arr = side === 'L' ? this.parsed.videoLeft : this.parsed.videoRight;
    const bm = await createImageBitmap(jpegBlobAt(this.parsed, arr[idx]));
    if (this.frameCache.size > 60) {
      const firstKey = this.frameCache.keys().next().value;
      const first = this.frameCache.get(firstKey);
      first.close?.();
      this.frameCache.delete(firstKey);
    }
    this.frameCache.set(key, bm);
    return bm;
  }

  _drawImageStatic() {
    if (this.media !== 'image') return;
    const { left, right } = this.imageBitmaps;
    const w = this.parsed.width, h = this.parsed.height;
    const swap = !!this.transform.swapLR;
    this._drawWithTransform((ctx) => {
      ctx.drawImage(swap ? right : left, 0, 0, w, h);
      if (this.mode === 'sbs') ctx.drawImage(swap ? left : right, w, 0, w, h);
    });
  }

  _setupAudio() {
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = decodeImaAdpcmAviChunks(
      this.parsed.rawBuffer.buffer,
      this.parsed.audio,
      this.parsed.audioFmt
    );
    const buf = this.audioCtx.createBuffer(decoded.channels, decoded.length, decoded.sampleRate);
    for (let ch = 0; ch < decoded.channels; ch++) {
      buf.copyToChannel(decoded.samples[ch].subarray(0, decoded.length), ch);
    }
    this.audioBuffer = buf;
  }

  async play() {
    if (this.media !== 'video') return;
    if (this.playing) return;
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    this.source = this.audioCtx.createBufferSource();
    this.source.buffer = this.audioBuffer;
    this.source.connect(this.audioCtx.destination);
    const offset = this.pauseAt;
    this.startTime = this.audioCtx.currentTime - offset;
    this.source.start(0, offset);
    this.playing = true;
    this.source.onended = () => {
      if (this.playing && this.currentTime() >= this.parsed.durationSec - 0.01) {
        this.playing = false;
        this.pauseAt = 0;
        this.onEnd?.();
        cancelAnimationFrame(this.rafId);
      }
    };
    const tick = async () => {
      if (!this.playing) return;
      const t = this.currentTime();
      await this._renderFrameAt(t);
      this.onTime?.(t);
      if (t >= this.parsed.durationSec) {
        this.pause();
        this.pauseAt = 0;
        this.onEnd?.();
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  pause() {
    if (!this.playing) return;
    this.pauseAt = this.currentTime();
    try { this.source?.stop(); } catch {}
    this.source = null;
    this.playing = false;
    cancelAnimationFrame(this.rafId);
  }

  async seek(t) {
    const wasPlaying = this.playing;
    this.pause();
    this.pauseAt = Math.max(0, Math.min(this.parsed.durationSec, t));
    await this._renderFrameAt(this.pauseAt);
    this.onTime?.(this.pauseAt);
    if (wasPlaying) this.play();
  }

  currentTime() {
    if (!this.audioCtx) return 0;
    if (!this.playing) return this.pauseAt;
    return this.audioCtx.currentTime - this.startTime;
  }

  dispose() {
    this.pause();
    for (const bm of this.frameCache.values()) bm.close?.();
    this.frameCache.clear();
    if (this.imageBitmaps) {
      this.imageBitmaps.left?.close?.();
      this.imageBitmaps.right?.close?.();
    }
  }
}
