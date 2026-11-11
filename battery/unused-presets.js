// Battery remake - "Never-used originals": one simple preset per part that Microsoft built into Battery
// (wmp.dll) but never used in any of its 25 named presets. Before, these only appeared by chance in Random.
// Each preset uses ONLY stock Battery classes (no new effects); the recipes and palettes are our own.
// Names follow the WMP fan wiki's nicknames (wmpvis.fandom.com/wiki/Battery). Load after extras.js.
var B = (typeof globalThis !== 'undefined' && globalThis.Battery) || require('./extras.js');
if (!B.Extras && typeof require === 'function') require('./extras.js');
(function (B) {
  'use strict';
  var P = B.Extras.palette;
  function d(cls, v) { var a = [0, 0, 0, 0, 0, 0, 0, 0]; for (var i = 0; i < v.length; i++) a[i] = v[i]; return { 'class': cls, dbl: a }; }
  function preset(key, title, part, pre, cur, post, stops) {
    return { key: key, title: title, part: part, PaletteLocked: 1, pre: pre, current: cur, post: post, palette: P(stops) };
  }
  B.UNUSED_PRESETS = [
    preset('u_thingus', 'thingus', 'CThingusShift',
      [], d('CThingusShift', [-0.08, 0.018]), [d('CCircleWaveform', [1, 1, 0.35])],
      [[0, 20, 8, 4], [110, 120, 50, 18], [200, 220, 150, 90], [255, 255, 240, 210]]),
    preset('u_zoom', 'zoom', 'CZoomShift',
      [], d('CZoomShift', [0.015, 0.016]), [d('CJDar', [60, 3, 0, 16, 0.9, 0, 100])],
      [[0, 4, 14, 10], [120, 20, 100, 70], [205, 120, 210, 160], [255, 235, 255, 240]]),
    preset('u_trig', 'trig', 'CTrigShift',
      [], d('CTrigShift', [-0.035, -0.012, 2]), [d('CCircleWaveform', [2, 2, 0.6])],
      [[0, 10, 6, 22], [120, 70, 40, 130], [205, 190, 150, 230], [255, 255, 245, 255]]),
    preset('u_trigtunnel', 'trig tunnel', 'CTrigStretchShift',
      [], d('CTrigStretchShift', [-0.03, 0.035, 0, 0.12]), [d('CJDar', [60, 3, 0, 16, 0.9, 0, 100])],
      [[0, 6, 6, 18], [120, 30, 60, 120], [205, 110, 170, 230], [255, 230, 250, 255]]),
    preset('u_shimmer', 'shimmer', 'CSinShimmerShift',
      [], d('CSinShimmerShift', [2.2, 0.07, 0]), [d('CCircleWaveform', [3, 1, 1])],
      [[0, 14, 16, 12], [110, 70, 90, 70], [200, 170, 200, 170], [255, 245, 255, 245]]),
    preset('u_falloff', 'edge falloff', 'CEdgeFalloffShift',
      [d('CSpectrumEdge', [6, 14, 8])], d('CEdgeFalloffShift', [0.03, 3]), [d('CCircleWaveform', [1, 1, 0.35])],
      [[0, 18, 4, 8], [110, 130, 30, 30], [200, 240, 140, 80], [255, 255, 240, 200]]),
    preset('u_galaxy', 'galaxy', 'CGalaxy',
      [], d('CStretchShift', [0.012, 0.08]), [d('CGalaxy', [3, 20, 0.06, 230, 0, 40, 0, 0])],
      [[0, 4, 8, 20], [110, 40, 50, 140], [200, 150, 160, 240], [255, 250, 250, 255]])
  ];
  // append to an engine right after the stock presets (stock indices and Random are untouched)
  B.installUnused = function (E) {
    if (E._uFirst) return E._uFirst;
    var first = E.presets.length;
    for (var i = 0; i < B.UNUSED_PRESETS.length; i++) { var c = new B.Cycle(E, B.UNUSED_PRESETS[i]); c.unused = true; E.presets.push(c); }
    E._uFirst = first;
    return first;
  };
})(B);
if (typeof module !== 'undefined' && module.exports) module.exports = B;
