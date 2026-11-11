// Battery remake - shared base. Works as a plain <script> (sets globalThis.Battery) and in node (module.exports).
// Spec: re/battery/CORE_SPEC.md (engine), SHIFTS_SPEC.md, DRAWERS_SPEC.md, EDGES_SPEC.md.
// Class files (shifts.js, drawers.js, edges.js) register into Battery.classes by class name, e.g. 'CStretchShift'.
(function (root) {
  'use strict';
  var B = root.Battery || {};
  root.Battery = B;
  if (typeof module !== 'undefined' && module.exports) module.exports = B;

  B.classes = B.classes || {};

  // MSVC/ucrt rand(): state = state*214013 + 2531011; return (state >> 16) & 0x7fff
  B.msvcRand = function (seed) {
    var s = seed >>> 0;
    var r = function () { s = (Math.imul(s, 214013) + 2531011) >>> 0; return (s >>> 16) & 0x7fff; };
    r.seed = function (n) { s = n >>> 0; };
    return r;
  };

  // Engine context passed to every class:
  //   E.W, E.H        internal resolution (default 384x288)
  //   E.front         Uint8Array(W*H) palette-index buffer that drawers draw into (in place)
  //   E.back          the other buffer
  //   E.rand()        0..32767, the one shared rand stream (call order matters for exactness)
  // audio = { freq: [Uint8Array(1024), Uint8Array(1024)], wave: [Uint8Array(1024), Uint8Array(1024)], state }

  // Drawer / edge base (pre and post effects). Subclasses override what they need.
  B.Drawer = class Drawer {
    constructor() { this.dbl = new Float64Array(8); this.mask = 0; }
    randomizeParams(E) {}          // vtable slot 3 (uses E.rand)
    reset(E) {}                    // after params change / resize
    render(audio, E) {}            // vtable slot 4, draws into E.front in place
  };

  // Shift base. Subclasses implement map() and randomizeParams(); the engine owns build/morph/apply.
  // Per-class behaviour flags (set in the subclass constructor as the spec says):
  //   this.outOfRangeKeep: true  -> out-of-range axis keeps the destination coordinate
  //                        false -> out-of-range axis falls back to 0
  //   this.mask: incompatibility mask (+0xe0)
  B.Shift = class Shift {
    constructor() { this.dbl = new Float64Array(8); this.mask = 0; this.outOfRangeKeep = true; }
    randomizeParams(E) {}          // slot 3
    prepare(W, H, E) {}            // optional: precompute per-size values before a build
    map(x, y, E) { var r = this._r || (this._r = [0, 0]); r[0] = x; r[1] = y; return r; } // slot 8: dest pixel -> source pixel (ints; may call E.rand(), e.g. CSwirlShift)
  };

  B.register = function (name, cls) { B.classes[name] = cls; };
})(typeof globalThis !== 'undefined' ? globalThis : this);
