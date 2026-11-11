/* wmpaudio.js - bit-exact port of the audio analysis Windows Media Player (Win11 classic wmp.dll) uses to
 * build the TimedLevel it hands to visualizations (IWMPEffects::Render): frequency[2][1024] and
 * waveform[2][1024] bytes per frame. Spec and addresses: re/audio/WMP_AUDIO_SPEC.md.
 *
 * WMP does not analyse audio itself: its Media Foundation graph feeds PCM to the Resampler DMO
 * (resampledmo.dll, created via export #24) in "visualization" output mode, and wmp.dll copies each 0x1010-byte
 * output sample verbatim into TimedLevel. Per frame and channel (L, R; mono -> R = L):
 *   - 2048 samples starting at the read position; next frame starts sampleRate/30 samples later (30 fps).
 *   - x * Blackman-Harris(2048, symmetric) * 32768 -> real split-radix FFT (float32).
 *   - P[k] = (re^2 + im^2) / (4 * 1024^2) for k = 1..1023; P[0] = raw DC term (not squared - a WMP quirk).
 *   - if sampleRate/2048 != 22050/1024 (+-0.001): bins re-binned so 1024 bins always span 0..22050 Hz.
 *   - freq byte = clamp(round(31.875 * log10(P)), 0, 255) via WMP's own 2-table float-bits lookup (P<=0 -> 0).
 *   - wave byte = (int)(sample * 127) & 0xFF ^ 0x80 for the first 1024 samples of the window.
 *
 * API (plain script or CommonJS; globalThis.WmpAudio):
 *   var an = WmpAudio.createAnalyzer(sampleRate);    // any rate (WMP analyses at the stream/mix rate)
 *   an.push(leftFloat32, rightFloat32);               // right optional (mono). Any block size.
 *   an.level()   -> {freq:[Uint8Array(1024),Uint8Array(1024)], wave:[..,..], frame: n, state: 2}
 *                   = most recent complete frame (all zeros / wave 0x80 before the first one).
 *   an.onframe = function (lvl) {}                    // optional: called for every frame produced
 *   an.frames    -> frames produced so far; an.reset() -> forget buffered audio.
 *   an.levelInto(tl) copies into an existing {freq,wave} object (no allocation).
 *   WmpAudio.attach(audioContext, sourceNode, opts) -> Promise<{analyzer, node, disconnect()}>
 *     taps a Web Audio node (AudioWorklet from a Blob URL, so it works from file://; falls back to
 *     ScriptProcessor). The tap is connected to a zero-gain sink so it keeps running without adding sound.
 *     opts.onframe(level) optional.
 */
(function (root) {
  'use strict';
  var fr = Math.fround;
  var N = 2048, HALF = 1024;

  // ---- tables (built exactly like resampledmo.dll FUN_180002104 / data at 0x1800a1090, 0x1800a1490) ----
  var WIN = new Float32Array(N), TAB = new Float32Array(2 * N);
  (function () {
    var d = 6.283185307179586 / (N - 1), d2 = d + d, d3 = d * 3, i;
    for (i = 0; i < N; i++) {
      var v = 0.35875 - Math.cos(i * d) * 0.48829;
      v = v + Math.cos(i * d2) * 0.14128;
      v = v - Math.cos(i * d3) * 0.01168;
      WIN[i] = fr(fr(v) * 32768);
    }
    var st = Math.PI / N;
    TAB[0] = 0; TAB[N] = 0;
    for (i = 1; i < N / 2; i++) {
      var s = fr(Math.sin(st * i));
      TAB[i] = s; TAB[N - i] = s; TAB[N + i] = -s; TAB[2 * N - i] = -s;
    }
    TAB[N / 2] = 1; TAB[3 * N / 2] = -1;
  })();
  var LOG_E = new Int32Array(256), LOG_M = new Int32Array(2048);
  (function () {
    var k = 31.875, ke = k * Math.LOG10E * Math.LN2, i;
    for (i = 0; i < 256; i++) LOG_E[i] = (ke * (i - 127) + 0.5) | 0;            // C (int) truncation
    for (i = 0; i < 2048; i++) LOG_M[i] = Math.round(k * Math.log10(1 + i / 2048));
  })();
  var f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  function logByte(p) {
    f32[0] = p; var b = u32[0];
    var v = LOG_M[(b >>> 12) & 0x7ff] + LOG_E[(b >>> 23) & 0xff];
    return v > 255 ? 255 : (v < 0 ? 0 : v);
  }

  // ---- real split-radix FFT, exact op order of resampledmo.dll FUN_180078d14 (float32) ----
  var H = fr(0.70710677);
  function rfft(x) {
    var n = N, m = 11, i, j = 0, k, t;
    for (i = 0; i < n - 1; i++) {
      if (i < j) { t = x[j]; x[j] = x[i]; x[i] = t; }
      k = n >> 1;
      while (k <= j) { j -= k; k >>= 1; }
      j += k;
    }
    var is = 0, id = 4;
    do {
      for (i = is; i < n; i += id) { var a = x[i + 1], b = x[i]; x[i] = a + b; x[i + 1] = b - a; }
      is = 2 * id - 2; id <<= 2;
    } while (is < n - 1);
    var n2 = 4, s = n;
    for (var stage = 1; stage < m; stage++) {
      var n4 = n2 >> 2, n8 = n2 >> 3; s >>= 1; id = n2 * 2; is = 0;
      do {
        for (i = is; i < n; i += id) {
          var i1 = i, i2 = i + n4, i3 = i2 + n4, i4 = i3 + n4;
          var t1 = fr(x[i3] + x[i4]);
          x[i4] = x[i4] - x[i3];
          x[i3] = x[i1] - t1;
          x[i1] = t1 + x[i1];
          if (n4 > 1) {
            i1 += n8; i2 += n8; i3 += n8; i4 += n8;
            var t2 = fr(fr(x[i3] - x[i4]) * H);
            t1 = fr(fr(x[i3] + x[i4]) * H);
            x[i4] = x[i2] - t1;
            x[i3] = -x[i2] - t1;
            x[i2] = x[i1] - t2;
            x[i1] = t2 + x[i1];
          }
        }
        is = 2 * id - n2; id <<= 2;
      } while (is < n);
      for (var jj = 1; jj < n8; jj++) {
        var a1 = jj * s, a3 = 3 * jj * s;
        var cc1 = TAB[a1 + HALF], ss1 = TAB[a1], cc3 = TAB[a3 + HALF], ss3 = TAB[a3];
        id = n2 * 2; is = 0;
        do {
          for (i = is; i < n; i += id) {
            var q = i + 3 * n4 + jj;                  // i4
            var j1 = q - 3 * n4, j2 = q - 2 * n4, j3 = q - n4, j4 = q;
            var j7 = q - 2 * jj, j8 = q + n4 - 2 * jj, j6 = q - n4 - 2 * jj, j5 = j7 - 2 * n4;
            var u2 = fr(fr(x[j7] * cc1) - fr(x[j3] * ss1));
            var u1 = fr(fr(x[j3] * cc1) + fr(x[j7] * ss1));
            var u4 = fr(fr(x[j8] * cc3) - fr(x[j4] * ss3));
            var f5 = x[j6];
            var u3 = fr(fr(x[j4] * cc3) + fr(x[j8] * ss3));
            var u6 = fr(u4 + u2);
            u2 = fr(u2 - u4);
            var u5 = fr(u3 + u1);
            u1 = fr(u1 - u3);
            x[j3] = u6 - f5;
            x[j8] = f5 + u6;
            f5 = x[j2];
            x[j7] = -f5 - u1;
            x[j4] = f5 - u1;
            f5 = x[j1];
            x[j6] = f5 - u5;
            x[j1] = f5 + u5;
            f5 = x[j5];
            x[j5] = f5 - u2;
            x[j2] = f5 + u2;
          }
          is = 2 * id - n2; id <<= 2;
        } while (is < n);
      }
      n2 <<= 1;
    }
  }

  // ---- one channel of one frame (FUN_1800782a0, flag = 1 path, which the DMO's own output type selects) ----
  function spectrum(win, out, sampleRate, buf, tmp) {
    var i;
    for (i = 0; i < N; i++) buf[i] = win[i] * WIN[i];
    rfft(buf);
    var sc = fr(1 / (4 * HALF * HALF));
    for (i = 1; i < HALF; i++) buf[i] = fr(fr(fr(buf[i] * buf[i]) + fr(buf[N - i] * buf[N - i])) * sc);
    var srcW = fr(sampleRate / N), dstW = fr(22050 / HALF), diff = fr(dstW - srcW);
    if (diff < fr(-0.001) || diff > fr(0.001)) {
      var ratio = fr(dstW / srcW), rem = 1, src = 0;
      for (var o = 0; o < HALF && src < HALF; o++) {
        var acc = 0, need = ratio;
        while (need > 0) {
          var take = rem < need ? rem : need; if (take > 1) take = 1;
          rem = fr(rem - take);
          acc = fr(acc + fr(take * buf[src]));
          need = fr(need - take);
          if (!(rem > 0)) { rem = 1; src++; }
        }
        tmp[o] = acc;
      }
      for (; o < HALF; o++) tmp[o] = 0;
      for (i = 0; i < HALF; i++) buf[i] = tmp[i];
    }
    for (i = 0; i < HALF; i++) { var p = buf[i]; out[i] = logByte(p > 0 ? p : 1); }
  }
  function waveByte(x) {
    var v = fr(x * 127);
    if (!(v > -2147483649 && v < 2147483648)) return 0x80;   // cvttss2si overflow/NaN -> 0x80000000
    return ((v < 0 ? Math.ceil(v) : Math.floor(v)) & 0xff) ^ 0x80;
  }

  function waveByte16(x) {                                   // 16-bit PCM input: high byte ^ 0x80
    var v = Math.round(x * 32768); v = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
    return ((v >> 8) & 0xff) ^ 0x80;
  }

  // opts.int16: the floats are 16-bit PCM / 32768 (WMP fed 16-bit PCM). Changes only the wave bytes.
  function createAnalyzer(sampleRate, opts) {
    sampleRate = sampleRate | 0;
    var wb = opts && opts.int16 ? waveByte16 : waveByte;
    var hop = Math.floor(sampleRate / 30);                   // DMO+0x250 = rate / (1e7 / 333333)
    var CAP = 1 << 15; while (CAP < 4 * (N + hop)) CAP <<= 1;
    var ringF = [new Float32Array(CAP), new Float32Array(CAP)];
    var ringB = [new Uint8Array(CAP), new Uint8Array(CAP)];
    var written = 0, readPos = 0, chans = 2;
    var win = new Float32Array(N), buf = new Float32Array(N + 1), tmp = new Float32Array(HALF);
    var lvl = { freq: [new Uint8Array(HALF), new Uint8Array(HALF)], wave: [new Uint8Array(HALF), new Uint8Array(HALF)], frame: -1, state: 0 };
    lvl.wave[0].fill(0x80); lvl.wave[1].fill(0x80);
    var an = { sampleRate: sampleRate, hop: hop, frames: 0, onframe: null };

    function frame() {
      var c, i, base = readPos;
      for (c = 0; c < chans; c++) {
        var rf = ringF[c], rb = ringB[c], wv = lvl.wave[c];
        for (i = 0; i < N; i++) win[i] = rf[(base + i) & (CAP - 1)];
        spectrum(win, lvl.freq[c], sampleRate, buf, tmp);
        for (i = 0; i < HALF; i++) wv[i] = rb[(base + i) & (CAP - 1)];
      }
      if (chans === 1) { lvl.freq[1].set(lvl.freq[0]); lvl.wave[1].set(lvl.wave[0]); }
      lvl.frame = an.frames++; lvl.state = 2;
      readPos += hop;   // DMO: read += hop, or (if fewer than hop buffered) reset + skip the missing input
      if (an.onframe) an.onframe(lvl);
    }
    an.push = function (left, right, count) {   // count: use only the first count samples (no subarray needed)
      var n = count != null ? Math.min(count, left.length) : left.length, i = 0;
      chans = right ? 2 : 1;
      for (; i < n; i++) {
        var p = written & (CAP - 1), l = left[i];
        ringF[0][p] = l; ringB[0][p] = wb(l);
        if (right) { var r = right[i]; ringF[1][p] = r; ringB[1][p] = wb(r); }
        written++;
        if (written - readPos >= N) frame();
      }
    };
    an.level = function () { return lvl; };
    an.levelInto = function (t) {
      for (var c = 0; c < 2; c++) { t.freq[c].set(lvl.freq[c]); t.wave[c].set(lvl.wave[c]); }
      return t;
    };
    an.reset = function () { written = readPos = 0; };
    return an;
  }

  // ---- Web Audio wiring ----
  var WORKLET_SRC =
    "class WmpTap extends AudioWorkletProcessor{process(i){var c=i[0];if(c&&c.length){" +
    "this.port.postMessage([c[0].slice(0),c.length>1?c[1].slice(0):null]);}return true;}}" +
    "registerProcessor('wmp-tap',WmpTap);";
  function attach(ctx, source, opts) {
    opts = opts || {};
    var an = createAnalyzer(ctx.sampleRate);
    if (opts.onframe) an.onframe = opts.onframe;
    var sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
    function done(node) {
      source.connect(node); node.connect(sink);
      return { analyzer: an, node: node, disconnect: function () {
        try { source.disconnect(node); } catch (e) {} node.disconnect(); sink.disconnect();
        if (node.port) node.port.onmessage = null; else node.onaudioprocess = null; } };
    }
    function legacy() {
      var sp = ctx.createScriptProcessor(1024, 2, 2);
      sp.onaudioprocess = function (e) {
        var b = e.inputBuffer;
        an.push(b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : null);
      };
      return done(sp);
    }
    if (!opts.forceScriptProcessor && ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined' && typeof Blob !== 'undefined') {
      var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      return ctx.audioWorklet.addModule(url).then(function () {
        var node = new AudioWorkletNode(ctx, 'wmp-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        node.port.onmessage = function (e) { an.push(e.data[0], e.data[1]); };
        return done(node);
      }).catch(function () { return legacy(); });
    }
    return Promise.resolve(legacy());
  }

  var api = { createAnalyzer: createAnalyzer, attach: attach, FFT_SIZE: N, FPS: 30,
    _tables: { window: WIN, sin: TAB, logE: LOG_E, logM: LOG_M }, _rfft: rfft, _logByte: logByte };
  root.WmpAudio = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
