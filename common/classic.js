/*
 * classic.js - "Load classic presets from your Windows".
 *
 * This distribution ships NO data from Microsoft. If you own a copy of Windows, this module reads the
 * original preset data out of YOUR copy of wmp.dll (and, optionally, wmploc.dll.mui for the preset titles),
 * entirely inside your browser - nothing is uploaded anywhere. The result is a "classic pack" (JSON) that is
 * stored locally (localStorage) so this is a one-time step, and that can be exported and copied to devices
 * without Windows (e.g. a TV box).
 *
 *   ClassicPack.fromFiles([File, File...]) -> Promise<{pack, report}>   (wmp.dll required, .mui optional)
 *   ClassicPack.fromBuffers(dllU8, muiU8OrNull, fileName) -> {pack, report}  (sync; used by tests)
 *   ClassicPack.validate(obj) -> pack | throws Error('...')               (an imported/exported pack)
 *   ClassicPack.save(pack) / load() -> pack|null / clear()                 (localStorage)
 *   ClassicPack.enabled() / setEnabled(bool)                               ("Original presets on/off")
 *   ClassicPack.toJSON(pack) -> string                                     (export)
 *
 * Pack format: { format: 'classic-visualizer-pack', version: 1, created, source: { file, size, sha256,
 *   fileVersion, machine }, battery: [preset...] | null, barswaves: [style...] | null, notes: [..] }
 *   battery preset = { key, titleId, title, PaletteLocked, pre:[{class, dbl[8]}], current:{class, dbl[8]},
 *                      post:[...], palette: hex string (256 x RGB0) | null }   (registry-script layout)
 *   barswaves style = { title, bg, c1, c2, set: { property: value } }
 *
 * How the data is found (no offsets or values from the DLL are stored in this file):
 *   Battery: the DLL's REGISTRY resources are COM registration scripts (RGS text). The one that creates the
 *     visualization's Presets key holds every preset as registry values; this parses that script.
 *   Spectrum (bars/waves) styles: they are not data but code - one switch in the visualization's
 *     SetCurrentPreset method. The x64 code is located by an instruction-shape signature (opcodes and struct
 *     offsets only, every constant wildcarded) and then run through a tiny x86-64 interpreter for each preset
 *     index, recording which property setters are called with which values. Only builds whose SHA-256 is
 *     listed in VERIFIED were checked against the reference behaviour; other builds are accepted only if
 *     the interpreter's result passes every structural check, and are reported as "unverified".
 */
(function (root) {
  'use strict';
  var FORMAT = 'classic-visualizer-pack';
  var LS_PACK = 'classicvis.pack', LS_ON = 'classicvis.enabled';

  // builds whose spectrum-style extraction was verified against the pixel-exact reference
  // (sha256 -> note). Hashes identify a file; they contain none of its content.
  var VERIFIED = {
    'eedb3150f83cbcaf1b094739634eb986389c5baefd23a20c306513e829c1f40f': 'Windows 11 x64 (verified)'
  };

  // ------------------------------------------------------------------ sha-256 (sync, no dependencies)
  var K256 = new Uint32Array(64);
  (function () {   // first 32 bits of the fractional parts of the cube roots of the first 64 primes
    var n = 0, c = 2;
    while (n < 64) {
      var p = true; for (var d = 2; d * d <= c; d++) if (c % d === 0) { p = false; break; }
      if (p) { var r = Math.pow(c, 1 / 3); K256[n++] = ((r - Math.floor(r)) * 4294967296) >>> 0; }
      c++;
    }
  })();
  function sha256(u8) {
    var H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var len = u8.length, nb = ((len + 9 + 63) >> 6), W = new Uint32Array(64), i, j, t;
    var tail = new Uint8Array(128), tailStart = (nb - (len % 64 + 9 > 64 ? 2 : 1)) * 64;
    tail.set(u8.subarray(tailStart)); tail[len - tailStart] = 0x80;
    var bits = len * 8, tl = (nb * 64 - tailStart);
    tail[tl - 1] = bits & 255; tail[tl - 2] = (bits >>> 8) & 255; tail[tl - 3] = (bits >>> 16) & 255; tail[tl - 4] = (bits >>> 24) & 255;
    var hi = Math.floor(len / 536870912); tail[tl - 5] = hi & 255; tail[tl - 6] = (hi >>> 8) & 255;
    for (var b = 0; b < nb; b++) {
      var src = b * 64 < tailStart ? u8 : tail, o = b * 64 < tailStart ? b * 64 : b * 64 - tailStart;
      for (i = 0; i < 16; i++) W[i] = (src[o + 4 * i] << 24 | src[o + 4 * i + 1] << 16 | src[o + 4 * i + 2] << 8 | src[o + 4 * i + 3]) >>> 0;
      for (i = 16; i < 64; i++) {
        var x = W[i - 15], y = W[i - 2];
        var s0 = ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)), s1 = ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10));
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (j = 0; j < 64; j++) {
        var S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7), ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[j] + W[j]) >>> 0;
        var S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10), mj = (a & bb) ^ (a & c) ^ (bb & c);
        t = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t) >>> 0;
      }
      H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    var out = ''; for (i = 0; i < 8; i++) out += ('0000000' + H[i].toString(16)).slice(-8);
    return out;
  }

  // ------------------------------------------------------------------ PE reader
  function fail(code, msg) { var e = new Error(msg); e.code = code; throw e; }
  function PE(u8) {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
    this.u8 = u8; var dv = this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 0x100 || dv.getUint16(0, true) !== 0x5a4d) fail('notpe', 'This is not a Windows DLL (no MZ header).');
    var pe = dv.getUint32(0x3c, true);
    if (pe + 24 > u8.length || dv.getUint32(pe, true) !== 0x4550) fail('notpe', 'This is not a Windows DLL (no PE header).');
    this.machine = dv.getUint16(pe + 4, true);
    var nsec = dv.getUint16(pe + 6, true), optSize = dv.getUint16(pe + 20, true), opt = pe + 24;
    var magic = dv.getUint16(opt, true);
    this.is64 = magic === 0x20b;
    var ddOff = opt + (this.is64 ? 112 : 96);
    this.dirs = [];
    for (var i = 0; i < 16; i++) this.dirs.push({ rva: dv.getUint32(ddOff + i * 8, true), size: dv.getUint32(ddOff + i * 8 + 4, true) });
    this.sections = [];
    var so = opt + optSize;
    for (i = 0; i < nsec; i++) {
      var o = so + i * 40, name = '';
      for (var k = 0; k < 8 && u8[o + k]; k++) name += String.fromCharCode(u8[o + k]);
      this.sections.push({ name: name, vsize: dv.getUint32(o + 8, true), rva: dv.getUint32(o + 12, true),
        rawSize: dv.getUint32(o + 16, true), raw: dv.getUint32(o + 20, true), flags: dv.getUint32(o + 36, true) });
    }
  }
  PE.prototype.off = function (rva) {
    for (var i = 0; i < this.sections.length; i++) {
      var s = this.sections[i], span = Math.max(s.vsize, s.rawSize);
      if (rva >= s.rva && rva < s.rva + span) { var o = rva - s.rva; return o < s.rawSize ? s.raw + o : -1; }
    }
    return -1;
  };
  // resources: [{type, name, lang, rva, size}] (type/name are numbers or upper-case strings)
  PE.prototype.resources = function () {
    if (this._res) return this._res;
    var d = this.dirs[2], out = [], self = this;
    if (!d || !d.rva) return (this._res = out);
    var base = this.off(d.rva), dv = this.dv, u8 = this.u8;
    if (base < 0) return (this._res = out);
    function nameAt(o) {
      var n = dv.getUint16(base + o, true), s = '';
      for (var i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(base + o + 2 + 2 * i, true));
      return s.toUpperCase();
    }
    function dir(o, depth, path) {
      var nNamed = dv.getUint16(base + o + 12, true), nId = dv.getUint16(base + o + 14, true);
      for (var i = 0; i < nNamed + nId; i++) {
        var e = base + o + 16 + i * 8, nm = dv.getUint32(e, true), tgt = dv.getUint32(e + 4, true);
        var key = (nm & 0x80000000) ? nameAt(nm & 0x7fffffff) : (nm & 0xffff);
        var p = path.concat([key]);
        if (tgt & 0x80000000) { if (depth < 3) dir(tgt & 0x7fffffff, depth + 1, p); }
        else {
          var de = base + tgt;
          out.push({ type: p[0], name: p[1], lang: p[2], rva: dv.getUint32(de, true), size: dv.getUint32(de + 4, true) });
        }
      }
    }
    try { dir(0, 1, []); } catch (e) { /* truncated file: keep what was read */ }
    void self; void u8;
    return (this._res = out);
  };
  PE.prototype.resData = function (r) {
    var o = this.off(r.rva);
    if (o < 0 || o + r.size > this.u8.length) return null;
    return this.u8.subarray(o, o + r.size);
  };
  PE.prototype.fileVersion = function () {
    var rs = this.resources().filter(function (r) { return r.type === 16; });
    for (var i = 0; i < rs.length; i++) {
      var d = this.resData(rs[i]); if (!d) continue;
      for (var o = 0; o + 52 <= d.length; o += 4) {
        if (d[o] === 0xbd && d[o + 1] === 0x04 && d[o + 2] === 0xef && d[o + 3] === 0xfe) {
          var dv = new DataView(d.buffer, d.byteOffset + o, 52);
          var ms = dv.getUint32(8, true), ls = dv.getUint32(12, true);
          return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
        }
      }
    }
    return null;
  };
  // RT_STRING tables -> { id: text }
  PE.prototype.strings = function () {
    var out = {}, rs = this.resources().filter(function (r) { return r.type === 6 && typeof r.name === 'number'; });
    for (var i = 0; i < rs.length; i++) {
      var d = this.resData(rs[i]); if (!d) continue;
      var dv = new DataView(d.buffer, d.byteOffset, d.byteLength), o = 0;
      for (var k = 0; k < 16 && o + 2 <= d.length; k++) {
        var n = dv.getUint16(o, true); o += 2;
        var s = ''; for (var c = 0; c < n && o + 2 <= d.length; c++, o += 2) s += String.fromCharCode(dv.getUint16(o, true));
        if (n) out[(rs[i].name - 1) * 16 + k] = s;
      }
    }
    return out;
  };

  // ------------------------------------------------------------------ registry script (RGS) -> presets
  function latin1(u8) {
    var s = '', CH = 8192;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + CH)));
    return s;
  }
  function textOf(u8) {   // RGS resources are 8-bit text; tolerate UTF-16LE too
    if (u8.length > 3 && u8[1] === 0 && u8[3] === 0) {
      var s = ''; for (var i = 0; i + 1 < u8.length; i += 2) s += String.fromCharCode(u8[i] | u8[i + 1] << 8);
      return s;
    }
    return latin1(u8);
  }
  // -> tree node: { keys: [[name, node]...], vals: [[name, value]...] }
  function parseRgs(txt) {
    var re = /ForceRemove '([^']*)'|NoRemove (\w+)|^[ \t]*(\w+)[ \t]*\r?$|val '([^']*)' = (\w) '([^']*)'|(\{)|(\})/gm, m;
    var rootNode = { keys: [], vals: [] }, stack = [rootNode], pending = null;
    while ((m = re.exec(txt))) {
      if (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined) pending = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
      else if (m[7]) { var nd = { keys: [], vals: [] }; setKey(stack[stack.length - 1], pending, nd); stack.push(nd); pending = null; }
      else if (m[8]) { if (stack.length > 1) stack.pop(); }
      else if (m[4] !== undefined) setVal(stack[stack.length - 1], m[4], m[5] === 'd' ? parseInt(m[6], 10) : m[6]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return rootNode;
  }
  function setKey(n, k, v) { for (var i = 0; i < n.keys.length; i++) if (n.keys[i][0] === k) { n.keys[i][1] = v; return; } n.keys.push([k, v]); }
  function setVal(n, k, v) { for (var i = 0; i < n.vals.length; i++) if (n.vals[i][0] === k) { n.vals[i][1] = v; return; } n.vals.push([k, v]); }
  function key(n, k) { if (!n) return null; for (var i = 0; i < n.keys.length; i++) if (n.keys[i][0] === k) return n.keys[i][1]; return null; }
  function val(n, k) { if (!n) return undefined; for (var i = 0; i < n.vals.length; i++) if (n.vals[i][0] === k) return n.vals[i][1]; return undefined; }
  function path(n, names) { for (var i = 0; i < names.length && n; i++) n = key(n, names[i]); return n; }

  function presetsFromRgs(tree, titles) {
    var P = path(tree, ['HKEY_CURRENT_USER', 'SOFTWARE', 'Microsoft', 'MediaPlayer', 'Battery', 'Presets']);
    if (!P || !P.keys.length) return null;
    function dbls(info) { var a = []; for (var j = 1; j <= 8; j++) a.push(parseFloat(val(info, 'dbl' + j))); return a; }
    function list(v, prefix, cnt) {
      var out = [];
      for (var i = 0; i < cnt; i++) out.push({ 'class': val(v, prefix + i), dbl: dbls(key(key(v, prefix + 'Info'), String(i))) });
      return out;
    }
    return P.keys.map(function (kv) {
      var k = kv[0], v = kv[1], t = String(val(v, 'Title') || ''), sid = parseInt(t.split('#')[1], 10);
      var pal = val(v, 'Palette');
      return {
        key: k, titleId: sid, title: titles && titles[sid] != null ? titles[sid] : k,
        PaletteLocked: val(v, 'PaletteLocked'),
        pre: list(v, 'PreShift', val(v, 'PreShiftCount') | 0),
        current: { 'class': val(v, 'CurrentShift'), dbl: dbls(key(key(v, 'CurrentShiftInfo'), '0')) },
        post: list(v, 'PostShift', val(v, 'PostShiftCount') | 0),
        palette: pal === undefined ? null : pal
      };
    });
  }
  function extractBattery(pe, titles) {
    var rs = pe.resources().filter(function (r) { return r.type === 'REGISTRY'; });
    for (var i = 0; i < rs.length; i++) {
      var d = pe.resData(rs[i]); if (!d) continue;
      var txt = textOf(d);
      if (txt.indexOf('Presets') < 0 || txt.indexOf('CurrentShift') < 0) continue;
      var list = presetsFromRgs(parseRgs(txt), titles);
      if (list && list.length) return list;
    }
    return null;
  }

  // ------------------------------------------------------------------ x86-64 subset interpreter (spectrum styles)
  // Signature of the SetCurrentPreset entry: push rbx; sub rsp,20h; mov rbx,rcx; cmp edx,imm8; ja rel32;
  // xor r8d,r8d; mov [rcx+disp32],edx; test edx,edx; je rel32   (-1 = any byte)
  var SIG = [0x53, 0x48, 0x83, 0xec, 0x20, 0x48, 0x8b, 0xd9, 0x83, 0xfa, -1, 0x0f, 0x87, -1, -1, -1, -1,
             0x45, 0x33, 0xc0, 0x89, 0x91, -1, -1, -1, -1, 0x85, 0xd2, 0x0f, 0x84];
  // object field offsets and property-setter vtable slots of the spectrum visualization (SPEC section 4)
  var FIELDS = { 0x590: 'bg', 0x598: 'c1', 0x5a0: 'c2' };
  var SETTERS = { 0x40: 'mode', 0x60: 'peakHold', 0xa0: 'barSpeed', 0xe0: 'gap', 0xf0: 'barWidth', 0x110: 'fade', 0x120: 'trail' };
  var SPECTRUM_TITLE_ID = 0x157d;   // string ids of the 4 style names in wmploc.dll.mui

  function findSig(pe) {
    var u8 = pe.u8, hits = [];
    pe.sections.forEach(function (s) {
      if (!(s.flags & 0x20000000)) return;   // executable sections only
      var end = Math.min(u8.length, s.raw + s.rawSize) - SIG.length;
      outer: for (var o = s.raw; o < end; o++) {
        if (u8[o] !== 0x53 || u8[o + 1] !== 0x48) continue;
        for (var k = 2; k < SIG.length; k++) if (SIG[k] >= 0 && u8[o + k] !== SIG[k]) continue outer;
        hits.push(s.rva + (o - s.raw));
      }
    });
    return hits;
  }
  // run the method with edx = index; returns { stores: {disp: value}, calls: [[slot, edx, xmm1]] } or null
  function interp(pe, entryRva, index) {
    var u8 = pe.u8, dv = pe.dv;
    var R = { edx: index >>> 0, r8: 0, eax: 0 }, zf = 0, cf = 0, xmm1 = NaN, vt = -1;
    var stores = {}, calls = [], rip = entryRva;
    function rd8(rva) { var o = pe.off(rva); return o < 0 ? -1 : u8[o]; }
    function s32(rva) { var o = pe.off(rva); return o < 0 ? 0 : dv.getInt32(o, true); }
    function u32(rva) { var o = pe.off(rva); return o < 0 ? 0 : dv.getUint32(o, true); }
    function f32at(rva) { var o = pe.off(rva); return o < 0 ? NaN : dv.getFloat32(o, true); }
    function flagsSub(a, b) { var r = (a - b) >>> 0; zf = r === 0 ? 1 : 0; cf = (a >>> 0) < (b >>> 0) ? 1 : 0; return r; }
    // ModRM decoder: returns { len, mod, reg, rm, disp, rip } (len counts the modrm byte + sib + disp)
    function modrm(p) {
      var m = rd8(p), mod = m >> 6, reg = (m >> 3) & 7, rm = m & 7, len = 1, disp = 0, ripRel = false;
      if (mod !== 3 && rm === 4) len++;   // SIB
      if (mod === 0 && rm === 5) { disp = s32(p + len); len += 4; ripRel = true; }
      else if (mod === 1) { disp = (rd8(p + len) << 24) >> 24; len += 1; }
      else if (mod === 2) { disp = s32(p + len); len += 4; }
      return { len: len, mod: mod, reg: reg, rm: rm, disp: disp, rip: ripRel };
    }
    for (var steps = 0; steps < 4000; steps++) {
      var p = rip, b = rd8(p), rex = 0;
      if (b < 0) return null;
      if (b >= 0x40 && b <= 0x4f) { rex = b; p++; b = rd8(p); }
      var W = rex & 8, RX = rex & 4;
      var mr, imm;
      switch (b) {
        case 0x53: case 0x5b: case 0x55: case 0x5d: case 0x56: case 0x5e: case 0x57: case 0x5f: rip = p + 1; continue;   // push/pop
        case 0xc3: return { stores: stores, calls: calls };
        case 0xcc: case 0x90: rip = p + 1; continue;
        case 0x83: case 0x81:   // group 1 with imm8 / imm32
          mr = modrm(p + 1); imm = b === 0x83 ? (rd8(p + 1 + mr.len) << 24) >> 24 : s32(p + 1 + mr.len);
          if (mr.mod === 3 && !W && mr.rm === 2 && !(rex & 1)) {   // edx
            if (mr.reg === 7) flagsSub(R.edx, imm >>> 0);
            else if (mr.reg === 5) R.edx = flagsSub(R.edx, imm >>> 0);
            else if (mr.reg === 0) { R.edx = (R.edx + imm) >>> 0; zf = R.edx === 0 ? 1 : 0; }
          }
          rip = p + 1 + mr.len + (b === 0x83 ? 1 : 4); continue;
        case 0x85: mr = modrm(p + 1); if (mr.mod === 3 && mr.reg === 2 && mr.rm === 2) { zf = R.edx === 0 ? 1 : 0; cf = 0; } rip = p + 1 + mr.len; continue;
        case 0x33: case 0x31:   // xor r,r
          mr = modrm(p + 1);
          if (mr.mod === 3 && mr.reg === mr.rm) {
            var rr = mr.reg + (RX ? 8 : 0);
            if (rr === 2) R.edx = 0; else if (rr === 8) R.r8 = 0; else if (rr === 0) R.eax = 0;
            zf = 1; cf = 0;
          }
          rip = p + 1 + mr.len; continue;
        case 0x8b:   // mov r, r/m
          mr = modrm(p + 1);
          if (W && mr.mod !== 3 && mr.reg === 0 && mr.rm === 0 && !RX) vt = mr.disp;   // mov rax,[rax+disp]: vtable slot
          rip = p + 1 + mr.len; continue;
        case 0x89:   // mov r/m, r
          mr = modrm(p + 1);
          if (mr.mod !== 3 && !W) { var v = (mr.reg + (RX ? 8 : 0)) === 8 ? R.r8 : (mr.reg + (RX ? 8 : 0)) === 2 ? R.edx : null; if (v !== null) stores[mr.disp] = v >>> 0; }
          rip = p + 1 + mr.len; continue;
        case 0xc7:   // mov r/m32, imm32
          mr = modrm(p + 1); imm = u32(p + 1 + mr.len);
          if (mr.mod !== 3 && !W) stores[mr.disp] = imm;
          rip = p + 1 + mr.len + 4; continue;
        case 0x8a: case 0x88: case 0x22: case 0x0a: case 0x8d: case 0x3a: case 0x84:
          mr = modrm(p + 1); rip = p + 1 + mr.len; continue;   // byte ops / lea: no effect on what we track
        case 0xb0: case 0xb1: case 0xb2: case 0xb3:   // mov r8, imm8
          if (b === 0xb2 && !(rex & 1)) R.edx = ((R.edx & ~0xff) | rd8(p + 1)) >>> 0;
          rip = p + 2; continue;
        case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbe: case 0xbf:   // mov r32, imm32 / movabs r64, imm64
          if (W) { rip = p + 9; continue; }
          imm = u32(p + 1);
          if (b === 0xba && !(rex & 1)) R.edx = imm; else if (b === 0xb8 && (rex & 1)) R.r8 = imm; else if (b === 0xb8) R.eax = imm;
          rip = p + 5; continue;
        case 0xe8: rip = p + 5; continue;   // direct call (memset, ring/colour rebuild): not interpreted
        case 0xe9: rip = p + 5 + s32(p + 1); continue;
        case 0xeb: rip = p + 2 + ((rd8(p + 1) << 24) >> 24); continue;
        case 0x74: case 0x75: case 0x77: case 0x72: case 0x73: case 0x76: {
          var t8 = p + 2 + ((rd8(p + 1) << 24) >> 24);
          rip = cond(b & 0x0f) ? t8 : p + 2; continue;
        }
        case 0xff:
          mr = modrm(p + 1);
          if (mr.reg === 2) {   // call [..]: a property setter through the vtable (CFG dispatch)
            if (vt >= 0) calls.push([vt, R.edx, xmm1]);
            vt = -1; rip = p + 1 + mr.len; continue;
          }
          if (mr.reg === 4) return null;   // indirect jmp: not supported
          rip = p + 1 + mr.len; continue;
        case 0xf3: case 0xf2:
          if (rd8(p + 1) === 0x0f && rd8(p + 2) === 0x10) {   // movss/movsd xmm, [rip+disp]
            var q = p + 3;
            mr = modrm(q);
            if (b === 0xf3 && mr.rip && mr.reg === 1) xmm1 = f32at(q + mr.len + mr.disp);
            rip = q + mr.len; continue;
          }
          if (rd8(p + 1) >= 0x40 && rd8(p + 1) <= 0x4f && rd8(p + 2) === 0x0f && rd8(p + 3) === 0x10) {
            mr = modrm(p + 4); rip = p + 4 + mr.len; continue;
          }
          return null;
        case 0x0f: {
          var b2 = rd8(p + 1);
          if (b2 >= 0x80 && b2 <= 0x8f) { var t32 = p + 6 + s32(p + 2); rip = cond(b2 & 0x0f) ? t32 : p + 6; continue; }
          if (b2 === 0x57 || b2 === 0x28 || b2 === 0x10 || b2 === 0x11) { mr = modrm(p + 2); rip = p + 2 + mr.len; continue; }
          return null;
        }
        default: return null;   // unknown instruction: this build is not supported
      }
    }
    return null;
    function cond(c) {
      switch (c) {
        case 2: return cf === 1;              // jb
        case 3: return cf === 0;              // jae
        case 4: return zf === 1;              // je
        case 5: return zf === 0;              // jne
        case 6: return cf === 1 || zf === 1;  // jbe
        case 7: return cf === 0 && zf === 0;  // ja
      }
      return false;
    }
  }
  function extractSpectrum(pe, titles) {
    if (pe.machine !== 0x8664) return { styles: null, why: 'this wmp.dll is not the 64-bit (x64) build; use C:\\Windows\\System32\\wmp.dll from 64-bit Windows' };
    var hits = findSig(pe);
    if (hits.length !== 1) return { styles: null, why: hits.length ? 'ambiguous code signature in this build' : 'code signature not found in this build' };
    var styles = [];
    for (var i = 0; i < 4; i++) {
      var r = interp(pe, hits[0], i);
      if (!r) return { styles: null, why: 'unsupported instructions in this build' };
      var st = { title: titles && titles[SPECTRUM_TITLE_ID + i] ? titles[SPECTRUM_TITLE_ID + i] : 'Classic style ' + (i + 1),
        bg: 0, c1: 0, c2: null, set: {} };
      if (!(0x590 in r.stores) || !(0x598 in r.stores)) return { styles: null, why: 'unexpected structure in this build' };
      st.bg = r.stores[0x590]; st.c1 = r.stores[0x598]; if (0x5a0 in r.stores) st.c2 = r.stores[0x5a0];
      for (var k = 0; k < r.calls.length; k++) {
        var c = r.calls[k], name = SETTERS[c[0]];
        if (!name) return { styles: null, why: 'unexpected setter in this build' };
        var v = name === 'barSpeed' ? c[2] : c[1] | 0;
        if (v !== v) return { styles: null, why: 'unexpected setter value in this build' };
        st.set[name] = v;
      }
      if (st.set.mode === undefined || st.set.mode < 0 || st.set.mode > 4 || r.calls.length < 2) return { styles: null, why: 'unexpected values in this build' };
      styles.push(st);
    }
    return { styles: styles, why: null };
  }

  // ------------------------------------------------------------------ public
  function isMui(pe) {
    var rs = pe.resources();
    var hasStrings = rs.some(function (r) { return r.type === 6; }), hasReg = rs.some(function (r) { return r.type === 'REGISTRY'; });
    return hasStrings && !hasReg;
  }
  function fromBuffers(dll, mui, fileName) {
    var report = { ok: false, lines: [], battery: 0, barswaves: 0, verified: false };
    var pe = new PE(dll);
    var titles = null;
    if (mui) { try { titles = new PE(mui).strings(); } catch (e) { report.lines.push('The .mui file could not be read (' + e.message + '): using key names as titles.'); } }
    var bat = extractBattery(pe, titles);
    if (!bat) {
      if (isMui(pe)) fail('mui', 'This is the language file (wmploc.dll.mui). Pick wmp.dll itself (you can add the .mui as well, for the preset names).');
      fail('wrongdll', 'No classic visualizer presets found in this file. Pick wmp.dll from C:\\Windows\\System32 ' +
        '(Windows Media Player Legacy). If it is missing: Settings > Apps > Optional features > Add a feature > "Windows Media Player Legacy".');
    }
    var hash = sha256(pe.u8), ver = pe.fileVersion();
    var sp = extractSpectrum(pe, titles);
    var verified = !!VERIFIED[hash];
    report.battery = bat.length; report.barswaves = sp.styles ? sp.styles.length : 0; report.verified = verified;
    report.lines.push('Read ' + (fileName || 'wmp.dll') + (ver ? ' version ' + ver : '') + '.');
    report.lines.push('Found ' + bat.length + ' classic presets for the plasma visualizer' + (titles ? '' : ' (add wmploc.dll.mui from C:\\Windows\\System32\\en-US for their original names)') + '.');
    if (sp.styles) report.lines.push('Found ' + sp.styles.length + ' classic spectrum styles' + (verified ? ' (verified build).' : ' (build not verified: they should match, but this exact file was never checked).'));
    else report.lines.push('Classic spectrum styles are not available for this version: ' + sp.why + '. Our own styles stay available.');
    var notes = [];
    if (sp.styles && !verified) notes.push('spectrum styles from an unverified build');
    var pack = { format: FORMAT, version: 1, created: new Date().toISOString(),
      source: { file: fileName || 'wmp.dll', size: pe.u8.length, sha256: hash, fileVersion: ver, machine: pe.machine === 0x8664 ? 'x64' : pe.machine === 0x14c ? 'x86' : String(pe.machine), titles: !!titles },
      battery: bat, barswaves: sp.styles, notes: notes };
    report.ok = true;
    return { pack: pack, report: report };
  }
  function readFile(f) {
    return new Promise(function (res, rej) {
      if (f.arrayBuffer) { f.arrayBuffer().then(function (b) { res(new Uint8Array(b)); }, rej); return; }
      var r = new FileReader(); r.onload = function () { res(new Uint8Array(r.result)); }; r.onerror = function () { rej(r.error); }; r.readAsArrayBuffer(f);
    });
  }
  // files: FileList/array. Accepts wmp.dll (+ optional wmploc.dll.mui) or a previously exported .json pack.
  function fromFiles(files) {
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return Promise.reject(new Error('No file chosen.'));
    var json = files.filter(function (f) { return /\.json$/i.test(f.name); })[0];
    if (json) return readFile(json).then(function (u8) {
      var pack = validate(JSON.parse(new TextDecoder().decode(u8)));
      return { pack: pack, report: { ok: true, lines: ['Imported classic pack ' + json.name + '.'], battery: pack.battery ? pack.battery.length : 0, barswaves: pack.barswaves ? pack.barswaves.length : 0 } };
    });
    var mui = files.filter(function (f) { return /\.mui$/i.test(f.name); })[0];
    var dll = files.filter(function (f) { return f !== mui; })[0];
    if (!dll) return Promise.reject(Object.assign(new Error('Pick wmp.dll as well (the .mui file only has the names).'), { code: 'mui' }));
    if (/\.(dylib|app|zip|exe)$/i.test(dll.name)) return Promise.reject(Object.assign(new Error('That is not wmp.dll. On a Mac or Linux PC, copy wmp.dll from C:\\Windows\\System32 of a Windows PC you own.'), { code: 'wrongdll' }));
    return Promise.all([readFile(dll), mui ? readFile(mui) : null]).then(function (b) { return fromBuffers(b[0], b[1], dll.name); });
  }
  function validate(o) {
    if (!o || o.format !== FORMAT || o.version !== 1) throw new Error('This is not a classic pack exported by this player.');
    if (o.battery != null) {
      if (!Array.isArray(o.battery)) throw new Error('Damaged classic pack (battery).');
      o.battery.forEach(function (p) {
        if (!p || typeof p.key !== 'string' || !p.current || typeof p.current['class'] !== 'string' || !Array.isArray(p.pre) || !Array.isArray(p.post))
          throw new Error('Damaged classic pack (preset).');
        if (p.palette != null && !/^[0-9A-Fa-f]{2048}$/.test(p.palette)) throw new Error('Damaged classic pack (palette).');
      });
    }
    if (o.barswaves != null) {
      if (!Array.isArray(o.barswaves)) throw new Error('Damaged classic pack (styles).');
      o.barswaves.forEach(function (s) { if (!s || typeof s.c1 !== 'number' || !s.set || typeof s.set !== 'object') throw new Error('Damaged classic pack (style).'); });
    }
    return o;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  var api = {
    FORMAT: FORMAT, PE: PE, sha256: sha256, parseRgs: parseRgs, verifiedBuilds: VERIFIED,
    fromBuffers: fromBuffers, fromFiles: fromFiles, validate: validate,
    toJSON: function (pack) { return JSON.stringify(pack); },
    save: function (pack) { return lsSet(LS_PACK, JSON.stringify(pack)); },
    load: function () { var s = lsGet(LS_PACK); if (!s) return null; try { return validate(JSON.parse(s)); } catch (e) { return null; } },
    clear: function () { lsSet(LS_PACK, null); },
    enabled: function () { return lsGet(LS_ON) !== '0'; },
    setEnabled: function (on) { lsSet(LS_ON, on ? '1' : '0'); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ClassicPack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
