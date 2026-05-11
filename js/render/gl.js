// WebGL2 destructive rendering pipeline.
// Draws left/right eye images into an offscreen canvas applying mode, transform
// and color filters entirely in GPU — no CSS tricks.

import { FRAG_SRC } from './filters.glsl.js?v=20';

// ---- Vertex shader: full-screen triangle trick (no VBO needed) ----
const VERT_SRC = /* glsl */`#version 300 es
void main() {
  // Emit a triangle that covers the entire clip-space, in three invocations.
  vec2 pos[3];
  pos[0] = vec2(-1.0, -1.0);
  pos[1] = vec2( 3.0, -1.0);
  pos[2] = vec2(-1.0,  3.0);
  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);
}
`;

// Map mode string to integer used by the shader.
const MODE_MAP = {
  '2d-l':   0,
  '2d':     0,  // alias — player.js sends '2d' for preview
  '2d-r':   1,
  'sbs':    2,
  'tab':    3,
  'anaglyph': 4,
};

function normaliseMode(raw) {
  // Strip leading encoder prefix like 'mp4-' or 'jpg-'.
  const stripped = raw.replace(/^(mp4|jpg)-/, '');
  if (stripped in MODE_MAP) return stripped;
  if (raw in MODE_MAP) return raw;
  throw new Error(`Renderer: unknown mode "${raw}"`);
}

// ---- Renderer ----

export class Renderer {
  constructor() {
    this._canvas = document.createElement('canvas');
    const gl = this._canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 unsupported');
    this._gl = gl;

    this._baseW = 1;
    this._baseH = 1;
    this._mode = '2d-l';
    this._transform = { rotate: 0, flipH: false, flipV: false, swapLR: false };
    this._filter = { brightness: 0, contrast: 0, saturation: 0, gamma: 1, hue: 0 };

    this._leftBitmap  = null;
    this._rightBitmap = null;

    this._prog   = this._buildProgram();
    this._uniforms = this._collectUniforms();
    this._texLeft  = this._makePlaceholderTex();
    this._texRight = this._makePlaceholderTex();
  }

  // ---- Public API ----

  setBaseSize(w, h) {
    this._baseW = w;
    this._baseH = h;
  }

  setSource(leftBitmap, rightBitmap) {
    this._leftBitmap  = leftBitmap  ?? null;
    this._rightBitmap = rightBitmap ?? null;
  }

  setMode(mode) {
    this._mode = normaliseMode(mode);
  }

  setTransform(t) {
    this._transform = { ...this._transform, ...t };
  }

  setFilter(f) {
    this._filter = { ...this._filter, ...f };
  }

  render() {
    const gl = this._gl;
    const { w, h } = this.outputSize();

    // Resize canvas only when dimensions changed (avoids GPU re-alloc every frame).
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width  = w;
      this._canvas.height = h;
    }
    gl.viewport(0, 0, w, h);

    // Upload source images to textures.
    this._uploadBitmap(gl.TEXTURE0, this._texLeft,  this._leftBitmap);
    this._uploadBitmap(gl.TEXTURE1, this._texRight, this._rightBitmap);

    // Set uniforms.
    const u = this._uniforms;
    gl.useProgram(this._prog);

    gl.uniform1i(u.uLeft,  0);
    gl.uniform1i(u.uRight, 1);

    gl.uniform1i(u.uMode,   MODE_MAP[this._mode]);
    gl.uniform1i(u.uRotate, (this._transform.rotate ?? 0) % 360);
    gl.uniform1i(u.uFlipH,  this._transform.flipH  ? 1 : 0);
    gl.uniform1i(u.uFlipV,  this._transform.flipV  ? 1 : 0);
    gl.uniform1i(u.uSwapLR, this._transform.swapLR ? 1 : 0);

    gl.uniform1f(u.uBrightness, this._filter.brightness ?? 0);
    gl.uniform1f(u.uContrast,   this._filter.contrast   ?? 0);
    gl.uniform1f(u.uSaturation, this._filter.saturation ?? 0);
    gl.uniform1f(u.uGamma,      this._filter.gamma       ?? 1);
    gl.uniform1f(u.uHue,        this._filter.hue         ?? 0);

    gl.uniform2f(u.uOutSize,  w, h);
    gl.uniform2f(u.uBaseSize, this._baseW, this._baseH);

    // Draw a full-screen triangle (3 vertices, no VBO).
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();
  }

  getCanvas() {
    return this._canvas;
  }

  outputSize() {
    const mode = this._mode;
    const rot   = (this._transform.rotate ?? 0) % 360;

    let w = this._baseW;
    let h = this._baseH;

    if (mode === 'sbs') w *= 2;
    else if (mode === 'tab') h *= 2;
    // 2d-l, 2d-r, anaglyph: w × h unchanged

    // Rotation swaps dimensions.
    if (rot === 90 || rot === 270) return { w: h, h: w };
    return { w, h };
  }

  dispose() {
    const gl = this._gl;
    gl.deleteProgram(this._prog);
    gl.deleteTexture(this._texLeft);
    gl.deleteTexture(this._texRight);
    // Detach canvas from DOM if it was appended.
    this._canvas.remove?.();
  }

  // ---- Internal helpers ----

  _buildProgram() {
    const gl = this._gl;
    const vert = this._compileShader(gl.VERTEX_SHADER,   VERT_SRC);
    const frag = this._compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('GL link error: ' + info);
    }
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return prog;
  }

  _compileShader(type, src) {
    const gl = this._gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('GL compile error: ' + info);
    }
    return sh;
  }

  _collectUniforms() {
    const gl = this._gl;
    const p  = this._prog;
    const names = [
      'uLeft','uRight',
      'uMode','uRotate','uFlipH','uFlipV','uSwapLR',
      'uBrightness','uContrast','uSaturation','uGamma','uHue',
      'uOutSize','uBaseSize',
    ];
    const out = {};
    for (const n of names) {
      out[n] = gl.getUniformLocation(p, n);
    }
    return out;
  }

  // Create a 1×1 transparent texture as placeholder when source is null.
  _makePlaceholderTex() {
    const gl = this._gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    return tex;
  }

  // Upload an ImageBitmap (or null → placeholder 1x1) to the given texture unit.
  _uploadBitmap(unit, tex, bitmap) {
    const gl = this._gl;
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (bitmap) {
      // texImage2D from ImageBitmap; origin is top-left in ImageBitmap.
      // UNPACK_FLIP_Y_WEBGL flips it to match WebGL bottom-left convention.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // we handle orientation in shader
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      // Rebind placeholder data.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
                    gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
}
