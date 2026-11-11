/*
 * music.js - shared "Music" panel + audio sources for the visualizer players.
 * Plain ES2015 script (no modules, no build), works from file:// and http(s)://.
 *
 *   <script src="../common/midi-sf2.js"></script>   (optional: MIDI + SoundFont playback)
 *   <script src="../common/music.js"></script>
 *
 *   var music = WmpMusic.create({
 *     bar: document.getElementById('music'),   // element in the player's bar; Music/transport/Demo/Mic buttons go here
 *     onStatus: function (text) {},            // now-playing / messages for the bar status
 *     onActivity: function () {},              // the panel was used (keeps the auto-hiding UI awake)
 *     volume: 80,                              // 0..100 (output only; visuals read the signal BEFORE volume)
 *     analyzer: WmpMusic.analyserStage         // optional: the level-producing stage (see below)
 *   });
 *   each engine step:  if (!music.isPaused()) { music.sampleLevel(level); E.frame(level); }
 *   music.setVolume(v) / getVolume() / togglePause() / isPaused() / next() / prev()
 *   music.openPanel() / closePanel() / togglePanel() / isPanelOpen()
 *   music.setUiHidden(bool)   hide/show the panel together with the player's bar (it stays "open")
 *   music.isActive()          true while the panel is hovered or being used (don't auto-hide then)
 *   music.nowPlaying()        current title
 *   music.audioContext / music.tap   (null until the first sound starts: browsers need a click first)
 *
 * level = { freq: [Uint8Array(1024) x2], wave: [Uint8Array(1024) x2], state } (WMP's TimedLevel layout).
 *
 * Audio graph:
 *   every source --> tap (GainNode, gain 1, 2 ch explicit, mono up-mixed to L=R) --> analyzer stage
 *               \-> out (GainNode = volume slider) --> speakers          (the mic is not sent to the speakers)
 *   The tap is the raw, pre-volume signal: anything that wants the samples connects to music.tap.
 *
 * Analyzer stage = function (audioContext, tap) -> { sample(level), dispose() }.
 *   Default WmpMusic.analyserStage: L/R AnalyserNodes (fftSize 2048, smoothing 0, -100..-30 dB),
 *   freq = getByteFrequencyData, wave = newest 1024 samples of getByteTimeDomainData (an approximation).
 *   To use exact WMP maths (web/common/wmpaudio.js, createAnalyzer(sampleRate) -> {push(left, right), level()}):
 *     WmpMusic.create({ ..., analyzer: WmpMusic.pcmStage(WmpAudio.createAnalyzer) })
 *   or at run time: music.setAnalyzer(WmpMusic.pcmStage(WmpAudio.createAnalyzer)).
 *   pcmStage feeds Float32Array L/R blocks (ScriptProcessorNode, works on file:// where AudioWorklet
 *   modules can't load) to push(), and sample(level) copies level().freq[ch] / .wave[ch] (any array-likes of
 *   1024 bytes) into the player's level. Adapt the two lines marked ADAPT if wmpaudio's API differs.
 *   While the Demo beat is selected (or a radio station blocks analysis) the synthetic demo level is used.
 */
(function (root) {
  'use strict';
  var AUDIO_RE = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm|weba|wma|mp4|m4b)$/i;
  var MIDI_RE = /\.(mid|midi|kar|rmi)$/i, SF2_RE = /\.sf2$/i;
  var K_FAVS = 'wmpmusic.radio.favs', K_NOVIZ = 'wmpmusic.radio.noviz', K_OPTS = 'wmpmusic.options', K_SOUND = 'wmpmusic.sound';
  var DLS_PATH = 'C:\\Windows\\System32\\drivers\\gm.dls';
  var SOUNDS = [['retro', 'Retro Synth'], ['windows', 'Windows (gm.dls)'], ['sf2', 'SoundFont']];
  var API_SERVERS = ['https://de1.api.radio-browser.info', 'https://de2.api.radio-browser.info', 'https://fi1.api.radio-browser.info'];
  var MAX_ROWS = 300;

  function lsGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (k === 'text') el.textContent = v;
      else if (k === 'cls') el.className = v;
      else if (k.slice(0, 2) === 'on') el[k] = v;
      else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function readFile(f) {
    return f.arrayBuffer ? f.arrayBuffer() : new Promise(function (ok, no) {
      var r = new FileReader(); r.onload = function () { ok(r.result); }; r.onerror = no; r.readAsArrayBuffer(f);
    });
  }
  function isMediaName(n) { return AUDIO_RE.test(n) || MIDI_RE.test(n); }
  function trackFromFile(f, path) {
    return { type: MIDI_RE.test(f.name) ? 'midi' : 'audio', name: f.name, path: path || f.webkitRelativePath || f.name, file: f };
  }
  function errText(e) { return (e && (e.message || e.name)) || String(e); }

  // ------------------------------------------------------------------ IndexedDB (folder handle memory)
  function idb(mode, fn) {
    return new Promise(function (ok, no) {
      if (!root.indexedDB) { no(new Error('no IndexedDB')); return; }
      var r;
      try { r = indexedDB.open('wmp-music', 1); } catch (e) { no(e); return; }
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onerror = function () { no(r.error); };
      r.onsuccess = function () {
        var db = r.result, tx, q;
        try { tx = db.transaction('kv', mode); q = fn(tx.objectStore('kv')); } catch (e) { db.close(); no(e); return; }
        tx.oncomplete = function () { db.close(); ok(q && q.result); };
        tx.onerror = tx.onabort = function () { db.close(); no(tx.error); };
      };
    });
  }

  // ------------------------------------------------------------------ analyzer stages
  function analyserStage(actx, tap) {
    var sp = actx.createChannelSplitter(2), anL = actx.createAnalyser(), anR = actx.createAnalyser();
    [anL, anR].forEach(function (a) { a.fftSize = 2048; a.smoothingTimeConstant = 0; a.minDecibels = -100; a.maxDecibels = -30; });
    tap.connect(sp); sp.connect(anL, 0); sp.connect(anR, 1);
    var tdL = new Uint8Array(2048), tdR = new Uint8Array(2048);
    return {
      name: 'analyser',
      sample: function (level) {
        anL.getByteFrequencyData(level.freq[0]); anR.getByteFrequencyData(level.freq[1]);
        anL.getByteTimeDomainData(tdL); anR.getByteTimeDomainData(tdR);
        level.wave[0].set(tdL.subarray(1024)); level.wave[1].set(tdR.subarray(1024));
      },
      dispose: function () { try { tap.disconnect(sp); } catch (e) {} }
    };
  }
  function pcmStage(createAnalyzer, opts) {
    return function (actx, tap) {
      var a = createAnalyzer(actx.sampleRate);
      var sp = actx.createScriptProcessor((opts && opts.bufferSize) || 1024, 2, 2), mute = actx.createGain();
      mute.gain.value = 0;   // a ScriptProcessor only runs when connected to the destination
      tap.connect(sp); sp.connect(mute); mute.connect(actx.destination);
      sp.onaudioprocess = function (e) {
        var ib = e.inputBuffer;
        a.push(ib.getChannelData(0), ib.getChannelData(ib.numberOfChannels > 1 ? 1 : 0));   // ADAPT
      };
      return {
        name: 'pcm', analyzer: a,
        sample: function (level) {
          var r = a.level();                                                                  // ADAPT
          for (var ch = 0; ch < 2; ch++) {
            if (r && r.freq && r.freq[ch]) level.freq[ch].set(r.freq[ch].length > 1024 ? r.freq[ch].subarray(0, 1024) : r.freq[ch]);
            if (r && r.wave && r.wave[ch]) level.wave[ch].set(r.wave[ch].length > 1024 ? r.wave[ch].subarray(0, 1024) : r.wave[ch]);
          }
        },
        dispose: function () { sp.onaudioprocess = null; try { tap.disconnect(sp); sp.disconnect(); mute.disconnect(); } catch (e) {} }
      };
    };
  }

  // ------------------------------------------------------------------ demo beat (synthetic TimedLevel)
  // 120 BPM kick, off-beat hats, bass line; 30 calls per second (one per engine step).
  function DemoBeat() { this.t = 0; this.seed = 12345; }
  DemoBeat.prototype.noise = function () { this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0; return (this.seed >>> 16) / 65536; };
  DemoBeat.prototype.fill = function (level) {
    var t = this.t++ / 30, beat = t * 2, ph = beat - Math.floor(beat);
    var kick = Math.exp(-ph * 7), hat = Math.exp(-(((beat + 0.5) % 1)) * 18), bar = Math.floor(beat) % 8;
    var bassNote = [55, 55, 65.4, 49][(bar >> 1) & 3];
    for (var ch = 0; ch < 2; ch++) {
      var F = level.freq[ch], Wv = level.wave[ch];
      for (var i = 0; i < 1024; i++) {
        var hz = i * 21.53;
        var v = 70 * Math.exp(-i / 160) + 150 * kick * Math.exp(-i / 18) + 90 * hat * Math.exp(-Math.abs(i - 600) / 220)
              + 60 * Math.exp(-Math.abs(hz - bassNote * 2) / 40) + 18 * this.noise();
        F[i] = Math.max(0, Math.min(255, v | 0));
        var s = t + i / 44100;
        var a = 0.55 * kick * Math.sin(2 * Math.PI * (50 + 80 * kick) * s) + 0.25 * Math.sin(2 * Math.PI * bassNote * s + ch)
              + 0.12 * hat * (this.noise() * 2 - 1) + 0.08 * Math.sin(2 * Math.PI * 440 * s * (1 + 0.003 * ch));
        Wv[i] = Math.max(0, Math.min(255, 128 + a * 127 | 0));
      }
    }
  };

  // ------------------------------------------------------------------ CSS
  var CSS = [
    '.wmpm-slot{display:contents}',
    '.wmpm-bar-music{font-weight:700!important;padding:6px 14px!important}',
    '.wmpm-panel{position:fixed;top:0;right:0;bottom:0;z-index:30;width:min(94vw,clamp(380px,40vw,860px));display:flex;flex-direction:column;',
    '  box-sizing:border-box;background:rgba(10,14,20,.95);border-left:1px solid rgba(255,255,255,.14);box-shadow:-12px 0 40px rgba(0,0,0,.55);',
    '  color:#e7eef5;font:500 clamp(17px,1.3vw,28px)/1.35 system-ui,Segoe UI,sans-serif;transition:transform .25s ease,opacity .35s,visibility .25s}',
    '.wmpm-panel.closed{transform:translateX(105%);visibility:hidden}',
    '.wmpm-panel.hide{opacity:0;pointer-events:none}',
    '.wmpm-panel *{box-sizing:border-box}',
    '.wmpm-panel button,.wmpm-panel input,.wmpm-panel select{font:inherit;color:inherit;min-height:2.3em;border-radius:.4em;',
    '  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);padding:.25em .7em;cursor:pointer;margin:0}',
    '.wmpm-panel button:hover,.wmpm-panel select:hover{background:rgba(255,255,255,.16)}',
    '.wmpm-panel input{cursor:text;background:rgba(0,0,0,.35);min-width:0}',
    '.wmpm-panel select option{background:#111}',
    '.wmpm-panel :focus-visible{outline:3px solid #7cc4ff;outline-offset:2px}',
    '.wmpm-panel button.on{background:#2d7fb8;border-color:#2d7fb8}',
    '.wmpm-head{display:flex;gap:.4em;align-items:center;padding:.6em .7em .4em}',
    '.wmpm-tabs{display:flex;gap:.3em;flex:1}',
    '.wmpm-tabs button{flex:1;font-weight:700}',
    '.wmpm-tabs button[aria-selected=true]{background:#2d7fb8;border-color:#2d7fb8}',
    '.wmpm-close{font-weight:700;min-width:2.3em}',
    '.wmpm-sec{display:none;flex:1;min-height:0;flex-direction:column;padding:0 .7em .7em;gap:.45em}',
    '.wmpm-sec.active{display:flex}',
    '.wmpm-tools{display:flex;flex-wrap:wrap;gap:.4em;align-items:center}',
    '.wmpm-tools input{flex:1 1 8em}',
    '.wmpm-info{color:#93a4b4;font-size:.8em;min-height:1.2em}',
    '.wmpm-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:.25em;padding:.15em .2em .15em 0}',
    '.wmpm-row{display:flex;gap:.3em}',
    '.wmpm-item{flex:1;text-align:left;display:flex;flex-direction:column;justify-content:center;min-height:2.8em!important;min-width:0;',
    '  background:rgba(255,255,255,.04)!important;border-color:transparent!important}',
    '.wmpm-item:hover{background:rgba(255,255,255,.12)!important}',
    '.wmpm-item .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wmpm-item .s{font-size:.72em;color:#93a4b4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wmpm-row.cur .wmpm-item{background:rgba(45,127,184,.45)!important;border-color:#5aa0e0!important}',
    '.wmpm-row.cur .wmpm-item .t:before{content:"\\25B6\\FE0E  "}',
    '.wmpm-star{min-width:2.6em;font-size:1.1em}',
    '.wmpm-star.on{color:#ffd24a}',
    '.wmpm-badge{display:inline-block;color:#f0b35a;margin-right:.8em}',
    '.wmpm-empty{color:#93a4b4;padding:.6em .2em}',
    '.wmpm-hidden-input{display:none!important}',
    '.wmpm-drop{position:fixed;inset:0;z-index:40;border:6px dashed #5aa0e0;background:rgba(0,30,60,.35);pointer-events:none;display:none}',
    '.wmpm-drop.on{display:block}',
    '.wmpm-sound{display:flex;flex-wrap:wrap;gap:.3em;align-items:center;padding:0 .7em .5em}',
    '.wmpm-sound .lbl{color:#93a4b4;margin-right:.15em}',
    '.wmpm-sound .opts{display:flex;gap:.3em;flex:1;flex-wrap:wrap}',
    '.wmpm-sound .opts button{flex:1 1 auto}',
    '.wmpm-sound .hint{flex-basis:100%;display:flex;flex-wrap:wrap;gap:.4em;align-items:center;font-size:.75em;color:#93a4b4}',
    '.wmpm-sound .hint button{min-height:2em;font-size:1em}',
    '.wmpm-sound code{color:#e7eef5;user-select:all}',
    '.wmpm-fx .fx{display:flex;align-items:center;gap:.5em;flex:1 1 12em}',
    '.wmpm-fx input[type=range]{flex:1;min-width:6em;accent-color:#5aa0e0}',
    '.wmpm-fx .v{min-width:3.2em;text-align:right;color:#c8d3dd}'
  ].join('\n');
  function injectCss() {
    if (document.getElementById('wmpm-css')) return;
    document.head.appendChild(h('style', { id: 'wmpm-css', text: CSS }));
  }

  // ------------------------------------------------------------------ the player
  function create(opts) {
    opts = opts || {};
    injectCss();
    var onStatus = opts.onStatus || function () {};
    var onActivity = opts.onActivity || function () {};
    var stageFactory = opts.analyzer || analyserStage;
    var haveMidi = typeof root.MidiSF2 !== 'undefined';
    // Demo MIDIs: none ship with this player. The user can pick the sample MIDIs of their own Windows
    // (C:\Windows\Media\*.mid); they are kept on this device only (localStorage, base64): a one-time step.
    var K_DEMOS = 'rvmusic.demos', DEMOS_MAX = 3000000;
    var DEMOS = haveMidi ? lsGet(K_DEMOS, []) : [];
    if (!Array.isArray(DEMOS)) DEMOS = [];
    var vol = clamp(typeof opts.volume === 'number' ? opts.volume : 80, 0, 100);
    var sopts = lsGet(K_OPTS, {});
    var shuffle = !!sopts.shuffle, repeat = sopts.repeat === 'all' || sopts.repeat === 'one' ? sopts.repeat : 'off';
    var favs = lsGet(K_FAVS, []), noviz = lsGet(K_NOVIZ, {});

    var st = { kind: 'demo', paused: false, noViz: false, title: 'Demo beat', item: null };
    var actx = null, tap = null, out = null, stage = null, probe = null, probeBuf = null;
    var fileEl = null, radioEl = null, plainEl = null, midi = null, micStream = null, micNode = null;
    var sf = { key: '', name: '' }, pendingSf = null;
    var fx = lsGet('wmpm.fx', null) || { reverb: 1, chorus: 1 };
    var soundChoice = lsGet(K_SOUND, null);   // null until the user picks: Retro Synth by default
    var soundMode = soundChoice === 'windows' || soundChoice === 'sf2' ? soundChoice : 'retro';
    var dls = { cached: false, buf: null }, soundQ = Promise.resolve(), pendingPick = '';
    var queue = { list: [], order: [], pos: -1 };
    var token = 0, radioTimer = 0, demo = new DemoBeat();
    var lib = { tracks: [], name: '', handle: null };
    var savedHandle = null;
    var radio = { list: [], view: 'top', server: null, busy: false };

    function volGain() { var v = vol / 100; return v * v; }   // squared: feels even across the slider
    function status(t) { onStatus(t); }

    // ---- audio context + graph (created on the first user action)
    function ensureCtx() {
      if (actx) { if (actx.state === 'suspended') actx.resume(); return actx; }
      var AC = root.AudioContext || root.webkitAudioContext;
      actx = new AC();
      tap = actx.createGain(); tap.channelCount = 2; tap.channelCountMode = 'explicit'; tap.channelInterpretation = 'speakers';
      out = actx.createGain(); out.gain.value = volGain(); out.connect(actx.destination);
      probe = actx.createAnalyser(); probe.fftSize = 512; probeBuf = new Uint8Array(512); tap.connect(probe);
      stage = stageFactory(actx, tap);
      return actx;
    }
    function route(node, speakers) { node.connect(tap); if (speakers) node.connect(out); }
    function setAnalyzer(factory) {
      stageFactory = factory || analyserStage;
      if (actx) { if (stage && stage.dispose) stage.dispose(); stage = stageFactory(actx, tap); }
    }

    // ---- sources
    function ensureFileEl() {
      if (fileEl) return fileEl;
      fileEl = new Audio(); fileEl.preload = 'auto';
      route(actx.createMediaElementSource(fileEl), true);
      fileEl.addEventListener('ended', function () { if (st.kind === 'file') next(true); });
      fileEl.addEventListener('error', function () { if (st.kind === 'file' && fileEl.getAttribute('src')) { status("Can't play " + st.title + ' in this browser'); } });
      return fileEl;
    }
    function ensureRadioEl() {
      if (radioEl) return radioEl;
      radioEl = new Audio(); radioEl.crossOrigin = 'anonymous'; radioEl.preload = 'none';
      route(actx.createMediaElementSource(radioEl), true);
      return radioEl;
    }
    function ensurePlainEl() {   // not connected to Web Audio: used for streams that refuse CORS
      if (!plainEl) { plainEl = new Audio(); plainEl.preload = 'none'; }
      plainEl.volume = volGain();
      return plainEl;
    }
    function ensureMidi() {
      ensureCtx();
      if (midi) return midi;
      var bus = actx.createGain(); route(bus, true);
      midi = root.MidiSF2.createPlayer(actx, bus);
      if (midi.setEffects) midi.setEffects(fx);
      midi.onended = function () { if (st.kind === 'midi') next(true); };
      return midi;
    }
    function silence(el) { if (!el) return; el.onplaying = el.onerror = null; el.pause(); if (el.getAttribute('src')) { el.removeAttribute('src'); try { el.load(); } catch (e) {} } }
    function stopSources() {
      clearInterval(radioTimer); radioTimer = 0;
      if (fileEl) fileEl.pause();
      silence(radioEl); silence(plainEl);
      if (midi) midi.stop();
      if (micNode) { try { micNode.disconnect(); } catch (e) {} micNode = null; }
      if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    }
    function setKind(k) {
      st.kind = k; st.paused = false;
      if (k !== 'radio') st.noViz = false;
      if (k === 'demo' || k === 'mic') st.item = null;
      ui.demoBtn.classList.toggle('on', k === 'demo');
      ui.micBtn.classList.toggle('on', k === 'mic');
      updatePlay(); renderAll();
    }
    function updatePlay() {
      ui.playBtn.textContent = st.paused ? 'Play' : 'Pause';
      var hasQ = queue.list.length > 0;
      ui.prevBtn.disabled = ui.nextBtn.disabled = !hasQ;
    }
    function nowStatus(t) { st.title = t; status(t); }

    function startDemo() {
      token++; stopSources(); setKind('demo'); nowStatus('Demo beat');
    }
    function startMic() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status('Microphone not available here'); return; }
      ensureCtx();
      var my = ++token;
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        if (my !== token) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stopSources(); micStream = s;
        micNode = actx.createMediaStreamSource(s); route(micNode, false);   // not sent to the speakers
        actx.resume(); setKind('mic'); nowStatus('Microphone');
      }, function (e) { status('Microphone refused: ' + e.name); });
    }

    // ---- queue / playlist
    function shuffled(n, first) {
      var a = []; for (var i = 0; i < n; i++) if (i !== first) a.push(i);
      for (var j = a.length - 1; j > 0; j--) { var r = Math.floor(Math.random() * (j + 1)), t = a[j]; a[j] = a[r]; a[r] = t; }
      if (first >= 0) a.unshift(first);
      return a;
    }
    function buildOrder(cur) {
      var n = queue.list.length, i;
      if (shuffle) queue.order = shuffled(n, cur);
      else { queue.order = []; for (i = 0; i < n; i++) queue.order.push(i); }
      queue.pos = Math.max(0, queue.order.indexOf(cur));
    }
    function playList(list, index) {
      queue.list = list.slice(); buildOrder(index);
      playCurrent();
    }
    function curItem() { return queue.pos >= 0 ? queue.list[queue.order[queue.pos]] : null; }
    function next(auto) {
      var n = queue.list.length; if (!n) return;
      if (auto && repeat === 'one') { playCurrent(); return; }
      if (queue.pos + 1 < n) queue.pos++;
      else if (repeat === 'all') { if (shuffle) queue.order = shuffled(n, -1); queue.pos = 0; }
      else if (auto) { st.paused = true; updatePlay(); status('End of playlist'); return; }
      else return;   // manual next at the end: stay
      playCurrent();
    }
    function prev() {
      var n = queue.list.length; if (!n) return;
      if (st.kind === 'file' && fileEl && fileEl.currentTime > 3) { fileEl.currentTime = 0; return; }
      if (st.kind === 'midi' && midi && midi.currentTime > 3) { midi.seek(0); return; }
      if (queue.pos > 0) queue.pos--; else if (repeat === 'all') queue.pos = n - 1; else return;
      playCurrent();
    }
    // ---- MIDI sound: Retro Synth (built in) | Windows (the user's own gm.dls, cached in IndexedDB) | SoundFont (.sf2)
    function wantedSound() {
      if (soundMode === 'windows' && (dls.buf || dls.cached)) return { key: 'dls', name: 'Windows GM', get: function () {
        if (dls.buf) return Promise.resolve(dls.buf);
        return idb('readonly', function (s) { return s.get('gmdls'); }).then(function (b) {
          if (!b) { dls.cached = false; throw new Error('gm.dls is no longer stored in this browser, pick it again'); }
          dls.buf = b; return b;
        });
      } };
      if (soundMode === 'sf2' && pendingSf) {
        var p = pendingSf;
        return { key: p.key, name: p.name, get: function () { return (p.file ? Promise.resolve(p.file) : p.getFile()).then(readFile); } };
      }
      return { key: '', name: 'Retro Synth' };
    }
    function soundLabel() { return sf.key && sf.name ? sf.name : 'Retro Synth'; }
    function ensureSoundFont() {   // serialised: a switch during a load waits for it
      soundQ = soundQ.then(loadWanted, loadWanted);
      return soundQ;
    }
    function loadWanted() {
      var w = wantedSound();
      if (w.key === sf.key) return;
      if (!w.key) { if (midi) midi.unloadSoundFont(); sf = { key: '', name: '' }; renderSound(); return; }
      status('Loading ' + w.name + ' sound...');
      return w.get().then(function (buf) { return ensureMidi().loadSoundFont(buf); }).then(function (info) {
        sf = { key: w.key, name: w.key === 'dls' ? 'Windows GM' : (info && info.name) || w.name };
        renderSound(); renderLib();
      }, function (e) {
        if (midi) midi.unloadSoundFont();
        sf = { key: w.key, name: '' };   // don't retry the same broken file on every track
        status(w.name + ' failed: ' + errText(e) + ' (using Retro Synth)');
        renderSound();
      });
    }
    function midiStatus() { return st.midiLabel + '  (MIDI, ' + soundLabel() + ')'; }
    function applySound() {
      renderSound();
      if (!midi) return Promise.resolve();   // used from the next MIDI on
      return ensureSoundFont().then(function () {
        if (st.kind === 'midi' && st.midiLabel) { st.title = midiStatus(); status(st.paused ? 'Paused: ' + st.title : st.title); }
        else status('MIDI sound: ' + soundLabel());
      });
    }
    function setSound(mode, explicit) {
      if (!haveMidi) return;
      if (mode === 'windows' && !dls.buf && !dls.cached) {   // ask once for the file
        pendingPick = 'windows'; renderSound();
        status('Pick gm.dls: ' + DLS_PATH);
        ui.dlsInput.click(); return;
      }
      if (mode === 'sf2' && !pendingSf) { pendingPick = 'sf2'; renderSound(); ui.sf2Input.click(); return; }
      pendingPick = '';
      soundMode = mode;
      if (explicit !== false) { soundChoice = mode; lsSet(K_SOUND, mode); }
      applySound();
    }
    function useDlsFile(f) {
      if (!f) return;
      readFile(f).then(function (buf) {
        var u = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
        var tag = String.fromCharCode.apply(null, u);
        if (tag.slice(0, 4) !== 'RIFF' || tag.slice(8, 12) !== 'DLS ') { status(f.name + ' is not a DLS sound bank: pick ' + DLS_PATH); return; }
        root.MidiSF2._parseDLS(buf);   // throws if unusable (nothing is kept then)
        dls.buf = buf; dls.cached = true;
        idb('readwrite', function (s) { return s.put(buf, 'gmdls'); }).catch(function () { dls.cached = false; });
        if (sf.key === 'dls') sf = { key: '', name: '' };   // reload the new bytes
        setSound('windows');
      }).catch(function (e) { status('Could not use ' + f.name + ': ' + errText(e)); });
    }
    function forgetDls() {
      dls.buf = null; dls.cached = false;
      idb('readwrite', function (s) { return s.delete('gmdls'); }).catch(function () {});
      if (soundMode === 'windows') setSound('retro'); else renderSound();
    }
    function playCurrent() {
      var it = curItem(); if (!it) return;
      ensureCtx(); stopSources();
      var my = ++token, n = queue.list.length;
      st.item = it;
      var label = (it.title || it.name) + (n > 1 && it.type !== 'radio' ? '  (' + (queue.pos + 1) + '/' + n + ')' : '');
      setMediaSession(it);
      if (it.type === 'radio') { startRadio(it, my); return; }
      var getF = it.file ? Promise.resolve(it.file) : it.getFile();
      if (it.type === 'midi') {
        if (!haveMidi) { status('MIDI needs midi-sf2.js'); return; }
        var m = ensureMidi();
        setKind('midi'); status('Loading ' + it.name + '...');
        ensureSoundFont().then(function () { return getF; }).then(readFile).then(function (buf) {
          if (my !== token) return null;
          return m.loadMidi(buf);
        }).then(function (info) {
          if (my !== token || !info) return;
          actx.resume(); m.play();
          st.midiLabel = label; nowStatus(midiStatus());
        }, function (e) { if (my === token) status('Could not read MIDI ' + it.name + ': ' + errText(e)); });
        return;
      }
      setKind('file'); status('Loading ' + it.name + '...');
      getF.then(function (f) {
        if (my !== token) return;
        var el = ensureFileEl();
        if (el._url) URL.revokeObjectURL(el._url);
        el._url = URL.createObjectURL(f); el.src = el._url;
        actx.resume();
        var pr = el.play();
        if (pr && pr.catch) pr.catch(function (e) { if (my === token && e.name !== 'AbortError') status("Can't play " + it.name + ' in this browser (' + e.name + ')'); });
        nowStatus(label);
      }, function (e) { if (my === token) status("Can't open " + it.name + ': ' + errText(e)); });
    }

    // ---- radio playback (CORS-aware)
    function startRadio(it, my) {
      var s = it.station;
      setKind('radio'); st.noViz = false;
      clickCount(s);
      if (noviz[s.stationuuid]) { startPlain(it, my, 'known'); return; }
      status('Connecting to ' + s.name + '...');
      var el = ensureRadioEl(), fellBack = false;
      function fallback() { if (fellBack || my !== token) return; fellBack = true; silence(el); startPlain(it, my, 'cors'); }
      el.onerror = fallback;   // CORS refused (or the stream is broken: then the plain element fails too)
      el.onplaying = function () {
        if (my !== token) return;
        nowStatus('Radio: ' + s.name);
        watchSilence(it, my, el, fallback);
      };
      el.src = s.url_resolved;
      actx.resume();
      var pr = el.play();
      if (pr && pr.catch) pr.catch(function (e) { if (my === token && e.name === 'NotSupportedError') fallback(); });
      clearTimeout(el._to);
      el._to = setTimeout(function () { if (my === token && el.paused && !fellBack) status(s.name + ': not responding'); }, 15000);
    }
    // a CORS stream that loads but delivers only digital silence to the analyser is treated as blocked
    function watchSilence(it, my, el, fallback) {
      clearInterval(radioTimer);
      var quiet = 0, heard = false, lastT = -1, ticks = 0;
      radioTimer = setInterval(function () {
        if (my !== token || st.paused) return;
        if (++ticks > 40 || heard) { clearInterval(radioTimer); radioTimer = 0; return; }
        if (el.currentTime === lastT) return;   // buffering
        lastT = el.currentTime;
        probe.getByteTimeDomainData(probeBuf);
        for (var i = 0; i < probeBuf.length; i++) if (probeBuf[i] !== 128) { heard = true; return; }
        quiet += 0.5;
        if (quiet >= 6) { clearInterval(radioTimer); radioTimer = 0; fallback(); }
      }, 500);
    }
    function startPlain(it, my, why) {
      var s = it.station, el = ensurePlainEl();
      status('Connecting to ' + s.name + '...');
      el.onerror = function () {
        if (my !== token) return;
        st.noViz = true;   // nothing to analyse: keep the demo beat going
        status("Can't play " + s.name + ' (stream offline or unsupported)');
      };
      el.onplaying = function () {
        if (my !== token) return;
        st.noViz = true;
        if (why === 'cors' && !noviz[s.stationuuid]) { noviz[s.stationuuid] = 1; lsSet(K_NOVIZ, noviz); }
        nowStatus('Radio: ' + s.name + '  (visuals unavailable for this station: showing the demo beat)');
        renderRadio();
      };
      el.src = s.url_resolved;
      var pr = el.play();
      if (pr && pr.catch) pr.catch(function (e) { if (my === token && e.name !== 'AbortError' && e.name !== 'NotSupportedError') status("Can't play " + s.name + ' (' + e.name + ')'); });
    }

    function togglePause() {
      st.paused = !st.paused;
      var p = st.paused;
      if (st.kind === 'midi' && midi) { if (p) midi.pause(); else { ensureCtx(); midi.play(); } }
      else if (st.kind === 'file' && fileEl) { if (p) fileEl.pause(); else { ensureCtx(); fileEl.play(); } }
      else if (st.kind === 'radio' && st.item) {
        var el = st.noViz ? plainEl : radioEl;
        if (el) {
          if (p) el.pause();
          else { ensureCtx(); el.src = st.item.station.url_resolved; var pr = el.play(); if (pr && pr.catch) pr.catch(function () {}); }   // back to live
        }
      }
      updatePlay();
      status(p ? 'Paused: ' + st.title : st.title);
    }
    function setVolume(v) {
      vol = clamp(Math.round(v), 0, 100);
      if (out) out.gain.setTargetAtTime(volGain(), actx.currentTime, 0.02);
      if (plainEl) plainEl.volume = volGain();
    }
    function sampleLevel(level) {
      if (st.kind === 'demo' || st.noViz || !stage) demo.fill(level);
      else stage.sample(level);
    }

    function setMediaSession(it) {
      var ms = navigator.mediaSession; if (!ms) return;
      try {
        if (root.MediaMetadata) ms.metadata = new MediaMetadata({ title: it.title || it.name, artist: it.type === 'radio' ? 'Internet radio' : (it.path || '') });
        ms.setActionHandler('nexttrack', function () { next(false); });
        ms.setActionHandler('previoustrack', prev);
        ms.setActionHandler('play', function () { if (st.paused) togglePause(); });
        ms.setActionHandler('pause', function () { if (!st.paused) togglePause(); });
      } catch (e) {}
    }

    // ---- library (My music)
    function setLibrary(tracks, name, handle) {
      tracks.sort(function (a, b) { return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }); });
      lib.tracks = tracks; lib.name = name; lib.handle = handle || null;
      renderLib();
    }
    function addFiles(list, play) {
      var fl = Array.prototype.slice.call(list || []), media = [], sfF = null;
      fl.forEach(function (f) {
        if (SF2_RE.test(f.name)) { if (haveMidi) sfF = f; }
        else if ((MIDI_RE.test(f.name) && haveMidi) || AUDIO_RE.test(f.name) || /^audio\//.test(f.type)) media.push(trackFromFile(f));
      });
      var dirName = fl.length && fl[0].webkitRelativePath ? fl[0].webkitRelativePath.split('/')[0] : '';
      if (sfF) {
        pendingSf = { key: 'f:' + sfF.name + ':' + sfF.size, name: sfF.name, file: sfF };
        // a .sf2 picked/dropped on its own is a choice; one found in a folder only wins while nothing was chosen
        if (!dirName || soundChoice === null || soundMode === 'sf2') setSound('sf2', !dirName);
      }
      if (dirName) setLibrary(media, dirName, null);
      else if (media.length) setLibrary(lib.tracks.concat(media), lib.name || 'Added files', lib.handle);
      else renderLib();
      if (!media.length) {
        if (sfF) { ensureCtx(); ensureMidi(); applySound(); }
        else status('No playable files');
        return;
      }
      if (play) { media.sort(function (a, b) { return a.path.localeCompare(b.path, undefined, { numeric: true }); }); playList(media, 0); }
      else status(media.length + ' tracks added');
    }
    function scanHandle(dir) {
      var tracks = [], sfs = [], count = 0;
      status('Scanning ' + dir.name + '...');
      ui.libInfo.textContent = 'Scanning ' + dir.name + '...';
      function walk(d, path, depth) {
        var it = d.values();
        function step() {
          return it.next().then(function (r) {
            if (r.done || count > 20000) return;
            var e = r.value, p = path + e.name, pr = null;
            if (e.kind === 'file') {
              count++;
              if (isMediaName(e.name) && (haveMidi || !MIDI_RE.test(e.name))) tracks.push({ type: MIDI_RE.test(e.name) ? 'midi' : 'audio', name: e.name, path: p, getFile: e.getFile.bind(e) });
              else if (SF2_RE.test(e.name)) sfs.push({ key: 'h:' + p, name: e.name, getFile: e.getFile.bind(e) });
              if (count % 200 === 0) ui.libInfo.textContent = 'Scanning ' + dir.name + '... ' + tracks.length + ' tracks';
            } else if (e.kind === 'directory' && depth < 10) pr = walk(e, p + '/', depth + 1);
            return pr ? pr.then(step) : step();
          });
        }
        return step();
      }
      return walk(dir, '', 0).then(function () {
        if (sfs.length) { pendingSf = sfs[0]; if (soundChoice === null || soundMode === 'sf2') setSound('sf2', false); }
        setLibrary(tracks, dir.name, dir);
        status(dir.name + ': ' + tracks.length + ' tracks' + (sfs.length ? ', SoundFont ' + sfs[0].name : ''));
      }, function (e) { status('Could not read folder: ' + errText(e)); renderLib(); });
    }
    function pickFolder() {
      if (root.showDirectoryPicker) {
        root.showDirectoryPicker({ id: 'wmp-music', mode: 'read' }).then(function (dir) {
          savedHandle = dir;
          idb('readwrite', function (s) { return s.put(dir, 'folder'); }).catch(function () {});
          return scanHandle(dir);
        }, function (e) { if (e && e.name !== 'AbortError') { status('Folder picker failed (' + e.name + '), using the basic picker'); ui.dirInput.click(); } });
      } else ui.dirInput.click();
    }
    function reloadSaved() {
      if (!savedHandle) return;
      var hd = savedHandle;
      (hd.requestPermission ? hd.requestPermission({ mode: 'read' }) : Promise.resolve('granted')).then(function (p) {
        if (p === 'granted') return scanHandle(hd);
        status('Permission to read ' + hd.name + ' was not given');
      }, function (e) { status('Could not open ' + hd.name + ': ' + errText(e)); });
    }
    function forgetSaved() {
      savedHandle = null;
      idb('readwrite', function (s) { return s.delete('folder'); }).catch(function () {});
      renderLib();
    }
    function loadSavedHandle() {
      if (!root.showDirectoryPicker) return;
      idb('readonly', function (s) { return s.get('folder'); }).then(function (hd) {
        if (!hd || !hd.values) return;
        savedHandle = hd; renderLib();
        if (hd.queryPermission) hd.queryPermission({ mode: 'read' }).then(function (p) { if (p === 'granted' && !lib.tracks.length) scanHandle(hd); }, function () {});
      }, function () {});
    }

    // ---- radio browser API
    function api(path) {
      var servers = radio.server ? [radio.server] : API_SERVERS.slice();
      var i = 0;
      function tryNext(err) {
        if (i >= servers.length) {
          if (!radio.discovered) {   // ask the round-robin name for the live server list
            radio.discovered = true;
            return fetchJson('https://all.api.radio-browser.info/json/servers').then(function (list) {
              servers = (list || []).map(function (s) { return 'https://' + s.name; }); i = 0; return tryNext(err);
            }, function () { throw err || new Error('no server'); });
          }
          return Promise.reject(err || new Error('no server'));
        }
        var base = servers[i++];
        return fetchJson(base + path).then(function (j) { radio.server = base; return j; }, function (e) { if (radio.server === base) radio.server = null; return tryNext(e); });
      }
      return tryNext(null);
    }
    function fetchJson(url) {
      var ctl = root.AbortController ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, 9000);
      return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
        clearTimeout(to); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
      }, function (e) { clearTimeout(to); throw e; });
    }
    var canHls = (function () { try { return !!document.createElement('audio').canPlayType('application/vnd.apple.mpegurl'); } catch (e) { return false; } })();
    function usable(s) {
      var u = s.url_resolved || '';
      if (!/^https:\/\//i.test(u)) return false;
      if ((s.hls === 1 || /\.m3u8(\?|$)/i.test(u)) && !canHls) return false;
      return true;
    }
    function slim(s) {
      return { stationuuid: s.stationuuid, name: (s.name || '').trim() || 'Unnamed station', url_resolved: s.url_resolved, tags: s.tags || '',
               country: s.country || '', countrycode: s.countrycode || '', codec: s.codec || '', bitrate: s.bitrate || 0, hls: s.hls || 0, votes: s.votes || 0 };
    }
    function radioSearch(view) {
      radio.view = view;
      if (view === 'favs') { radio.list = favs.slice(); renderRadio(); return; }
      var q = ui.radioQ.value.trim(), by = ui.radioBy.value, path;
      var common = 'hidebroken=true&is_https=true&order=votes&reverse=true&limit=120';
      if (view === 'top' || !q) { radio.view = 'top'; path = '/json/stations/search?' + common; }
      else path = '/json/stations/search?' + common + '&' + by + '=' + encodeURIComponent(q);
      radio.busy = true; radio.err = ''; renderRadio();
      var my = ++radio.req;
      api(path).then(function (list) {
        if (my !== radio.req) return;
        var seen = {};
        radio.list = (list || []).filter(function (s) { if (!usable(s) || seen[s.url_resolved]) return false; seen[s.url_resolved] = 1; return true; }).map(slim);
        radio.busy = false; renderRadio();
      }, function (e) {
        if (my !== radio.req) return;
        radio.busy = false; radio.list = []; radio.err = 'Radio directory unreachable (' + errText(e) + ')'; renderRadio();
      });
    }
    radio.req = 0;
    function clickCount(s) { if (radio.server) fetch(radio.server + '/json/url/' + s.stationuuid).catch(function () {}); }
    function isFav(s) { return favs.some(function (f) { return f.stationuuid === s.stationuuid; }); }
    function toggleFav(s) {
      if (isFav(s)) favs = favs.filter(function (f) { return f.stationuuid !== s.stationuuid; }); else favs.push(slim(s));
      lsSet(K_FAVS, favs);
      if (radio.view === 'favs') radio.list = favs.slice();
      renderRadio();
    }

    // ------------------------------------------------------------------ UI: bar
    var ui = {};
    var slot = opts.bar || document.body;
    if (slot !== document.body) slot.classList.add('wmpm-slot');
    ui.musicBtn = h('button', { cls: 'wmpm-bar-music', title: 'Music: your files and folders, internet radio, demos', 'aria-haspopup': 'dialog', text: 'Music', onclick: function () { togglePanel(); } });
    ui.prevBtn = h('button', { title: 'Previous track', 'aria-label': 'Previous track', text: '⏮︎', onclick: function () { prev(); } });
    ui.playBtn = h('button', { title: 'Play / pause (Space)', text: 'Pause', onclick: function () { togglePause(); } });
    ui.nextBtn = h('button', { title: 'Next track', 'aria-label': 'Next track', text: '⏭︎', onclick: function () { next(false); } });
    ui.demoBtn = h('button', { cls: 'on', title: 'Built-in demo beat (no audio needed)', text: 'Demo', onclick: function () { startDemo(); } });
    ui.micBtn = h('button', { title: 'Use the microphone', text: 'Mic', onclick: function () { if (st.kind === 'mic') startDemo(); else startMic(); } });
    [ui.musicBtn, ui.prevBtn, ui.playBtn, ui.nextBtn, ui.demoBtn, ui.micBtn].forEach(function (b) { slot.appendChild(b); });

    // ------------------------------------------------------------------ UI: panel
    var TABS = [['lib', 'My music'], ['radio', 'Radio'], ['demos', 'Demos']];
    var tab = sopts.tab === 'radio' || sopts.tab === 'demos' ? sopts.tab : 'lib';
    ui.tabs = {}; ui.secs = {};
    var tabBar = h('div', { cls: 'wmpm-tabs', role: 'tablist' });
    TABS.forEach(function (t) {
      var b = h('button', { role: 'tab', id: 'wmpm-tab-' + t[0], 'aria-controls': 'wmpm-sec-' + t[0], text: t[1],
        onclick: function () { selectTab(t[0], true); }, onfocus: function () { if (tab !== t[0]) selectTab(t[0], false); } });
      ui.tabs[t[0]] = b; tabBar.appendChild(b);
    });
    ui.closeBtn = h('button', { cls: 'wmpm-close', title: 'Close (Esc)', 'aria-label': 'Close music panel', text: '✕', onclick: function () { closePanel(); } });
    ui.panel = h('div', { cls: 'wmpm-panel closed', role: 'dialog', 'aria-label': 'Music', 'aria-hidden': 'true' },
      [h('div', { cls: 'wmpm-head' }, [tabBar, ui.closeBtn])]);
    // MIDI sound selector (shown above every tab)
    ui.soundBtns = {};
    ui.dlsInput = h('input', { type: 'file', cls: 'wmpm-hidden-input', accept: '.dls' });
    ui.dlsInput.onchange = function () { var f = this.files && this.files[0]; this.value = ''; if (f) { ensureCtx(); useDlsFile(f); } };
    ui.sf2Input = h('input', { type: 'file', cls: 'wmpm-hidden-input', accept: '.sf2' });
    ui.sf2Input.onchange = function () { var fs = this.files; if (fs && fs.length) { ensureCtx(); addFiles(fs, false); } this.value = ''; };
    var soundTitles = {
      retro: 'The built-in synth (no files needed)',
      windows: 'The General MIDI sound bank that comes with Windows (Microsoft GS Wavetable Synth). Pick ' + DLS_PATH + ' once; it is kept in this browser only. On a Mac or other system, copy it from a Windows PC you own.',
      sf2: 'A SoundFont (.sf2) file of your own'
    };
    ui.soundRow = h('div', { cls: 'wmpm-sound', role: 'group', 'aria-label': 'MIDI sound' }, [h('span', { cls: 'lbl', text: 'Sound:' }),
      h('div', { cls: 'opts' }, SOUNDS.map(function (o) {
        var b = h('button', { text: o[1], title: soundTitles[o[0]], onclick: function () { setSound(o[0]); } });
        ui.soundBtns[o[0]] = b; return b;
      })), ui.dlsInput, ui.sf2Input]);
    ui.soundHint = h('div', { cls: 'hint', 'aria-live': 'polite' });
    ui.soundRow.appendChild(ui.soundHint);
    if (haveMidi) ui.panel.appendChild(ui.soundRow);
    // ---- MIDI effects: reverb + chorus amounts (100% = what the song asks for, like the Windows synth)
    function fxSlider(key, label, tip) {
      var val = h('span', { cls: 'v', text: Math.round(fx[key] * 100) + '%' });
      var r = h('input', { type: 'range', min: '0', max: '200', step: '5', title: tip, 'aria-label': label });
      r.value = String(Math.round(fx[key] * 100));
      r.oninput = function () {
        fx[key] = (+r.value) / 100; val.textContent = r.value + '%'; lsSet('wmpm.fx', fx);
        if (midi && midi.setEffects) midi.setEffects(fx);
      };
      return h('label', { cls: 'fx' }, [h('span', { cls: 'lbl', text: label }), r, val]);
    }
    ui.fxRow = h('div', { cls: 'wmpm-sound wmpm-fx', role: 'group', 'aria-label': 'MIDI effects' }, [
      fxSlider('reverb', 'Reverb', 'Echo of a room or hall. 100% = as the song asks (Windows-style); 0% = dry'),
      fxSlider('chorus', 'Chorus', 'Shimmer / thickening. 100% = as the song asks; most songs use little or none')]);
    if (haveMidi) ui.panel.appendChild(ui.fxRow);
    function renderSound() {
      if (!ui.soundHint) return;
      SOUNDS.forEach(function (o) { var on = soundMode === o[0]; ui.soundBtns[o[0]].classList.toggle('on', on); ui.soundBtns[o[0]].setAttribute('aria-pressed', on); });
      var kids = [], showPick = pendingPick === 'windows' || (soundMode === 'windows' && !dls.buf && !dls.cached);
      if (showPick) {
        kids.push(h('span', null, ['Pick ', h('code', { text: DLS_PATH }), ' (on a Mac or other system: copy gm.dls from a Windows PC you own)']),
          h('button', { text: 'Pick gm.dls', onclick: function () { ui.dlsInput.click(); } }));
      } else if (pendingPick === 'sf2' && !pendingSf) {
        kids.push(h('span', { text: 'Pick a .sf2 SoundFont, or open a folder that has one.' }), h('button', { text: 'Pick .sf2', onclick: function () { ui.sf2Input.click(); } }));
      } else if (soundMode === 'windows') {
        kids.push(h('span', { text: 'Windows GM sound set from your gm.dls (stored in this browser only).' }),
          h('button', { text: 'Pick again', onclick: function () { ui.dlsInput.click(); } }),
          h('button', { text: 'Forget', title: 'Remove the stored copy of gm.dls from this browser', onclick: forgetDls }));
      } else if (soundMode === 'sf2') {
        kids.push(h('span', { text: 'SoundFont: ' + (pendingSf ? (sf.key === pendingSf.key && sf.name ? sf.name : pendingSf.name) : 'none yet') }),
          h('button', { text: pendingSf ? 'Other .sf2' : 'Pick .sf2', onclick: function () { ui.sf2Input.click(); } }));
      } else kids.push(h('span', { text: 'Retro Synth: simple built-in sounds for MIDI.' }));
      ui.soundHint.textContent = '';
      kids.forEach(function (k) { ui.soundHint.appendChild(k); });
    }
    renderSound();
    if (haveMidi) idb('readonly', function (s) { return s.count('gmdls'); }).then(function (n) { dls.cached = n > 0; renderSound(); }, function () {});

    function section(id, kids) { var s = h('div', { cls: 'wmpm-sec', id: 'wmpm-sec-' + id, role: 'tabpanel', 'aria-labelledby': 'wmpm-tab-' + id }, kids); ui.secs[id] = s; ui.panel.appendChild(s); return s; }

    // My music
    ui.fileInput = h('input', { type: 'file', cls: 'wmpm-hidden-input', multiple: true, accept: 'audio/*,.mid,.midi,.kar,.rmi,.sf2,.flac,.opus,.m4a' });
    ui.fileInput.onchange = function () { addFiles(this.files, true); this.value = ''; };
    ui.dirInput = h('input', { type: 'file', cls: 'wmpm-hidden-input', multiple: true, webkitdirectory: true });
    ui.dirInput.onchange = function () { addFiles(this.files, false); this.value = ''; };
    ui.openDir = h('button', { text: 'Open folder', title: 'Pick a music folder (sub-folders included). .sf2 files in it become the SoundFont for MIDI.', onclick: pickFolder });
    ui.addFiles = h('button', { text: 'Add files', title: 'Audio files, MIDI and SoundFonts (.sf2). You can also drag files onto the window.', onclick: function () { ui.fileInput.click(); } });
    ui.reload = h('button', { onclick: reloadSaved });
    ui.forget = h('button', { text: 'Forget', title: 'Forget the remembered folder', onclick: forgetSaved });
    ui.libQ = h('input', { type: 'search', placeholder: 'Search tracks', 'aria-label': 'Search tracks' });
    var libQT = 0;
    ui.libQ.oninput = function () { clearTimeout(libQT); libQT = setTimeout(renderLib, 120); };
    ui.shuffleBtn = h('button', { onclick: function () { shuffle = !shuffle; saveOpts(); if (queue.list.length) { var c = queue.order[queue.pos]; buildOrder(c); } renderLib(); } });
    ui.repeatBtn = h('button', { onclick: function () { repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off'; saveOpts(); renderLib(); } });
    ui.libInfo = h('div', { cls: 'wmpm-info', 'aria-live': 'polite' });
    ui.libList = h('div', { cls: 'wmpm-list', role: 'list' });
    section('lib', [h('div', { cls: 'wmpm-tools' }, [ui.openDir, ui.reload, ui.forget, ui.addFiles, ui.fileInput, ui.dirInput]),
      h('div', { cls: 'wmpm-tools' }, [ui.libQ, ui.shuffleBtn, ui.repeatBtn]), ui.libInfo, ui.libList]);

    // Radio
    ui.radioQ = h('input', { type: 'search', placeholder: 'Search stations', 'aria-label': 'Search stations' });
    ui.radioQ.onkeydown = function (e) { if (e.key === 'Enter') { radioSearch('search'); e.preventDefault(); } };
    ui.radioBy = h('select', { 'aria-label': 'Search by' }, [h('option', { value: 'name', text: 'Name' }), h('option', { value: 'tag', text: 'Genre' }), h('option', { value: 'country', text: 'Country' })]);
    ui.radioGo = h('button', { text: 'Search', onclick: function () { radioSearch('search'); } });
    ui.radioTop = h('button', { text: 'Top stations', onclick: function () { ui.radioQ.value = ''; radioSearch('top'); } });
    ui.radioFavs = h('button', { onclick: function () { radioSearch('favs'); } });
    ui.radioInfo = h('div', { cls: 'wmpm-info', 'aria-live': 'polite' });
    ui.radioList = h('div', { cls: 'wmpm-list', role: 'list' });
    section('radio', [h('div', { cls: 'wmpm-tools' }, [ui.radioQ, ui.radioBy, ui.radioGo]), h('div', { cls: 'wmpm-tools' }, [ui.radioTop, ui.radioFavs]), ui.radioInfo, ui.radioList]);

    // Demos
    ui.demoBeat = h('button', { text: 'Demo beat', title: 'Synthetic beat, no audio', onclick: startDemo });
    ui.demoMic = h('button', { text: 'Microphone', onclick: startMic });
    ui.demoAll = h('button', { text: 'Play all', onclick: function () { playList(demoTracks(), 0); } });
    ui.demoList = h('div', { cls: 'wmpm-list', role: 'list' });
    ui.demoInput = h('input', { type: 'file', cls: 'wmpm-hidden-input', multiple: true, accept: '.mid,.midi,.rmi,.kar' });
    ui.demoInput.onchange = function () { addDemos(this.files); this.value = ''; };
    ui.demoPick = h('button', { text: 'Load demos from your Windows', title: 'Pick the .mid files in C:\\Windows\\Media (any MIDI files work)',
      onclick: function () { ui.demoInput.click(); } });
    ui.demoForget = h('button', { text: 'Forget demos', onclick: function () { DEMOS = []; demoCache = null; lsSet(K_DEMOS, []); renderDemos(); } });
    ui.demoInfo = h('div', { cls: 'wmpm-info', 'aria-live': 'polite' });
    section('demos', [h('div', { cls: 'wmpm-tools' }, [ui.demoBeat, ui.demoMic, ui.demoAll]),
      h('div', { cls: 'wmpm-tools' }, [ui.demoPick, ui.demoForget, ui.demoInput]), ui.demoInfo, ui.demoList]);
    ui.drop = h('div', { cls: 'wmpm-drop' });
    document.body.appendChild(ui.panel); document.body.appendChild(ui.drop);

    var demoCache = null;
    function demoTracks() {
      if (demoCache) return demoCache;
      demoCache = DEMOS.map(function (d) {
        var tr = { type: 'midi', name: d.file, title: d.name, path: 'Demo MIDI (this device)' };
        tr.getFile = function () {
          var bin = atob(d.b64), u = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          return Promise.resolve(new File([u], d.file, { type: 'audio/midi' }));
        };
        return tr;
      });
      return demoCache;
    }

    function saveOpts() { lsSet(K_OPTS, { shuffle: shuffle, repeat: repeat, tab: tab }); }
    function rowFor(it, title, sub, onplay, extra) {
      var cur = st.item && (st.item === it || (it.station && st.item.station && st.item.station.stationuuid === it.station.stationuuid));
      var b = h('button', { cls: 'wmpm-item', onclick: onplay, 'aria-current': cur ? 'true' : null },
        [h('span', { cls: 't', text: title }), sub ? h('span', { cls: 's' }, sub) : null]);
      return h('div', { cls: 'wmpm-row' + (cur ? ' cur' : ''), role: 'listitem' }, [b, extra]);
    }
    function fillList(listEl, rows, emptyText) {
      var keep = ui.panel.contains(document.activeElement) && listEl.contains(document.activeElement);
      var idx = keep ? Array.prototype.indexOf.call(listEl.querySelectorAll('button'), document.activeElement) : -1;
      listEl.textContent = '';
      if (!rows.length && emptyText) listEl.appendChild(h('div', { cls: 'wmpm-empty', text: emptyText }));
      rows.forEach(function (r) { listEl.appendChild(r); });
      if (idx >= 0) { var bs = listEl.querySelectorAll('button'); if (bs.length) bs[Math.min(idx, bs.length - 1)].focus({ preventScroll: true }); }
    }
    function renderLib() {
      ui.shuffleBtn.textContent = 'Shuffle'; ui.shuffleBtn.classList.toggle('on', shuffle); ui.shuffleBtn.setAttribute('aria-pressed', shuffle);
      ui.repeatBtn.textContent = 'Repeat: ' + (repeat === 'off' ? 'off' : repeat === 'all' ? 'all' : 'one'); ui.repeatBtn.classList.toggle('on', repeat !== 'off');
      var showReload = savedHandle && lib.handle !== savedHandle;
      ui.reload.style.display = showReload ? '' : 'none';
      ui.reload.textContent = savedHandle ? 'Reload "' + savedHandle.name + '"' : '';
      ui.forget.style.display = savedHandle ? '' : 'none';
      var q = ui.libQ.value.trim().toLowerCase();
      var shown = q ? lib.tracks.filter(function (t) { return t.path.toLowerCase().indexOf(q) >= 0; }) : lib.tracks;
      var info = lib.tracks.length ? (lib.name ? lib.name + ': ' : '') + lib.tracks.length + ' tracks' + (q ? ', ' + shown.length + ' match' : '') : '';
      if (pendingSf) info += (info ? '  |  ' : '') + 'SoundFont: ' + (sf.key === pendingSf.key && sf.name ? sf.name : pendingSf.name) + (soundMode === 'sf2' ? '' : ' (not in use)');
      if (shown.length > MAX_ROWS) info += '  |  showing the first ' + MAX_ROWS + ', search to find more';
      ui.libInfo.textContent = info;
      var rows = shown.slice(0, MAX_ROWS).map(function (t, i) {
        var dir = t.path.lastIndexOf('/') > 0 ? t.path.slice(0, t.path.lastIndexOf('/')) : '';
        var sub = [dir, t.type === 'midi' ? 'MIDI' : ''].filter(Boolean).join('  |  ');
        return rowFor(t, t.name.replace(/\.[^.]+$/, ''), sub ? [sub] : null, function () { playList(shown, i); });
      });
      fillList(ui.libList, rows, 'Open a folder or add files to see your music here. Audio files and MIDI are listed; a .sf2 SoundFont in the folder is used for MIDI.' +
        (location.protocol === 'file:' && !root.showDirectoryPicker ? '' : ''));
    }
    function renderRadio() {
      ui.radioTop.classList.toggle('on', radio.view === 'top');
      ui.radioFavs.classList.toggle('on', radio.view === 'favs');
      ui.radioFavs.textContent = 'Favourites (' + favs.length + ')';
      ui.radioInfo.textContent = radio.busy ? 'Searching...' : radio.err ? radio.err :
        radio.view === 'favs' ? (favs.length ? 'Your favourite stations' : '') :
        (radio.list.length ? (radio.view === 'top' ? 'Most voted stations' : radio.list.length + ' stations') : '');
      var items = radio.list.map(function (s) { return { type: 'radio', name: s.name, title: s.name, station: s }; });
      var rows = items.slice(0, MAX_ROWS).map(function (it, i) {
        var s = it.station, sub = [];
        var meta = [s.country, (s.tags || '').split(',').filter(Boolean).slice(0, 3).join(', '), s.codec + (s.bitrate ? ' ' + s.bitrate + 'k' : '')].filter(function (x) { return x && x.trim(); }).join('  |  ');
        if (noviz[s.stationuuid]) sub.push(h('span', { cls: 'wmpm-badge', text: 'visuals unavailable' }));
        sub.push(meta);
        var fav = isFav(s);
        var star = h('button', { cls: 'wmpm-star' + (fav ? ' on' : ''), title: fav ? 'Remove from favourites' : 'Add to favourites',
          'aria-label': (fav ? 'Remove ' : 'Add ') + s.name + (fav ? ' from' : ' to') + ' favourites', 'aria-pressed': fav, text: fav ? '★' : '☆',
          onclick: function () { toggleFav(s); } });
        return rowFor(it, s.name, sub, function () { playList(items, i); }, star);
      });
      fillList(ui.radioList, rows, radio.busy ? '' : radio.view === 'favs' ? 'No favourites yet: press the star next to a station.' : radio.err ? '' : 'No stations found.');
    }
    function addDemos(files) {
      var list = Array.prototype.filter.call(files || [], function (f) { return MIDI_RE.test(f.name); });
      if (!haveMidi) { ui.demoInfo.textContent = 'MIDI playback is not available in this build.'; return; }
      if (!list.length) { ui.demoInfo.textContent = 'No MIDI files chosen. In C:\\Windows\\Media pick the files ending in .mid.'; return; }
      Promise.all(list.map(function (f) { return readFile(f).then(function (b) { return { f: f, u: new Uint8Array(b) }; }); })).then(function (rs) {
        rs.forEach(function (r) {
          var bin = '', u = r.u; for (var i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, Math.min(u.length, i + 8192)));
          var name = r.f.name.replace(/\.[^.]+$/, ''), rec = { name: name.charAt(0).toUpperCase() + name.slice(1), file: r.f.name, b64: btoa(bin) };
          DEMOS = DEMOS.filter(function (d) { return d.file.toLowerCase() !== rec.file.toLowerCase(); });
          DEMOS.push(rec);
        });
        DEMOS.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
        demoCache = null;
        var size = JSON.stringify(DEMOS).length, kept = size <= DEMOS_MAX && lsSet(K_DEMOS, DEMOS) !== false;
        ui.demoInfo.textContent = DEMOS.length + ' demo songs' + (kept ? ' (kept on this device)' : ' (too big to keep: available until you close the page)');
        renderDemos();
      }, function (e) { ui.demoInfo.textContent = 'Could not read the files: ' + errText(e); });
    }
    function renderDemos() {
      var tr = demoTracks();
      ui.demoAll.style.display = tr.length ? '' : 'none';
      ui.demoForget.style.display = tr.length ? '' : 'none';
      if (!ui.demoInfo.textContent) ui.demoInfo.textContent = tr.length ? tr.length + ' demo songs on this device' :
        'Windows comes with a few sample MIDI songs in C:\\Windows\\Media. Pick them here to use them as demos; they stay on this device.';
      ui.demoBeat.classList.toggle('on', st.kind === 'demo');
      ui.demoMic.classList.toggle('on', st.kind === 'mic');
      fillList(ui.demoList, tr.map(function (t, i) { return rowFor(t, t.title, null, function () { playList(tr, i); }); }), '');
    }
    function renderAll() { renderLib(); renderRadio(); renderDemos(); }

    var radioLoaded = false;
    function selectTab(id, focusFirst) {
      tab = id; saveOpts();
      TABS.forEach(function (t) {
        var on = t[0] === id;
        ui.tabs[t[0]].setAttribute('aria-selected', on); ui.tabs[t[0]].tabIndex = on ? 0 : -1;
        ui.secs[t[0]].classList.toggle('active', on);
      });
      if (id === 'radio' && !radioLoaded) { radioLoaded = true; radioSearch('top'); }
      if (focusFirst) { var f = focusables(ui.secs[id])[0]; if (f) f.focus(); }
    }

    // ---- open / close / keyboard
    var lastInput = 0, opener = null;
    function placePanel() {
      var bar = slot !== document.body ? slot.closest('.bar') || slot.parentElement : null;
      ui.panel.style.bottom = bar && !bar.classList.contains('hide') ? Math.round(bar.getBoundingClientRect().height) + 'px' : '0';
    }
    function openPanel() {
      placePanel();
      ui.panel.classList.remove('closed', 'hide'); ui.panel.setAttribute('aria-hidden', 'false');
      ui.musicBtn.classList.add('on'); ui.musicBtn.setAttribute('aria-expanded', 'true');
      lastInput = Date.now();
      opener = document.activeElement;
      selectTab(tab, false); renderAll();
      var cur = ui.secs[tab].querySelector('.wmpm-row.cur .wmpm-item');
      (cur || ui.tabs[tab]).focus({ preventScroll: !cur });
      if (cur) cur.scrollIntoView({ block: 'center' });
    }
    function closePanel() {
      var had = ui.panel.contains(document.activeElement);
      ui.panel.classList.add('closed'); ui.panel.setAttribute('aria-hidden', 'true');
      ui.musicBtn.classList.remove('on'); ui.musicBtn.setAttribute('aria-expanded', 'false');
      if (had) (opener && opener !== document.body && document.contains(opener) ? opener : ui.musicBtn).focus();
    }
    function isPanelOpen() { return !ui.panel.classList.contains('closed'); }
    function togglePanel() { if (isPanelOpen()) closePanel(); else openPanel(); }
    function focusables(scope) {
      return Array.prototype.filter.call((scope || ui.panel).querySelectorAll('button,input,select'), function (el) {
        return !el.disabled && el.offsetParent !== null && !el.classList.contains('wmpm-hidden-input');
      });
    }
    // spatial arrow-key navigation (TV remotes / keyboards)
    function moveFocus(from, dx, dy) {
      var list = focusables(), r0 = from.getBoundingClientRect(), cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2, best = null, bestD = 1e9;
      list.forEach(function (el) {
        if (el === from) return;
        var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, d;
        if (dy) { if ((y - cy) * dy <= r0.height * 0.4) return; d = Math.abs(y - cy) * 4 + Math.abs(x - cx); }
        else { if (Math.abs(y - cy) > r0.height * 0.6 || (x - cx) * dx <= 0) return; d = Math.abs(x - cx); }
        if (d < bestD) { bestD = d; best = el; }
      });
      if (best) { best.focus(); best.scrollIntoView({ block: 'nearest' }); }
      return !!best;
    }
    ui.panel.addEventListener('keydown', function (e) {
      e.stopPropagation(); lastInput = Date.now(); onActivity();
      var k = e.key, t = e.target, text = t.tagName === 'INPUT';
      if (k === 'Escape') { closePanel(); e.preventDefault(); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') { moveFocus(t, 0, k === 'ArrowDown' ? 1 : -1); e.preventDefault(); }
      else if ((k === 'ArrowLeft' || k === 'ArrowRight') && !text) { moveFocus(t, k === 'ArrowRight' ? 1 : -1, 0); e.preventDefault(); }
      else if (k === 'PageDown' || k === 'PageUp') {
        var l = ui.secs[tab].querySelector('.wmpm-list'); if (l) l.scrollTop += (k === 'PageDown' ? 1 : -1) * l.clientHeight * 0.9; e.preventDefault();
      }
    });
    ['pointermove', 'wheel', 'pointerdown'].forEach(function (ev) { ui.panel.addEventListener(ev, function () { lastInput = Date.now(); onActivity(); }, { passive: true }); });
    ui.panel.addEventListener('scroll', function () { lastInput = Date.now(); onActivity(); }, true);
    window.addEventListener('resize', function () { if (isPanelOpen()) placePanel(); });
    // media keys (keyboards / TV remotes) when the page has focus
    var lastMediaKey = 0;
    document.addEventListener('keydown', function (e) {
      var k = e.key, now = Date.now();
      if (k !== 'MediaTrackNext' && k !== 'MediaTrackPrevious' && k !== 'MediaPlayPause') return;
      e.preventDefault(); if (now - lastMediaKey < 300) return; lastMediaKey = now;
      if (k === 'MediaTrackNext') next(false); else if (k === 'MediaTrackPrevious') prev(); else togglePause();
    });

    // ---- drag and drop anywhere
    var dragDepth = 0;
    document.addEventListener('dragenter', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { dragDepth++; ui.drop.classList.add('on'); } });
    document.addEventListener('dragleave', function () { if (--dragDepth <= 0) { dragDepth = 0; ui.drop.classList.remove('on'); } });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      e.preventDefault(); dragDepth = 0; ui.drop.classList.remove('on');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { ensureCtx(); addFiles(e.dataTransfer.files, true); }
    });

    selectTab(tab, false);
    renderAll(); updatePlay();
    loadSavedHandle();
    nowStatus('Demo beat');

    var music = {
      sampleLevel: sampleLevel,
      setVolume: setVolume,
      getVolume: function () { return vol; },
      togglePause: togglePause,
      isPaused: function () { return st.paused; },
      next: function () { next(false); },
      prev: prev,
      playDemo: startDemo,
      playMic: startMic,
      playFiles: function (files) { ensureCtx(); addFiles(files, true); },
      openPanel: openPanel, closePanel: closePanel, togglePanel: togglePanel, isPanelOpen: isPanelOpen,
      setUiHidden: function (hide) { ui.panel.classList.toggle('hide', !!hide); if (!hide && isPanelOpen()) placePanel(); },
      isActive: function () {
        if (!isPanelOpen()) return false;
        return ui.panel.matches(':hover') || (ui.panel.contains(document.activeElement) && Date.now() - lastInput < 15000);
      },
      nowPlaying: function () { return st.title; },
      sourceKind: function () { return st.kind; },
      visualsAvailable: function () { return st.kind !== 'demo' && !st.noViz; },
      setAnalyzer: setAnalyzer,
      get audioContext() { return actx; },
      get tap() { return tap; },
      setSound: setSound,
      soundMode: function () { return soundMode; },
      soundLabel: soundLabel,
      _state: st, _radio: radio, _lib: lib
    };
    root.WmpMusic.last = music;   // debugging / tests
    return music;
  }

  root.WmpMusic = { create: create, analyserStage: analyserStage, pcmStage: pcmStage, DemoBeat: DemoBeat };
})(window);
