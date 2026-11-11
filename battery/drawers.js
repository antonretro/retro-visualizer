// Battery remake - drawer classes (pre/post effects that paint into E.front).
// Spec: re/battery/DRAWERS_SPEC.md. CCircleWaveform, CJDar, CJiggyScribble verified pixel-exact against
// wmp.dll; CDotPlane near-exact (float32 rounding); CGalaxy ported from the disassembly (see notes there).
// Plain script (ES2015): needs engine.js loaded first in the browser; in node it requires ./engine.js.
var B = (typeof globalThis !== 'undefined' && globalThis.Battery) || require('./engine.js');
(function (B) {
  'use strict';
  var f32 = Math.fround;
  // wmp.dll calls ucrtbase sin/cos/atan2; V8's Math.* differ by 1 ulp on a few % of inputs, which moves pixels.
  // shifts.js provides bit-exact ports as Battery.ucrt (page order: engine, shifts, edges, drawers).
  if (!B.ucrt && typeof require === 'function') { try { require('./shifts.js'); } catch (e) { /* fall back to Math */ } }
  // register forms of the exact sin/cos/atan2 (result in FRD[0], no boxed double per call); Math fallback
  var UR = B.ucrtR || { FR: new Float64Array(1), FX: new Float64Array(2), sin: function () { UR.FR[0] = Math.sin(UR.FX[0]); },
    cos: function () { UR.FR[0] = Math.cos(UR.FX[0]); }, atan2: function () { UR.FR[0] = Math.atan2(UR.FX[0], UR.FX[1]); } };
  var FRD = UR.FR, FXD = UR.FX, SINR = UR.sin, COSR = UR.cos, ATAN2R = UR.atan2;
  var PI_F = f32(3.1415927);          // float pi, also used widened to double
  var TWO_PI_F = f32(6.2831855);      // float 2pi; as a double = 6.283185482025146
  var INV256 = f32(1 / 256);

  // C cvttsd2si / cvttss2si: truncate toward zero, out of range -> INT_MIN
  function ti(x) { return (x < 2147483648 && x > -2147483649) ? (x | 0) : -2147483648; }

  // TimedLevel as one flat 4096-byte array: freq0 | freq1 | wave0 | wave1 (T[i] in the spec)
  function tlBytes(audio) {
    if (audio.tl) return audio.tl;
    var t = new Uint8Array(4096);
    t.set(audio.freq[0], 0); t.set(audio.freq[1], 1024); t.set(audio.wave[0], 2048); t.set(audio.wave[1], 3072);
    return t;
  }

  // FUN_180523328 -> FUN_180523750: endpoints clamped (not clipped), Bresenham, plain set
  function line(E, x0, y0, x1, y1, c) {
    var w = E.W, h = E.H, buf = E.front;
    x0 = x0 < 0 ? 0 : (x0 >= w ? w - 1 : x0); y0 = y0 < 0 ? 0 : (y0 >= h ? h - 1 : y0);
    x1 = x1 < 0 ? 0 : (x1 >= w ? w - 1 : x1); y1 = y1 < 0 ? 0 : (y1 >= h ? h - 1 : y1);
    c &= 255;
    var dx = x1 - x0, sx = dx >= 0 ? 1 : -1, adx = dx >= 0 ? dx : -dx;
    var dy = y1 - y0, sy = dy >= 0 ? w : -w, ady = dy >= 0 ? dy : -dy;
    var p = y0 * w + x0, e = 0, n;
    if (ady < adx) {
      for (n = adx + 1; n > 0; n--) { buf[p] = c; e += ady; p += sx; if (e > adx) { e -= adx; p += sy; } }
    } else {
      for (n = ady + 1; n > 0; n--) { buf[p] = c; e += adx; p += sy; if (e > ady) { e -= ady; p += sx; } }
    }
  }
  function plot(E, x, y, c) { if (x >= 0 && x < E.W && y >= 0 && y < E.H) E.front[y * E.W + x] = c & 255; }

  // FUN_1805233a8: spiral arc P0 -> P1 curling around focus F, n steps, colour ramp c0 -> c1 (bytes).
  // mode = dt wrap rule (0: if dt >= pi then dt = -(2pi - dt)); all callers here use 0.
  // CJDar inlines the same code with n = 100, c1 = 255.
  // the focus point (fx, fy) is passed in SAF[0], SAF[1] (doubles passed as call arguments would be boxed)
  var SAF = new Float64Array(2);
  function spiralArc(E, x0, y0, x1, y1, n, c0, c1, lines) {
    var fx = SAF[0], fy = SAF[1], tq = 0;   // tq: inline ti() (a call with a double argument would box it)
    if (n === 0) return;
    var d0x = (x0 - fx) | 0, d0y = (y0 - fy) | 0, d1x = (x1 - fx) | 0, d1y = (y1 - fy) | 0;
    var dc = ((c1 - c0) | 0) / n, c = c0;
    var r0 = Math.sqrt((Math.imul(d0x, d0x) + Math.imul(d0y, d0y)) | 0);
    var r1 = Math.sqrt((Math.imul(d1x, d1x) + Math.imul(d1y, d1y)) | 0);
    var dr = r1 - r0;
    var t0 = d0x !== 0 ? (FXD[0] = d0y, FXD[1] = d0x, ATAN2R(), FRD[0]) : 0, t1 = d1x !== 0 ? (FXD[0] = d1y, FXD[1] = d1x, ATAN2R(), FRD[0]) : 0;
    if (t0 < 0) t0 += TWO_PI_F;
    if (t1 < 0) t1 += TWO_PI_F;
    var dt = t1 - t0;
    if (dt >= PI_F) dt = -(TWO_PI_F - dt);
    var du = f32(PI_F / f32(f32(n) + f32(n)));
    dt /= n;
    var u = 0, th = t0, qx = x0, qy = y0;
    for (var k = 0; k < n; k++) {
      var rr = (FXD[0] = u, SINR(), FRD[0]) * dr + r0;
      var X = ((tq = (FXD[0] = th, COSR(), FRD[0]) * rr + fx) < 2147483648 && tq > -2147483649 ? (tq | 0) : -2147483648), Y = ((tq = (FXD[0] = th, SINR(), FRD[0]) * rr + fy) < 2147483648 && tq > -2147483649 ? (tq | 0) : -2147483648);
      if (lines) { line(E, qx, qy, X, Y, ((tq = c) < 2147483648 && tq > -2147483649 ? (tq | 0) : -2147483648)); qx = X; qy = Y; }
      else plot(E, X, Y, ((tq = c) < 2147483648 && tq > -2147483649 ? (tq | 0) : -2147483648));
      u += du; th += dt; c += dc;
    }
  }

  // FUN_180528a3c: bouncing point (CJDar, CGalaxy). Floats are float32.
  function Bouncer() {
    this.x = 0; this.y = 0; this.minX = 0; this.minY = 0; this.maxX = 512; this.maxY = 352;
    this.bw = 40; this.bh = 40; this.vx = 0; this.vy = 0; this.px = 0; this.py = 0;
  }
  Bouncer.prototype.step = function (s) {
    var vx = this.vx, vy = this.vy;
    var px = f32(f32(vx * s) + this.px), py = f32(f32(vy * s) + this.py);
    var x = ti(px), y = ti(py);
    this.px = px; this.py = py; this.x = x; this.y = y;
    if ((this.maxX <= this.bw + x && vx > 0) || (x <= this.minX && vx < 0)) this.vx = -vx;
    if ((y <= this.minY && vy < 0) || (this.maxY <= this.bh + y && vy > 0)) this.vy = -vy;
  };

  function rnd01(E) { return f32(E.rand() / f32(32767)); }   // (float)rand() / 32767.0f

  // ---------------------------------------------------------------- CCircleWaveform
  class CCircleWaveform extends B.Drawer {
    constructor(E) {
      super(); this.className = 'CCircleWaveform'; this.mask = 2;
      this.base = 20; this.spin = 0; this.dbl[1] = 1.0;
      this._cL = 0; this._cR = 0;
    }
    randomizeParams(E) {
      var r1 = E.rand(), r2 = E.rand(), r3 = E.rand();
      this.dbl[0] = r3 % 4;
      this.dbl[1] = (2 - (r1 % 5 !== 0 ? 1 : 0)) + (r2 % 5 === 0 ? 1 : 0);
      this.dbl[2] = f32(f32(rnd01(E) * f32(0.6)) + f32(0.05));
    }
    render(audio, E) {
      var T = tlBytes(audio), W = E.W, H = E.H, d = this.dbl;
      var Rb = f32(ti(f32(f32(f32(T[0]) * INV256) * f32(H >> 1))));
      var cnt = ti(d[1]), base = f32(this.base), cL = this._cL, cR = this._cR;
      for (var k = 0; k < cnt; k++) {
        var cx = W >> 1, cy = H >> 1;
        if (cnt > 1) {
          var a = f32(f32(f32(TWO_PI_F / f32(d[1])) * f32(k)) + this.spin), rr = f32(W >> 3);
          cx += ti(f32(f32((FXD[0] = a, COSR(), FRD[0])) * rr)); cy += ti(f32(f32((FXD[0] = a, SINR(), FRD[0])) * rr));
        }
        var n;
        if (d[2] > 1.0) { n = 1024; d[2] = 1.0; } else { n = ti(d[2] * 1024); if (n <= 0) continue; }
        var fn = f32(n), mode = ti(d[0]), plx = 0, ply = 0, prx = 0, pry = 0;
        for (var i = 0; i < n; i++) {
          var L = T[2048 + i], R = T[3072 + i], fi = f32(f32(i) / fn);
          var ang = f32(fi * PI_F), ca = f32((FXD[0] = ang, COSR(), FRD[0])), sa = f32((FXD[0] = ang, SINR(), FRD[0]));
          if (mode === 0) { cL = (Math.abs(L - 128) * 2) & 255; cR = (Math.abs(R - 128) * 2) & 255; }
          else if (mode === 1) { cL = L; cR = R; }
          else if (mode === 2) { cL = cR = 255; }
          else if (mode === 3) {
            var v = ti(f32(fi * f32(768))); cL = v & 255;
            if (((v / 256) | 0) & 1) cL = (~v) & 255;
            cR = cL;
          }                                        // other modes: colours keep their previous values
          var rL = f32(f32(Rb * f32(f32(L) * INV256)) + base);
          var xL = cx + ti(f32(ca * rL)), yL = cy + ti(f32(sa * rL));
          if (i) line(E, plx, ply, xL, yL, cL);
          plx = xL; ply = yL;
          var rR = f32(f32(Rb * f32(f32(R) * INV256)) + base);
          var xR = cx + ti(f32(ca * rR)), yR = cy - ti(f32(sa * rR));
          if (i) line(E, prx, pry, xR, yR, cR);
          prx = xR; pry = yR;
        }
      }
      this._cL = cL; this._cR = cR;
      this.spin = f32(this.spin + f32(0.049087387));
    }
  }

  // ---------------------------------------------------------------- CJDar
  class CJDar extends B.Drawer {
    constructor(E) {
      super(); this.className = 'CJDar'; this.mask = 2;
      this.dbl[1] = 1.0; this.dbl[6] = 100.0;
      this.cb = 0; this.angle = 0; this.toggle = 0; this.b = new Bouncer();
      if (E && E.rand) {
        this.cb = E.rand() % 256;
        this.angle = f32(rnd01(E) * PI_F);
        this._randState(E);
      }
    }
    _randState(E) {
      var y = E.rand() % 200, x = E.rand() % 200;
      this.b.y = y; this.b.py = y; this.b.x = x; this.b.px = x;
      this.b.vy = rnd01(E); this.b.vx = rnd01(E);
    }
    randomizeParams(E) {
      var d = this.dbl;
      d[0] = E.rand() % 100 + 5;
      d[1] = E.rand() % 4;
      d[2] = E.rand() % 2;
      d[3] = f32(Math.pow(2, E.rand() % 4 + 2));
      d[4] = f32(f32(rnd01(E) * f32(1.5)) + f32(0.3));
      d[5] = E.rand() % 2;
      d[6] = E.rand() % 95 + 5;
      this.cb = E.rand() % 256;
      this._randState(E);
    }
    render(audio, E) {
      var d = this.dbl;
      if (d[3] === 0) return;
      var T = tlBytes(audio), W = E.W, H = E.H, N = ti(d[3]), b = this.b;
      b.step(f32(6));
      var s = f32(f32(T[0x400] + T[1] + T[0]) / f32(9000));
      this.cb = (this.cb - ti(s * -6.0)) & 255;
      this.angle += s;
      if (this.angle > TWO_PI_F) this.angle -= TWO_PI_F;
      var cx = W >> 1, cy = H >> 1;
      var r10 = E.rand() % (W >> 1);
      var total = 0, k;
      for (k = 0; k < 512; k++) total += T[0x401 + 2 * k] + T[2 * k];
      if (total === 0) return;
      var M = (1024 / N) | 0;
      if (M === 0) return;
      var Mf = f32(M * 255), lines = d[5] === 0, mirror = d[2] === 0, mode = ti(d[1]);
      var cum = 0, off = 0, qx = cx, qy = cy;
      for (var i = 0; i < N; i++) {
        var sum = 0;
        if (M > 1) { var p = 0x400 - off; for (k = ((M - 2) >> 1) + 1; k > 0; k--) { sum += T[p]; sum += T[p + 0x3ff]; p -= 2; } }
        cum = (cum + ti(sum)) | 0;
        var r = sum / Mf * d[4];
        var rad = cum * r10 / total;
        if (mode === 0) { if ((i & 1) === 0) r = -r; }
        else if (mode === 1) { this.toggle = (this.toggle + 1) % 2; if (this.toggle === 0) r = -r; }
        else if (E.rand() % 2 === 1) r = -r;
        var a = this.angle + r;
        var X = cx + ti((FXD[0] = a, COSR(), FRD[0]) * rad), Y = cy + ti((FXD[0] = a, SINR(), FRD[0]) * rad);
        SAF[0] = b.x; SAF[1] = b.y; spiralArc(E, qx, qy, X, Y, 100, this.cb, 255, lines);
        if (mirror) { SAF[0] = W - b.x; SAF[1] = H - b.y; spiralArc(E, W - qx, H - qy, W - X, H - Y, 100, this.cb, 255, lines); }
        off += M; qx = X; qy = Y;
      }
    }
  }

  // ---------------------------------------------------------------- CJiggyScribble
  // one point of the scribble -> JP[0], JP[1] (a plain function writing to a Float64Array: no closure, no boxing)
  var JP = new Float64Array(2);
  function jigPt(t, A, r0, kk, phase, cx, cy) {
    var X = (FXD[0] = t, COSR(), FRD[0]) * A + (FXD[0] = t * kk, COSR(), FRD[0]) * r0, Y = (FXD[0] = t, SINR(), FRD[0]) * A + (FXD[0] = t * kk, SINR(), FRD[0]) * r0;
    var r = Math.sqrt(X * X + Y * Y), th = (FXD[0] = X, FXD[1] = Y, ATAN2R(), FRD[0]) + phase;
    JP[0] = (FXD[0] = th, COSR(), FRD[0]) * r + cx; JP[1] = (FXD[0] = th, SINR(), FRD[0]) * r + cy;
  }
  class CJiggyScribble extends B.Drawer {
    constructor(E) { super(); this.className = 'CJiggyScribble'; this.mask = 2; this.phase = 0; }
    randomizeParams(E) {
      var d = this.dbl;
      d[0] = E.rand() % 100 + 4;
      d[1] = E.rand() % 200 + 40;
      d[2] = E.rand() % 1000 + 300;
      d[3] = E.rand() % 20 + 1;
      d[4] = f32(f32(rnd01(E) * f32(0.6)) + f32(0.05));
      d[5] = E.rand() % 10;
      d[6] = E.rand() % 10;
    }
    render(audio, E) {
      var T = tlBytes(audio), d = this.dbl, W = E.W, H = E.H, buf = E.front;
      var lines = d[6] === 9.0, dt = d[2] === 0 ? 0 : TWO_PI_F / d[2];
      this.phase += d[4];
      if (this.phase > TWO_PI_F) this.phase -= TWO_PI_F;
      var phase = this.phase, r0 = d[0], kk = d[3];
      var A = (T[0x403] + T[0x405] + T[0x401] + T[4] + T[2] + T[0]) / 1530.0 * (d[1] - d[0]);
      var cx = W >> 1, cy = H >> 1, px = 0, py = 0, x, y;
      if (lines) { jigPt(0, A, r0, kk, phase, cx, cy); px = x = JP[0]; py = y = JP[1]; }
      var t = 0, n = ti(d[2]);
      for (var i = 0; i < n; i++) {
        jigPt(t, A, r0, kk, phase, cx, cy); x = JP[0]; y = JP[1];
        if (lines) { line(E, ti(px), ti(py), ti(x), ti(y), 255); px = x; py = y; }
        else if (x >= 0 && y >= 0 && x < W && y < H) buf[ti(y) * W + ti(x)] = 255;
        t += dt;
      }
    }
  }

  // ---------------------------------------------------------------- CDotPlane
  // 4x4 float32 matrices, row-vector convention, flat row-major Float32Array(16).
  function mmul(a, b, o) {   // FUN_180528d40: a.b, each entry ((a0b0 + a1b1) + a2b2) + a3b3 in float32
    o = o || new Float32Array(16);   // o must not alias a or b
    for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
      var r = i * 4;
      o[r + j] = f32(f32(f32(f32(a[r] * b[j]) + f32(a[r + 1] * b[4 + j])) + f32(a[r + 2] * b[8 + j])) + f32(a[r + 3] * b[12 + j]));
    }
    return o;
  }
  function ident() { var m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
  function norm3(v) {        // FUN_18052b92c
    var l = f32(Math.sqrt(f32(f32(f32(v[0] * v[0]) + f32(v[1] * v[1])) + f32(v[2] * v[2]))));
    if (l > 0) { v[0] = f32(v[0] / l); v[1] = f32(v[1] / l); v[2] = f32(v[2] / l); }
    return v;
  }
  function dot3(a, b) { return f32(f32(f32(a[0] * b[0]) + f32(a[1] * b[1])) + f32(a[2] * b[2])); }

  class CDotPlane extends B.Drawer {
    constructor(E) {
      super(); this.className = 'CDotPlane'; this.mask = 2;
      this.g = new Float32Array(50 * 50 * 5);    // {x, y, z, w, vel}
      this.head = 0; this.gravity = f32(0.01); this.vel0 = 0;
      this.D = 1; this.f = new Float32Array(3); this.C = ident(); this.T = ident(); this.M = ident();
      this.cw = 0; this.ch = 0; this.tDirty = false;
      this._Rb = [ident(), ident(), ident()]; this._SA = ident(); this._SB = ident(); this._Mb = ident();
      this._resetRot();
    }
    _resetRot() {            // FUN_1805294fc
      this.cnt = [0, 0, 0]; this.R = [ident(), ident(), ident()];
      this.T = ident(); this.M = ident();
    }
    randomizeParams(E) {
      this._resetRot(); this.cw = 0; this.ch = 0;
      var d = this.dbl;
      d[0] = E.rand() % 28 + 20;
      var r2 = E.rand(), r3 = E.rand(), r4 = E.rand();
      d[1] = (r2 % 4 === 0 ? 1 : 0) | (r3 % 4 === 0 ? 2 : 0) | (r4 % 4 === 0 ? 4 : 0);
    }
    reset(E) { if (E) this._resize(E.W, E.H); }
    key(ch) {                 // slot 5: 'D' moves the camera away, 'd' closer
      if (ch === 'D' || ch === 0x44) this.D = f32(this.D + 1);
      else if (ch === 'd' || ch === 0x64) this.D = f32(this.D - 1);
      else return;
      this.dbl[3] = this.D; this.tDirty = true;
    }
    _resize(W, H) {
      if (W === this.cw && H === this.ch) return;
      this.cw = W; this.ch = H;
      this.D = f32(f32(W) * f32(0.6)); this.dbl[3] = this.D;
      this._camera([f32((W / 2) | 0), f32((H / 2) | 0), f32((H / 2) | 0)], W, H);
      this.tDirty = true;
    }
    _camera(eye, W, H) {      // FUN_18052b9bc, target = origin, up = (0,1,0), near n = -1, fov = 60 deg
      var up = [0, 1, 0], f = norm3([eye[0], eye[1], eye[2]]);
      var du = dot3(f, up);
      var u = norm3([f32(up[0] - f32(f[0] * du)), f32(up[1] - f32(f[1] * du)), f32(up[2] - f32(f[2] * du))]);
      var r = norm3([f32(f32(u[2] * f[1]) - f32(u[1] * f[2])), f32(f32(u[0] * f[2]) - f32(u[2] * f[0])), f32(f32(u[1] * f[0]) - f32(u[0] * f[1]))]);
      this.f = Float32Array.from(f);
      var V = new Float32Array([r[0], u[0], f[0], 0, r[1], u[1], f[1], 0, r[2], u[2], f[2], 0, -dot3(eye, r), -dot3(eye, u), -dot3(eye, f), 1]);
      var n = f32(-1), K = f32(1000), m = f32(Math.min(W, H));
      var t = f32(f32(Math.tan(f32(f32(1.0471976) * f32(0.5)))) * n), nt = -t, fa = f32(n + f32(0.01)), mm = f32(0 - m);
      var P = new Float32Array(16);
      P[0] = nt !== t ? f32(mm / f32(nt - t)) : 1;
      P[5] = t !== nt ? f32(mm / f32(t - nt)) : 1;
      var q = f32(f32(n * n) * f32(K - fa));
      P[10] = q !== 0 ? f32(f32(f32(n - fa) * f32(n - K)) / q) : 1;
      P[12] = P[13] = nt !== t ? f32(f32(f32(m * nt) - f32(t * 0)) / f32(nt - t)) : 1;
      q = f32(f32(fa - K) * n);
      P[14] = q !== 0 ? f32(f32(f32(n - K) * fa) / q) : 1;
      P[15] = 1;
      var L = ident(); L[11] = f32(f32(-1) / n);
      this.C = mmul(V, mmul(L, P));
    }
    render(audio, E) {
      var W = E.W, H = E.H, d = this.dbl, g = this.g;
      this._resize(W, H);
      var T = tlBytes(audio), state = audio.state | 0;
      var N = ti(d[0]), c, e, k;
      if (state !== 1) {                         // grid update (FUN_1805295ec)
        k = 1;
        var zf = -f32(f32(N) * f32(0.5));
        for (c = 0; c < N; c++) {
          var fk = f32(f32(k) * f32(1.096));
          e = (this.head * 50 + c) * 5;
          var a0 = T[k], a1 = T[0x400 + k], v = f32((a0 > a1 ? a0 : a1) >> 2);
          g[e] = c - ((N / 2) | 0); g[e + 1] = f32(f32(v * f32(0.015)) * v); g[e + 2] = zf; g[e + 3] = 1; g[e + 4] = this.vel0;
          k = k < ti(fk) ? ti(fk) : k + 1;
        }
        this.head++;
        if (this.head >= N) this.head -= N;
        var row = this.head;
        for (var j = 0; j < N - 1; j++) {
          if (row >= N) row -= N;
          for (c = 0; c < N; c++) {
            e = (row * 50 + c) * 5;
            g[e + 2] = f32(g[e + 2] + 1);
            if (g[e + 1] > 0) {
              var y = f32(g[e + 1] - g[e + 4]);
              g[e + 1] = y < 0 ? 0 : y;
              g[e + 4] = f32(g[e + 4] + this.gravity);
            }
          }
          row++;
        }
      }
      var flags = ti(d[1]);
      for (var ax = 0; ax < 3; ax++) {
        if (!((flags >> ax) & 1)) continue;
        var cn = ++this.cnt[ax], a = f32(f32(f32(cn) * TWO_PI_F) / f32(300));
        var co = f32((FXD[0] = a, COSR(), FRD[0])), si = f32((FXD[0] = a, SINR(), FRD[0])), Rm = this._Rb[ax];
        Rm.fill(0); Rm[0] = Rm[5] = Rm[10] = Rm[15] = 1;
        if (ax === 0) { Rm[5] = co; Rm[6] = -si; Rm[9] = si; Rm[10] = co; }
        else if (ax === 1) { Rm[0] = co; Rm[2] = -si; Rm[8] = si; Rm[10] = co; }
        else { Rm[0] = co; Rm[1] = -si; Rm[4] = si; Rm[5] = co; }
        this.R[ax] = Rm;
        if (cn === 300) this.cnt[ax] = 0;
      }
      if (this.tDirty) {
        this.T = ident(); this.T[12] = f32(this.D * this.f[0]); this.T[13] = f32(this.D * this.f[1]); this.T[14] = f32(this.D * this.f[2]);
        this.tDirty = false;
      }
      var SA = this._SA, SB = this._SB;   // scratch matrices: no allocation per frame
      mmul(this.R[0], this.R[1], SA); mmul(SA, this.R[2], SB); mmul(SB, this.T, SA);
      var M = this.M = mmul(SA, this.C, this._Mb);
      var buf = E.front, xoff = H < W ? (W - H) >> 1 : 0;
      for (var rr = 0; rr < N; rr++) for (c = 0; c < N; c++) {
        e = (rr * 50 + c) * 5;
        var x = g[e], yy = g[e + 1], z = g[e + 2], w = g[e + 3];
        var ow = f32(f32(f32(f32(x * M[3]) + f32(yy * M[7])) + f32(z * M[11])) + f32(w * M[15]));
        if (ow < 0) {
          var ox = f32(f32(f32(f32(x * M[0]) + f32(yy * M[4])) + f32(z * M[8])) + f32(w * M[12]));
          var oy = f32(f32(f32(f32(x * M[1]) + f32(yy * M[5])) + f32(z * M[9])) + f32(w * M[13]));
          var sx = ti(f32(ox / ow)) + xoff, sy = ti(f32(oy / ow));
          if (sx >= 0 && sx < W && sy >= 0 && sy < H) buf[sy * W + sx] = 0xfe;
        }
      }
    }
  }

  // ---------------------------------------------------------------- CGalaxy
  // Not used by any preset. Ported from the wmp.dll disassembly (180527660 / 1805260d8 / 1805233a8).
  class CGalaxy extends B.Drawer {
    constructor(E) {
      super(); this.className = 'CGalaxy'; this.mask = 2;
      this.rot = 0; this.b = new Bouncer();
      if (E && E.rand) { this.b.vy = f32(rnd01(E) * f32(5.6)); this.b.vx = f32(rnd01(E) * f32(5.6)); }
    }
    randomizeParams(E) {
      var d = this.dbl, b = this.b;
      d[0] = E.rand() % 5 + 1;
      d[1] = (E.rand() % 4 === 0) ? E.rand() % 100 + 9 : E.rand() % 20 + 10;
      d[2] = d[0] !== 0 ? f32(f32(rnd01(E) * f32(0.4)) + f32(0.05)) / d[0] : f32(0.1);
      d[3] = E.rand() % 56 + 200;
      d[4] = E.rand() % 10;
      d[5] = E.rand() % 150;
      d[6] = f32(rnd01(E) * f32(6e-7));
      d[7] = f32(rnd01(E) * f32(0.3));
      var x = 0, y = 0;
      if (d[5] < 3) { y = E.rand() % 200; x = E.rand() % 200; }
      b.x = x; b.y = y; b.px = x; b.py = y;
      b.vy = f32(rnd01(E) * f32(5.6)); b.vx = f32(rnd01(E) * f32(5.6));
    }
    render(audio, E) {
      var T = tlBytes(audio), d = this.dbl, b = this.b, W = E.W, H = E.H;
      var lvl = (T[0x401] + T[0x405] + T[0x403] + T[0] + T[2] + T[4]) / 1530;
      if (d[5] < 2) {                            // centre physics + bouncer in [-W,W]x[-H,H]
        var px = b.px, py = b.py, vx = b.vx, vy = b.vy;
        var p2 = f32(f32(px * px) + f32(py * py));
        var ax = (-px) * p2 * d[6] - vx * d[7];
        var ay = (-py) * p2 * d[6] - vy * d[7];
        var sp = f32(Math.sqrt(f32(f32(vy * vy) + f32(vx * vx))));
        var ux = 0, uy = 0;
        if (sp !== 0) { ux = vy / sp; uy = (-vx) / sp; }
        b.maxX = W; b.maxY = H; b.minX = -W; b.minY = -H;
        b.vx = f32(f32(ux * lvl + ax) + vx);
        b.vy = f32(f32(uy * lvl + ay) + b.vy);
        b.step(f32(0.6));
      }
      var rot = lvl * d[2] + this.rot;
      if (rot > TWO_PI_F) rot -= TWO_PI_F;
      this.rot = rot;
      var N = ti(d[0]), da = N > 0 ? PI_F / N : 0.5;
      if (N > 50) N = 50;
      var scale = f32(H) + d[5];
      var n = ti(d[3]), c1 = n & 255, lines = d[4] === 0;
      var cx = (W >> 1) + b.x, cy = (H >> 1) + b.y;
      for (var i = 0; i < N; i++) {
        var len = (T[i] + T[i + 2] + T[i + 4] + T[0x401 + i] + T[0x405 + i] + T[0x403 + i]) / 1530 * scale;
        var p5 = T[0xC00 + i] / 255 * len, p6 = 1.0 - T[0x800 + i] / 255;
        var a = i * da + this.rot, ca = (FXD[0] = a, COSR(), FRD[0]), sa = (FXD[0] = a, SINR(), FRD[0]);
        var i5 = ti(ca * len), i6 = ti(sa * len);
        var i7 = ti(ca * p5) + ti(i6 * p6), i8 = ti(sa * p5) - ti(i5 * p6);
        SAF[0] = cx + i7; SAF[1] = cy + i8; spiralArc(E, cx, cy, cx + i5, cy + i6, n, 255, c1, lines);
        SAF[0] = cx - i7; SAF[1] = cy - i8; spiralArc(E, cx, cy, cx - i5, cy - i6, n, 255, c1, lines);
      }
    }
  }

  B.register('CCircleWaveform', CCircleWaveform);
  B.register('CJDar', CJDar);
  B.register('CJiggyScribble', CJiggyScribble);
  B.register('CDotPlane', CDotPlane);
  B.register('CGalaxy', CGalaxy);
  B.drawerUtil = { line: line, plot: plot, spiralArc: spiralArc, tlBytes: tlBytes, Bouncer: Bouncer };
})(B);
if (typeof module !== 'undefined' && module.exports) module.exports = B;
