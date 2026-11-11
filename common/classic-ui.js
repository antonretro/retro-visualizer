// Classic presets dialog shared by both players: load from wmp.dll (or a classic pack .json), on/off toggle,
// export, remove. Needs classic.js and brand.js.
//   var ui = ClassicUI.mount({ button: buttonElement, onChange: function (packOrNull) {} });
//   ui.active() -> pack when classic presets are loaded AND switched on, else null
(function (root) {
  'use strict';
  var CSS = [
    '.cvx-back{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}',
    '.cvx-back.closed{display:none}',
    '.cvx{width:min(94vw,620px);max-height:92vh;overflow:auto;background:#121820;color:#e7eef5;border:1px solid rgba(255,255,255,.18);border-radius:10px;',
    'padding:18px 20px;font:14px/1.45 system-ui,Segoe UI,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.6)}',
    '.cvx h2{margin:0 0 6px;font-size:18px}.cvx p{margin:6px 0}.cvx small,.cvx .fine{color:#93a4b4;font-size:12px}',
    '.cvx button{font:600 13px system-ui,Segoe UI,sans-serif;color:#e7eef5;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:7px 12px;cursor:pointer;margin:4px 6px 4px 0}',
    '.cvx button:hover{background:rgba(255,255,255,.16)}.cvx button.main{background:#2d7fb8;border-color:#2d7fb8}',
    '.cvx .drop{border:2px dashed rgba(255,255,255,.25);border-radius:8px;padding:12px;margin:10px 0;text-align:center}',
    '.cvx .drop.on{border-color:#5aa0e0;background:rgba(45,127,184,.15)}',
    '.cvx .msg{white-space:pre-line;margin:8px 0;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.05);min-height:1.4em}',
    '.cvx .msg.err{background:rgba(200,60,60,.2)}.cvx .msg.ok{background:rgba(60,160,90,.2)}',
    '.cvx label.tog{display:flex;gap:8px;align-items:center;font-weight:600;margin:8px 0}',
    '.cvx ul{margin:4px 0 4px 18px;padding:0}.cvx code{background:rgba(255,255,255,.08);padding:0 4px;border-radius:3px}'
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
  function isClassicFile(f) { return /\.(dll|mui|json)$/i.test(f.name); }

  function mount(opts) {
    var CP = root.ClassicPack, BR = root.BRAND || {};
    if (!document.getElementById('cvx-css')) document.head.appendChild(h('style', { id: 'cvx-css', text: CSS }));
    var pack = CP.load();
    var onChange = opts.onChange || function () {};
    var input = h('input', { type: 'file', multiple: '', accept: '.dll,.mui,.json', style: 'display:none' });
    var msg = h('div', { cls: 'msg', 'aria-live': 'polite' });
    var tog = h('input', { type: 'checkbox' });
    var togRow = h('label', { cls: 'tog' }, [tog, 'Original presets on']);
    var exportBtn = h('button', { text: 'Export classic pack (.json)', title: 'For devices without Windows: copy this file to them and load it there' });
    var removeBtn = h('button', { text: 'Remove from this device' });
    var drop = h('div', { cls: 'drop' }, [
      h('button', { cls: 'main', text: 'Load classic presets from your Windows', onclick: function () { input.click(); } }),
      h('div', { cls: 'fine', text: 'or drop wmp.dll here (add wmploc.dll.mui for the original names, optional) - or a classic pack .json' })]);
    var box = h('div', { cls: 'cvx', role: 'dialog', 'aria-label': 'Classic presets' }, [
      h('h2', { text: 'Classic presets' }),
      h('p', { text: (BR.name || 'This player') + ' comes with its own presets. If you own a copy of Windows, you can also use the original classic presets: they are read from your own wmp.dll, inside this page. Nothing is uploaded.' }),
      drop, input, msg, togRow, h('div', {}, [exportBtn, removeBtn]),
      h('p', { cls: 'fine' }, [h('b', { text: 'Where is it? ' }), 'C:\\Windows\\System32\\wmp.dll  (names: C:\\Windows\\System32\\en-US\\wmploc.dll.mui, or your language folder).']),
      h('ul', { cls: 'fine' }, [
        h('li', { text: 'No wmp.dll? Install Windows Media Player Legacy: Settings > Apps > Optional features > Add a feature (View features) > "Windows Media Player Legacy".' }),
        h('li', { text: 'Mac, Linux, phone: copy wmp.dll from a Windows PC you own, then pick it here.' }),
        h('li', { text: 'TV box or other device without Windows: load it on your PC, press Export, and copy the .json to the device.' }),
        h('li', { text: 'Only use files from your own Windows installation.' })]),
      h('p', { cls: 'fine', text: BR.disclaimer || '' }),
      h('div', {}, [h('button', { text: 'Close', onclick: function () { close(); } })])
    ]);
    var back = h('div', { cls: 'cvx-back closed', onclick: function (e) { if (e.target === back) close(); } }, [box]);
    document.body.appendChild(back);

    function say(t, kind) { msg.textContent = t; msg.className = 'msg' + (kind ? ' ' + kind : ''); }
    function refresh() {
      tog.checked = !!pack && CP.enabled(); tog.disabled = !pack;
      togRow.style.display = pack ? '' : 'none'; exportBtn.style.display = pack ? '' : 'none'; removeBtn.style.display = pack ? '' : 'none';
      if (opts.button) opts.button.classList.toggle('on', !!active());
    }
    function active() { return pack && CP.enabled() ? pack : null; }
    function handle(files) {
      say('Reading...');
      CP.fromFiles(files).then(function (r) {
        pack = r.pack;
        var saved = CP.save(pack);
        CP.setEnabled(true);
        say(r.report.lines.join('\n') + (saved ? '\nSaved on this device: you will not need to do this again.' : '\n(Could not save on this device: storage is full or disabled.)'), 'ok');
        refresh(); onChange(active());
      }, function (e) {
        say(e && e.message ? e.message : String(e), 'err');
      });
    }
    input.onchange = function () { if (input.files.length) handle(input.files); input.value = ''; };
    tog.onchange = function () { CP.setEnabled(tog.checked); refresh(); onChange(active()); };
    exportBtn.onclick = function () {
      var url = URL.createObjectURL(new Blob([CP.toJSON(pack)], { type: 'application/json' }));
      var a = h('a', { href: url, download: 'classic-pack.json' }); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    };
    removeBtn.onclick = function () { CP.clear(); pack = null; say('Classic presets removed from this device.'); refresh(); onChange(null); };
    // drag and drop (wins over the Music panel's drop for .dll/.mui/.json files)
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('on'); }); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('on'); });
    document.addEventListener('drop', function (e) {
      var fs = e.dataTransfer && e.dataTransfer.files;
      if (!fs || !fs.length || !Array.prototype.some.call(fs, isClassicFile)) return;
      e.preventDefault(); e.stopImmediatePropagation(); drop.classList.remove('on');
      var md = document.querySelector('.wmpm-drop'); if (md) md.classList.remove('on');
      open(); handle(fs);
    }, true);
    function open() { back.classList.remove('closed'); }
    function close() { back.classList.add('closed'); }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !back.classList.contains('closed')) close(); });
    if (opts.button) opts.button.onclick = function () { open(); };
    refresh();
    return { open: open, close: close, active: active, pack: function () { return pack; } };
  }
  root.ClassicUI = { mount: mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);
