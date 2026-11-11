// Bars and Waves - remake of the Windows Media Player visualization built into wmp.dll
// (CLSID {48501FF0-F6A9-11D2-9435-00A0C92A2F2D}). Behavioural port, see re/barswaves/SPEC.md.
// Plain ES2015 script: works in the browser (window.BarsWaves) and in node (module.exports).
//
// The real thing draws straight into a 32-bit DIB the size of the window (no fixed internal resolution,
// no scaling): every frame it clears to the background colour and draws filled rectangles, 1-pixel
// horizontal peak lines and Bresenham lines with its own software rasteriser, then SetDIBitsToDevice.
// This file ports that rasteriser and the per-preset maths exactly (float32 where the original uses floats).
(function (root) {
  'use strict';
  var f32 = Math.fround;

  // ---- level tables, computed (no data copied from any binary) -------------------------------------
  // LEVEL[b]: float power for a level byte, 10^(8*b/255) rounded to float32 and then to 7 significant
  //   digits (the precision of a printed float literal), LEVEL[0] = 0.
  // LOG2 lookup turns a float's bits back into a 0..255 level, 31.875*log10(x):
  //   out = MANT[(bits >> 12) & 0x7ff] + EXP[(bits >> 23) & 0xff]
  // dist/test/tables.test.js checks these are bit-identical to the tables the engine was verified with.
  var LEVEL = new Float32Array(256), MANT = new Int32Array(2048), EXP = new Int32Array(256);
  (function () {
    var k = 31.875, ke = k * Math.LOG10E * Math.LN2, i;
    for (i = 1; i < 256; i++) LEVEL[i] = f32(+f32(Math.pow(10, 8 * i / 255)).toPrecision(7));
    for (i = 0; i < 256; i++) EXP[i] = (ke * (i - 127) + 0.5) | 0;          // C (int) truncation
    for (i = 0; i < 2048; i++) MANT[i] = Math.round(k * Math.log10(1 + i / 2048));
  })();
  var cvF = new Float32Array(1), cvU = new Uint32Array(cvF.buffer);
  function floatBits(x) { cvF[0] = x; return cvU[0]; }

  // constants (addresses in wmp.dll)
  var C_BINHZ = f32(21.513671875);   // 0x180975238  Hz per FFT bin used for the bar edges
  var C_F0 = f32(20);                // 0x1809059a0  first bar edge (Hz)
  var C_RANGE = 1102.5;              // 0x180975178  (double) last edge / first edge = 22050/20
  var C_255 = f32(255);              // 0x180905ffc
  var C_INV256 = f32(0.00390625);    // 0x180974ef0
  var C_1024 = f32(1024);            // 0x180975264
  var C_INV1024 = f32(0.0009765625); // 0x180974ee8
  var C_DOTK = f32(-0.0078125);      // 0x180975270

  // COLORREF (0x00BBGGRR) -> 32-bit DIB pixel (0x00RRGGBB), FUN_180551880
  function conv(c) { return (((c >> 16) & 0xff) + (c & 0xff) * 0x10000 + (c & 0xff00ff00)) >>> 0; }
  // move every channel of a toward b by at most step, FUN_18052cd90
  function fadeToward(a, b, step) {
    function ch(x, y) { if (x < y) return (x + step <= y) ? x + step : y; return (x - step < y) ? y : x - step; }
    var r = ch(a & 0xff, b & 0xff), g = ch((a >> 8) & 0xff, (b >> 8) & 0xff), bl = ch((a >> 16) & 0xff, (b >> 16) & 0xff);
    return ((g & 0xff) << 8 | (bl & 0xff) << 16 | (r & 0xff)) >>> 0;
  }

  // MSVC rand (the harness hooks wmp.dll's _o_rand to the same LCG, seed 1)
  function makeRand(seed) {
    var s = (seed === undefined ? 1 : seed) >>> 0;
    var r = function () { s = (Math.imul(s, 214013) + 2531011) >>> 0; return (s >>> 16) & 0x7fff; };
    r.getState = function () { return s; };
    return r;
  }

  // ---- styles --------------------------------------------------------------------------------------
  // A style = { title, bg, c1, c2 (null = keep), set: { property: value, ... } }. Colours are COLORREF
  // (0x00BBGGRR). Like the original, a style only sets some properties; the rest keep their previous values.
  // The built-in styles below are our own. Classic styles can be supplied at run time (see ../common/classic.js)
  // with Engine.setStyles(list).
  var STYLES = [
    { title: 'Neon Rain',   bg: 0x000000, c1: 0xffd000, c2: 0xff40ff, set: { mode: 1, trail: 0, barWidth: 0, gap: 2, barSpeed: 3, peakHold: 10, showPeaks: true } },
    { title: 'Aurora',      bg: 0x100800, c1: 0x80ff40, c2: 0xffc060, set: { mode: 2, trail: 3, barWidth: 0, gap: 0, barSpeed: 6, fade: 12, peakHold: 0 } },
    { title: 'Lava Lamp',   bg: 0x000010, c1: 0x0040ff, c2: 0x40e0ff, set: { mode: 0, trail: 2, barWidth: 0, gap: 6, barSpeed: 2, fade: 26, peakHold: 20 } },
    { title: 'Ice Columns', bg: 0x200800, c1: 0xffe0c0, c2: 0xff8000, set: { mode: 0, trail: 0, barWidth: 0, gap: 10, barSpeed: 5, peakHold: 30, showPeaks: true } },
    { title: 'Amber Scope', bg: 0x000810, c1: 0x30c0ff, c2: null,     set: { mode: 3, trail: 4, fade: 40 } },
    { title: 'Stardust',    bg: 0x180010, c1: 0xffffff, c2: null,     set: { mode: 4, trail: 1, fade: 30 } }
  ];
  var MODE_BARS = [20, 50, 1024];   // mode 0/1/2 -> bar count asked for; 3 = scope, 4 = dots

  function Engine(opts) {
    opts = opts || {};
    this.rand = opts.rand || makeRand(opts.seed);
    // properties, constructor defaults (FUN_18052bee8)
    this.p = { mode: 1, trail: 0, barAccel: 0, peakAccel: f32(0.2), barSpeed: 5, peakSpeed: 1, scale: 1, barWidth: 0,
               channels: 0, peakHold: 0, showPeaks: true, fade: 20, bg: 0, c1: 0xffff00, c2: 0x0000ff, gap: 1 };
    this.presetIndex = 0;
    this.barV = new Int32Array(1024); this.barS = new Float32Array(1024);                 // +0x600
    this.pkV = new Int32Array(1024); this.pkS = new Float32Array(1024); this.pkH = new Int32Array(1024);   // +0x4600
    this.edges = new Float32Array(1025); this.edgesN = 0;                                  // +0xa61c / +0xa618
    this.ring = new Int32Array(2048 * 16); this.ringIdx = 0; this.ringRows = 0; this.trailOn = false;   // +0xb6b4..
    this.col1 = new Uint32Array(16); this.col2 = new Uint32Array(16); this.bgPix = 0; this.mask = 15;
    this.lastStamp = null; this.frozen = false;
    this.W = 0; this.H = 0; this.mem = null;   // bottom-up rows like the DIB
    this.lv = new Uint8Array(1024); this.lv2 = new Uint8Array(1024);
    this.resetRing();
    if (opts.W && opts.H) this.resize(opts.W, opts.H);
    if (opts.preset !== undefined) this.setPreset(opts.preset);
  }
  var P = Engine.prototype;
  P.presets = STYLES;
  P.setStyles = function (list) { this.presets = list && list.length ? list : STYLES; };

  P.resetRing = function () { this.ring.fill(-1); this.ringRows = 0; this.trailOn = false; };   // FUN_18052d420
  P.buildColors = function () {   // FUN_18052cfcc
    var p = this.p, a = p.c1, b = p.c2;
    for (var k = 0; k < 16; k++) {
      this.col1[k] = conv(a); this.col2[k] = conv(b);
      a = fadeToward(a, p.bg, p.fade); b = fadeToward(b, p.bg, p.fade);
    }
    this.bgPix = conv(p.bg); this.mask = 15;
  };
  P.setPreset = function (i) {   // FUN_18052dac0
    var pr = this.presets[i]; if (!pr) return false;
    this.presetIndex = i;
    this.p.bg = pr.bg; this.p.c1 = pr.c1; if (pr.c2 !== null) this.p.c2 = pr.c2;
    this.barV.fill(0); this.barS.fill(0); this.pkV.fill(0); this.pkS.fill(0); this.pkH.fill(0);
    for (var k in pr.set) this.p[k] = pr.set[k];
    this.resetRing(); this.buildColors();
    return true;
  };
  P.mediaInfo = function (channels) { this.p.channels = channels; };   // MediaInfo (0x18013ce20) stores lChannelCount at +0x5c4
  P.resize = function (W, H) {   // Render: new surface when the rect size changes
    this.W = W; this.H = H; this.mem = new Uint32Array(W * H);
    this.resetRing(); this.buildColors(); this.clear();
  };

  // ---- software rasteriser (FUN_1805515a0, 1805512d4, 180551114, 180550bdc, 18055147c) -------------
  // Coordinates are screen coordinates (y down); memory row = H-1-y.
  P.clear = function () { this.mem.fill(this.bgPix); };
  P.vline = function (x, y0, y1, c) {
    var W = this.W, H = this.H; if (x < 0 || x >= W) return;
    var lo = y0, hi = y1; if (y1 <= y0) { lo = y1; hi = y0; }
    if (lo < 0) lo = 0; if (hi >= H) hi = H - 1; if (hi < lo) return;
    for (var y = lo; y <= hi; y++) this.mem[(H - 1 - y) * W + x] = c;
  };
  P.fillRect = function (x0, y0, x1, y1, c) {
    var W = this.W, H = this.H, xa = x0, xb = x1;
    if (x0 <= x1) { xa = x1; xb = x0; }          // xa = max, xb = min
    var lo = xb < 0 ? 0 : xb, hi = xa < W ? xa : W - 1;
    if (lo < hi) {
      var ya = y0, yb = y1; if (y1 <= y0) { ya = y1; yb = y0; }   // ya = min, yb = max
      var ylo = ya < 0 ? 0 : ya, yhi = yb < H ? yb : H - 1;
      if (yhi < ylo) return;
      for (var y = ylo; y <= yhi; y++) { var o = (H - 1 - y) * W; this.mem.fill(c, o + lo, o + hi + 1); }
    } else if (lo === hi) this.vline(lo, y0, y1, c);
  };
  P.hline = function (x0, x1, y, c) {
    var W = this.W, H = this.H; if (y < 0 || y >= H) return;
    var a = x0, b = x1; if (x0 <= x1) { a = x1; b = x0; }
    var lo = b < 0 ? 0 : b, hi = a < W ? a : W - 1; if (hi < lo) return;
    var o = (H - 1 - y) * W; this.mem.fill(c, o + lo, o + hi + 1);
  };
  P.setPixel = function (x, y, c) {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return;
    this.mem[(this.H - 1 - y) * this.W + x] = c;
  };
  P.line = function (x0, y0, x1, y1, c) {   // FUN_180550bdc, pointer walk on the bottom-up DIB
    var W = this.W, H = this.H, m = this.mem;
    var right = x0, yl = y1, yr = y0, left = x1;
    if (x0 <= x1) { right = x1; yl = y0; yr = y1; left = x0; }
    if (left < 0 || right >= W) return;
    if (yr < yl) { if (yr < 0 || yl >= H) return; } else { if (yl < 0 || yr >= H) return; }
    var stride = W, rowL = H - yl - 1, dx = right - left, dy = (H - yr - rowL) - 1;
    var p = rowL * W + left, end = p + dx + dy * W;
    if (dy < 0) { dy = -dy; stride = -W; }
    var e, t, guard = (dx + dy + 2) * 2;
    if (dy === 0) { if (p <= end) m.fill(c, p, end + 1); }
    else if (dx === 0) { p -= stride; do { p += stride; m[p] = c; } while (p !== end && --guard); }
    else {
      m[p] = c;
      if (dx < dy) {
        e = -dy;
        do { t = dx * 2 + e; p = (t < 1 ? p : p + 1) + stride; m[p] = c; e = t < 1 ? t : t - dy * 2; } while (p !== end && --guard);
      } else {
        e = -dx;
        do { t = dy * 2 + e; p = (t < 1 ? p : p + stride) + 1; m[p] = c; e = t < 1 ? t : t - dx * 2; } while (p !== end && --guard);
      }
    }
  };

  // ---- bars --------------------------------------------------------------------------------------------
  P.buildEdges = function (n) {   // FUN_18052c2b4: n+1 log-spaced edges from 20 Hz up by a factor 1102.5
    var r = f32(Math.exp(Math.log(C_RANGE) / n)), f = C_F0;
    for (var i = 0; i <= n; i++) { this.edges[i] = f; f = f32(f * r); }
  };
  P.binsToBars = function (src, out, n) {   // FUN_18052c3e8: average bin power over each bar's span, back to a byte
    var e = this.edges, rem = f32(1), val = LEVEL[src[0]], bin = 0;
    for (var k = 0; k < n; k++) {
      if (bin > 0x3ff) return;   // (original leaves the rest of its stack buffer untouched)
      var sum = 0, need = f32(f32(e[k + 1] - e[k]) / C_BINHZ);
      if (need > 0) {
        do {
          var take = rem < need ? rem : need;
          rem = f32(rem - take); need = f32(need - take); sum = f32(sum + f32(take * val));
          if (!(rem > 0)) { bin++; if (bin > 0x3ff) break; val = LEVEL[src[bin]]; rem = f32(1); }
        } while (need > 0);
      }
      var bits = floatBits(sum), v = MANT[(bits >>> 12) & 0x7ff] + EXP[(bits >>> 23) & 0xff];
      out[k] = v > 255 ? 255 : v < 0 ? 0 : v;
    }
  };
  P.barFall = function (h, i) {   // FUN_18052c23c (returns the value before this frame's drop)
    var cur = this.barV[i]; if (this.frozen) return cur;
    if (cur < h) { this.barV[i] = h; this.barS[i] = this.p.barSpeed; return h; }
    var s = this.barS[i]; this.barV[i] = cur - (s | 0); this.barS[i] = f32(s + this.p.barAccel);
    return cur < 0 ? 0 : cur;
  };
  P.peakFall = function (h, i) {   // FUN_18052c328
    var cur = this.pkV[i]; if (this.frozen) return cur;
    if (cur < h) {
      this.pkV[i] = h;
      if (h < 1) this.pkS[i] = 0; else { this.pkS[i] = this.p.peakSpeed; this.pkH[i] = 0; }
      return h;
    }
    if (this.p.peakHold < this.pkH[i]) {
      var s = this.pkS[i]; this.pkV[i] = cur - (s | 0); this.pkS[i] = f32(s + this.p.peakAccel);
      return cur < 0 ? 0 : cur;
    }
    this.pkH[i]++; return cur;
  };
  P.drawBar = function (row, x0, x1, h) {   // FUN_18052d1cc, returns the drawn top
    var H = this.H, v = h > 0 ? h : -1, top = v < H - 1 ? v : H - 2;
    if (!this.trailOn) { if (top >= 0) this.fillRect(x0, H - top, x1, H, this.col1[0]); return top; }
    var base = row * 16, u = this.ringIdx, k = 0, done = 0;
    this.ring[base + u] = top;
    do {
      var t = this.ring[base + u];
      if (this.col1[k] === this.bgPix) break;
      if (done <= t) { this.fillRect(x0, H - t, x1, H - done, this.col1[k]); done = t + 1; }
      k++; u = (u + 1) & this.mask;
    } while (u !== this.ringIdx);
    return done - 1;
  };
  P.drawPeak = function (row, x0, x1, pk, barTop) {   // FUN_18052d2f4
    var H = this.H, lo = barTop > 0 ? barTop : 1, v = pk < H ? pk : -1;
    if (!this.trailOn) { if (lo <= v) this.hline(x0, x1, H - v, this.col2[0]); return; }
    var base = row * 16, u = this.ringIdx, ci = this.mask;
    this.ring[base + u] = v;
    do {
      u = (u - 1) & this.mask;
      var c = this.col2[ci], t = this.ring[base + u];
      if (t >= H) { this.ring[base + u] = -1; t = -1; }
      if (c !== this.bgPix && lo <= t) this.hline(x0, x1, H - t, c);
      ci--;
    } while (u !== this.ringIdx);
  };
  P.drawBars = function (lvl, n) {   // FUN_18052c6f8
    var p = this.p, W = this.W, H = this.H, gap = p.gap, bw = p.barWidth;
    if (bw === 0) { bw = ((W - (n - 1) * gap) / n) | 0; if (bw < 1) bw = 1; }
    var count = ((W / (gap + bw)) | 0) + 1; if (n < count) count = n;
    var left = W - (gap + bw) * count, margin = (left < 0 ? 0 : left) >> 1;
    if (this.edgesN !== n) { this.buildEdges(count); this.edgesN = count; }   // sic: compares with n, stores count
    if (count > 0x400) count = 0x400;
    this.binsToBars(lvl.freq[0], this.lv, count);
    var two = p.channels > 1;
    if (two) this.binsToBars(lvl.freq[1], this.lv2, count);
    this.ringRows = count * 2;
    var playing = lvl.state === 2;
    for (var i = 0; i < count; i++) {
      var h = f32(f32(f32(this.lv[i] * H) / C_255) * p.scale) | 0;
      if (h > 0 && playing) h = h + ((this.rand() * 20) / 0x7fff | 0) - 10;
      if (two) {
        var h2 = f32(f32(f32(this.lv2[i] * H) / C_255) * p.scale) | 0;
        if (h2 > 0 && playing) h2 = h2 + ((this.rand() * 20) / 0x7fff | 0) - 10;
        if (h <= h2) h = h2;
      }
      var bar = this.barFall(h, i);
      var x0 = (gap + bw) * i + margin, x1 = (W - 1 <= x0 + bw - 1) ? W - 1 : x0 + bw - 1;
      var top = this.drawBar(2 * i, x0, x1, bar);
      if (p.showPeaks) this.drawPeak(2 * i + 1, x0, x1, this.peakFall(bar, i), top);
    }
  };
  P.drawScope = function (lvl) {   // FUN_18052c9e4
    var W = this.W, H = this.H, wv = lvl.wave[0], c = this.col1[0];
    var m = H <= W ? H : W, base = (H >> 1) - (m >> 2), sc = f32((m >> 1) * C_INV256);
    var prev = (f32(wv[0] * sc) | 0) + base, y;
    if (W < 0) return;
    if (W <= 1024) {
      var acc = 0, step = f32(f32(C_1024 / W) * C_INV1024);
      for (var x = 1; x < W; x++) {
        acc = f32(acc + step);
        y = (f32(wv[f32(acc * C_1024) | 0] * sc) | 0) + base;
        this.line(x - 1, prev, x, y, c); prev = y;
      }
    } else {
      var px = 0;
      for (var i = 1; i < 0x400; i++) {
        var nx = f32(f32(i * C_INV1024) * W) | 0;
        y = (f32(wv[i] * sc) | 0) + base;
        this.line(px, prev, nx, y, c); prev = y; px = nx;
      }
    }
  };
  P.drawDots = function (lvl) {   // FUN_18052c618 (mode 4, not used by the stock presets)
    var W = this.W, H = this.H, wv = lvl.wave[0], n = W < 0x400 ? W : 0x400;
    for (var x = 1; x < n; x++) {
      var y = ((H / 2) | 0) - (f32(f32((wv[x] - 128) * C_DOTK) * (H - 1)) | 0);
      if (y < 0) y = 0; else if (y >= H) y = H - 1;
      this.setPixel(x, y, this.col1[0]);
    }
  };

  // one Render call. lvl = { freq:[Uint8Array(1024) x2], wave:[Uint8Array(1024) x2], state: 2, stamp? }
  P.frame = function (lvl, W, H) {
    if (W !== undefined && (W !== this.W || H !== this.H || !this.mem)) this.resize(W, H);
    if (!this.mem || this.W < 1 || this.H < 1) return;
    if (lvl.state === 0) { this.mem.fill(conv(this.p.bg)); return; }   // stopped: plain background
    if (lvl.state === 1 || (lvl.stamp !== undefined && lvl.stamp === this.lastStamp)) return;   // paused: keep the image
    this.lastStamp = lvl.stamp;
    var p = this.p;   // FUN_18052cbb0
    if (this.H > 1 && p.fade !== 0xff && p.trail !== 0) {
      if (p.trail >= 1 && p.trail <= 4) this.trailStep(p.trail === 4 ? 0 : 1);
    } else this.clear();
    if (p.mode <= 2) this.drawBars(lvl, MODE_BARS[p.mode]);
    else if (p.mode === 3) this.drawScope(lvl);
    else if (p.mode === 4) this.drawDots(lvl);
  };
  P.trailStep = function (drop) {   // FUN_18052cf08: older trail entries sink by `drop` px, ring moves on
    if (drop) {
      var n = this.ringRows * 16, H = this.H, r = this.ring;
      for (var i = 0; i < n; i++) { var v = r[i]; if (v >= 0 && v < H) r[i] = v - drop; }
    }
    this.trailOn = true;
    this.ringIdx = this.mask & (this.ringIdx - 1);
    this.clear();
  };
  // pixels for canvas ImageData (Uint32 RGBA little-endian), top-down
  P.toRGBA = function (out32) {
    var W = this.W, H = this.H, m = this.mem;
    for (var y = 0; y < H; y++) {
      var s = (H - 1 - y) * W, d = y * W;
      for (var x = 0; x < W; x++) { var v = m[s + x]; out32[d + x] = 0xff000000 | (v & 0xff) << 16 | (v & 0xff00) | ((v >>> 16) & 0xff); }
    }
  };
  P.pixel = function (x, y) { return this.mem[(this.H - 1 - y) * this.W + x]; };   // 0x00RRGGBB

  var BarsWaves = { Engine: Engine, STYLES: STYLES, PRESETS: STYLES, _tables: { LEVEL: LEVEL, MANT: MANT, EXP: EXP }, makeRand: makeRand, conv: conv, fadeToward: fadeToward };
  if (typeof module !== 'undefined' && module.exports) module.exports = BarsWaves;
  else root.BarsWaves = BarsWaves;
})(typeof window !== 'undefined' ? window : this);
