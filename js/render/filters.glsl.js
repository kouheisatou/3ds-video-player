// Fragment shader source for all color filters + mode composition.
// Exported as a string so gl.js can inline it without a fetch().

export const FRAG_SRC = /* glsl */`#version 300 es
precision highp float;

uniform sampler2D uLeft;
uniform sampler2D uRight;

// mode: 0=2d-l, 1=2d-r, 2=sbs, 3=tab, 4=anaglyph
uniform int   uMode;

// transform (applied before UV lookup)
uniform int   uRotate;   // 0, 90, 180, 270
uniform bool  uFlipH;
uniform bool  uFlipV;
uniform bool  uSwapLR;

// filter
uniform float uBrightness;  // -100..100
uniform float uContrast;    // -100..100
uniform float uSaturation;  // -100..100
uniform float uGamma;       // 0.5..2.0
uniform float uHue;         // -180..180 degrees

// output canvas size (after rotation)
uniform vec2 uOutSize;
// one-eye base size (before rotation)
uniform vec2 uBaseSize;

out vec4 fragColor;

// ---- UV helpers ----

// Rotate a UV (in [0,1]^2) by degrees around the center.
// We rotate the *source* UV, so the canvas shows a rotated image.
// rotate=90 means the image is rotated 90° CW in the output, so we
// apply the inverse (CCW) rotation to find the source pixel.
vec2 rotateUV(vec2 uv, int deg) {
  // move to [-0.5, 0.5]
  vec2 c = uv - 0.5;
  if (deg == 90) {
    // inverse of CW-90 is CCW-90: (x,y) -> (y,-x)
    c = vec2(c.y, -c.x);
  } else if (deg == 180) {
    c = vec2(-c.x, -c.y);
  } else if (deg == 270) {
    // inverse of CW-270 is CCW-270: (x,y) -> (-y, x)
    c = vec2(-c.y, c.x);
  }
  return c + 0.5;
}

// ---- Color filters ----

vec3 applyBrightness(vec3 col, float b) {
  return col * (1.0 + b / 100.0);
}

vec3 applyContrast(vec3 col, float c) {
  return (col - 0.5) * (1.0 + c / 100.0) + 0.5;
}

vec3 applySaturation(vec3 col, float s) {
  float Y = dot(col, vec3(0.299, 0.587, 0.114));
  return mix(vec3(Y), col, 1.0 + s / 100.0);
}

vec3 applyGamma(vec3 col, float g) {
  // guard against gamma=0 or negative input
  vec3 safe = max(col, vec3(0.0));
  return pow(safe, vec3(1.0 / g));
}

// RGB -> HSV -> shift H -> HSV -> RGB (simple, no branch-heavy HSL)
vec3 applyHue(vec3 col, float hDeg) {
  if (abs(hDeg) < 0.001) return col;
  float h = hDeg / 360.0; // normalise to [0,1) cycle

  // RGB->HSV
  float maxC = max(col.r, max(col.g, col.b));
  float minC = min(col.r, min(col.g, col.b));
  float delta = maxC - minC;

  float hue = 0.0;
  if (delta > 0.0001) {
    if (maxC == col.r)      hue = (col.g - col.b) / delta;
    else if (maxC == col.g) hue = 2.0 + (col.b - col.r) / delta;
    else                    hue = 4.0 + (col.r - col.g) / delta;
    hue /= 6.0;
    if (hue < 0.0) hue += 1.0;
  }
  float sat = (maxC < 0.0001) ? 0.0 : delta / maxC;
  float val = maxC;

  // shift H
  hue = fract(hue + h);

  // HSV->RGB
  float hh = hue * 6.0;
  float i  = floor(hh);
  float f  = hh - i;
  float p  = val * (1.0 - sat);
  float q  = val * (1.0 - sat * f);
  float t  = val * (1.0 - sat * (1.0 - f));
  int   ii = int(i) % 6;
  if      (ii == 0) return vec3(val, t,   p);
  else if (ii == 1) return vec3(q,   val, p);
  else if (ii == 2) return vec3(p,   val, t);
  else if (ii == 3) return vec3(p,   q,   val);
  else if (ii == 4) return vec3(t,   p,   val);
  else              return vec3(val, p,   q);
}

vec3 applyFilters(vec3 col) {
  col = applyBrightness(col, uBrightness);
  col = applyContrast(col, uContrast);
  col = applySaturation(col, uSaturation);
  col = applyGamma(col, uGamma);
  col = applyHue(col, uHue);
  return clamp(col, 0.0, 1.0);
}

// ---- Main ----

void main() {
  // fragCoord is in pixels (0..outSize); convert to [0,1]
  vec2 outUV = gl_FragCoord.xy / uOutSize;
  // WebGL origin is bottom-left; flip Y so UV(0,0) = top-left
  outUV.y = 1.0 - outUV.y;

  // --- determine which eye and local UV within that eye ---
  // "local UV" is the UV inside a single eye's image, after transform.
  // We need to map outUV -> (eye, localUV) -> source texture UV.

  // Output canvas dimensions depend on mode and rotation.
  // We work in the *pre-rotation* output space first:
  // i.e., undo the rotation to get the UV in the logical (pre-rotate) layout.

  // 1. Convert outUV to pre-rotation canvas UV.
  //    The canvas was sized for rotated output, so outUV space has
  //    (outW × outH) where outW/outH swap when rotate=90|270.
  //    We apply the *inverse* rotation (same as rotateUV does above).
  vec2 preRotUV = rotateUV(outUV, uRotate);

  // 2. In pre-rotation space the layout is:
  //    sbs: side by side -> left half = left eye, right half = right eye
  //    tab: top = left, bottom = right
  //    2d-l/2d-r/anaglyph: full canvas = one eye
  //
  // For sbs/tab we extract the per-eye UV here.
  // For anaglyph we sample both eyes at the same UV.

  bool useLeft  = true;
  bool useRight = false;
  vec2 eyeUV    = preRotUV; // UV within the eye image (after flip)

  if (uMode == 2) {
    // sbs: left half / right half
    if (preRotUV.x < 0.5) {
      eyeUV = vec2(preRotUV.x * 2.0, preRotUV.y);
      useLeft = true; useRight = false;
    } else {
      eyeUV = vec2((preRotUV.x - 0.5) * 2.0, preRotUV.y);
      useLeft = false; useRight = true;
    }
  } else if (uMode == 3) {
    // tab: top half / bottom half
    if (preRotUV.y < 0.5) {
      eyeUV = vec2(preRotUV.x, preRotUV.y * 2.0);
      useLeft = true; useRight = false;
    } else {
      eyeUV = vec2(preRotUV.x, (preRotUV.y - 0.5) * 2.0);
      useLeft = false; useRight = true;
    }
  } else if (uMode == 1) {
    // 2d-r
    useLeft = false; useRight = true;
    eyeUV = preRotUV;
  } else {
    // 2d-l or anaglyph: full canvas
    useLeft = true;
    if (uMode == 4) useRight = true;
    eyeUV = preRotUV;
  }

  // 3. Apply flipH / flipV to the per-eye UV.
  if (uFlipH) eyeUV.x = 1.0 - eyeUV.x;
  if (uFlipV) eyeUV.y = 1.0 - eyeUV.y;

  // 4. swapLR: swap which eye's texture is shown in which slot.
  //    In 2d-l/2d-r modes there is only one slot so swap is a no-op.
  //    useLeft/useRight are mutually exclusive for sbs/tab,
  //    both true for anaglyph, one true for 2d-l/2d-r.
  bool wantLeft;  // true  => sample uLeft for this fragment's slot
  if (uSwapLR && (uMode == 2 || uMode == 3)) {
    // Stereo layout: swap textures between slots.
    wantLeft = useRight; // the slot that would show right now shows left
  } else {
    wantLeft = useLeft;
  }

  // 5. Sample textures.
  //    The texture was uploaded with UNPACK_FLIP_Y_WEBGL=false, so texel (s,t)=(0,0)
  //    corresponds to the top-left of the source image — same orientation as eyeUV.
  vec2 texUV = eyeUV;

  if (uMode == 4) {
    // Anaglyph: left eye R + right eye GB, both sampled at the same UV.
    vec3 rawL = texture(uLeft,  texUV).rgb;
    vec3 rawR = texture(uRight, texUV).rgb;
    // swapLR swaps which texture supplies R and which supplies GB.
    vec3 colL = applyFilters(uSwapLR ? rawR : rawL);
    vec3 colR = applyFilters(uSwapLR ? rawL : rawR);
    fragColor = vec4(colL.r, colR.g, colR.b, 1.0);
    return;
  }

  vec4 col = wantLeft ? texture(uLeft, texUV) : texture(uRight, texUV);
  col.rgb = applyFilters(col.rgb);
  fragColor = vec4(col.rgb, 1.0);
}
`;
