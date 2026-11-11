// Built-in presets for the plasma visualizer. These are ORIGINAL recipes made for this project (own class
// combinations, own parameters, own palettes); none is a copy of a stock preset. The classic presets are
// not included: users load them from their own copy of Windows (see ../common/classic.js).
// Format = the engine's preset layout: { key, title, PaletteLocked, pre:[{class, dbl}], current:{class, dbl},
// post:[...], palette: 256 x RGB0 as hex (built here from gradient stops) }.
(function (root) {
  var B = root.Battery = root.Battery || {};
  if (typeof module !== 'undefined' && module.exports) module.exports = B;

  // stops: [[index 0..255, '#rrggbb'], ...] -> 2048 hex chars (R, G, B, 0 per entry), linear in between
  function grad(stops) {
    var out = '', s = 0;
    function rgb(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
    for (var i = 0; i < 256; i++) {
      while (s < stops.length - 2 && i > stops[s + 1][0]) s++;
      var a = stops[s], b = stops[Math.min(s + 1, stops.length - 1)], ca = rgb(a[1]), cb = rgb(b[1]);
      var t = b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (i - a[0]) / (b[0] - a[0])));
      for (var c = 0; c < 3; c++) { var v = Math.round(ca[c] + (cb[c] - ca[c]) * t); out += (v < 16 ? '0' : '') + v.toString(16).toUpperCase(); }
      out += '00';
    }
    return out;
  }
  function d(a) { var r = a.slice(); while (r.length < 8) r.push(0); return r; }

  B.PRESETS = [
    { key: 'ember-bloom', title: 'Ember Bloom', PaletteLocked: 1,
      pre: [{ 'class': 'CJiggyScribble', dbl: d([24, 150, 900, 5, 0.12, 2, 1]) }],
      current: { 'class': 'CZoomShift', dbl: d([0.012, -0.045]) },
      post: [{ 'class': 'CCircleWaveform', dbl: d([0, 1, 0.35]) }],
      palette: grad([[0, '#000000'], [50, '#3a0400'], [120, '#c42800'], [190, '#ff9a10'], [240, '#fff2b0'], [255, '#ffffff']]) },

    { key: 'glacier-drift', title: 'Glacier Drift', PaletteLocked: 1,
      pre: [{ 'class': 'CWaveEdge', dbl: d([0]) }],
      current: { 'class': 'CTwirlocity', dbl: d([6, 0.3, 3]) },
      post: [{ 'class': 'CJDar', dbl: d([40, 2, 0, 16, 1.2, 0, 100]) }],
      palette: grad([[0, '#00040c'], [70, '#06305a'], [150, '#2aa0c0'], [215, '#bff0f4'], [255, '#ffffff']]) },

    { key: 'neon-tunnel', title: 'Neon Tunnel', PaletteLocked: 1,
      pre: [{ 'class': 'CSpectrumEdge', dbl: d([3, 8, 9]) }],
      current: { 'class': 'CTrigShift', dbl: d([0.02, 0.03, 1]) },
      post: [{ 'class': 'CCircleWaveform', dbl: d([3, 3, 0.25]) }],
      palette: grad([[0, '#000000'], [60, '#2a0050'], [130, '#d000c0'], [190, '#20e0ff'], [255, '#f0ffff']]) },

    { key: 'moss-vortex', title: 'Moss Vortex', PaletteLocked: 1,
      pre: [{ 'class': 'CEdgeTrace', dbl: d([48]) }],
      current: { 'class': 'CSwirlShift', dbl: d([0.03, -6, 7]) },
      post: [{ 'class': 'CJiggyScribble', dbl: d([12, 90, 600, 3, 0.2, 0, 9]) }],
      palette: grad([[0, '#020600'], [80, '#1d3a08'], [160, '#6fa22a'], [220, '#d8f08a'], [255, '#fbffe0']]) },

    { key: 'solar-lattice', title: 'Solar Lattice', PaletteLocked: 1,
      pre: [],
      current: { 'class': 'CTileShift', dbl: d([0.07]) },
      post: [{ 'class': 'CDotPlane', dbl: d([28, 4]) }],
      palette: grad([[0, '#000818'], [70, '#0a2a6a'], [140, '#7060a0'], [200, '#f0b040'], [255, '#fff8d0']]) },

    { key: 'ink-in-water', title: 'Ink in Water', PaletteLocked: 1,
      pre: [{ 'class': 'CCosEdgeGradiant', dbl: d([0.03]) }],
      current: { 'class': 'CShiitake', dbl: d([2.5, 0.04, 0.012, 4]) },
      post: [],
      palette: grad([[0, '#f4ead8'], [90, '#c8a878'], [170, '#5a3a20'], [235, '#140a04'], [255, '#000000']]) },

    { key: 'candy-ripple', title: 'Candy Ripple', PaletteLocked: 1,
      pre: [{ 'class': 'CEdgeGradiant', dbl: d([]) }],
      current: { 'class': 'CSinShimmerShift', dbl: d([1.5, 0.6, 0]) },
      post: [{ 'class': 'CCircleWaveform', dbl: d([1, 2, 0.55]) }],
      palette: grad([[0, '#1a0820'], [80, '#ff70b0'], [150, '#ffd0e0'], [200, '#80f0c8'], [255, '#ffffff']]) },

    { key: 'deep-sonar', title: 'Deep Sonar', PaletteLocked: 1,
      pre: [{ 'class': 'CEdgeTrace', dbl: d([60]) }],
      current: { 'class': 'CRingSpinShift', dbl: d([0.02, 0.45]) },
      post: [{ 'class': 'CCircleWaveform', dbl: d([3, 2, 0.45]) }],
      palette: grad([[0, '#000400'], [100, '#003a10'], [190, '#20c040'], [245, '#c0ffc0'], [255, '#ffffff']]) },

    { key: 'tidal-shear', title: 'Tidal Shear', PaletteLocked: 1,
      pre: [{ 'class': 'CWaveEdge', dbl: d([1]) }],
      current: { 'class': 'CTrigStretchShift', dbl: d([-0.01, -0.025, 2, 0.12]) },
      post: [{ 'class': 'CJiggyScribble', dbl: d([50, 120, 360, 7, 0.08, 1, 2]) }],
      palette: grad([[0, '#000a10'], [60, '#003850'], [140, '#00a0a0'], [200, '#f0e0a0'], [255, '#fffaf0']]) },

    { key: 'starfield-fold', title: 'Starfield Fold', PaletteLocked: 1,
      pre: [],
      current: { 'class': 'CThingusShift', dbl: d([0.25, 0.06]) },
      post: [{ 'class': 'CGalaxy', dbl: d([3, 30, 0.08, 230, 4, 50, 0.0000002, 0.15]) }],
      palette: grad([[0, '#00000a'], [90, '#1a1050'], [170, '#8050c0'], [225, '#ffc0f0'], [255, '#ffffff']]) },

    { key: 'rust-engine', title: 'Rust Engine', PaletteLocked: 1,
      pre: [{ 'class': 'CEdgeGradiant', dbl: d([]) }],
      current: { 'class': 'CEdgeFalloffShift', dbl: d([0.05, 2]) },
      post: [{ 'class': 'CJiggyScribble', dbl: d([70, 180, 700, 13, 0.3, 0, 9]) }],
      palette: grad([[0, '#080402'], [70, '#4a1c08'], [150, '#b0501a'], [210, '#e8b070'], [255, '#fff0e0']]) },

    { key: 'prism-drift', title: 'Prism Drift', PaletteLocked: 1,
      pre: [{ 'class': 'CSpectrumEdge', dbl: d([6, 4, 12]) }],
      current: { 'class': 'CLinearShift', dbl: d([1, -2]) },
      post: [{ 'class': 'CDotPlane', dbl: d([40, 1]) }],
      palette: grad([[0, '#000000'], [40, '#400060'], [90, '#0040ff'], [140, '#00e080'], [190, '#ffe000'], [235, '#ff2000'], [255, '#ffffff']]) }
  ];
})(typeof globalThis !== 'undefined' ? globalThis : this);
