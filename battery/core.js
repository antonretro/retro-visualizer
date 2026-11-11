// Battery remake - core engine (CORE_SPEC.md sections 1-6). Plain script (globalThis.Battery) and node module.
// Load order: engine.js, shifts.js, drawers.js, edges.js, core.js (classes must be registered before new Engine()).
(function (root) {
  'use strict';
  var B = root.Battery;
  if (!B && typeof require !== 'undefined') B = require('./engine.js');
  if (typeof module !== 'undefined' && module.exports) module.exports = B;

  // Engine class lists, in the order of the real ctor (FUN_18051e788). Missing classes are skipped
  // (the real code also drops failed allocations), which changes rand()%count - only exact with all present.
  B.SHIFT_POOL = ['CLinearShift', 'CLinearShift', 'CThingusShift', 'CZoomShift', 'CRingSpinShift', 'CStretchShift',
    'CTileShift', 'CTrigShift', 'CSinShimmerShift', 'CEdgeFalloffShift', 'CStarburstShift', 'CSwirlShift',
    'CTrigStretchShift', 'CTwirlocity', 'CShiitake'];
  B.DRAWER_LIST = ['CEdgeTrace', 'CEdgeGradiant', 'CCosEdgeGradiant', 'CWaveEdge', 'CSpectrumEdge', 'CCircleWaveform',
    'CDotPlane', 'CJDar', 'CGalaxy', 'CJiggyScribble'];
  B.SIZES = [[256, 192], [384, 288], [512, 384]];   // registry Resolution 0/1/2

  var K19 = 1 / 19;

  // ---------------------------------------------------------------- shift base (6.1 - 6.3)
  function shiftInit(s) {
    if (s._init) return;
    s._init = true; s._W = 0; s._H = 0; s._map = null; s._morph = null;
    s._step = 18; s._hold = 15; s._complete = false; s._suppress = false; s._row = 0; s._prev = null;
  }
  // Int32Array pool for shift maps / morph frames: a movement change frees ~19 W*H tables and builds as many
  // new ones; reusing them keeps memory flat (no multi-MB garbage every few seconds on small devices).
  // Reused tables are zeroed so they behave exactly like fresh allocations.
  var POOL = [], POOL_N = 0, POOL_MAX = 20;
  function getI32(n) {
    if (n !== POOL_N) { POOL = []; POOL_N = n; }
    if (POOL.length) { var a = POOL.pop(); a.fill(0); return a; }
    return new Int32Array(n);
  }
  function putI32(a) { if (a && a.length === POOL_N && POOL.length < POOL_MAX) POOL.push(a); }
  B.poolClear = function () { POOL = []; POOL_N = 0; };
  function freeMorph(s) {
    var m = s._morph; s._morph = null;
    if (m) for (var k = 0; k < m.length; k++) putI32(m[k]);
  }
  function freeMap(s) { var m = s._map; s._map = null; putI32(m); }
  function restartBuild(s) { shiftInit(s); s._row = 0; s._complete = false; }   // slot 2
  // slot 5: Resize(W, H, withMorph); runs only if the size changed or there is no map. Resize(0,0) frees all.
  function shiftResize(s, W, H, withMorph) {
    shiftInit(s);
    if (W === 0 || H === 0) { freeMap(s); freeMorph(s); s._prev = null; s._W = 0; s._H = 0; return; }
    if (s._map && s._W === W && s._H === H) return;
    freeMap(s); freeMorph(s); s._prev = null;
    s._W = W; s._H = H; s._map = getI32(W * H);
    if (withMorph) {
      s._morph = new Array(18);
      for (var k = 0; k < 18; k++) s._morph[k] = getI32(W * H);
      s._step = 0;
    } else s._step = 18;
    s.cx = W >> 1; s.cy = H >> 1;
    restartBuild(s);
  }
  function toInt(v) {   // cvttsd2si: NaN / out of int range -> INT_MIN
    if (v !== v || v >= 2147483648 || v < -2147483648) return -2147483648;
    return v | 0;
  }
  // slot 6: BuildRows, 3 rows per call
  function buildRows(s, E) {
    shiftInit(s);
    if (s._complete || !s._map) return;
    var W = s._W, H = s._H, map = s._map;
    var p = s._prev;
    if (p && (!p._map || p._W !== W || p._H !== H)) { s._prev = p = null; freeMorph(s); if (s._step < 18) s._step = 18; }
    var keep = s.outOfRangeKeep !== false, fx = s.fallbackX | 0, fy = s.fallbackY | 0;
    var doMorph = !s._suppress && p && s._step < 18 && s._morph;
    var pm = doMorph ? p._map : null, morph = s._morph;
    for (var rep = 0; rep < 3; rep++) {
      var y = s._row;
      if (y === 0 && s.prepare) s.prepare(W, H, E);
      for (var x = 0; x < W; x++) {
        var r = s.map(x, y, E);
        var sx = toInt(r[0]), sy = toInt(r[1]);
        if (sx < 0 || sx >= W) sx = keep ? x : fx;
        if (sy < 0 || sy >= H) sy = keep ? y : fy;
        var i = y * W + x;
        map[i] = sy * W + sx;
        if (doMorph) {
          var pv = pm[i] >>> 0, px = pv % W, py = (pv / W) | 0, ddx = sx - px, ddy = sy - py;
          for (var k = 1; k <= 18; k++) {
            var mx = px + toInt(k * K19 * ddx), my = py + toInt(k * K19 * ddy);
            morph[k - 1][i] = my * W + mx;
          }
        }
      }
      s._row++;
      if (s._row >= H) { s._complete = true; return; }
    }
  }
  // slot 7: Prepare(engine)
  function shiftEnsure(s, E) {
    shiftInit(s);
    if (s._W !== E.W || s._H !== E.H) shiftResize(s, E.W, E.H, false);
    if (!s._complete) {
      s._step = 18; freeMorph(s); s._suppress = true;
      while (!s._complete && s._map) buildRows(s, E);
      s._suppress = false;
    }
    if (s._prev) shiftResize(s._prev, 0, 0, false);
  }
  // applier FUN_1805215b0
  function shiftApply(s, E) {
    if (!s) return;
    shiftEnsure(s, E);
    if (!s._map) return;
    E.swap();
    var use;
    if (s._step < 18) {
      var h = s._hold; s._hold = h - 1;
      if (h < 1) {
        s._step++; s._hold = E.rand() % 15 + 1;
      }
      if (s._step > 17 || !s._morph) { s._step = 18; freeMorph(s); use = s._map; }
      else use = s._morph[s._step];
    } else use = s._map;
    var src = E.back, dst = E.front, n = E.W * E.H;
    for (var i = 0; i < n; i++) dst[i] = src[use[i]];
  }
  function shiftRandomize(s, E) { shiftInit(s); s.randomizeParams(E); restartBuild(s); }   // slot 0
  B.shiftOps = { init: shiftInit, resize: shiftResize, restartBuild: restartBuild, buildRows: buildRows,
    ensure: shiftEnsure, apply: shiftApply, randomize: shiftRandomize };

  function drawerRandomize(d, E) { d.randomizeParams(E); d.reset(E); }

  // ---------------------------------------------------------------- blur + decay (2.3)
  var BLUR = new Uint8Array(1280);
  for (var s5 = 0; s5 < 1280; s5++) { var v = (s5 / 5) | 0; v = v - 1; if (v < 1) v = 1; if (v > 254) v = 254; BLUR[s5] = v; }
  function blurDecay(E) {
    E.swap();
    var W = E.W, H = E.H, src = E.back, dst = E.front, T = BLUR, i, x;
    var last = (H - 1) * W;
    // interior rows: one linear run (left/right wrap to neighbouring rows). Edge rows [H, checked vs wmp.dll]:
    // top row x=0 takes Left from the end of the top row, x=W-1 takes Right from the start of row 1 (linear);
    // bottom row x=0 takes Left from the end of row H-2 (linear), x=W-1 Right wraps to the bottom row start [unverified].
    for (i = W; i < last; i++) dst[i] = T[src[i] + src[i - W] + src[i + W] + src[i - 1] + src[i + 1]];
    // top row: up = bottom row, horizontal wrap inside the row
    for (x = 0; x < W; x++) {
      var l = x === 0 ? W - 1 : x - 1, r = x === W - 1 ? 0 : x + 1;
      dst[x] = T[src[x] + src[last + x] + src[W + x] + src[l] + (x === W - 1 ? src[W] : src[r])];
      dst[last + x] = T[src[last + x] + src[last - W + x] + src[x] + (x === 0 ? src[last - 1] : src[last + l]) + src[last + r]];
    }
  }
  B.blurDecay = blurDecay;

  // ---------------------------------------------------------------- cycle (preset) objects (1.3, 1.5, 5.x)
  function Cycle(E, json) {
    this.E = E; this.json = json || null; this.title = json ? json.title : 'Random (default)';
    this.pre = []; this.post = []; this.current = null; this.next = null;
    this.autoEffects = !json; this.autoMovement = !json;
    this.effectsTimer = 0; this.movementTimer = 0; this.paused = false;
  }
  Cycle.prototype.activate = function () {
    this.effectsTimer = 0; this.movementTimer = 0;
    if (this.json) this.load(this.json);
  };
  Cycle.prototype.deactivate = function () {
    if (this.autoMovement) {
      if (this.current) shiftResize(this.current, 0, 0, false);
      if (this.next) shiftResize(this.next, 0, 0, false);
      this.current = this.next = null;
    }
  };
  // FUN_1805241b0 with the JSON preset in place of the registry
  Cycle.prototype.load = function (p) {
    var E = this.E, i;
    this.pre = []; this.post = [];
    var lists = [[p.pre || [], this.pre], [p.post || [], this.post]];
    for (var l = 0; l < 2; l++) {
      var src = lists[l][0];
      for (i = 0; i < src.length; i++) {
        var d = E.findDrawer(src[i].class);
        if (!d) { E.warn('missing drawer ' + src[i].class); continue; }
        copyDbl(d, src[i].dbl); d.reset(E);
        lists[l][1].push(d);
      }
    }
    var s = p.current ? E.findShift(p.current.class) : null;
    if (s) { shiftInit(s); copyDbl(s, p.current.dbl); restartBuild(s); this.current = s; }
    else { E.warn('missing shift ' + (p.current && p.current.class)); this.newMovement(); }
    this.next = null;
    // The value is kept with the preset (cycle +0x688) but the harness shows engine+0xc8 (locked) stays 0 for
    // every stock preset: the palette fades in over 25 frames, then auto random palettes resume after the
    // usual rand()%600 countdown. So the load does NOT lock the engine palette.
    this.palLockedSaved = !!p.PaletteLocked;
    if (this.palLockedSaved && p.palette && p.palette !== 'None') {
      var hex = p.palette;
      for (i = 0; i < 1024; i++) E.palTarget[i] = parseInt(hex.substr(2 * i, 2), 16) || 0;
      E.palReq = true;
    }
  };
  function copyDbl(o, a) { if (a) for (var k = 0; k < 8 && k < a.length; k++) if (a[k] != null) o.dbl[k] = +a[k]; }

  // FUN_1805256b0
  Cycle.prototype.newEffects = function () {
    var E = this.E, D = E.drawers, n = D.length, d;
    this.pre = []; this.post = [];
    if (!n) return;
    var k = E.rand() % 2;
    while (k > 0) {
      d = D[E.rand() % n];
      if (d.mask & 1) { drawerRandomize(d, E); this.pre.push(d); k--; }
    }
    var m = (((E.rand() % 4 + 1) / 4) | 0) + 1;
    while (m > 0) {
      d = D[E.rand() % n];
      if (!(d.mask & 2)) continue;
      drawerRandomize(d, E);
      var r = E.rand();
      var flags = this.current ? (this.current.flags | 0) : 0;
      if (!(flags & 1)) (r % 2 ? this.pre : this.post).push(d);
      else (E.rand() % 6 ? this.post : this.pre).push(d);
      m--;
    }
  };
  // FUN_1805258d0
  Cycle.prototype.newMovement = function () {
    var E = this.E, S = E.shifts, n = S.length;
    if (!n) return;
    if (this.current) shiftResize(this.current, 0, 0, false);
    this.current = this.next; this.next = null;
    var nx;
    do { nx = S[E.rand() % n]; } while (nx === this.current && n > 1);
    this.next = nx;
    shiftResize(nx, E.W, E.H, E.morphEnabled);
    shiftRandomize(nx, E);
    if (!this.current) this.newMovement();
    else nx._prev = this.current;
  };
  // FUN_180524e00
  Cycle.prototype.render = function (audio) {
    var E = this.E, i;
    if (!this.paused) { this.movementTimer--; this.effectsTimer--; }
    if (this.autoMovement && this.movementTimer < 1) {
      this.movementTimer = E.rand() % 390 + Math.max(60, (E.H / 3) | 0);
      this.newMovement();
    }
    if (this.autoEffects && this.effectsTimer < 1) {
      this.effectsTimer = E.rand() % 310 + 90;
      this.newEffects();
    }
    if (this.next) buildRows(this.next, E);
    // frame pipeline FUN_180523cd0
    var cm = this.current ? (this.current.mask | 0) : 0;
    for (i = 0; i < this.pre.length; i++) if (!(this.pre[i].mask & cm)) this.pre[i].render(audio, E);
    shiftApply(this.current, E);
    for (i = 0; i < this.post.length; i++) this.post[i].render(audio, E);
    blurDecay(E);
  };
  B.Cycle = Cycle;

  // registry key order (RegEnumKeyEx: case-insensitive, upper-cased ordinal compare)
  B.sortPresets = function (list) {
    return list.slice().sort(function (a, b) {
      var x = a.key.toUpperCase(), y = b.key.toUpperCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  };

  // ---------------------------------------------------------------- engine
  // opts: { W, H, resolution (0..2), seed, presets (JSON array, in any order), morph (default true), ctorSeed (default 1) }
  function Engine(opts) {
    opts = opts || {};
    var sz = opts.resolution != null ? B.SIZES[Math.max(0, Math.min(2, opts.resolution | 0))] : null;
    var W = opts.W || (sz ? sz[0] : 384), H = opts.H || (sz ? sz[1] : 288);
    this.W = W; this.H = H;
    this.front = new Uint8Array(W * H); this.back = new Uint8Array(W * H);
    this.pal = new Uint8Array(1024); this.palFrom = new Uint8Array(1024); this.palTarget = new Uint8Array(1024);
    for (var i = 0; i < 256; i++) this.pal[4 * i + 2] = i;
    this.palLocked = false; this.autoPal = true; this.palCountdown = 0; this.palReq = false;
    this.fading = false; this.forced = false; this.fadeLen = 0; this.fadeLeft = 0;
    this.morphEnabled = opts.morph !== false;
    this.stopCounter = 300; this.frameCount = 0;
    this.warnings = [];
    // class instances are built before srand(time) in the real code: their ctor rand() calls use the
    // unseeded CRT state (seed 1), then the stream is reseeded.
    this.rand = B.msvcRand(opts.ctorSeed != null ? opts.ctorSeed : 1);
    this.shifts = []; this.drawers = [];
    var n, C;
    for (n = 0; n < B.SHIFT_POOL.length; n++) {
      C = B.classes[B.SHIFT_POOL[n]];
      if (!C) { this.warn('class ' + B.SHIFT_POOL[n] + ' not loaded'); continue; }
      var s = new C(this); s.className = s.className || B.SHIFT_POOL[n]; shiftInit(s); this.shifts.push(s);
    }
    for (n = 0; n < B.DRAWER_LIST.length; n++) {
      C = B.classes[B.DRAWER_LIST[n]];
      if (!C) { this.warn('class ' + B.DRAWER_LIST[n] + ' not loaded'); continue; }
      var d = new C(this); d.className = d.className || B.DRAWER_LIST[n]; this.drawers.push(d);
    }
    // Extra classes (e.g. an effects collection loaded from another file): every registered class that is not in
    // the two random pools is instantiated for presets to use, but never picked by Random mode, so the random
    // stream and Random mode stay exactly as before. Built before the reseed below: ctor rand() calls are harmless.
    this.extraShifts = []; this.extraDrawers = [];
    Object.keys(B.classes).forEach(function (nm) {
      if (B.SHIFT_POOL.indexOf(nm) >= 0 || B.DRAWER_LIST.indexOf(nm) >= 0) return;
      var X = B.classes[nm], o = new X(this); o.className = o.className || nm;
      if (o instanceof B.Shift) { shiftInit(o); this.extraShifts.push(o); } else this.extraDrawers.push(o);
    }, this);
    var seed = opts.seed != null ? opts.seed : (Date.now() / 1000) | 0;
    this.seed = seed >>> 0;
    this.rand.seed(this.seed);
    this.presets = [new Cycle(this, null)];
    var ps = B.sortPresets(opts.presets || []);
    for (n = 0; n < ps.length; n++) this.presets.push(new Cycle(this, ps[n]));
    this.presetIndex = 0;
    this.presets[0].activate();
  }
  Engine.prototype.warn = function (m) { if (this.warnings.indexOf(m) < 0) { this.warnings.push(m); if (typeof console !== 'undefined') console.warn('Battery: ' + m); } };
  Engine.prototype.swap = function () { var t = this.front; this.front = this.back; this.back = t; };
  function findIn(list, name) { for (var i = 0; i < list.length; i++) if (list[i].className === name) return list[i]; return null; }
  Engine.prototype.findDrawer = function (name) { return findIn(this.drawers, name) || findIn(this.extraDrawers, name); };
  Engine.prototype.findShift = function (name) { return findIn(this.shifts, name) || findIn(this.extraShifts, name); };
  Engine.prototype.setPreset = function (i) {   // SetCurrentPreset
    i = Math.max(0, Math.min(this.presets.length - 1, i | 0));
    this.presets[this.presetIndex].deactivate();
    this.presetIndex = i;
    this.presets[i].activate();
  };
  Engine.prototype.presetTitles = function () { return this.presets.map(function (p) { return p.title; }); };

  // FUN_1805216ec. Returns true when the palette changed.
  Engine.prototype.paletteStep = function () {
    if (this.palReq) {
      this.palReq = false; this.forced = true; this.palFrom.set(this.pal); this.fading = true; this.fadeLen = this.fadeLeft = 25;
    }
    if (!this.palLocked || this.forced) {
      if (this.fading) {
        var t = this.fadeLen > 0 ? Math.fround((this.fadeLen - this.fadeLeft) / this.fadeLen) : 1;
        lerpPal(this.pal, this.palFrom, this.palTarget, t);
        this.fadeLeft--;
        if (this.fadeLeft < 1) {
          this.fading = this.forced = false;
          if (this.autoPal) this.palCountdown = this.rand() % 600;
        }
        return true;
      }
      if (this.autoPal && --this.palCountdown < 1) this.randomPalette();
    }
    return false;
  };
  function lerpPal(cur, from, to, t) {
    for (var i = 0; i < 1024; i++) {
      if ((i & 3) === 3) continue;
      cur[i] = from[i] + Math.trunc(Math.fround((to[i] - from[i]) * t));
    }
  }
  // FUN_180521cd0 -> FUN_180522f34, FUN_180522774
  Engine.prototype.randomPalette = function () {
    var R = this.rand, a = R(), b = R(), c = R();
    var n = 2 + c % ((a % 10) ? 4 : 10), keys = [], k, j;
    keys.push(gbr(R() % 32, R() % 32, R() % 32));
    keys.push(gbr(255 - R() % 32, 255 - R() % 32, 255 - R() % 32));
    for (k = 2; k < n; k++) keys.push(gbr(R() % 256, R() % 256, R() % 256));
    var desc = b % 10 === 0;
    for (k = 0; k < n; k++) for (j = k + 1; j < n; j++) {
      var sk = keys[k][0] + keys[k][1] + keys[k][2], sj = keys[j][0] + keys[j][1] + keys[j][2];
      if (desc ? sj > sk : sj < sk) { var tmp = keys[k]; keys[k] = keys[j]; keys[j] = tmp; }
    }
    var dur = R() % 250, seg = (256 / (n - 1)) | 0, T = this.palTarget;
    for (k = 0; k < n - 1; k++) {
      var s = k * seg, e = s + seg; if (k === n - 2) e = 255;
      for (j = s; j <= e; j++) {
        var t = Math.fround((j - s) / (e - s + 1));
        for (var ch = 0; ch < 3; ch++) T[4 * j + ch] = keys[k][ch] + Math.trunc(Math.fround((keys[k + 1][ch] - keys[k][ch]) * t));
        T[4 * j + 3] = 0;
      }
    }
    this.palFrom.set(this.pal); this.fadeLen = this.fadeLeft = dur; this.fading = true;
  };
  function gbr(g, b, r) { return [r, g, b]; }

  // Render(TimedLevel): audio = { freq:[u8[1024] x2], wave:[u8[1024] x2], state } (state 2 playing, 1 paused, 0 stopped)
  Engine.prototype.frame = function (audio) {
    var st = audio && audio.state != null ? audio.state : 2;
    if (st === 2) {
      this.stopCounter = 300;
      this.paletteStep();
      this.presets[this.presetIndex].render(audio);
      this.frameCount++;
    } else if (st === 0) {
      if (this.stopCounter > 0) {
        this.stopCounter--;
        blurDecay(this);
        var W = this.W, H = this.H, f = this.front, x, y;
        for (x = 0; x < W; x++) { f[x] = 1; f[(H - 1) * W + x] = 1; }
        for (y = 0; y < H; y++) { f[y * W] = 1; f[y * W + W - 1] = 1; }
      } else this.solid = true;
    }
    if (st !== 0) this.solid = false;
  };

  // RGBA lookup for presenting (entry 255 is never sent to the DDraw palette after creation: stays 0,0,255)
  Engine.prototype.lut = function (out) {
    out = out || new Uint32Array(256);
    var p = this.pal;
    for (var i = 0; i < 255; i++) out[i] = (0xff000000 | (p[4 * i + 2] << 16) | (p[4 * i + 1] << 8) | p[4 * i]) >>> 0;
    out[255] = 0xffff0000 >>> 0;
    return out;
  };
  // write the frame as RGBA into a Uint32Array(W*H) (e.g. ImageData buffer) - nearest-neighbour scaling is done by the canvas
  Engine.prototype.toRGBA = function (out32) {
    var L = this._lut = this.lut(this._lut), f = this.front, n = f.length;
    if (this.solid) { out32.fill(L[1]); return out32; }
    for (var i = 0; i < n; i++) out32[i] = L[f[i]];
    return out32;
  };
  B.Engine = Engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
