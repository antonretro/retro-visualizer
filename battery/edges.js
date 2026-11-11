// Battery remake - the 5 edge classes (draw on the outer 1-2 pixel frame of E.front).
// Spec: re/battery/EDGES_SPEC.md (bit-exact vs wmp.dll). Reference model: re/battery/edges_sim.py.
// Registry dblN = this.dbl[N-1]. All five have mask (+0xe0) = 1 (pre-list only, never a main effect).
var B = (typeof globalThis !== 'undefined' && globalThis.Battery) || require('./engine.js');
(function (B) {
  'use strict';

  // C (int)double via cvttsd2si: truncation; NaN / out of range -> INT_MIN
  function toI32(d) {
    if (!(d > -2147483649 && d < 2147483648)) return -2147483648;
    return Math.trunc(d) | 0;
  }
  var F_09 = Math.fround(0.9);
  var F_TWO_PI = Math.fround(2 * Math.PI);   // 6.2831854820251465

  // 4 inclusive Bresenham lines round the frame = the whole 1-px outer ring set to c (spec 0.4)
  function solidBorder(E, c) {
    var W = E.W, H = E.H, f = E.front, x, y, last = (H - 1) * W;
    for (x = 0; x < W; x++) { f[x] = c; f[last + x] = c; }
    for (y = 0; y < H; y++) { f[y * W] = c; f[y * W + W - 1] = c; }
  }

  // ---- 1. CSpectrumEdge: colour = moving average of low bins ----
  class CSpectrumEdge extends B.Drawer {
    constructor(E) {
      super();
      this.className = 'CSpectrumEdge'; this.mask = 1;
      this.hist = new Int32Array(16); this.idx = 0;
    }
    randomizeParams(E) {
      this.dbl[0] = E.rand() % 10;
      this.dbl[1] = (E.rand() % 10) * 2 + 2;
      this.dbl[2] = E.rand() % 11 + 4;
    }
    render(audio, E) {
      var d0 = this.dbl[0], d1 = this.dbl[1], d2 = this.dbl[2];
      // (int) compared with Math.trunc semantics; L in (0,1) would divide by zero natively -> skip
      if (!(d1 !== 0 && d2 > 0 && Math.trunc(d2) < 16 && Math.trunc(d1) < 1023)) return;
      var L = toI32(d2);
      if (L === 0) return;
      var fl = audio.freq[0], fr = audio.freq[1], h = this.hist;
      this.idx = (this.idx + 1) % L;
      var acc = 0, i = 0;
      do { acc += fl[i] + fr[i + 1]; i += 2; } while (i < d1);
      h[this.idx] = acc;
      var sum = 0, k = 0;
      do { sum += h[k]; k = (k + 1) & 255; } while (k < d2);
      var v = toI32(sum / (d2 * d1)) & 255;
      var c;
      if (d0 === 0) c = 255 - v;
      else if (d0 > 5.0) c = toI32(Math.fround(Math.fround(v) * F_09)) & 255;
      else c = v;
      solidBorder(E, c);
    }
  }

  // ---- 2. CEdgeGradiant: triangle-wave colour, no audio, no params ----
  class CEdgeGradiant extends B.Drawer {
    constructor(E) { super(); this.className = 'CEdgeGradiant'; this.mask = 1; this.c = 0; this.step = 1; }
    randomizeParams(E) {}                 // ret stub, no rand()
    render(audio, E) {
      if ((this.c >>> 0) > 255) this.step = -this.step;
      this.c = (this.c + this.step) | 0;
      solidBorder(E, this.c & 255);
    }
  }

  // ---- 3. CEdgeTrace: marching ants clockwise round the border ----
  class CEdgeTrace extends B.Drawer {
    constructor(E) { super(); this.className = 'CEdgeTrace'; this.mask = 1; this.dbl[0] = 50.0; this.s = 0; }
    randomizeParams(E) { this.dbl[0] = E.rand() % 30 + 35; }
    render(audio, E) {
      var d = toI32(this.dbl[0]);
      if (d < 1) return;                  // native would divide by zero / loop forever
      var W = E.W, H = E.H, f = E.front;
      var r0 = 0, r1 = W, rH1 = (H - 1) * W, rH2 = (H - 2) * W;
      var p = (this.s + 1) % d + 3;
      if (p < 4) p = 3;
      this.s = p;
      for (; p < W - 4; p += d) {
        f[r0 + p - 3] = 0xF5; f[r0 + p - 2] = 0xFF; f[r0 + p - 1] = 0xFF; f[r0 + p] = 0xF5;
        f[r1 + p - 2] = 0xF5; f[r1 + p - 1] = 0xF5;
      }
      p -= W; if (p < 3) p += d;
      for (; p < H - 4; p += d) {
        f[(p - 3) * W + W - 1] = 0xF5; f[(p - 2) * W + W - 1] = 0xFF; f[(p - 1) * W + W - 1] = 0xFF; f[p * W + W - 1] = 0xF5;
        f[(p - 2) * W + W - 2] = 0xF5; f[(p - 1) * W + W - 2] = 0xF5;
      }
      p -= H; if (p < 3) p += d;
      for (; p < W - 4; p += d) {
        var q = W - p;
        f[rH1 + q - 3] = 0xF5; f[rH1 + q - 2] = 0xFF; f[rH1 + q - 1] = 0xFF; f[rH1 + q] = 0xF5;
        f[rH2 + q - 2] = 0xF5; f[rH2 + q - 1] = 0xF5;
      }
      p -= W; if (p < 3) p += d;
      for (; p < H - 4; p += d) {
        var r = H - p;
        f[(r - 3) * W] = 0xF5; f[(r - 2) * W] = 0xFF; f[(r - 1) * W] = 0xFF; f[r * W] = 0xF5;
        f[(r - 2) * W + 1] = 0xF5; f[(r - 1) * W + 1] = 0xF5;
      }
    }
  }

  // ---- 4. CCosEdgeGradiant: colour = cos(phase), phase resets after 2*pi ----
  class CCosEdgeGradiant extends B.Drawer {
    constructor(E) { super(); this.className = 'CCosEdgeGradiant'; this.mask = 1; this.phase = 0.0; }
    randomizeParams(E) {
      this.dbl[0] = Math.fround(Math.fround(E.rand() / 32767) * Math.fround(0.09));
    }
    render(audio, E) {
      this.phase += this.dbl[0];
      if (this.phase > F_TWO_PI) this.phase = 0.0;
      solidBorder(E, toI32(Math.cos(this.phase) * 253.0 + 1.0) & 255);
    }
  }

  // ---- 5. CWaveEdge: raw audio bytes on the 4 sides ----
  class CWaveEdge extends B.Drawer {
    constructor(E) { super(); this.className = 'CWaveEdge'; this.mask = 1; }
    randomizeParams(E) { this.dbl[0] = E.rand() % 2; }
    render(audio, E) {
      var src = this.dbl[0] !== 0 ? audio.freq : audio.wave, A = src[0], Bs = src[1];
      var W = E.W, H = E.H, f = E.front, last = (H - 1) * W, x, y;
      for (x = 0; x < W - 1; x++) { f[x] = A[x & 1023]; f[last + x] = Bs[x & 1023]; }
      for (y = 0; y < H - 1; y++) { f[y * W] = A[y & 1023]; f[y * W + W - 1] = Bs[y & 1023]; }
    }
  }

  B.register('CSpectrumEdge', CSpectrumEdge);
  B.register('CEdgeGradiant', CEdgeGradiant);
  B.register('CEdgeTrace', CEdgeTrace);
  B.register('CCosEdgeGradiant', CCosEdgeGradiant);
  B.register('CWaveEdge', CWaveEdge);
})(B);
