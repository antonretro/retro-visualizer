// Embed API for a host app (Android TV launcher WebView). Plain ES2015, no allocation in the per-frame paths
// (render loop, feedPcm, feedPcmBase64, feedLevel) once sizes and sample rate are stable.
// Needs (concatenated before this file by tools/build-embed.js): Battery engine + presets, BarsWaves,
// WmpAudio (analysis), ClassicPack (pack validation).
//
// window.feedPcm(Int16Array L, Int16Array R|null, sampleRate)   PCM -> exact analysis -> visuals
// window.feedPcmBase64(base64, channels, sampleRate)            interleaved little-endian int16 (from Kotlin)
// window.feedLevel({ freq: [L, R] | mono, wave: [L, R] | mono }) ready-made 1024-byte spectra/waveforms
// window.setVisualizer('battery' | 'barswaves')
// window.setPreset(nameOrIndex) / listPresets() -> [names] / currentPreset() -> name
// window.setOriginals(bool)                                      use the classic pack when loaded
// window.loadClassicPack(urlOrObject) -> Promise<{battery, barswaves}>   (also kept in localStorage)
// window.setSize(w, h) / pause() / resume() / setIdle('silence' | 'demo') / getStats()
(function (root) {
  'use strict';
  var B = root.Battery, BW = root.BarsWaves, WA = root.WmpAudio, CP = root.ClassicPack;
  var STEP_MS = 1000 / 30, MAX_W = 1280, MAX_H = 720, LS_ORIG = 'rvembed.originals', LS_VIS = 'rvembed.vis';

  var canvas = document.getElementById('vis') || (function () { var c = document.createElement('canvas'); c.id = 'vis'; document.body.appendChild(c); return c; })();
  var ctx = canvas.getContext('2d', { alpha: false });
  var off = document.createElement('canvas'), octx = off.getContext('2d', { alpha: false });
  var img = null, img32 = null;

  // one TimedLevel block; freq/wave are views of it (the drawers read .tl directly, no copy)
  var tl = new Uint8Array(4096);
  var level = { tl: tl, freq: [tl.subarray(0, 1024), tl.subarray(1024, 2048)], wave: [tl.subarray(2048, 3072), tl.subarray(3072, 4096)], state: 2, stamp: 0 };
  level.wave[0].fill(0x80); level.wave[1].fill(0x80);

  var vis = lsGet(LS_VIS) === 'barswaves' ? 'barswaves' : 'battery';
  var outW = 0, outH = 0, engW = 0, engH = 0, bwScale = 0;
  var bat = null, bw = null, pack = null, originals = lsGet(LS_ORIG) !== '0';
  // time bookkeeping in integers / a Float64Array: doubles kept in closure variables are re-boxed on every store
  var running = true, idle = 'silence', source = 'none', steps = 0, fedAt = -1000000;
  var TK = new Float64Array(2);   // TK[0] = accumulated ms, TK[1] = last rAF time (-1: none)
  TK[1] = -1;
  var analyzer = null, anRate = 0, fL = new Float32Array(4096), fR = new Float32Array(4096), b64buf = new Uint8Array(16384);
  var stats = { frames: 0, stepMs: 0, presentMs: 0, maxMs: 0 };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  try { var saved = lsGet('rvembed.pack'); if (saved) pack = CP.validate(JSON.parse(saved)); } catch (e) { pack = null; }

  // built-in presets + collection, plus the classic ones (from the user's own Windows) when loaded and on
  function batteryList() { return B.PRESETS.concat(B.COLLECTION || [], originals && pack && pack.battery ? pack.battery : []); }
  function styleList() { return BW.STYLES.concat(originals && pack && pack.barswaves ? pack.barswaves : []); }

  // ---- engines and buffers (allocated here only: on size / visualizer / preset-list changes)
  function build(keepPreset) {
    var name = keepPreset ? currentPreset() : null;
    if (vis === 'battery') {
      var w = Math.max(256, Math.min(1024, Math.round(288 * outW / Math.max(1, outH) / 2) * 2));
      var oldPal = bat ? bat.pal : null;
      if (B.poolClear) B.poolClear();
      bat = new B.Engine({ presets: batteryList(), seed: (Date.now() / 1000) | 0, W: w, H: 288 });
      if (oldPal) { bat.pal.set(oldPal); bat.palFrom.set(oldPal); }
      bw = null; engW = bat.W; engH = bat.H;
    } else {
      bwScale = outW > 960 ? 2 : 1;   // 1280x720 output -> the spectrum draws at 640x360, scaled x2
      engW = Math.max(4, Math.floor(outW / bwScale)); engH = Math.max(3, Math.floor(outH / bwScale));
      if (!bw) { bw = new BW.Engine({ seed: 1 }); bw.mediaInfo(2); }
      bw.setStyles(styleList()); bw.setPreset(0); bw.resize(engW, engH);
      bat = null;
    }
    off.width = engW; off.height = engH;
    img = octx.createImageData(engW, engH); img32 = new Uint32Array(img.data.buffer);
    if (name) setPreset(name);
  }
  function setSize(w, h) {
    w = Math.max(16, Math.min(MAX_W, w | 0 || window.innerWidth || MAX_W));
    h = Math.max(16, Math.min(MAX_H, h | 0 || window.innerHeight || MAX_H));
    if (w === outW && h === outH && (bat || bw)) return;
    outW = w; outH = h;
    canvas.width = w; canvas.height = h;
    canvas.style.width = '100%'; canvas.style.height = '100%';
    build(true);
  }

  // ---- audio input
  function ensureAnalyzer(rate) {
    rate = rate | 0 || 44100;
    if (!analyzer || anRate !== rate) { analyzer = WA.createAnalyzer(rate, { int16: true }); anRate = rate; }
  }
  function growF(n) { if (fL.length < n) { var m = fL.length; while (m < n) m *= 2; fL = new Float32Array(m); fR = new Float32Array(m); } }
  // Int16 L/R (R optional) -> analyzer, through reusable Float32 scratch buffers (grown once, never per call)
  function feedPcm(L, R, sampleRate) {
    if (!L || !L.length) return;
    ensureAnalyzer(sampleRate);
    var n = L.length, i, k = 1 / 32768;
    growF(n);
    for (i = 0; i < n; i++) fL[i] = L[i] * k;
    if (R) for (i = 0; i < n; i++) fR[i] = R[i] * k;
    analyzer.push(fL, R ? fR : null, n);
    source = 'pcm'; fedAt = steps;
  }
  var B64 = new Int16Array(256);
  (function () { B64.fill(-1); var a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; for (var i = 0; i < 64; i++) B64[a.charCodeAt(i)] = i; B64[45] = 62; B64[95] = 63; })();
  // interleaved little-endian int16 PCM as base64 (what a Kotlin AudioRecord/Visualizer tap can push cheaply)
  function feedPcmBase64(s, channels, sampleRate) {
    if (!s) return;
    var maxBytes = (s.length >> 2) * 3 + 3;
    if (b64buf.length < maxBytes) { var m = b64buf.length; while (m < maxBytes) m *= 2; b64buf = new Uint8Array(m); }
    var n = 0, acc = 0, bits = 0, i, v;
    for (i = 0; i < s.length; i++) {
      v = B64[s.charCodeAt(i) & 255]; if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; b64buf[n++] = (acc >> bits) & 255; }
    }
    ensureAnalyzer(sampleRate);
    var ch = channels === 1 ? 1 : 2, frames = (n / (2 * ch)) | 0, k = 1 / 32768;
    growF(frames);
    for (i = 0; i < frames; i++) {
      var o = i * 2 * ch, l = (b64buf[o] | b64buf[o + 1] << 8) << 16 >> 16;
      fL[i] = l * k;
      if (ch === 2) fR[i] = ((b64buf[o + 2] | b64buf[o + 3] << 8) << 16 >> 16) * k;
    }
    analyzer.push(fL, ch === 2 ? fR : null, frames);
    source = 'pcm'; fedAt = steps;
  }
  function copy1024(dst, src) { if (!src) return; var n = Math.min(1024, src.length); for (var i = 0; i < n; i++) dst[i] = src[i]; }
  function feedLevel(o) {
    if (!o) return;
    var f = o.freq, w = o.wave, two;
    if (f) { two = f.length === 2 && f[0] && f[0].length; copy1024(level.freq[0], two ? f[0] : f); copy1024(level.freq[1], two ? f[1] : f); }
    if (w) { two = w.length === 2 && w[0] && w[0].length; copy1024(level.wave[0], two ? w[0] : w); copy1024(level.wave[1], two ? w[1] : w); }
    source = 'level'; fedAt = steps;
  }

  // synthetic beat for idle / testing (same as the players' Demo beat)
  var demoT = 0, demoSeed = 12345;
  function noise() { demoSeed = (Math.imul(demoSeed, 1103515245) + 12345) >>> 0; return (demoSeed >>> 16) / 65536; }
  var BASS = [55, 55, 65.4, 49];
  function demoFill() {
    var t = demoT++ / 30, beat = t * 2, ph = beat - Math.floor(beat);
    var kick = Math.exp(-ph * 7), hat = Math.exp(-(((beat + 0.5) % 1)) * 18), bar = Math.floor(beat) % 8, bassNote = BASS[(bar >> 1) & 3];
    for (var ch = 0; ch < 2; ch++) {
      var F = level.freq[ch], Wv = level.wave[ch];
      for (var i = 0; i < 1024; i++) {
        var hz = i * 21.53;
        var v = 70 * Math.exp(-i / 160) + 150 * kick * Math.exp(-i / 18) + 90 * hat * Math.exp(-Math.abs(i - 600) / 220) +
          60 * Math.exp(-Math.abs(hz - bassNote * 2) / 40) + 18 * noise();
        F[i] = Math.max(0, Math.min(255, v | 0));
        var s = t + i / 44100;
        var a = 0.55 * kick * Math.sin(2 * Math.PI * (50 + 80 * kick) * s) + 0.25 * Math.sin(2 * Math.PI * bassNote * s + ch) +
          0.12 * hat * (noise() * 2 - 1) + 0.08 * Math.sin(2 * Math.PI * 440 * s * (1 + 0.003 * ch));
        Wv[i] = Math.max(0, Math.min(255, 128 + a * 127 | 0));
      }
    }
  }

  // ---- loop: fixed 30 engine steps per second, present after each batch of steps
  function step() {
    var stale = steps - fedAt > 60;   // nothing fed for 2 s (60 steps)
    steps++;
    if (source === 'pcm' && !stale) analyzer.levelInto(level);
    else if (stale && idle === 'demo') demoFill();
    else if (stale && source !== 'none') { level.freq[0].fill(0); level.freq[1].fill(0); level.wave[0].fill(0x80); level.wave[1].fill(0x80); source = 'none'; }
    level.state = 2; level.stamp += 333333;
    if (bat) bat.frame(level); else if (bw) bw.frame(level);
  }
  function present() {
    if (bat) bat.toRGBA(img32); else bw.toRGBA(img32);
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, outW, outH);
  }
  function tick(now) {
    if (!running) return;
    if (TK[1] < 0) TK[1] = now;
    TK[0] += Math.min(250, now - TK[1]); TK[1] = now;
    var n = 0, t0 = performance.now();
    while (TK[0] >= STEP_MS && n < 3) { TK[0] -= STEP_MS; n++; step(); }
    if (n) {
      var t1 = performance.now(); present(); var t2 = performance.now();
      stats.frames++; stats.stepMs = stats.stepMs * 0.95 + (t1 - t0) / n * 0.05; stats.presentMs = stats.presentMs * 0.95 + (t2 - t1) * 0.05;
      if (t2 - t0 > stats.maxMs) stats.maxMs = t2 - t0;
    }
    requestAnimationFrame(tick);
  }

  // ---- presets
  function names() {
    if (bat) return bat.presets.map(function (c, i) { return i === 0 ? 'Random' : c.title; });
    return bw.presets.map(function (s) { return s.title; });
  }
  function currentPreset() {
    if (bat) return bat.presetIndex === 0 ? 'Random' : bat.presets[bat.presetIndex].title;
    if (bw) return bw.presets[bw.presetIndex] ? bw.presets[bw.presetIndex].title : null;
    return null;
  }
  function setPreset(p) {
    var list = names(), i = typeof p === 'number' ? p : list.indexOf(p);
    if (i < 0 && typeof p === 'string') { var lp = p.toLowerCase(); for (var k = 0; k < list.length; k++) if (list[k].toLowerCase() === lp) i = k; }
    if (i < 0 || i >= list.length) return false;
    if (bat) bat.setPreset(i); else bw.setPreset(i);
    return true;
  }
  function setVisualizer(v) {
    v = v === 'barswaves' ? 'barswaves' : 'battery';
    if (v === vis && (bat || bw)) return true;
    vis = v; lsSet(LS_VIS, v); build(false); return true;
  }
  function setOriginals(on) { originals = !!on; lsSet(LS_ORIG, originals ? '1' : '0'); build(false); return !!(originals && pack); }
  function loadClassicPack(src) {
    return new Promise(function (ok, no) {
      function use(obj) {
        try { pack = CP.validate(obj); } catch (e) { no(e); return; }
        lsSet('rvembed.pack', JSON.stringify(pack));
        build(false);
        ok({ battery: pack.battery ? pack.battery.length : 0, barswaves: pack.barswaves ? pack.barswaves.length : 0 });
      }
      if (src && typeof src === 'object') { use(src); return; }
      if (typeof src === 'string' && src.charAt(0) === '{') { try { use(JSON.parse(src)); } catch (e) { no(e); } return; }
      var x = new XMLHttpRequest();   // XHR, not fetch: works for file:// in an Android WebView with file access on
      x.open('GET', src, true); x.responseType = 'text';
      x.onload = function () { if (x.status && x.status !== 200) { no(new Error('HTTP ' + x.status)); return; } try { use(JSON.parse(x.responseText)); } catch (e) { no(e); } };
      x.onerror = function () { no(new Error('Cannot read ' + src)); };
      x.send();
    });
  }
  function pause() { running = false; }
  function resume() { if (!running) { running = true; TK[1] = -1; TK[0] = 0; requestAnimationFrame(tick); } }

  var api = {
    feedPcm: feedPcm, feedPcmBase64: feedPcmBase64, feedLevel: feedLevel,
    setVisualizer: setVisualizer, getVisualizer: function () { return vis; },
    setPreset: setPreset, listPresets: names, currentPreset: currentPreset,
    setOriginals: setOriginals, hasClassicPack: function () { return !!pack; }, loadClassicPack: loadClassicPack,
    clearClassicPack: function () { pack = null; try { localStorage.removeItem('rvembed.pack'); } catch (e) {} build(false); },
    setSize: setSize, pause: pause, resume: resume,
    setIdle: function (m) { idle = m === 'demo' ? 'demo' : 'silence'; },
    getStats: function () { return { fps30Steps: true, frames: stats.frames, stepMs: +stats.stepMs.toFixed(2), presentMs: +stats.presentMs.toFixed(2), maxMs: +stats.maxMs.toFixed(2), engine: engW + 'x' + engH, output: outW + 'x' + outH }; },
    _level: level, _step: step, _present: present
  };
  root.RetroVisualizer = api;
  Object.keys(api).forEach(function (k) { if (k.charAt(0) !== '_') root[k] = api[k]; });

  setSize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', function () { setSize(window.innerWidth, window.innerHeight); });
  requestAnimationFrame(tick);
  if (root.onRetroVisualizerReady) root.onRetroVisualizerReady(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
