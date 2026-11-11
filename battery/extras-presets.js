// Battery remake - "Anthony's collection" presets (new, not from wmp.dll). Load after extras.js.
// Same shape as presets.js entries: pre/post drawers + current shift with dbl[8], PaletteLocked + a palette
// (built here from colour stops by Battery.Extras.palette). They mix the new extras classes with stock
// classes, including the ones Microsoft shipped but never used in a named preset (CGalaxy, CThingusShift,
// CTrigShift, CTrigStretchShift, CSinShimmerShift, CZoomShift, CEdgeFalloffShift).
var B = (typeof globalThis !== 'undefined' && globalThis.Battery) || require('./extras.js');
if (!B.Extras && typeof require === 'function') require('./extras.js');
(function (B) {
  'use strict';
  var P = B.Extras.palette;
  function d(cls, v) { var a = [0, 0, 0, 0, 0, 0, 0, 0]; for (var i = 0; i < v.length; i++) a[i] = v[i]; return { 'class': cls, dbl: a }; }
  function preset(key, title, pre, cur, post, stops) {
    return { key: key, title: title, PaletteLocked: 1, pre: pre, current: cur, post: post, palette: P(stops) };
  }
  B.EXTRA_PRESETS = [
    preset('x_rust', 'rust never sleeps',
      [d('CCogRing', [14, 2, 0.36, 0.12, 0.07, 3, 2, 5])], d('CThingusShift', [-0.08, 0.018]), [],
      [[0, 22, 10, 6], [90, 96, 38, 14], [170, 200, 110, 50], [255, 255, 236, 200]]),
    preset('x_cube', 'the cube remembers',
      [d('CWireCube', [0.5, 0.5, 0.05, 0, 6, 1, 0])], d('CZoomShift', [0.015, 0.016]), [],
      [[0, 6, 10, 24], [110, 24, 66, 96], [200, 120, 180, 190], [255, 236, 252, 250]]),
    preset('x_storm', 'summer storm warning',
      [], d('CTrigStretchShift', [-0.03, 0.035, 0, 0.12]), [d('CForkBolt', [1.25, 1, 0.18, 2, 6, 0.55, 3]), d('CCircleWaveform', [1, 1, 0.35])],
      [[0, 8, 4, 20], [140, 50, 26, 104], [215, 160, 130, 225], [255, 255, 250, 255]]),
    preset('x_tea', 'atomic tea party',
      [], d('CTrigShift', [-0.035, -0.012, 2]), [d('CAtomOrbits', [3, 0.75, 0.012, 0.08, 0, 10, 6])],
      [[0, 18, 16, 6], [130, 100, 86, 18], [210, 220, 196, 90], [255, 255, 252, 220]]),
    preset('x_hyper', 'hyperspace for beginners',
      [d('CStarTunnel', [220, 0.012, 2, 0.03, 1, 0, 120])], d('CStretchShift', [0.012, 0.08]), [],
      [[0, 2, 4, 18], [120, 30, 60, 150], [210, 140, 200, 250], [255, 250, 255, 255]]),
    preset('x_snow', 'snowflake in a blender',
      [d('CKaleidoWave', [6, 0.15, 0.75, 22, 0.012, 1, 64])], d('CKaleidoShift', [6, 0.012, 0.985, 0.04]), [],
      [[0, 8, 12, 24], [130, 50, 80, 112], [215, 170, 200, 226], [255, 255, 255, 255]]),
    preset('x_galaxy', 'galaxy with a toothache',
      [d('CGalaxy', [3, 20, 0.06, 230, 0, 40, 0, 0])], d('CSinShimmerShift', [2.2, 0.07, 0]), [d('CCogRing', [18, 1, 0.22, 0.14, 0.05, 2, 1])],
      [[0, 24, 6, 26], [100, 110, 30, 90], [190, 230, 120, 170], [255, 255, 235, 245]]),
    preset('x_moth', 'moth to the cube',
      [d('CJDar', [60, 3, 0, 16, 0.9, 0, 100])], d('CStarburstShift', [0.02, 0.12, 8, 0]), [d('CWireCube', [0.32, 0.3, 0.06, 1, 4, 2, 0.6])],
      [[0, 16, 18, 10], [110, 80, 96, 50], [200, 196, 206, 150], [255, 250, 255, 230]]),
    preset('x_jar', 'thunder in a jar',
      [d('CForkBolt', [1.2, 3, 0.22, 2, 5, 0.5, 2])], d('CEdgeFalloffShift', [0.03, 3]), [d('CSpectrumEdge', [6, 14, 8])],
      [[0, 10, 2, 16], [100, 90, 10, 80], [190, 230, 90, 190], [255, 255, 230, 255]]),
    preset('x_orbit', 'orbital drift',
      [d('CStarTunnel', [200, 0.01, 1.5, -0.02, 1, 0.3, 110])], d('CShiitake', [2.5, 0.02, 0.012, 2]), [d('CAtomOrbits', [4, 0.6, 0.008, 0.06, 0, 8, 3])],
      [[0, 6, 10, 14], [90, 30, 76, 70], [180, 140, 220, 180], [255, 240, 255, 240]]),
    preset('x_arms', 'spiral arms akimbo',
      [d('CGalaxy', [2, 15, 0.12, 210, 1, 60, 0, 0])], d('CKaleidoShift', [4, -0.02, 1.02, -0.05]), [d('CKaleidoWave', [4, 0.15, 0.6, 20, -0.008, 0, 48])],
      [[0, 20, 14, 4], [120, 140, 70, 10], [210, 250, 190, 80], [255, 255, 250, 220]]),
    preset('x_tin', 'tin heart',
      [d('CEdgeTrace', [30])], d('CRingSpinShift', [0.02, 0.3]), [d('CWireCube', [0.55, 0.6, 0.04, 2, 3, 1, 0])],
      [[0, 10, 14, 18], [110, 70, 90, 100], [200, 180, 200, 205], [255, 255, 255, 255]])
  ];
})(B);
if (typeof module !== 'undefined' && module.exports) module.exports = B;
