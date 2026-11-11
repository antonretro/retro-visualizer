// "Set up Windows extras": one guide shared by the start page and both players (browser and Windows app).
// Three optional steps, each with a tick: classic presets (wmp.dll), Windows sound (gm.dls), sample songs (*.mid).
// Opens by itself on the first visit (until "Don't show again"), and from a button.
//   RetroSetup.mount({ button: el, music: musicInstanceOrNull })   (needs brand.js, classic.js; classic-ui.js optional)
// In the Windows app (window.RetroHost) the files found on the PC are used in place and the steps tick themselves.
// Chrome 76 safe (ES5, no flex gap).
(function (root) {
  'use strict';
  var BS = String.fromCharCode(92);
  var P_DLL = 'C:' + BS + 'Windows' + BS + 'System32' + BS + 'wmp.dll';
  var P_MUI = 'C:' + BS + 'Windows' + BS + 'System32' + BS + 'en-US' + BS + 'wmploc.dll.mui';
  var P_DLS = 'C:' + BS + 'Windows' + BS + 'System32' + BS + 'drivers' + BS + 'gm.dls';
  var P_MID = 'C:' + BS + 'Windows' + BS + 'Media';
  var K_HIDE = 'rvsetup.hide', K_SHOWN = 'rvsetup.shown', K_DEMOS = 'rvmusic.demos', K_SOUND = 'wmpmusic.sound';
  var MIDI_RE = /\.(mid|midi|rmi|kar)$/i;
  var CSS = [
    '.rvs-back{position:fixed;top:0;left:0;right:0;bottom:0;z-index:60;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center}',
    '.rvs-back.closed{display:none}',
    '.rvs{width:96vw;max-width:860px;max-height:94vh;overflow:auto;box-sizing:border-box;background:#121820;color:#e7eef5;border:1px solid rgba(255,255,255,.18);',
    'border-radius:12px;padding:20px 24px;font:clamp(16px,1.7vw,21px)/1.45 system-ui,Segoe UI,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.6);text-align:left}',
    '.rvs h2{margin:0 0 4px;font-size:1.5em}.rvs .sub{color:#93a4b4;margin:0 0 12px}',
    '.rvs .note{background:rgba(255,200,80,.12);border:1px solid rgba(255,200,80,.35);border-radius:8px;padding:8px 12px;margin:8px 0}',
    '.rvs .step{border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:12px 16px;margin:10px 0;background:rgba(255,255,255,.03)}',
    '.rvs .head{display:flex;align-items:center}',
    '.rvs .tick{flex:0 0 1.6em;height:1.6em;margin-right:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;background:#55606b}',
    '.rvs .ok .tick{background:#2f9e5a}.rvs .no .tick{background:#3a4652}.rvs .err .state{color:#ff9a9a}',
    '.rvs .name{font-weight:600}.rvs .state{color:#93a4b4;font-size:.85em}',
    '.rvs .fix{margin:8px 0 0 calc(1.6em + 14px)}.rvs .ok .fix{display:none}',
    '.rvs .path{display:flex;flex-wrap:wrap;align-items:center;margin:4px 0}',
    '.rvs code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:4px;margin-right:8px;word-break:break-all}',
    '.rvs .drop{border:2px dashed rgba(255,255,255,.25);border-radius:8px;padding:8px 12px;margin:6px 0}',
    '.rvs .drop.on{border-color:#5aa0e0;background:rgba(45,127,184,.15)}',
    '.rvs .hint{color:#93a4b4;font-size:.8em;margin:4px 0}',
    '.rvs button{font:600 .85em system-ui,Segoe UI,sans-serif;color:#e7eef5;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.22);',
    'border-radius:6px;padding:7px 14px;cursor:pointer;margin:3px 8px 3px 0}',
    '.rvs button:hover,.rvs button:focus{background:rgba(255,255,255,.16);outline:2px solid #5aa0e0;outline-offset:1px}',
    '.rvs button.main{background:#2d7fb8;border-color:#2d7fb8;font-size:1.05em;padding:10px 34px}',
    '.rvs .end{display:flex;flex-wrap:wrap;align-items:center;margin-top:14px}',
    '.rvs label{display:flex;align-items:center;margin-left:12px;cursor:pointer}.rvs label input{width:1.1em;height:1.1em;margin-right:8px}',
    '.rvs .sum{margin:10px 0;padding:0;list-style:none}.rvs .sum li{margin:6px 0}',
    '.rvs .fine{color:#93a4b4;font-size:.72em;margin-top:12px}'
  ].join('\n');

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === 'text') el.textContent = v; else if (k === 'cls') el.className = v;
      else if (k.slice(0, 2) === 'on') el[k] = v; else el.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k) { try { sessionStorage.setItem(k, '1'); } catch (e) {} }
  function readBuf(f) {
    if (f.arrayBuffer) return f.arrayBuffer();
    return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok(r.result); }; r.onerror = function () { no(r.error); }; r.readAsArrayBuffer(f); });
  }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    var ta = h('textarea', { style: 'position:fixed;top:-100px;opacity:0' }); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove(); return Promise.resolve();
  }
  // same storage as music.js uses (for pages without a player, e.g. the start page)
  function idb(mode, fn) {
    return new Promise(function (ok, no) {
      if (!root.indexedDB) { no(new Error('no IndexedDB')); return; }
      var r; try { r = indexedDB.open('wmp-music', 1); } catch (e) { no(e); return; }
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
  function storedDemos() { try { var d = JSON.parse(lsGet(K_DEMOS) || '[]'); return Array.isArray(d) ? d : []; } catch (e) { return []; } }

  var inst = null;
  function mount(opts) {
    opts = opts || {};
    if (inst) { if (opts.button) opts.button.onclick = function () { inst.open(); }; return inst; }
    var H = root.RetroHost, CP = root.ClassicPack, BR = root.BRAND || {}, music = opts.music || null;
    var onWindows = /Win/i.test(navigator.platform || '') || /Windows/i.test(navigator.userAgent || '');
    if (!document.getElementById('rvs-css')) document.head.appendChild(h('style', { id: 'rvs-css', text: CSS }));
    var st = { wmp: { s: 'no', t: '' }, dls: { s: 'no', t: '' }, mid: { s: 'no', t: '' } };

    function pathRow(p, label) {
      return h('div', { cls: 'path' }, [label ? h('span', { text: label + ' ', style: 'margin-right:6px' }) : null, h('code', { text: p }),
        h('button', { text: 'Copy path', onclick: function () { var b = this; copyText(p).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy path'; }, 1500); }); } })]);
    }
    function step(id, title, paths, accept, multiple, hint, onFiles) {
      var input = h('input', { type: 'file', accept: accept, style: 'display:none' });
      if (multiple) input.multiple = true;
      input.onchange = function () { if (input.files.length) onFiles(input.files); input.value = ''; };
      var drop = h('div', { cls: 'drop' }, [h('button', { text: 'Open...', onclick: function () { input.click(); } }),
        h('span', { cls: 'hint', text: 'or drop the file' + (multiple ? 's' : '') + ' here' })]);
      var el = h('div', { cls: 'step no', id: 'rvs-' + id }, [
        h('div', { cls: 'head' }, [h('div', { cls: 'tick', text: '✗' }), h('div', {}, [h('div', { cls: 'name', text: title }), h('div', { cls: 'state' })])]),
        h('div', { cls: 'fix' }, paths.concat([drop, input, h('div', { cls: 'hint', text: hint })]))]);
      ['dragenter', 'dragover'].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.add('on'); }); });
      el.addEventListener('dragleave', function () { drop.classList.remove('on'); });
      el.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation(); drop.classList.remove('on');
        if (e.dataTransfer && e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
      });
      return el;
    }
    var openHint = 'Open... then paste the path into the "File name" box and press Enter.';
    var sWmp = step('wmp', '1. Classic presets (wmp.dll)', [pathRow(P_DLL), pathRow(P_MUI, 'Optional, for the original names:')], '.dll,.mui,.json', true,
      openHint + ' For the original names, then Open... wmploc.dll.mui the same way. No wmp.dll? Settings > Apps > Optional features > Add a feature > "Windows Media Player Legacy". Only the presets are kept, not the file.', loadWmp);
    var sDls = step('dls', '2. Windows sound (gm.dls)', [pathRow(P_DLS)], '.dls', false,
      openHint + ' Plays MIDI songs with the classic Windows instruments.', loadDls);
    var sMid = step('mid', '3. Optional: Windows sample songs (.mid)', [pathRow(P_MID)], '.mid,.midi,.rmi,.kar', true,
      'Open..., paste the folder path into "File name", press Enter, then select the .mid files (Ctrl+A) and press Open. They appear in Music > Demos.', loadMid);
    var dont = h('input', { type: 'checkbox' });
    dont.checked = lsGet(K_HIDE) === '1';
    var steps = h('div', {}, [sWmp, sDls, sMid]);
    var sum = h('ul', { cls: 'sum' });
    var stepsEnd = h('div', { cls: 'end' }, [h('button', { cls: 'main', text: 'Done', onclick: function () { showSummary(true); } }),
      h('button', { text: 'Skip', onclick: function () { close(); } }), h('label', {}, [dont, "Don't show again"])]);
    var sumView = h('div', { style: 'display:none' }, [h('p', { text: 'All set. Here is what this player will use:' }), sum,
      h('p', { cls: 'hint', text: 'Open this guide again any time with the Setup button.' }),
      h('div', { cls: 'end' }, [h('button', { cls: 'main', text: 'Start', onclick: function () { close(); } }),
        h('button', { text: 'Back', onclick: function () { showSummary(false); } })])]);
    var note = onWindows ? null : h('div', { cls: 'note', text: 'On a Mac, phone or TV box: copy these files from a Windows PC you own (USB stick or network share), then use Open... or drop them here. Never download them from websites.' });
    var box = h('div', { cls: 'rvs', role: 'dialog', 'aria-label': 'Set up Windows extras' }, [
      h('h2', { text: 'Set up Windows extras' }),
      h('p', { cls: 'sub', text: H ? 'Everything found on this PC is used where it is: nothing is copied or uploaded. All steps are optional.' :
        'Optional. If you own Windows, these files from your PC unlock the classic extras. They are read inside this page: nothing is uploaded.' }),
      note, steps, stepsEnd, sumView, h('p', { cls: 'fine', text: (BR.disclaimer || '') + ' Only use files from your own Windows installation.' })]);
    var back = h('div', { cls: 'rvs-back closed', onclick: function (e) { if (e.target === back) close(); } }, [box]);
    document.body.appendChild(back);

    function set(id, s, t) {
      st[id] = { s: s, t: t };
      var el = { wmp: sWmp, dls: sDls, mid: sMid }[id];
      el.className = 'step ' + s;
      el.querySelector('.tick').textContent = s === 'ok' ? '✓' : s === 'wait' ? '…' : '✗';
      el.querySelector('.state').textContent = t;
    }
    function packText(p) { return (p.battery ? p.battery.length : 0) + ' plasma presets, ' + (p.barswaves ? p.barswaves.length : 0) + ' spectrum styles'; }

    // ---- 1. classic presets: the existing loader (classic-ui when present, so the player updates at once)
    var lastDll = null;   // the two files live in different folders: a .mui picked later is paired with this
    function loadWmp(files) {
      files = Array.prototype.slice.call(files);
      var dll = files.filter(function (f) { return /\.dll$/i.test(f.name); })[0];
      if (dll) lastDll = dll;
      else if (lastDll && files.some(function (f) { return /\.mui$/i.test(f.name); })) files.unshift(lastDll);
      set('wmp', 'wait', 'Reading...');
      var ui = root.ClassicUI && root.ClassicUI.last;
      var p = ui ? ui.load(files) : CP.fromFiles(files).then(function (r) { CP.save(r.pack); CP.setEnabled(true); return r; });
      p.then(function () { checkWmp(); }, function (e) { set('wmp', 'err', (e && e.message) || String(e)); });
    }
    function checkWmp() {
      var pack = CP && CP.load();
      if (pack) set('wmp', 'ok', (H && H.wmp ? 'Found on this PC: ' : 'Ready: ') + packText(pack));
      else if (H && H.wmp) set('wmp', 'wait', 'Found on this PC, reading...');
      else set('wmp', 'no', 'Not set up');
    }
    document.addEventListener('classicpack', function (e) {
      if (e.detail && e.detail.error && !(CP && CP.load())) set('wmp', 'err', e.detail.error); else checkWmp();
    });
    if (H && H.wmp && CP && !CP.load() && !(root.ClassicUI && root.ClassicUI.last)) {   // page without classic-ui: read it here
      Promise.all([H.file(H.wmp), H.mui ? H.file(H.mui) : null]).then(function (fs) { loadWmp(fs.filter(Boolean)); }, function () {});
    }

    // ---- 2. gm.dls: the player's Windows-sound path (or the same storage, on pages without a player)
    function loadDls(files) {
      var f = Array.prototype.filter.call(files, function (x) { return /\.dls$/i.test(x.name); })[0];
      if (!f) { set('dls', 'err', 'That is not gm.dls: pick ' + P_DLS); return; }
      set('dls', 'wait', 'Reading...');
      if (music && music.useDls) { music.useDls(f).then(function (ok) { if (ok) set('dls', 'ok', 'Ready: Windows sound is on for MIDI songs'); else set('dls', 'err', f.name + ' could not be used: pick ' + P_DLS); }); return; }
      readBuf(f).then(function (buf) {
        var tag = String.fromCharCode.apply(null, new Uint8Array(buf, 0, Math.min(12, buf.byteLength)));
        if (tag.slice(0, 4) !== 'RIFF' || tag.slice(8, 12) !== 'DLS ') throw new Error(f.name + ' is not a DLS sound bank: pick ' + P_DLS);
        return idb('readwrite', function (s) { return s.put(buf, 'gmdls'); });
      }).then(function () { lsSet(K_SOUND, '"windows"'); set('dls', 'ok', 'Ready: Windows sound is on for MIDI songs'); },
        function (e) { set('dls', 'err', (e && e.message) || String(e)); });
    }
    function checkDls() {
      if (H && H.dls) { set('dls', 'ok', 'Found on this PC: Windows sound is available for MIDI songs'); return; }
      if (music && music.hasDls && music.hasDls()) { set('dls', 'ok', 'Ready: kept on this device'); return; }
      set('dls', 'no', 'Not set up');
      idb('readonly', function (s) { return s.count('gmdls'); }).then(function (n) { if (n > 0 && st.dls.s === 'no') set('dls', 'ok', 'Ready: kept on this device'); }, function () {});
    }

    // ---- 3. sample songs -> Demos
    function loadMid(files) {
      var list = Array.prototype.filter.call(files, function (f) { return MIDI_RE.test(f.name); });
      if (!list.length) { set('mid', 'err', 'No .mid files chosen. In ' + P_MID + ' select the files ending in .mid.'); return; }
      set('mid', 'wait', 'Reading...');
      if (music && music.addDemos) { music.addDemos(list).then(checkMid, function (e) { set('mid', 'err', String(e && e.message || e)); }); return; }
      Promise.all(list.map(function (f) { return readBuf(f).then(function (b) { return { f: f, u: new Uint8Array(b) }; }); })).then(function (rs) {
        var D = storedDemos();
        rs.forEach(function (r) {
          var bin = '', u = r.u; for (var i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, Math.min(u.length, i + 8192)));
          var name = r.f.name.replace(/\.[^.]+$/, ''), rec = { name: name.charAt(0).toUpperCase() + name.slice(1), file: r.f.name, b64: btoa(bin) };
          D = D.filter(function (d) { return d.file.toLowerCase() !== rec.file.toLowerCase(); }); D.push(rec);
        });
        D.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
        if (!lsSet(K_DEMOS, JSON.stringify(D))) throw new Error('Not enough storage on this device for these songs.');
        checkMid();
      }).catch(function (e) { set('mid', 'err', (e && e.message) || String(e)); });
    }
    function checkMid() {
      var n = H && H.midis ? H.midis.length : 0, mine = storedDemos().length;
      if (n) set('mid', 'ok', 'Found on this PC: ' + n + ' song' + (n === 1 ? '' : 's') + ' in Music > Demos');
      else if (mine) set('mid', 'ok', 'Ready: ' + mine + ' song' + (mine === 1 ? '' : 's') + ' in Music > Demos');
      else set('mid', 'no', 'Not set up (optional)');
    }

    function refresh() { checkWmp(); checkDls(); checkMid(); }
    function showSummary(on) {
      steps.style.display = stepsEnd.style.display = on ? 'none' : '';
      if (note) note.style.display = on ? 'none' : '';
      sumView.style.display = on ? '' : 'none';
      if (on) {
        sum.textContent = '';
        [['wmp', 'Classic presets'], ['dls', 'Windows sound'], ['mid', 'Windows sample songs']].forEach(function (x) {
          var ok = st[x[0]].s === 'ok';
          sum.appendChild(h('li', { text: (ok ? '✓ ' : '✗ ') + x[1] + ': ' + (ok ? st[x[0]].t : 'skipped (built-in ' + (x[0] === 'wmp' ? 'presets' : x[0] === 'dls' ? 'Retro Synth sound' : 'demo beat') + ' instead)') }));
        });
        sumView.querySelector('button.main').focus();
      }
    }
    function open() { refresh(); showSummary(false); back.classList.remove('closed'); ssSet(K_SHOWN); box.scrollTop = 0; var b = box.querySelector('button.main'); if (b) b.focus({ preventScroll: true }); }
    function close() { lsSet(K_HIDE, dont.checked ? '1' : null); back.classList.add('closed'); }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !back.classList.contains('closed')) { e.stopPropagation(); close(); } }, true);
    if (opts.button) opts.button.onclick = function () { open(); };
    inst = { open: open, close: close, refresh: refresh };
    if (lsGet(K_HIDE) !== '1' && !ssGet(K_SHOWN)) open(); else refresh();
    return inst;
  }
  root.RetroSetup = { mount: mount, open: function () { if (inst) inst.open(); } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
