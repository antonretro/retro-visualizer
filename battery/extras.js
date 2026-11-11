// Battery remake - "Anthony's collection": NEW effects (not from wmp.dll), drawn in Battery's own style.
// Load after drawers.js and core.js (browser), or require() in node. Plain ES2015, Chrome 76 safe.
//
// Exactness contract (the 25 classics + Random stay pixel-exact):
//  * Nothing here touches B.DRAWER_LIST / B.SHIFT_POOL, so the engine never constructs these classes and
//    Random mode never picks them.
//  * Engine.findDrawer/findShift get a FALLBACK: only when a name is not in the stock lists is an extras
//    instance created (lazily, once per engine). Stock names resolve exactly as before.
//  * Extras never call E.rand(): each instance owns a B.msvcRand stream (seeded from its own constant).
//  * Presets are only added to an engine by B.Extras.install(E), appended after the stock ones, so stock
//    preset indices are unchanged.
//
// Drawing vocabulary (as the real drawers): plain SET of palette index bytes into E.front, 1-px Bresenham
// lines with clamped endpoints (B.drawerUtil.line), mostly index 255; the shift warp + blur/decay make it glow.
var B = (typeof globalThis !== 'undefined' && globalThis.Battery) || require('./engine.js');
if (typeof require === 'function' && typeof module !== 'undefined' && !B.Engine) {
  require('./shifts.js'); require('./edges.js'); require('./drawers.js'); require('./core.js');
}
(function (B) {
  'use strict';
  var line = B.drawerUtil.line, spiralArc = B.drawerUtil.spiralArc;
  var PI = Math.PI, TAU = 2 * Math.PI, sin = Math.sin, cos = Math.cos, sqrt = Math.sqrt;

  function plot(E, x, y, c) { x |= 0; y |= 0; if (x >= 0 && x < E.W && y >= 0 && y < E.H) E.front[y * E.W + x] = c; }
  function inside(E, x, y) { return x >= 0 && y >= 0 && x < E.W && y < E.H; }
  function u01(r) { return r() / 32767; }

  // Per-drawer audio features (no allocation): bass / mid / treble 0..1 and a beat flag from energy flux.
  function Feat() { this.bass = 0; this.mid = 0; this.tre = 0; this.avg = 0.1; this.beat = false; this.cool = 0; this.kick = 0; }
  Feat.prototype.update = function (audio, sens) {
    var f0 = audio.freq[0], f1 = audio.freq[1], i, b = 0, m = 0, t = 0;
    for (i = 0; i < 6; i++) b += f0[i] + f1[i];
    for (i = 8; i < 64; i++) m += f0[i] + f1[i];
    for (i = 64; i < 320; i++) t += f0[i] + f1[i];
    this.bass = b / 3060; this.mid = m / 28560; this.tre = t / 130560;
    var e = this.bass * 0.5 + this.mid + this.tre;
    if (this.cool > 0) this.cool--;
    this.beat = false;
    if (e > this.avg * (sens || 1.3) + 0.04 && this.cool === 0) { this.beat = true; this.cool = 6; this.kick = 1; }
    this.avg = this.avg * 0.92 + e * 0.08;
    this.kick *= 0.82;
  };

  // Base for all extras drawers: own rng, never E.rand.
  class XDrawer extends B.Drawer {
    constructor(seed) { super(); this.mask = 2; this.rng = B.msvcRand(seed); this.feat = new Feat(); this.t = 0; }
  }

  // ======================================================================== CWireCube
  // A spinning 3D wireframe (cube / octahedron / cube-in-cube) drawn with Battery's line, edges wobbled by
  // the waveform. Bass swells it, treble spins it, beats kick it.
  // dbl[0] size (fraction of H/2, ~0.3..0.7)    dbl[1] bass swell (0..1)
  // dbl[2] spin (rad/frame at full treble, ~0.02..0.1)
  // dbl[3] shape: 0 cube, 1 octahedron, 2 cube-in-cube (inner cube spins the other way, breathes with bass)
  // dbl[4] wobble (px of waveform bend in the middle of each edge, 0..20)
  // dbl[5] colour: 0 all 255, 1 depth shaded (far edges dimmer), 2 dotted edges
  // dbl[6] orbit (centre circles the screen centre, fraction of W/4; 0 = fixed)
  var CUBE_V = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  var CUBE_E = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  var OCT_V = [1.4, 0, 0, -1.4, 0, 0, 0, 1.4, 0, 0, -1.4, 0, 0, 0, 1.4, 0, 0, -1.4];
  var OCT_E = [0, 2, 0, 3, 0, 4, 0, 5, 1, 2, 1, 3, 1, 4, 1, 5, 2, 4, 4, 3, 3, 5, 5, 2];
  class CWireCube extends XDrawer {
    constructor() {
      super(0x0C0BE); this.className = 'CWireCube';
      var d = this.dbl; d[0] = 0.5; d[1] = 0.4; d[2] = 0.05; d[3] = 0; d[4] = 6; d[5] = 1; d[6] = 0;
      this.ax = 0.4; this.ay = 0.2; this.az = 0;
      this.px = new Float64Array(16); this.py = new Float64Array(16); this.pz = new Float64Array(16);
    }
    randomizeParams() {
      var r = this.rng, d = this.dbl;
      d[0] = 0.3 + u01(r) * 0.4; d[1] = u01(r) * 0.8; d[2] = 0.02 + u01(r) * 0.08; d[3] = r() % 3;
      d[4] = r() % 16; d[5] = r() % 3; d[6] = r() % 3 === 0 ? u01(r) * 0.8 : 0;
    }
    reset() { this.ax = 0.4; this.ay = 0.2; this.az = 0; this.t = 0; }
    _rot(i, x, y, z, a, b, c, s, cx, cy, W) {
      var ca = cos(a), sa = sin(a), cb = cos(b), sb = sin(b), cc = cos(c), sc = sin(c), t;
      t = y * ca - z * sa; z = y * sa + z * ca; y = t;          // x axis
      t = x * cb + z * sb; z = -x * sb + z * cb; x = t;         // y axis
      t = x * cc - y * sc; y = x * sc + y * cc; x = t;          // z axis
      var p = 3.2 / (z + 4.2);
      this.px[i] = cx + x * s * p; this.py[i] = cy + y * s * p; this.pz[i] = z;
    }
    render(audio, E) {
      var d = this.dbl, F = this.feat, W = E.W, H = E.H, wv = audio.wave;
      F.update(audio, 1.3); this.t++;
      var spin = d[2] * (0.25 + F.tre * 3) + 0.06 * F.kick;
      this.ay += spin; this.ax += spin * 0.63; this.az += spin * 0.21;
      var s = (H >> 1) * d[0] * (1 + d[1] * (F.bass - 0.6) + 0.22 * F.kick);
      var cx = W >> 1, cy = H >> 1;
      if (d[6] > 0) { cx += cos(this.t * 0.021) * d[6] * (W >> 2); cy += sin(this.t * 0.017) * d[6] * (H >> 2); }
      var shape = d[3] | 0, V = shape === 1 ? OCT_V : CUBE_V, Ed = shape === 1 ? OCT_E : CUBE_E;
      var nv = V.length / 3, i;
      for (i = 0; i < nv; i++) this._rot(i, V[3 * i], V[3 * i + 1], V[3 * i + 2], this.ax, this.ay, this.az, s, cx, cy, W);
      this._edges(E, Ed, 0, wv[0], d);
      if (shape === 2) {
        var k = 0.45 + 0.25 * F.bass;
        for (i = 0; i < 8; i++) this._rot(8 + i, V[3 * i] * k, V[3 * i + 1] * k, V[3 * i + 2] * k, -this.ax, -this.ay * 1.3, this.az, s, cx, cy, W);
        this._edges(E, Ed, 8, wv[1], d);
        for (i = 0; i < 8; i++) this._edge(E, i, 8 + i, i * 97, wv[0], 0, 180);
      }
    }
    _edges(E, Ed, base, w, d) {
      for (var e = 0; e < Ed.length; e += 2) {
        var a = base + Ed[e], b = base + Ed[e + 1];
        var c = 255;
        if (d[5] === 1) c = 255 - ((this.pz[a] + this.pz[b] + 3) * 14 | 0);
        this._edge(E, a, b, e * 41, w, d[4], c);
      }
    }
    _edge(E, a, b, off, w, wob, c) {
      var x0 = this.px[a], y0 = this.py[a], x1 = this.px[b], y1 = this.py[b];
      var dx = x1 - x0, dy = y1 - y0, L = sqrt(dx * dx + dy * dy) || 1, nx = -dy / L, ny = dx / L;
      var SEG = 12, qx = x0 | 0, qy = y0 | 0, dots = this.dbl[5] === 2;
      for (var j = 1; j <= SEG; j++) {
        var t = j / SEG, o = (w[(off + j * 9) & 1023] - 128) / 128 * wob * sin(PI * t);
        var X = (x0 + dx * t + nx * o) | 0, Y = (y0 + dy * t + ny * o) | 0;
        if (dots) plot(E, X, Y, c); else line(E, qx, qy, X, Y, c);
        qx = X; qy = Y;
      }
    }
  }

  // ======================================================================== CCogRing
  // Interlocking gear outlines: a ring whose radius is a trapezoid tooth wave (+ the waveform), with a hub
  // circle and spokes. Up to 3 gears mesh (counter-rotating, speed ratio = tooth ratio). Spin follows bass.
  // dbl[0] teeth on the main gear (6..32)       dbl[1] gears 1..3
  // dbl[2] main radius (fraction of H/2, 0.2..0.7)   dbl[3] tooth depth (fraction of radius, 0.05..0.25)
  // dbl[4] spin (rad/frame at full bass)        dbl[5] waveform wobble on the rim (px, 0..16)
  // dbl[6] style: 0 rim only, 1 dotted rim, 2 rim + hub + spokes      dbl[7] spokes (0 = 5)
  class CCogRing extends XDrawer {
    constructor() {
      super(0x6EA25); this.className = 'CCogRing';
      var d = this.dbl; d[0] = 14; d[1] = 2; d[2] = 0.42; d[3] = 0.12; d[4] = 0.06; d[5] = 4; d[6] = 2; d[7] = 5;
      this.rot = 0;
      this.gx = new Float64Array(3); this.gy = new Float64Array(3); this.gn = new Float64Array(3);
      this.gr = new Float64Array(3); this.gm = new Float64Array(3); this.gp = new Float64Array(3);
    }
    randomizeParams() {
      var r = this.rng, d = this.dbl;
      d[0] = 8 + r() % 20; d[1] = 1 + r() % 3; d[2] = 0.25 + u01(r) * 0.35; d[3] = 0.06 + u01(r) * 0.16;
      d[4] = 0.02 + u01(r) * 0.08; d[5] = r() % 12; d[6] = r() % 3; d[7] = 3 + r() % 5;
    }
    reset() { this.rot = 0; }
    _layout(E) {
      var d = this.dbl, n = Math.max(1, Math.min(3, d[1] | 0)), H = E.H, R0 = (H >> 1) * d[2], N0 = Math.max(4, d[0] | 0);
      var ratio = [1, 0.6, 0.8], phiStep = [0, 0.45, -1.15], i;
      this.gn[0] = N0; this.gr[0] = R0; this.gx[0] = 0; this.gy[0] = 0; this.gm[0] = 1; this.gp[0] = 0;
      var phi = 0;
      for (i = 1; i < n; i++) {
        var Nk = Math.max(4, Math.round(N0 * ratio[i])), Rk = R0 * Nk / N0;
        phi += phiStep[i] + (i === 2 ? PI : 0);
        var dist = this.gr[i - 1] + Rk;
        this.gn[i] = Nk; this.gr[i] = Rk;
        this.gx[i] = this.gx[i - 1] + cos(phi) * dist; this.gy[i] = this.gy[i - 1] + sin(phi) * dist;
        this.gm[i] = -this.gm[i - 1] * this.gn[i - 1] / Nk;
        this.gp[i] = phi + PI + (this.gn[i - 1] / Nk) * (phi - this.gp[i - 1]);
      }
      var mx = 0, my = 0;                 // centre the cluster on the screen
      for (i = 0; i < n; i++) { mx += this.gx[i]; my += this.gy[i]; }
      mx /= n; my /= n;
      for (i = 0; i < n; i++) { this.gx[i] += (E.W >> 1) - mx; this.gy[i] += (E.H >> 1) - my; }
      return n;
    }
    render(audio, E) {
      var d = this.dbl, F = this.feat; F.update(audio, 1.3);
      this.rot += d[4] * (0.15 + F.bass * F.bass * 1.6) + 0.05 * F.kick;
      var n = this._layout(E), style = d[6] | 0, wob = d[5], depth = d[3];
      for (var g = 0; g < n; g++) {
        var N = this.gn[g], R = this.gr[g] * (1 + 0.08 * F.kick), cx = this.gx[g], cy = this.gy[g];
        var rot = this.gm[g] * this.rot + this.gp[g], w = audio.wave[g & 1];
        var P = Math.min(400, N * 10 | 0), qx = 0, qy = 0;
        for (var i = 0; i <= P; i++) {
          var a = i / P * TAU, s = sin(N * (a - rot)) * 2.6;
          s = s > 1 ? 1 : s < -1 ? -1 : s;
          var r = R * (1 + depth * s) + (w[(i * 1024 / P) & 1023] - 128) / 128 * wob;
          var X = (cx + cos(a) * r) | 0, Y = (cy + sin(a) * r) | 0;
          if (style === 1) { if (i & 1) plot(E, X, Y, 255); }
          else if (i) line(E, qx, qy, X, Y, 255);
          qx = X; qy = Y;
        }
        if (style === 2) {
          var hr = R * 0.32, ns = (d[7] | 0) || 5, k;
          for (k = 0; k <= 24; k++) {
            var ha = k / 24 * TAU, hx = (cx + cos(ha) * hr) | 0, hy = (cy + sin(ha) * hr) | 0;
            if (k) line(E, qx, qy, hx, hy, 230);
            qx = hx; qy = hy;
          }
          for (k = 0; k < ns; k++) {
            var sa = rot + k / ns * TAU, ca = cos(sa), sn = sin(sa);
            line(E, (cx + ca * hr) | 0, (cy + sn * hr) | 0, (cx + ca * R * (1 - depth) * 0.92) | 0, (cy + sn * R * (1 - depth) * 0.92) | 0, 220);
          }
        }
      }
    }
  }

  // ======================================================================== CForkBolt
  // Branching lightning that strikes on beats. A bolt keeps its skeleton (own seed) for its life, but each
  // frame the spectrum shakes every segment, so it flickers; then the trails carry it away.
  // dbl[0] beat sensitivity (1.1 = trigger-happy .. 1.8 = only big hits)
  // dbl[1] origin: 0 centre outwards, 1 screen edges inwards, 2 from a ring (H/5) outwards, 3 from the top down
  // dbl[2] branch chance per step (0..0.4)   dbl[3] bolts per strike (1..4)   dbl[4] step length px (3..12)
  // dbl[5] jaggedness (radians, 0.2..1.0)    dbl[6] life in frames (1..6)     dbl[7] colour (0 = 255)
  var MAXB = 8, STK = 48;
  class CForkBolt extends XDrawer {
    constructor() {
      super(0xB017); this.className = 'CForkBolt';
      var d = this.dbl; d[0] = 1.3; d[1] = 0; d[2] = 0.12; d[3] = 2; d[4] = 6; d[5] = 0.55; d[6] = 3; d[7] = 0;
      this.bseed = new Int32Array(MAXB); this.bx = new Float64Array(MAXB); this.by = new Float64Array(MAXB);
      this.ba = new Float64Array(MAXB); this.blife = new Int32Array(MAXB);
      this.r2 = B.msvcRand(1);
      this.sx = new Float64Array(STK); this.sy = new Float64Array(STK); this.sa = new Float64Array(STK);
      this.sd = new Int32Array(STK); this.sl = new Float64Array(STK);
    }
    randomizeParams() {
      var r = this.rng, d = this.dbl;
      d[0] = 1.15 + u01(r) * 0.5; d[1] = r() % 4; d[2] = u01(r) * 0.3; d[3] = 1 + r() % 3; d[4] = 3 + r() % 8;
      d[5] = 0.25 + u01(r) * 0.6; d[6] = 1 + r() % 4; d[7] = 0;
    }
    reset() { for (var i = 0; i < MAXB; i++) this.blife[i] = 0; }
    _spawn(E) {
      var r = this.rng, d = this.dbl, W = E.W, H = E.H, mode = d[1] | 0;
      for (var i = 0; i < MAXB; i++) {
        if (this.blife[i] > 0) continue;
        var x = W >> 1, y = H >> 1, a = u01(r) * TAU;
        if (mode === 1) {
          var p = u01(r) * 2 * (W + H);
          if (p < W) { x = p; y = 0; } else if (p < W + H) { x = W - 1; y = p - W; }
          else if (p < 2 * W + H) { x = p - W - H; y = H - 1; } else { x = 0; y = p - 2 * W - H; }
          a = Math.atan2((H >> 1) - y, (W >> 1) - x) + (u01(r) - 0.5) * 0.6;
        } else if (mode === 2) {
          x += cos(a) * H / 5; y += sin(a) * H / 5;
        } else if (mode === 3) {
          x = u01(r) * W; y = 0; a = PI / 2 + (u01(r) - 0.5) * 0.7;
        }
        this.bx[i] = x; this.by[i] = y; this.ba[i] = a; this.bseed[i] = r() * 32768 + r();
        this.blife[i] = Math.max(1, this.dbl[6] | 0);
        return;
      }
    }
    render(audio, E) {
      var d = this.dbl, F = this.feat, i;
      F.update(audio, d[0] || 1.3);
      if (F.beat) for (i = 0; i < Math.max(1, d[3] | 0); i++) this._spawn(E);
      for (i = 0; i < MAXB; i++) if (this.blife[i] > 0) { this._bolt(audio, E, i); this.blife[i]--; }
    }
    _bolt(audio, E, b) {
      var d = this.dbl, r = this.r2, fq = audio.freq[0], step = Math.max(2, d[4]), jag = d[5];
      var col = d[7] > 0 ? d[7] | 0 : 255, maxSteps = ((E.W + E.H) / step) | 0;
      r.seed(this.bseed[b]);
      var sp = 0, k = 0;
      this.sx[0] = this.bx[b]; this.sy[0] = this.by[b]; this.sa[0] = this.ba[b]; this.sd[0] = 0; this.sl[0] = maxSteps; sp = 1;
      while (sp > 0) {
        sp--;
        var x = this.sx[sp], y = this.sy[sp], a = this.sa[sp], dep = this.sd[sp], n = this.sl[sp] | 0, a0 = a;
        var c = col - dep * 28;
        for (var s = 0; s < n; s++) {
          k++;
          var shake = (fq[(k * 13) & 511] / 255) * 0.5;
          a += (u01(r) - 0.5) * 2 * jag + ((k & 1) ? shake : -shake);
          a += (a0 - a) * 0.25;                              // keep heading
          var L = step * (0.6 + u01(r) * 0.8);
          var nx = x + cos(a) * L, ny = y + sin(a) * L;
          line(E, x | 0, y | 0, nx | 0, ny | 0, c);
          x = nx; y = ny;
          if (!inside(E, x, y)) break;
          if (dep < 3 && sp < STK && u01(r) < d[2]) {
            this.sx[sp] = x; this.sy[sp] = y; this.sa[sp] = a + (u01(r) < 0.5 ? -1 : 1) * (0.4 + u01(r) * 0.6);
            this.sd[sp] = dep + 1; this.sl[sp] = (n - s) * 0.45; sp++;
          }
        }
      }
    }
  }

  // ======================================================================== CAtomOrbits
  // Tilted orbit rings (circles in 3D, precessing) with a bright electron on each, around a nucleus that is a
  // little waveform circle. Rings breathe with the waveform.
  // dbl[0] rings (1..6)   dbl[1] radius (fraction of H/2)   dbl[2] precession (rad/frame)
  // dbl[3] electron speed (rad/frame)   dbl[4] style: 0 solid rings, 1 dotted rings, 2 electrons only (+ short tails)
  // dbl[5] nucleus radius px (0 = none)   dbl[6] waveform breathing on rings (px)
  class CAtomOrbits extends XDrawer {
    constructor() {
      super(0xA7031); this.className = 'CAtomOrbits';
      var d = this.dbl; d[0] = 3; d[1] = 0.7; d[2] = 0.01; d[3] = 0.09; d[4] = 1; d[5] = 10; d[6] = 6;
    }
    randomizeParams() {
      var r = this.rng, d = this.dbl;
      d[0] = 2 + r() % 4; d[1] = 0.45 + u01(r) * 0.45; d[2] = 0.004 + u01(r) * 0.02; d[3] = 0.04 + u01(r) * 0.1;
      d[4] = r() % 3; d[5] = r() % 3 ? 4 + r() % 14 : 0; d[6] = r() % 10;
    }
    reset() { this.t = 0; }
    render(audio, E) {
      var d = this.dbl, F = this.feat; F.update(audio, 1.3); this.t++;
      var W = E.W, H = E.H, cx = W >> 1, cy = H >> 1, n = Math.max(1, Math.min(6, d[0] | 0));
      var R = (H >> 1) * d[1] * (1 + 0.1 * F.kick), style = d[4] | 0, t = this.t, w = audio.wave[0];
      for (var k = 0; k < n; k++) {
        var inc = 1.15 + 0.12 * k, node = t * d[2] * (1 + 0.3 * k) + k * TAU / n;
        var ci = cos(inc), si = sin(inc), cn = cos(node), sn = sin(node);
        var eu = t * d[3] * (1 + 0.25 * k) * (0.6 + F.mid * 2) + k;
        var P = 96, qx = 0, qy = 0;
        for (var i = 0; i <= P; i++) {
          var u = i / P * TAU, rr = R + (w[(i * 10 + k * 160) & 1023] - 128) / 128 * d[6];
          var X = cx + this._x(u, rr, ci, si, cn, sn), Y = cy + this._y(u, rr, ci, si, cn, sn);
          X |= 0; Y |= 0;
          if (style === 0) { if (i) line(E, qx, qy, X, Y, 200); }
          else if (style === 1) { if ((i & 1) === 0) plot(E, X, Y, 210); }
          qx = X; qy = Y;
        }
        var ex = (cx + this._x(eu, R, ci, si, cn, sn)) | 0, ey = (cy + this._y(eu, R, ci, si, cn, sn)) | 0;
        if (style === 2) {
          var tx = (cx + this._x(eu - 0.35, R, ci, si, cn, sn)) | 0, ty = (cy + this._y(eu - 0.35, R, ci, si, cn, sn)) | 0;
          spiralArc(E, tx, ty, ex, ey, cx, cy, 12, 160, 255, true);
        }
        line(E, ex - 2, ey, ex + 2, ey, 255); line(E, ex, ey - 2, ex, ey + 2, 255);
      }
      if (d[5] > 0) {
        var nr = d[5] * (0.7 + F.bass * 0.6 + 0.4 * F.kick), px = 0, py = 0, w1 = audio.wave[1];
        for (var j = 0; j <= 48; j++) {
          var a = j / 48 * TAU, r2 = nr + (w1[(j * 21) & 1023] - 128) / 32;
          var hx = (cx + cos(a) * r2) | 0, hy = (cy + sin(a) * r2) | 0;
          if (j) line(E, px, py, hx, hy, 255);
          px = hx; py = hy;
        }
      }
    }
    // circle in the x-y plane, tilted by inc around x, then turned by node around the view axis (orthographic)
    _x(u, r, ci, si, cn, sn) { var x = cos(u) * r, y = sin(u) * r * ci; return x * cn - y * sn; }
    _y(u, r, ci, si, cn, sn) { var x = cos(u) * r, y = sin(u) * r * ci; return x * sn + y * cn; }
  }

  // ======================================================================== CStarTunnel
  // A 3D starfield flying at the viewer: each star is drawn as a streak from its last screen position.
  // Bass speeds the flight, treble twists the field, beats lunge forward.
  // dbl[0] stars (16..400)   dbl[1] base speed (z per frame, 0.005..0.04)   dbl[2] bass boost (0..4)
  // dbl[3] twist (rad/frame at full treble)   dbl[4] 0 dots, 1 streaks
  // dbl[5] centre wander (fraction of W/4)   dbl[6] darkest colour for far stars (64..250)
  var MAXS = 400;
  class CStarTunnel extends XDrawer {
    constructor() {
      super(0x57A85); this.className = 'CStarTunnel';
      var d = this.dbl; d[0] = 160; d[1] = 0.012; d[2] = 1.5; d[3] = 0.03; d[4] = 1; d[5] = 0; d[6] = 140;
      this.x = new Float64Array(MAXS); this.y = new Float64Array(MAXS); this.z = new Float64Array(MAXS);
      this.qx = new Int32Array(MAXS); this.qy = new Int32Array(MAXS); this.ok = new Uint8Array(MAXS);
      this.inited = false;
    }
    randomizeParams() {
      var r = this.rng, d = this.dbl;
      d[0] = 60 + r() % 300; d[1] = 0.006 + u01(r) * 0.025; d[2] = u01(r) * 3; d[3] = (u01(r) - 0.5) * 0.1;
      d[4] = r() % 4 ? 1 : 0; d[5] = r() % 2 ? u01(r) * 0.7 : 0; d[6] = 80 + r() % 150;
    }
    reset() {
      this.rng.seed(0x57A85); this.t = 0;
      for (var i = 0; i < MAXS; i++) this._respawn(i, u01(this.rng));
      this.inited = true;
    }
    _respawn(i, z) {
      var r = this.rng, x, y;
      do { x = u01(r) * 2 - 1; y = u01(r) * 2 - 1; } while (x * x + y * y < 0.004);
      this.x[i] = x; this.y[i] = y; this.z[i] = 0.08 + z * 0.92; this.ok[i] = 0;
    }
    render(audio, E) {
      if (!this.inited) this.reset();
      var d = this.dbl, F = this.feat; F.update(audio, 1.3); this.t++;
      var W = E.W, H = E.H, n = Math.max(1, Math.min(MAXS, d[0] | 0)), f = H * 0.45;
      var cx = W >> 1, cy = H >> 1;
      if (d[5] > 0) { cx += cos(this.t * 0.019) * d[5] * (W >> 2); cy += sin(this.t * 0.027) * d[5] * (H >> 2); }
      var v = d[1] * (1 + d[2] * F.bass * F.bass + 2.5 * F.kick), tw = d[3] * (0.2 + F.tre * 4);
      var ct = cos(tw), st = sin(tw), lo = d[6], streak = d[4] !== 0;
      for (var i = 0; i < n; i++) {
        var x = this.x[i] * ct - this.y[i] * st, y = this.x[i] * st + this.y[i] * ct;
        this.x[i] = x; this.y[i] = y;
        var z = this.z[i] - v;
        if (z < 0.03) { this._respawn(i, 1); continue; }
        this.z[i] = z;
        var X = (cx + x / z * f) | 0, Y = (cy + y / z * f) | 0;
        if (!inside(E, X, Y)) { this._respawn(i, 1); continue; }
        var c = (lo + (255 - lo) * (1 - z)) | 0;
        if (streak && this.ok[i]) line(E, this.qx[i], this.qy[i], X, Y, c); else plot(E, X, Y, c);
        this.qx[i] = X; this.qy[i] = Y; this.ok[i] = 1;
      }
    }
  }

  // ======================================================================== CKaleidoWave
  // The oscilloscope trace laid along N spokes (optionally mirrored), like a snowflake made of sound.
  // dbl[0] arms (2..16)   dbl[1] inner radius (fraction of H/2)   dbl[2] arm length (fraction of H/2)
  // dbl[3] amplitude (px at full scale)   dbl[4] rotation (rad/frame, treble adds)   dbl[5] mirror (0/1)
  // dbl[6] samples per arm (16..256)       dbl[7] colour (0 = 255)
  class CKaleidoWave extends XDrawer {
    constructor() {
      super(0x6A1E1); this.className = 'CKaleidoWave';
      var d = this.dbl; d[0] = 6; d[1] = 0.1; d[2] = 0.8; d[3] = 40; d[4] = 0.01; d[5] = 1; d[6] = 64; d[7] = 0;
      this.rot = 0;
    }
    randomizeParams() {
      var r = this.rng, d = this.dbl;
      d[0] = 3 + r() % 10; d[1] = u01(r) * 0.3; d[2] = 0.4 + u01(r) * 0.6; d[3] = 10 + r() % 60;
      d[4] = (u01(r) - 0.5) * 0.04; d[5] = r() % 2; d[6] = 32 + r() % 160; d[7] = 0;
    }
    reset() { this.rot = 0; }
    render(audio, E) {
      var d = this.dbl, F = this.feat; F.update(audio, 1.3);
      this.rot += d[4] * (1 + F.tre * 3) + (d[4] >= 0 ? 0.03 : -0.03) * F.kick;
      var W = E.W, H = E.H, cx = W >> 1, cy = H >> 1, N = Math.max(1, d[0] | 0), S = Math.max(4, Math.min(256, d[6] | 0));
      var r0 = (H >> 1) * d[1], L = (H >> 1) * d[2] * (0.85 + 0.3 * F.kick), amp = d[3], col = d[7] > 0 ? d[7] | 0 : 255;
      var mir = d[5] !== 0 ? 2 : 1;
      for (var a = 0; a < N; a++) {
        var th = this.rot + a * TAU / N, ct = cos(th), st = sin(th), w = audio.wave[a & 1];
        for (var m = 0; m < mir; m++) {
          var sg = m ? -1 : 1, qx = 0, qy = 0;
          for (var i = 0; i <= S; i++) {
            var t = i / S, r = r0 + t * L, o = sg * (w[(i * 512 / S) | 0] - 128) / 128 * amp * sin(PI * t);
            var X = (cx + ct * r - st * o) | 0, Y = (cy + st * r + ct * o) | 0;
            if (i) line(E, qx, qy, X, Y, col);
            qx = X; qy = Y;
          }
        }
      }
    }
  }

  // ======================================================================== CKaleidoShift (new shift)
  // Mirror-fold warp: every wedge samples the same (mirrored) base wedge, slightly zoomed and twisted, so the
  // feedback grows N-fold symmetric.  dbl[0] wedges (2..12)  dbl[1] twist (rad)  dbl[2] zoom (src radius scale,
  // <1 flows outwards)  dbl[3] spiral (extra twist at the edge, rad)
  class CKaleidoShift extends B.Shift {
    constructor() {
      super(); this.className = 'CKaleidoShift'; this.outOfRangeKeep = false; this.rng = B.msvcRand(0x4A1E);
      this.dbl[0] = 6; this.dbl[1] = 0.02; this.dbl[2] = 0.96; this.dbl[3] = 0; this._o = [0, 0];
    }
    randomizeParams() {
      var r = this.rng, d = this.dbl;
      d[0] = 2 + r() % 9; d[1] = (u01(r) - 0.5) * 0.1; d[2] = 0.92 + u01(r) * 0.1; d[3] = (u01(r) - 0.5) * 0.2;
    }
    map(x, y, E) {
      var d = this.dbl, cx = E.W >> 1, cy = E.H >> 1, dx = x - cx, dy = y - cy;
      var r = sqrt(dx * dx + dy * dy), a = Math.atan2(dy, dx) + d[1] + d[3] * r / (E.H >> 1);
      var wedge = TAU / Math.max(1, d[0]), m = a - Math.floor(a / wedge) * wedge;
      if (m > wedge * 0.5) m = wedge - m;
      var rs = r * d[2];
      this._o[0] = cx + cos(m) * rs; this._o[1] = cy + sin(m) * rs;
      return this._o;
    }
  }

  var DRAWERS = { CWireCube: CWireCube, CCogRing: CCogRing, CForkBolt: CForkBolt, CAtomOrbits: CAtomOrbits,
    CStarTunnel: CStarTunnel, CKaleidoWave: CKaleidoWave };
  var SHIFTS = { CKaleidoShift: CKaleidoShift };
  Object.keys(DRAWERS).forEach(function (n) { B.register(n, DRAWERS[n]); });
  Object.keys(SHIFTS).forEach(function (n) { B.register(n, SHIFTS[n]); });

  // ---- lookup fallback: stock names resolve exactly as before; extras are built lazily per engine.
  var EP = B.Engine.prototype, fd = EP.findDrawer, fs = EP.findShift;
  function extra(E, kind, table, name) {
    var bag = kind === 'd' ? (E._xDrawers || (E._xDrawers = {})) : (E._xShifts || (E._xShifts = {}));
    if (!Object.prototype.hasOwnProperty.call(table, name)) return null;
    if (!bag[name]) { var o = new table[name](); o.className = name; if (kind === 's') B.shiftOps.init(o); bag[name] = o; }
    return bag[name];
  }
  EP.findDrawer = function (name) { return fd.call(this, name) || extra(this, 'd', DRAWERS, name); };
  EP.findShift = function (name) { return fs.call(this, name) || extra(this, 's', SHIFTS, name); };

  // ---- palettes from colour stops: [[index, r, g, b], ...] -> the 1024-byte RGBX hex string presets use
  function palette(stops) {
    var s = '', k = 0;
    for (var i = 0; i < 256; i++) {
      while (k < stops.length - 2 && i > stops[k + 1][0]) k++;
      var a = stops[k], b = stops[k + 1], t = b[0] > a[0] ? (i - a[0]) / (b[0] - a[0]) : 0;
      if (t < 0) t = 0; if (t > 1) t = 1;
      for (var c = 1; c < 4; c++) { var v = Math.round(a[c] + (b[c] - a[c]) * t); s += (v < 16 ? '0' : '') + v.toString(16).toUpperCase(); }
      s += '00';
    }
    return s;
  }

  // ---- install the collection into an engine (appended after the stock presets). Returns the first index.
  // "Random (everything)": Battery's own Random mode, but its pools also hold the new effects. A separate
  // cycle, so the classic Random (preset 0) stays exactly as in WMP. Constructing it uses no rand.
  function randomAll(E) {
    var c = new B.Cycle(E, null), CP = B.Cycle.prototype;
    c.title = 'Random (everything)'; c.extra = true; c.randomAll = true;
    function withPools(fn) {
      return function () {
        var d = E.drawers, s = E.shifts, i, k;
        var dd = d.slice(), ss = s.slice();
        for (k in DRAWERS) if (DRAWERS.hasOwnProperty(k)) { i = E.findDrawer(k); if (i) dd.push(i); }
        for (k in SHIFTS) if (SHIFTS.hasOwnProperty(k)) { i = E.findShift(k); if (i) ss.push(i); }
        E.drawers = dd; E.shifts = ss;
        try { return fn.apply(this, arguments); } finally { E.drawers = d; E.shifts = s; }
      };
    }
    c.newEffects = withPools(CP.newEffects);
    c.newMovement = withPools(CP.newMovement);
    return c;
  }
  function install(E) {
    if (E._xFirst) return E._xFirst;
    var list = B.EXTRA_PRESETS || [], first = E.presets.length;
    E.presets.push(randomAll(E));
    for (var i = 0; i < list.length; i++) { var c = new B.Cycle(E, list[i]); c.extra = true; E.presets.push(c); }
    E._xFirst = first;
    return first;
  }
  B.Extras = { palette: palette, install: install, drawers: DRAWERS, shifts: SHIFTS, Feat: Feat };
})(B);
if (typeof module !== 'undefined' && module.exports) module.exports = B;
