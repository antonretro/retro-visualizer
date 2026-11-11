/*
 * midi-sf2.js - dependency-free Standard MIDI File player with SoundFont 2 / DLS synthesis
 * (Web Audio API) and a small built-in fallback synth.
 *
 *   var player = MidiSF2.createPlayer(audioCtx, outputNode);
 *   await player.loadSoundFont(arrayBuffer);  // .sf2 or DLS (e.g. Windows gm.dls) -> {name, presetCount, format}
 *   player.unloadSoundFont();
 *   await player.loadMidi(arrayBuffer);       // -> {duration, title}
 *   player.play(); player.pause(); player.seek(sec); player.stop();
 *   player.currentTime / duration / paused / ended / soundFontName
 *   player.onended = function () {};
 *
 * Parsers are usable without an AudioContext: MidiSF2._parseMidi(buf), MidiSF2._parseSF2(buf), MidiSF2._parseDLS(buf).
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ helpers
  function toU8(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && input.buffer instanceof ArrayBuffer) {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    throw new Error('Expected an ArrayBuffer');
  }
  function str4(u8, o) {
    if (o + 4 > u8.length) return '';
    return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  }
  function cstr(u8, o, n) {
    var s = '';
    for (var i = 0; i < n && o + i < u8.length; i++) {
      var c = u8[o + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.replace(/\s+$/, '');
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ================================================================== MIDI
  // Event types in the merged list
  var EV_ON = 1, EV_OFF = 2, EV_CC = 3, EV_PC = 4, EV_PB = 5;

  function parseMidi(input) {
    var u8;
    try { u8 = toU8(input); } catch (e) { throw new Error('Not a MIDI file'); }
    var off = 0;
    // RIFF RMID wrapper
    if (str4(u8, 0) === 'RIFF' && str4(u8, 8) === 'RMID') {
      var p = 12, found = -1;
      while (p + 8 <= u8.length) {
        var sz = (u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24)) >>> 0;
        if (str4(u8, p) === 'data') { found = p + 8; break; }
        p += 8 + sz + (sz & 1);
      }
      if (found < 0) throw new Error('Not a MIDI file (RMID without data chunk)');
      off = found;
    }
    if (u8.length - off < 14 || str4(u8, off) !== 'MThd') throw new Error('Not a MIDI file');
    function u32(o) { return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0; }
    function u16(o) { return (u8[o] << 8) | u8[o + 1]; }
    var hlen = u32(off + 4);
    var format = u16(off + 8), ntrks = u16(off + 10), division = u16(off + 12);
    if (format > 2) throw new Error('Not a MIDI file (unknown format ' + format + ')');
    if (division === 0) throw new Error('Not a MIDI file (bad time division)');
    off += 8 + hlen;

    var tracks = [];
    while (off + 8 <= u8.length) {
      var id = str4(u8, off), len = u32(off + 4);
      var start = off + 8, end = Math.min(start + len, u8.length);
      if (id === 'MTrk') tracks.push(parseTrack(u8, start, end, tracks.length));
      off = start + len;
    }
    if (!tracks.length) throw new Error('Not a MIDI file (no tracks found)');

    // merge
    var all = [];
    var endTick = 0, title = '', names = [];
    for (var t = 0; t < tracks.length; t++) {
      var tr = tracks[t];
      names.push(tr.name);
      if (!title && tr.name) title = tr.name;
      if (tr.endTick > endTick) endTick = tr.endTick;
      for (var k = 0; k < tr.events.length; k++) all.push(tr.events[k]);
    }
    all.sort(function (a, b) { return a.tick - b.tick || a.tr - b.tr || a.seq - b.seq; });

    var tempoMap = buildTempoMap(all, division);
    var events = [];
    var lastTick = 0;
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.tick > lastTick) lastTick = e.tick;
      if (e.type === 0) continue; // tempo
      events.push({ time: tempoMap.toSeconds(e.tick), tick: e.tick, type: e.type, ch: e.ch, a: e.a, b: e.b });
    }
    if (endTick < lastTick) endTick = lastTick;
    // ignore absurd end-of-track padding: never more than 4 s after the last real event
    var lastEvTime = events.length ? events[events.length - 1].time : 0;
    var duration = Math.min(tempoMap.toSeconds(endTick), lastEvTime + 4);
    if (duration < lastEvTime) duration = lastEvTime;

    return {
      format: format,
      division: division,
      trackCount: tracks.length,
      declaredTrackCount: ntrks,
      trackNames: names,
      title: title,
      events: events,
      tempoMap: tempoMap,
      duration: duration
    };
  }

  function parseTrack(u8, p, end, trIndex) {
    var events = [], tick = 0, status = 0, seq = 0, name = '';
    function readVar() {
      var v = 0;
      for (var i = 0; i < 4 && p < end; i++) {
        var c = u8[p++];
        v = (v << 7) | (c & 0x7f);
        if (!(c & 0x80)) return v;
      }
      return v;
    }
    while (p < end) {
      tick += readVar();
      if (p >= end) break;
      var b = u8[p];
      if (b === 0xff) {
        p++;
        var type = u8[p++];
        var len = readVar();
        var dataStart = p;
        p += len;
        if (type === 0x2f) break; // end of track
        if (type === 0x51 && len >= 3) {
          var us = (u8[dataStart] << 16) | (u8[dataStart + 1] << 8) | u8[dataStart + 2];
          if (us > 0) events.push({ tick: tick, tr: trIndex, seq: seq++, type: 0, ch: 0, a: us, b: 0 });
        } else if (type === 0x03 && !name) {
          var s = '';
          for (var i = dataStart; i < Math.min(p, end); i++) s += String.fromCharCode(u8[i]);
          try { s = decodeURIComponent(escape(s)); } catch (e) { /* keep latin1 */ }
          name = s.replace(/\0/g, '').trim();
        }
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        p++;
        p += readVar();
        continue;
      }
      if (b & 0x80) { status = b; p++; }
      else if (!status) { p++; continue; } // stray data byte without running status
      var hi = status & 0xf0, ch = status & 0x0f;
      if (hi === 0xf0) { continue; } // system common/realtime inside a track: skip status only
      var d1 = u8[p++] & 0x7f, d2 = 0;
      if (hi !== 0xc0 && hi !== 0xd0) d2 = u8[p++] & 0x7f;
      if (p > end) break;
      switch (hi) {
        case 0x90:
          events.push({ tick: tick, tr: trIndex, seq: seq++, type: d2 ? EV_ON : EV_OFF, ch: ch, a: d1, b: d2 });
          break;
        case 0x80:
          events.push({ tick: tick, tr: trIndex, seq: seq++, type: EV_OFF, ch: ch, a: d1, b: d2 });
          break;
        case 0xb0:
          events.push({ tick: tick, tr: trIndex, seq: seq++, type: EV_CC, ch: ch, a: d1, b: d2 });
          break;
        case 0xc0:
          events.push({ tick: tick, tr: trIndex, seq: seq++, type: EV_PC, ch: ch, a: d1, b: 0 });
          break;
        case 0xe0:
          events.push({ tick: tick, tr: trIndex, seq: seq++, type: EV_PB, ch: ch, a: (d2 << 7) | d1, b: 0 });
          break;
        default: break; // aftertouch ignored
      }
    }
    return { events: events, endTick: tick, name: name };
  }

  function buildTempoMap(sortedEvents, division) {
    if (division & 0x8000) {
      // SMPTE: seconds per tick is fixed
      var fps = 256 - (division >> 8);
      if (fps === 29) fps = 29.97;
      var tpf = division & 0xff || 1;
      var spt = 1 / (fps * tpf);
      return {
        smpte: true,
        segments: [{ tick: 0, sec: 0, uspq: 0 }],
        toSeconds: function (tick) { return tick * spt; }
      };
    }
    var ppq = division;
    var segs = [{ tick: 0, sec: 0, uspq: 500000 }];
    for (var i = 0; i < sortedEvents.length; i++) {
      var e = sortedEvents[i];
      if (e.type !== 0) continue;
      var last = segs[segs.length - 1];
      if (e.tick === last.tick) { last.uspq = e.a; continue; }
      segs.push({ tick: e.tick, sec: last.sec + (e.tick - last.tick) * last.uspq / 1e6 / ppq, uspq: e.a });
    }
    return {
      smpte: false,
      ppq: ppq,
      segments: segs,
      toSeconds: function (tick) {
        var lo = 0, hi = segs.length - 1;
        while (lo < hi) {
          var mid = (lo + hi + 1) >> 1;
          if (segs[mid].tick <= tick) lo = mid; else hi = mid - 1;
        }
        var s = segs[lo];
        return s.sec + (tick - s.tick) * s.uspq / 1e6 / ppq;
      }
    };
  }

  // ================================================================== SF2
  var GEN_DEFAULTS = (function () {
    var g = new Array(61);
    for (var i = 0; i < g.length; i++) g[i] = 0;
    g[8] = 13500;                         // initialFilterFc
    g[21] = g[23] = g[25] = g[26] = g[27] = g[28] = -12000; // mod LFO/env times
    g[33] = g[34] = g[35] = g[36] = g[38] = -12000;          // vol env times
    g[46] = -1; g[47] = -1;               // keynum, velocity
    g[56] = 100;                          // scaleTuning
    g[58] = -1;                           // overridingRootKey
    return g;
  })();
  // generators that must NOT be added at preset level
  var NON_ADDITIVE = {};
  [0, 1, 2, 3, 4, 12, 14, 18, 19, 20, 41, 42, 43, 44, 45, 46, 47, 49, 50, 53, 54, 55, 57, 58, 59, 60]
    .forEach(function (o) { NON_ADDITIVE[o] = true; });

  function parseSF2(input) {
    var u8;
    try { u8 = toU8(input); } catch (e) { throw new Error('Not a SoundFont 2 file'); }
    if (u8.length < 12 || str4(u8, 0) !== 'RIFF' || str4(u8, 8) !== 'sfbk') {
      throw new Error('Not a SoundFont 2 file');
    }
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    function u32(o) { return dv.getUint32(o, true); }
    var riffEnd = Math.min(8 + u32(4), u8.length);

    var info = {}, smpl = null, pd = {};
    function walk(start, end, cb) {
      var p = start;
      while (p + 8 <= end) {
        var id = str4(u8, p), size = u32(p + 4);
        var body = p + 8, bodyEnd = Math.min(body + size, end);
        cb(id, body, bodyEnd);
        p = body + size + (size & 1);
      }
    }
    walk(12, riffEnd, function (id, body, bodyEnd) {
      if (id !== 'LIST') return;
      var type = str4(u8, body);
      walk(body + 4, bodyEnd, function (sid, sb, se) {
        if (type === 'INFO') {
          if (sid === 'INAM' || sid === 'ICMT' || sid === 'ICOP' || sid === 'IENG') info[sid] = cstr(u8, sb, se - sb);
        } else if (type === 'sdta') {
          if (sid === 'smpl') {
            var n = (se - sb) >> 1;
            var copy = u8.slice(sb, sb + n * 2); // aligned copy
            smpl = new Int16Array(copy.buffer, 0, n);
            if (!littleEndian()) {
              var dvs = new DataView(copy.buffer);
              var fixed = new Int16Array(n);
              for (var i = 0; i < n; i++) fixed[i] = dvs.getInt16(i * 2, true);
              smpl = fixed;
            }
          }
        } else if (type === 'pdta') {
          pd[sid] = { off: sb, size: se - sb };
        }
      });
    });
    if (!smpl) throw new Error('Not a SoundFont 2 file (missing sample data)');
    ['phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr'].forEach(function (k) {
      if (!pd[k]) throw new Error('Not a SoundFont 2 file (missing ' + k + ' chunk)');
    });

    function records(id, size, fn) {
      var c = pd[id], n = Math.floor(c.size / size), out = [];
      for (var i = 0; i < n; i++) out.push(fn(c.off + i * size));
      return out;
    }
    var phdr = records('phdr', 38, function (o) {
      return { name: cstr(u8, o, 20), preset: dv.getUint16(o + 20, true), bank: dv.getUint16(o + 22, true), bag: dv.getUint16(o + 24, true) };
    });
    var pbag = records('pbag', 4, function (o) { return dv.getUint16(o, true); });
    var pgen = records('pgen', 4, function (o) {
      return { op: dv.getUint16(o, true), s: dv.getInt16(o + 2, true), u: dv.getUint16(o + 2, true), lo: u8[o + 2], hi: u8[o + 3] };
    });
    var inst = records('inst', 22, function (o) { return { name: cstr(u8, o, 20), bag: dv.getUint16(o + 20, true) }; });
    var ibag = records('ibag', 4, function (o) { return dv.getUint16(o, true); });
    var igen = records('igen', 4, function (o) {
      return { op: dv.getUint16(o, true), s: dv.getInt16(o + 2, true), u: dv.getUint16(o + 2, true), lo: u8[o + 2], hi: u8[o + 3] };
    });
    var shdr = records('shdr', 46, function (o) {
      return {
        name: cstr(u8, o, 20),
        start: u32(o + 20), end: u32(o + 24), loopStart: u32(o + 28), loopEnd: u32(o + 32),
        rate: u32(o + 36), pitch: u8[o + 40], corr: dv.getInt8(o + 41),
        link: dv.getUint16(o + 42, true), type: dv.getUint16(o + 44, true)
      };
    });
    if (phdr.length < 2) throw new Error('Not a SoundFont 2 file (no presets)');
    var samples = shdr.slice(0, Math.max(0, shdr.length - 1));

    // Build zones for a list of bag indices. linkOp = 41 (instrument) or 53 (sampleID)
    function zonesFor(bagStart, bagEnd, bags, gens, linkOp) {
      var global = null, zones = [];
      for (var b = bagStart; b < bagEnd && b + 1 < bags.length; b++) {
        var g0 = bags[b], g1 = bags[b + 1];
        var z = { gens: {}, kl: -1, kh: -1, vl: -1, vh: -1, link: -1 };
        for (var gi = g0; gi < g1 && gi < gens.length; gi++) {
          var gen = gens[gi];
          if (gen.op === 43) { z.kl = gen.lo; z.kh = gen.hi; }
          else if (gen.op === 44) { z.vl = gen.lo; z.vh = gen.hi; }
          else if (gen.op === linkOp) { z.link = gen.u; break; } // link gen terminates the zone
          else if (gen.op < 61) z.gens[gen.op] = gen.s;
        }
        if (z.link >= 0) zones.push(z);
        else if (b === bagStart && !global) global = z;
      }
      return { global: global, zones: zones };
    }
    function rng(z, g, which) {
      var lo = z[which + 'l'], hi = z[which + 'h'];
      if (lo < 0 && g) { lo = g[which + 'l']; hi = g[which + 'h']; }
      if (lo < 0) { lo = 0; hi = 127; }
      return [lo, hi];
    }

    var instruments = [];
    for (var i = 0; i + 1 < inst.length; i++) {
      var zi = zonesFor(inst[i].bag, inst[i + 1].bag, ibag, igen, 53);
      instruments.push({ name: inst[i].name, global: zi.global, zones: zi.zones });
    }

    var presets = [], presetMap = {};
    for (var pi = 0; pi + 1 < phdr.length; pi++) {
      var ph = phdr[pi];
      var zp = zonesFor(ph.bag, phdr[pi + 1].bag, pbag, pgen, 41);
      var regions = [];
      zp.zones.forEach(function (pz) {
        var ins = instruments[pz.link];
        if (!ins) return;
        var pg = {}, k;
        if (zp.global) for (k in zp.global.gens) pg[k] = zp.global.gens[k];
        for (k in pz.gens) pg[k] = pz.gens[k];
        var pk = rng(pz, zp.global, 'k'), pv = rng(pz, zp.global, 'v');
        ins.zones.forEach(function (iz) {
          var smp = samples[iz.link];
          if (!smp || (smp.type & 0x8000)) return; // missing or ROM sample
          var ik = rng(iz, ins.global, 'k'), iv = rng(iz, ins.global, 'v');
          var kl = Math.max(pk[0], ik[0]), kh = Math.min(pk[1], ik[1]);
          var vl = Math.max(pv[0], iv[0]), vh = Math.min(pv[1], iv[1]);
          if (kl > kh || vl > vh) return;
          var g = GEN_DEFAULTS.slice(), op;
          if (ins.global) for (op in ins.global.gens) g[op] = ins.global.gens[op];
          for (op in iz.gens) g[op] = iz.gens[op];
          for (op in pg) if (!NON_ADDITIVE[op]) g[op] += pg[op];
          g[53] = iz.link;
          regions.push({ kl: kl, kh: kh, vl: vl, vh: vh, g: g, sample: smp });
        });
      });
      var preset = { name: ph.name, bank: ph.bank, program: ph.preset, regions: regions };
      presets.push(preset);
      var key = ph.bank * 128 + ph.preset;
      if (!presetMap[key]) presetMap[key] = preset;
    }

    var name = info.INAM || (presets[0] && presets[0].name) || 'SoundFont';
    var lookupCache = {};
    function findPreset(bank, program) {
      var ck = bank + ':' + program;
      if (ck in lookupCache) return lookupCache[ck];
      var p = presetMap[bank * 128 + program];
      if (!p && bank === 128) {
        p = presetMap[128 * 128];
        if (!p) for (var a = 0; a < presets.length && !p; a++) if (presets[a].bank === 128) p = presets[a];
      } else if (!p) {
        p = presetMap[program];
        if (!p) for (var b = 0; b < presets.length && !p; b++) if (presets[b].program === program && presets[b].bank !== 128) p = presets[b];
        if (!p) p = presetMap[0];
        if (!p) for (var c = 0; c < presets.length && !p; c++) if (presets[c].bank !== 128) p = presets[c];
      }
      lookupCache[ck] = p || null;
      return p || null;
    }
    function findRegions(bank, program, key, vel) {
      var p = findPreset(bank, program), out = [];
      if (!p) return out;
      for (var i = 0; i < p.regions.length; i++) {
        var r = p.regions[i];
        if (key >= r.kl && key <= r.kh && vel >= r.vl && vel <= r.vh) out.push(r);
      }
      return out;
    }

    return {
      name: name,
      info: info,
      presetCount: presets.length,
      presets: presets,
      instruments: instruments,
      samples: samples,
      sampleData: smpl,
      findPreset: findPreset,
      findRegions: findRegions
    };
  }
  function littleEndian() {
    var a = new Uint16Array([1]);
    return new Uint8Array(a.buffer)[0] === 1;
  }

  // Shared preset lookup (SF2 + DLS). Bank 128 = drum kits. Missing GS variation -> bank 0.
  function makeLookup(presets) {
    var presetMap = {}, cache = {};
    presets.forEach(function (p) { var k = p.bank * 128 + p.program; if (!presetMap[k]) presetMap[k] = p; });
    function findPreset(bank, program) {
      var ck = bank + ':' + program;
      if (ck in cache) return cache[ck];
      var p = presetMap[bank * 128 + program];
      if (!p && bank === 128) {
        p = presetMap[128 * 128];
        if (!p) for (var a = 0; a < presets.length && !p; a++) if (presets[a].bank === 128) p = presets[a];
      } else if (!p) {
        p = presetMap[program];
        if (!p) for (var b = 0; b < presets.length && !p; b++) if (presets[b].program === program && presets[b].bank !== 128) p = presets[b];
        if (!p) p = presetMap[0];
        if (!p) for (var c = 0; c < presets.length && !p; c++) if (presets[c].bank !== 128) p = presets[c];
      }
      cache[ck] = p || null;
      return p || null;
    }
    function findRegions(bank, program, key, vel) {
      var p = findPreset(bank, program), out = [];
      if (!p) return out;
      for (var i = 0; i < p.regions.length; i++) {
        var r = p.regions[i];
        if (key >= r.kl && key <= r.kh && vel >= r.vl && vel <= r.vh) out.push(r);
      }
      return out;
    }
    return { findPreset: findPreset, findRegions: findRegions };
  }

  // ================================================================== DLS (Level 1/2)
  // Parsed into the same shape as parseSF2: presets[].regions[] = {kl,kh,vl,vh,g (SF2 generator
  // array), sample {start,end,loopStart,loopEnd,rate,pitch,corr}} over one Int16 sampleData pool,
  // so the SF2 voice code plays it. DLS articulation (connection blocks) is mapped onto SF2
  // generators: EG1 -> volume envelope, EG2 -> mod envelope, LFO -> vibrato, pan, tuning, key scaling.
  var DLS_CONN = {
    // [source, control, destination] keys (control 0 = none)
    EG1_ATTACK: 0x206, EG1_DECAY: 0x207, EG1_RELEASE: 0x209, EG1_SUSTAIN: 0x20a, EG1_DELAY: 0x20b, EG1_HOLD: 0x20c,
    EG2_ATTACK: 0x30a, EG2_DECAY: 0x30b, EG2_RELEASE: 0x30d, EG2_SUSTAIN: 0x30e, EG2_DELAY: 0x30f, EG2_HOLD: 0x310,
    LFO_FREQ: 0x104, LFO_DELAY: 0x105, VIB_FREQ: 0x114, VIB_DELAY: 0x115,
    ATTEN: 1, PITCH: 3, PAN: 4, FILTER_CUTOFF: 0x500, FILTER_Q: 0x501
  };
  var SRC_NONE = 0, SRC_LFO = 1, SRC_VEL = 2, SRC_KEY = 3, SRC_EG1 = 4, SRC_EG2 = 5, SRC_VIB = 9, SRC_CC1 = 0x81;

  function parseDLS(input) {
    var u8;
    try { u8 = toU8(input); } catch (e) { throw new Error('Not a DLS file'); }
    if (u8.length < 12 || str4(u8, 0) !== 'RIFF' || str4(u8, 8) !== 'DLS ') throw new Error('Not a DLS file');
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    function u32(o) { return dv.getUint32(o, true); }
    function chunks(start, end) {
      var out = [], p = start;
      while (p + 8 <= end) {
        var id = str4(u8, p), size = u32(p + 4), body = p + 8, be = Math.min(body + size, end);
        out.push({ id: id, type: id === 'LIST' || id === 'RIFF' ? str4(u8, body) : '', off: p, body: body, end: be });
        p = body + size + (size & 1);
      }
      return out;
    }
    function find(list, id, type) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id && (!type || list[i].type === type)) return list[i];
      return null;
    }
    function kids(c) { return chunks(c.body + 4, c.end); }
    var top = chunks(12, Math.min(8 + u32(4), u8.length));
    var info = {};
    var infoL = find(top, 'LIST', 'INFO');
    if (infoL) kids(infoL).forEach(function (c) { if (/^I/.test(c.id)) info[c.id] = cstr(u8, c.body, c.end - c.body); });

    function readWsmp(c) {
      if (!c) return null;
      var cb = u32(c.body);
      var w = {
        unity: dv.getUint16(c.body + 4, true), fine: dv.getInt16(c.body + 6, true),
        atten: dv.getInt32(c.body + 8, true), options: u32(c.body + 12), loops: []
      };
      var n = u32(c.body + 16), p = c.body + cb;
      for (var i = 0; i < n && p + 16 <= c.end; i++, p += u32(p) || 16) {
        w.loops.push({ type: u32(p + 4), start: u32(p + 8), length: u32(p + 12) });
      }
      return w;
    }
    function readArt(list) {   // all art1/art2 connection blocks in an lart/lar2 list
      var conns = [];
      list.forEach(function (L) {
        kids(L).forEach(function (a) {
          if (a.id !== 'art1' && a.id !== 'art2') return;
          var cb = u32(a.body), n = u32(a.body + 4), p = a.body + cb;
          for (var i = 0; i < n && p + 12 <= a.end; i++, p += 12) {
            conns.push({ src: dv.getUint16(p, true), ctl: dv.getUint16(p + 2, true), dst: dv.getUint16(p + 4, true),
                         tr: dv.getUint16(p + 6, true), scale: dv.getInt32(p + 8, true) });
          }
        });
      });
      return conns;
    }
    function artLists(c) { return kids(c).filter(function (x) { return x.id === 'LIST' && (x.type === 'lart' || x.type === 'lar2'); }); }

    // ---- wave pool
    var ptblC = find(top, 'ptbl'), wvpl = find(top, 'LIST', 'wvpl');
    if (!wvpl) throw new Error('Not a DLS file (missing wave pool)');
    var cues = [];
    if (ptblC) {
      var pcb = u32(ptblC.body), pn = u32(ptblC.body + 4);
      for (var ci = 0; ci < pn; ci++) cues.push(u32(ptblC.body + pcb + ci * 4));
    }
    var waveChunks = kids(wvpl).filter(function (c) { return c.id === 'LIST' && c.type === 'wave'; });
    var waveAt = {};
    waveChunks.forEach(function (c, i) { waveAt[c.off - (wvpl.body + 4)] = i; waveAt[c.off - wvpl.body] = i; });
    var waveIndex = cues.length ? cues.map(function (off, i) { return off in waveAt ? waveAt[off] : i; })
                                : waveChunks.map(function (c, i) { return i; });
    var total = 0, waves = [];
    waveChunks.forEach(function (c) {
      var k = kids(c), fmt = find(k, 'fmt '), data = find(k, 'data');
      var w = { tag: 1, channels: 1, rate: 22050, bits: 16, dataOff: 0, frames: 0, wsmp: readWsmp(find(k, 'wsmp')), name: '' };
      var inf = find(k, 'LIST', 'INFO');
      if (inf) { var nm = find(kids(inf), 'INAM'); if (nm) w.name = cstr(u8, nm.body, nm.end - nm.body); }
      if (fmt) {
        w.tag = dv.getUint16(fmt.body, true); w.channels = dv.getUint16(fmt.body + 2, true) || 1;
        w.rate = u32(fmt.body + 4); w.bits = dv.getUint16(fmt.body + 14, true);
      }
      if (data && w.tag === 1 && (w.bits === 8 || w.bits === 16)) {
        w.dataOff = data.body;
        w.frames = Math.floor((data.end - data.body) / (w.channels * w.bits / 8));
      }
      w.start = total;
      total += w.frames + 8;   // small silent gap between waves (interpolation guard)
      waves.push(w);
    });
    var pcm = new Int16Array(total);
    waves.forEach(function (w) {
      var step = w.channels * (w.bits >> 3);
      for (var i = 0; i < w.frames; i++) {
        var o = w.dataOff + i * step;
        pcm[w.start + i] = w.bits === 8 ? (u8[o] - 128) << 8 : dv.getInt16(o, true);   // first channel only
      }
    });

    // ---- articulation -> SF2 generators
    function tcv(scale) { return scale === -2147483648 ? -12000 : clamp(Math.round(scale / 65536), -12000, 8000); }
    function applyArt(g, conns, extra) {
      // DLS defaults (Level 1): EG times 0, sustain 100 %, LFO 5 Hz, no modulation
      g[33] = g[34] = g[35] = g[36] = g[38] = -12000; g[37] = 0;
      g[25] = g[26] = g[27] = g[28] = g[30] = -12000; g[29] = 0;
      g[24] = -851;   // 5 Hz
      conns.forEach(function (c) {
        var v = c.scale / 65536;
        if (c.src === SRC_NONE && c.ctl === 0) {
          switch (c.dst) {
            case DLS_CONN.EG1_ATTACK: g[34] = tcv(c.scale); break;
            case DLS_CONN.EG1_DECAY: g[36] = tcv(c.scale); break;
            case DLS_CONN.EG1_RELEASE: g[38] = tcv(c.scale); break;
            case DLS_CONN.EG1_DELAY: g[33] = tcv(c.scale); break;
            case DLS_CONN.EG1_HOLD: g[35] = tcv(c.scale); break;
            case DLS_CONN.EG1_SUSTAIN: {   // 0.1 % units -> attenuation in cB
              var s = clamp(v / 1000, 0, 1);
              g[37] = s <= 0.0001 ? 1440 : Math.round(-200 * Math.log(s) / Math.LN10);
              break;
            }
            case DLS_CONN.EG2_ATTACK: g[26] = tcv(c.scale); break;
            case DLS_CONN.EG2_DECAY: g[28] = tcv(c.scale); break;
            case DLS_CONN.EG2_RELEASE: g[30] = tcv(c.scale); break;
            case DLS_CONN.EG2_DELAY: g[25] = tcv(c.scale); break;
            case DLS_CONN.EG2_HOLD: g[27] = tcv(c.scale); break;
            case DLS_CONN.EG2_SUSTAIN: g[29] = Math.round(1000 - clamp(v, 0, 1000)); break;
            case DLS_CONN.LFO_FREQ: case DLS_CONN.VIB_FREQ: g[24] = Math.round(v); break;
            case DLS_CONN.LFO_DELAY: case DLS_CONN.VIB_DELAY: g[22] = tcv(c.scale); break;
            case DLS_CONN.PAN: g[17] = Math.round(clamp(v, -500, 500)); break;
            case DLS_CONN.PITCH: g[52] += Math.round(v); break;
            case DLS_CONN.ATTEN: g[48] += Math.round(-v); break;   // gain (cB) -> attenuation
            case DLS_CONN.FILTER_CUTOFF: g[8] = Math.round(v); break;
            case DLS_CONN.FILTER_Q: g[9] = Math.round(v); break;
            default: break;
          }
        } else if ((c.src === SRC_LFO || c.src === SRC_VIB) && c.dst === DLS_CONN.PITCH) {
          if (c.ctl === 0) g[6] += Math.round(v);
          else if (c.ctl === SRC_CC1) extra.modVib += v;     // mod wheel vibrato depth (cents at CC1 = 127)
        } else if (c.src === SRC_EG2 && c.ctl === 0 && c.dst === DLS_CONN.PITCH) {
          g[7] = Math.round(v);
        } else if (c.src === SRC_KEY && c.ctl === 0 && c.dst === DLS_CONN.PITCH) {
          g[56] = Math.round(v / 128);                         // 12800 = 100 cents per key
        } else if (c.src === SRC_KEY && c.ctl === 0 && c.dst === DLS_CONN.EG1_DECAY) {
          extra.keyDecay = v;                                  // timecents across 128 keys
        } else if (c.src === SRC_KEY && c.ctl === 0 && c.dst === DLS_CONN.EG1_HOLD) {
          extra.keyHold = v;
        } else if (c.src === SRC_VEL && c.ctl === 0 && c.dst === DLS_CONN.EG1_ATTACK) {
          extra.velAttack = v;                                 // timecents across 128 velocities
        }
      });
      // DLS: decay += keyScale * key/128.  SF2: decay += g40 * (60 - key)
      if (extra.keyDecay) { g[40] = Math.round(-extra.keyDecay / 128); g[36] += Math.round(extra.keyDecay * 60 / 128); }
      if (extra.keyHold) { g[39] = Math.round(-extra.keyHold / 128); g[35] += Math.round(extra.keyHold * 60 / 128); }
    }

    // ---- instruments
    var lins = find(top, 'LIST', 'lins');
    if (!lins) throw new Error('Not a DLS file (missing instrument list)');
    var presets = [];
    kids(lins).forEach(function (insC) {
      if (insC.id !== 'LIST' || insC.type !== 'ins ') return;
      var k = kids(insC), insh = find(k, 'insh');
      if (!insh) return;
      var bankRaw = u32(insh.body + 4), prog = u32(insh.body + 8) & 127;
      var drum = (bankRaw & 0x80000000) !== 0;
      var msb = (bankRaw >> 8) & 127, lsb = bankRaw & 127;
      var name = '';
      var inf = find(k, 'LIST', 'INFO');
      if (inf) { var nm = find(kids(inf), 'INAM'); if (nm) name = cstr(u8, nm.body, nm.end - nm.body); }
      var insArt = readArt(artLists(insC));
      var lrgn = find(k, 'LIST', 'lrgn'), regions = [];
      if (lrgn) kids(lrgn).forEach(function (rc) {
        if (rc.id !== 'LIST' || (rc.type !== 'rgn ' && rc.type !== 'rgn2')) return;
        var rk = kids(rc), rgnh = find(rk, 'rgnh'), wlnk = find(rk, 'wlnk');
        if (!rgnh || !wlnk) return;
        var kl = dv.getUint16(rgnh.body, true), kh = dv.getUint16(rgnh.body + 2, true);
        var vl = dv.getUint16(rgnh.body + 4, true), vh = dv.getUint16(rgnh.body + 6, true);
        var keyGroup = dv.getUint16(rgnh.body + 10, true);
        if (vh === 0 && vl === 0) vh = 127;   // DLS1 files often leave velocity ranges empty
        var tableIdx = u32(wlnk.body + 8), wi = waveIndex[tableIdx];
        var w = waves[wi];
        if (!w || w.frames < 2) return;
        var ws = readWsmp(find(rk, 'wsmp')) || w.wsmp || { unity: 60, fine: 0, atten: 0, loops: [] };
        var rArt = readArt(artLists(rc));
        var extra = { modVib: 0 };
        var g = GEN_DEFAULTS.slice();
        applyArt(g, rArt.length ? rArt : insArt, extra);
        g[48] += Math.round(-ws.atten / 65536);
        g[48] = Math.max(0, g[48]);
        g[57] = keyGroup;
        var lp = ws.loops[0], smp = {
          name: w.name, start: w.start, end: w.start + w.frames, rate: w.rate,
          pitch: ws.unity & 127, corr: ws.fine, loopStart: w.start, loopEnd: w.start
        };
        if (lp && lp.length > 1 && lp.start + lp.length <= w.frames) {
          smp.loopStart = w.start + lp.start; smp.loopEnd = w.start + lp.start + lp.length;
          g[54] = 1;
        }
        regions.push({ kl: kl, kh: Math.min(kh, 127), vl: vl, vh: Math.min(vh, 127), g: g, sample: smp,
                       modVib: extra.modVib, velAttack: extra.velAttack || 0, wave: wi });
      });
      presets.push({ name: name, bank: drum ? 128 : msb, bankLsb: lsb, program: prog, drum: drum, regions: regions });
    });
    var lk = makeLookup(presets);
    return {
      format: 'dls',
      name: info.INAM || 'DLS',
      info: info,
      presetCount: presets.length,
      presets: presets,
      waves: waves.map(function (w) { return { name: w.name, rate: w.rate, bits: w.bits, channels: w.channels, tag: w.tag, frames: w.frames, start: w.start, wsmp: w.wsmp }; }),
      sampleData: pcm,
      findPreset: lk.findPreset,
      findRegions: lk.findRegions
    };
  }
  function parseSoundBank(input) {
    var u8 = toU8(input);
    if (u8.length >= 12 && str4(u8, 0) === 'RIFF' && str4(u8, 8) === 'DLS ') return parseDLS(u8);
    return parseSF2(u8);
  }

  // ================================================================== player
  var MAX_VOICES = 64;
  var LOOKAHEAD = 0.15;
  var INTERVAL_MS = 25;
  var FALLBACK_LEVEL = 0.6; // fallback voices scaled so master*this ~= 0.3

  function tc2s(tc) {
    if (tc <= -12000) return 0;
    return Math.min(Math.pow(2, tc / 1200), 40);
  }

  // Envelope model (shared by SF2 + fallback voices):
  //   0 until a0, linear to peak at a1, hold to h1, then exponential approach to sus with dTau.
  function scheduleEnv(param, env) {
    param.value = 0;
    param.setValueAtTime(0, env.t0);
    if (env.a0 > env.t0) param.setValueAtTime(0, env.a0);
    param.linearRampToValueAtTime(env.peak, env.a1);
    if (env.h1 > env.a1) param.setValueAtTime(env.peak, env.h1);
    if (env.sus < env.peak) param.setTargetAtTime(env.sus, env.h1, Math.max(env.dTau, 0.001));
  }
  function envValueAt(env, t) {
    if (t <= env.a0) return 0;
    if (t < env.a1) return env.peak * (t - env.a0) / (env.a1 - env.a0);
    if (t < env.h1 || env.sus >= env.peak) return env.peak;
    return env.sus + (env.peak - env.sus) * Math.exp(-(t - env.h1) / Math.max(env.dTau, 0.001));
  }

  function createPlayer(ctx, outputNode) {
    if (!ctx || typeof ctx.createGain !== 'function') throw new Error('MidiSF2.createPlayer needs an AudioContext');
    var dest = outputNode || ctx.destination;

    var master = ctx.createGain();
    master.gain.value = 0.5;
    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter);
    limiter.connect(dest);

    // ---- effects: GS-style reverb + chorus sends (CC91 / CC93, GS defaults 40 / 0), like the Windows synth
    var fxAmount = { reverb: 1, chorus: 1 };          // user multipliers (1 = what the song asks for)
    function makeIR(seconds, preDelay) {           // synthetic stereo hall: pre-delay + softened decaying noise
      var rate = ctx.sampleRate, n = Math.max(1, Math.floor(rate * seconds)), pd = Math.floor(rate * preDelay);
      var ir = ctx.createBuffer(2, n + pd, rate), seed = 22222;
      for (var c = 0; c < 2; c++) {
        var d = ir.getChannelData(c), lp = 0;
        for (var i = 0; i < n; i++) {
          seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
          var x = (seed / 4294967296) * 2 - 1, t = i / n;
          lp += (x - lp) * (0.55 - 0.4 * t);              // darker as it decays
          d[pd + i] = lp * Math.pow(1 - t, 2.2) * Math.exp(-3 * t);
        }
      }
      return ir;
    }
    var reverb = null, revIn = ctx.createGain(), revOut = ctx.createGain();
    revOut.gain.value = 0.9;
    if (typeof ctx.createConvolver === 'function') try { reverb = ctx.createConvolver(); reverb.buffer = makeIR(2.2, 0.025); revIn.connect(reverb); reverb.connect(revOut); revOut.connect(master); } catch (e) { reverb = null; }
    var choIn = ctx.createGain(), chorusOk = false;
    if (typeof ctx.createDelay === 'function') {
      try {
        var choOut = ctx.createGain(), choL = ctx.createDelay(0.1), choR = ctx.createDelay(0.1);
        choOut.gain.value = 0.8;
        choL.delayTime.value = 0.017; choR.delayTime.value = 0.021;
        var choMerge = typeof ctx.createChannelMerger === 'function' ? ctx.createChannelMerger(2) : null;
        choIn.connect(choL); choIn.connect(choR);
        if (choMerge) { choL.connect(choMerge, 0, 0); choR.connect(choMerge, 0, 1); choMerge.connect(choOut); } else { choL.connect(choOut); choR.connect(choOut); }
        choOut.connect(master);
        [[choL, 0.8, 0.0025], [choR, 0.95, 0.0025]].forEach(function (a) {
          try { var o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = a[1]; og.gain.value = a[2]; o.connect(og); og.connect(a[0].delayTime); o.start(); } catch (e) {}
        });
        chorusOk = true;
      } catch (e) { chorusOk = false; }
    }

    function makePanner() {
      return typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    }

    var channels = [];
    for (var c = 0; c < 16; c++) {
      var g = ctx.createGain();
      var pn = makePanner();
      var out = pn || g;
      if (pn) g.connect(pn);
      out.connect(master);
      var rs = ctx.createGain(), cs = ctx.createGain(); rs.gain.value = 0; cs.gain.value = 0;
      out.connect(rs); rs.connect(revIn); out.connect(cs); cs.connect(choIn);
      channels.push({ index: c, gain: g, panner: pn, revSend: rs, choSend: cs });
    }
    function resetChannel(ch) {
      ch.vol = 100; ch.expr = 127; ch.pan = 64; ch.prog = 0; ch.bank = 0; ch.mod = 0;
      ch.sustain = false; ch.bendRaw = 8192; ch.bend = 0; ch.bendRange = 2;
      ch.rpnMsb = 127; ch.rpnLsb = 127;
      ch.rev = 40; ch.cho = 0;                       // GS power-on defaults
    }
    function applyChannelFx(ch, t) {
      ch.revSend.gain.setValueAtTime(reverb ? (ch.rev / 127) * fxAmount.reverb : 0, t);
      ch.choSend.gain.setValueAtTime(chorusOk ? (ch.cho / 127) * fxAmount.chorus : 0, t);
    }
    function chGainValue(ch) { var v = ch.vol / 127, e = ch.expr / 127; return v * v * e * e; }
    function applyChannelGain(ch, t) { ch.gain.gain.setValueAtTime(chGainValue(ch), t); }
    function applyChannelPan(ch, t) {
      if (ch.panner) ch.panner.pan.setValueAtTime(clamp((ch.pan - 64) / 63, -1, 1), t);
    }
    function resetAllChannels(t) {
      channels.forEach(function (ch) {
        resetChannel(ch);
        ch.gain.gain.cancelScheduledValues(0);
        if (ch.panner) ch.panner.pan.cancelScheduledValues(0);
        applyChannelGain(ch, t);
        applyChannelPan(ch, t);
        ch.revSend.gain.cancelScheduledValues(0); ch.choSend.gain.cancelScheduledValues(0);
        applyChannelFx(ch, t);
      });
    }
    resetAllChannels(ctx.currentTime);

    var sf = null;
    var bufferCache = {};
    var voices = [];
    var noiseBuf = null;

    var song = null, idx = 0, pos = 0, startCtx = 0, isPaused = true, isEnded = false, timer = null;

    // ---------------------------------------------------------- voices
    function stopSources(v, when) {
      if (when >= v.stopAt) return;
      v.stopAt = when;
      for (var i = 0; i < v.srcs.length; i++) {
        try { v.srcs[i].stop(when); } catch (e) { /* ignore */ }
      }
    }
    function releaseVoice(v, t, fast) {
      if (v.released && !fast) return;
      var env = v.env, p = v.gain.gain;
      var relTau = fast ? 0.004 : Math.max(env.rTau, 0.004);
      if (t < env.t0) t = env.t0;
      var val = envValueAt(env, t);
      p.cancelScheduledValues(t);
      if (t <= env.a0) p.setValueAtTime(0, t);
      else if (t < env.a1) p.linearRampToValueAtTime(val, t); // same line as the attack ramp
      else p.setValueAtTime(val, t);
      p.setTargetAtTime(0, t, relTau);
      v.released = true;
      v.held = false;
      stopSources(v, t + relTau * 9 + 0.02);
    }
    function killVoice(v, t) { releaseVoice(v, t, true); }

    function addVoice(v, t) {
      // retrigger: release the same key on the same channel
      for (var i = 0; i < voices.length; i++) {
        var o = voices[i];
        if (o.ch === v.ch && o.key === v.key && !o.released && o.t0 < v.t0 - 1e-6 && !o.oneShot) releaseVoice(o, t);
      }
      if (v.excl) {
        for (var j = 0; j < voices.length; j++) {
          var x = voices[j];
          if (x.ch === v.ch && x.excl === v.excl && x.stopAt > t) killVoice(x, t);
        }
      }
      var live = 0;
      for (var k = 0; k < voices.length; k++) if (voices[k].stopAt > t + 0.03) live++;
      for (var m = 0; live >= MAX_VOICES && m < voices.length; m++) {
        if (voices[m].stopAt > t + 0.03) { killVoice(voices[m], t); live--; }
      }
      voices.push(v);
    }
    function pruneVoices(now) {
      var keep = [];
      for (var i = 0; i < voices.length; i++) {
        var v = voices[i];
        if (v.stopAt < now - 0.05) {
          for (var n = 0; n < v.nodes.length; n++) { try { v.nodes[n].disconnect(); } catch (e) { /* */ } }
        } else keep.push(v);
      }
      voices = keep;
    }
    function killAll(t) {
      for (var i = 0; i < voices.length; i++) killVoice(voices[i], t);
    }

    // ---------------------------------------------------------- SF2 voice
    function getBuffer(start, end, rate) {
      var bufRate = clamp(rate || 44100, 3000, 192000);
      var key = start + ':' + end + ':' + bufRate;
      var hit = bufferCache[key];
      if (hit) return hit;
      var n = end - start;
      var ab = ctx.createBuffer(1, n, bufRate);
      var data = ab.getChannelData(0), s = sf.sampleData;
      for (var i = 0; i < n; i++) data[i] = s[start + i] / 32768;
      hit = { buffer: ab, rate: bufRate };
      bufferCache[key] = hit;
      return hit;
    }

    function sfVoice(ch, key, vel, t, r) {
      var g = r.g, s = r.sample, total = sf.sampleData.length;
      var start = s.start + g[0] + g[4] * 32768;
      var end = s.end + g[1] + g[12] * 32768;
      var ls = s.loopStart + g[2] + g[45] * 32768;
      var le = s.loopEnd + g[3] + g[50] * 32768;
      start = clamp(start, 0, total);
      end = clamp(end, 0, total);
      if (end - start < 2) return null;
      var buf = getBuffer(start, end, s.rate);

      var src = ctx.createBufferSource();
      src.buffer = buf.buffer;
      var mode = g[54] & 3;
      var looping = (mode === 1 || mode === 3) && le > ls + 1 && ls >= start && le <= end;
      if (looping) {
        src.loop = true;
        src.loopStart = (ls - start) / buf.rate;
        src.loopEnd = (le - start) / buf.rate;
      }
      var k = g[46] >= 0 ? g[46] : key;
      var v = g[47] >= 0 ? g[47] : vel;
      var rootKey = g[58] >= 0 ? g[58] : (s.pitch <= 127 ? s.pitch : 60);
      var cents = (k - rootKey) * g[56] + g[51] * 100 + g[52] + s.corr;
      var baseRate = Math.pow(2, cents / 1200) * (s.rate || buf.rate) / buf.rate;
      src.playbackRate.setValueAtTime(baseRate * Math.pow(2, ch.bend / 1200), t);

      var nodes = [src], last = src;
      if (g[8] < 13500) {
        var f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = clamp(8.176 * Math.pow(2, g[8] / 1200), 20, 20000);
        f.Q.value = clamp(g[9], 0, 960) / 10;
        last.connect(f); last = f; nodes.push(f);
      }
      var gain = ctx.createGain();
      last.connect(gain); last = gain; nodes.push(gain);
      var pn = makePanner();
      if (pn) {
        pn.pan.value = clamp(g[17] / 500, -1, 1);
        last.connect(pn); last = pn; nodes.push(pn);
      }
      last.connect(ch.gain);

      var vn = v / 127;
      var peak = Math.pow(10, -clamp(g[48], 0, 1440) / 200) * vn * vn;
      var a0 = t + tc2s(g[33]);
      var a1 = a0 + Math.max(tc2s(g[34] + (r.velAttack || 0) * v / 128), 0.001);
      var h1 = a1 + tc2s(g[35] + g[39] * (60 - k));
      var decay = tc2s(g[36] + g[40] * (60 - k));
      var susCb = clamp(g[37], 0, 1440);
      var env = {
        t0: t, a0: a0, a1: a1, h1: h1, peak: peak,
        sus: susCb >= 1000 ? 0 : peak * Math.pow(10, -susCb / 200),
        dTau: Math.max(decay, 0.001) / 11.5,          // 100 dB over the SF2 decay time
        rTau: Math.max(tc2s(g[38]), 0.006) / 11.5
      };
      scheduleEnv(gain.gain, env);
      var srcs = [src];
      // mod envelope -> pitch (DLS EG2 -> pitch; SF2 modEnvToPitch), on the detune param
      if (g[7] && src.detune) {
        var ma0 = t + tc2s(g[25]), ma1 = ma0 + Math.max(tc2s(g[26]), 0.001);
        var mh1 = ma1 + tc2s(g[27]), msus = g[7] * (1 - clamp(g[29], 0, 1000) / 1000);
        src.detune.setValueAtTime(0, t);
        if (ma0 > t) src.detune.setValueAtTime(0, ma0);
        src.detune.linearRampToValueAtTime(g[7], ma1);
        if (mh1 > ma1) src.detune.setValueAtTime(g[7], mh1);
        src.detune.setTargetAtTime(msus, mh1, Math.max(tc2s(g[28]), 0.001) / 5);
      }
      // vibrato LFO -> pitch (static depth + mod-wheel depth for DLS)
      var vibDepth = (g[6] || 0) + (r.modVib || 0) * (ch.mod || 0) / 127;
      if (Math.abs(vibDepth) >= 1 && src.detune && typeof ctx.createOscillator === 'function') {
        var lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = clamp(8.176 * Math.pow(2, g[24] / 1200), 0.1, 40);
        lg.gain.value = vibDepth;
        lfo.connect(lg); lg.connect(src.detune);
        lfo.start(t + tc2s(g[22]));
        srcs.push(lfo); nodes.push(lfo, lg);
      }
      src.start(t);
      var voice = {
        ch: ch.index, key: key, t0: t, env: env, gain: gain, srcs: srcs, nodes: nodes,
        released: false, held: false, oneShot: false, excl: g[57] || 0, stopAt: Infinity,
        setBend: function (centsBend, when) {
          src.playbackRate.setValueAtTime(baseRate * Math.pow(2, centsBend / 1200), when);
        }
      };
      var naturalEnd = Infinity;
      if (!looping) naturalEnd = t + buf.buffer.duration / Math.max(baseRate * Math.pow(2, -ch.bendRange / 12), 0.01) + 0.02;
      if (env.sus <= 1e-5) naturalEnd = Math.min(naturalEnd, h1 + env.dTau * 12 + 0.02);
      if (naturalEnd < Infinity) stopSources(voice, naturalEnd);
      return voice;
    }

    // ---------------------------------------------------------- fallback synth
    function fbPatch(prog) {
      switch (prog >> 3) {
        case 0: return { type: 'triangle', a: 0.004, d: 0.55, s: 0, r: 0.12, lp: 3800, gain: 0.9, partial: 2, pgain: 0.25 };
        case 1: return { type: 'sine', a: 0.002, d: 0.35, s: 0, r: 0.15, gain: 0.8, partial: 4, pgain: 0.12 };
        case 2: return { type: 'square', a: 0.01, d: 0.1, s: 0.8, r: 0.06, lp: 2400, gain: 0.35 };
        case 3: return { type: 'triangle', a: 0.003, d: 0.45, s: 0, r: 0.1, lp: 3000, gain: 0.8, partial: 2, pgain: 0.2 };
        case 4: return { type: 'sawtooth', a: 0.005, d: 0.25, s: 0.45, r: 0.08, lp: 650, gain: 0.8 };
        case 5: case 6: return { type: 'sawtooth', a: 0.12, d: 0.3, s: 0.8, r: 0.3, lp: 2200, gain: 0.4 };
        case 7: return { type: 'sawtooth', a: 0.04, d: 0.25, s: 0.7, r: 0.12, lp: 1700, gain: 0.45 };
        case 8: return { type: 'square', a: 0.03, d: 0.2, s: 0.7, r: 0.1, lp: 1800, gain: 0.35 };
        case 9: return { type: 'sine', a: 0.04, d: 0.2, s: 0.85, r: 0.12, gain: 0.7 };
        case 10: return { type: 'square', a: 0.01, d: 0.2, s: 0.6, r: 0.1, lp: 3200, gain: 0.35 };
        case 11: return { type: 'sawtooth', a: 0.35, d: 0.5, s: 0.7, r: 0.6, lp: 1200, gain: 0.4 };
        case 12: return { type: 'triangle', a: 0.08, d: 0.4, s: 0.5, r: 0.4, lp: 2500, gain: 0.6 };
        case 14: return { type: 'sine', a: 0.002, d: 0.3, s: 0, r: 0.1, gain: 0.8, partial: 3, pgain: 0.2 };
        default: return { type: 'triangle', a: 0.01, d: 0.3, s: 0.6, r: 0.15, gain: 0.7 };
      }
    }
    function fbVoice(ch, key, vel, t) {
      var p = fbPatch(ch.prog);
      var freq = 440 * Math.pow(2, (key - 69) / 12);
      var vn = vel / 127;
      var gain = ctx.createGain();
      var nodes = [gain], srcs = [];
      var dest = gain;
      if (p.lp) {
        var f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = Math.min(p.lp + freq * 2, 16000);
        f.Q.value = 0.5;
        f.connect(gain); nodes.push(f); dest = f;
      }
      function osc(type, fr, lvl) {
        var o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = fr;
        o.detune.setValueAtTime(ch.bend, t);
        var og = ctx.createGain();
        og.gain.value = lvl;
        o.connect(og); og.connect(dest);
        nodes.push(o, og); srcs.push(o);
        o.start(t);
        return o;
      }
      osc(p.type, freq, 1);
      if (p.partial) osc('sine', freq * p.partial, p.pgain);
      gain.connect(ch.gain);
      var peak = FALLBACK_LEVEL * p.gain * vn * vn * 0.5;
      var a1 = t + p.a, h1 = a1;
      var env = { t0: t, a0: t, a1: a1, h1: h1, peak: peak, sus: peak * p.s, dTau: p.d, rTau: p.r };
      scheduleEnv(gain.gain, env);
      var v = {
        ch: ch.index, key: key, t0: t, env: env, gain: gain, srcs: srcs, nodes: nodes,
        released: false, held: false, oneShot: false, excl: 0, stopAt: Infinity,
        setBend: function (c, when) { for (var i = 0; i < srcs.length; i++) srcs[i].detune.setValueAtTime(c, when); }
      };
      if (p.s === 0) stopSources(v, h1 + p.d * 9 + 0.02);
      return v;
    }
    function getNoise() {
      if (noiseBuf) return noiseBuf;
      var len = Math.floor(ctx.sampleRate || 44100);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate || 44100);
      var d = noiseBuf.getChannelData(0), seed = 22222;
      for (var i = 0; i < len; i++) { seed = (seed * 16807) % 2147483647; d[i] = seed / 1073741823.5 - 1; }
      return noiseBuf;
    }
    function fbDrum(ch, key, vel, t) {
      var vn = vel / 127;
      var gain = ctx.createGain();
      var nodes = [gain], srcs = [];
      gain.connect(ch.gain);
      var level = 1, tau = 0.05;
      function noise(ftype, fq, q, lvl) {
        var n = ctx.createBufferSource();
        n.buffer = getNoise();
        n.loop = true;
        var f = ctx.createBiquadFilter();
        f.type = ftype; f.frequency.value = fq; f.Q.value = q;
        var g = ctx.createGain(); g.gain.value = lvl;
        n.connect(f); f.connect(g); g.connect(gain);
        nodes.push(n, f, g); srcs.push(n);
        n.start(t, Math.random() * 0.5);
      }
      function sweep(type, f0, f1, dur, lvl) {
        var o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f1, t + dur);
        var g = ctx.createGain(); g.gain.value = lvl;
        o.connect(g); g.connect(gain);
        nodes.push(o, g); srcs.push(o);
        o.start(t);
      }
      if (key === 35 || key === 36) { sweep('sine', 150, 45, 0.12, 1); tau = 0.13; level = 1.1; }
      else if (key === 37) { noise('bandpass', 2500, 2, 1); tau = 0.02; level = 0.5; }
      else if (key === 38 || key === 40) { noise('bandpass', 1800, 0.8, 1); sweep('triangle', 200, 160, 0.05, 0.6); tau = 0.06; level = 0.8; }
      else if (key === 39) { noise('bandpass', 1200, 1.2, 1); tau = 0.05; level = 0.7; }
      else if (key === 42 || key === 44) { noise('highpass', 7000, 0.7, 1); tau = 0.018; level = 0.45; }
      else if (key === 46) { noise('highpass', 7000, 0.7, 1); tau = 0.12; level = 0.4; }
      else if (key === 49 || key === 52 || key === 55 || key === 57) { noise('highpass', 5000, 0.5, 1); tau = 0.45; level = 0.35; }
      else if (key === 51 || key === 53 || key === 59) { noise('bandpass', 6500, 1.5, 1); tau = 0.25; level = 0.3; }
      else if (key >= 41 && key <= 50) { var f0 = 70 + (key - 41) * 14; sweep('sine', f0 * 1.4, f0, 0.15, 1); tau = 0.14; level = 0.8; }
      else { noise('bandpass', 3000, 1, 1); tau = 0.03; level = 0.35; }
      var peak = FALLBACK_LEVEL * level * vn * vn * 0.6;
      var env = { t0: t, a0: t, a1: t + 0.001, h1: t + 0.001, peak: peak, sus: 0, dTau: tau, rTau: tau };
      scheduleEnv(gain.gain, env);
      var v = {
        ch: ch.index, key: key, t0: t, env: env, gain: gain, srcs: srcs, nodes: nodes,
        released: false, held: false, oneShot: true, excl: (key === 42 || key === 44 || key === 46) ? 1 : 0,
        stopAt: Infinity, setBend: function () {}
      };
      stopSources(v, t + tau * 9 + 0.02);
      return v;
    }

    // ---------------------------------------------------------- MIDI handling
    function noteOn(ch, key, vel, t) {
      var drum = ch.index === 9;
      if (sf) {
        var regions = sf.findRegions(drum ? 128 : ch.bank, ch.prog, key, vel);
        if (regions.length) {
          for (var i = 0; i < regions.length; i++) {
            var v = sfVoice(ch, key, vel, t, regions[i]);
            if (v) addVoice(v, t);
          }
          return;
        }
        if (!drum) return; // SF2 loaded but no matching zone
        if (sf.findPreset(128, ch.prog)) return; // kit exists but key unmapped
      }
      addVoice(drum ? fbDrum(ch, key, vel, t) : fbVoice(ch, key, vel, t), t);
    }
    function noteOff(ch, key, t) {
      for (var i = 0; i < voices.length; i++) {
        var v = voices[i];
        if (v.ch !== ch.index || v.key !== key || v.released || v.oneShot) continue;
        if (ch.sustain) v.held = true;
        else releaseVoice(v, t);
      }
    }
    function releaseChannel(ch, t, kill) {
      for (var i = 0; i < voices.length; i++) {
        var v = voices[i];
        if (v.ch !== ch.index) continue;
        if (kill) killVoice(v, t); else if (!v.oneShot) releaseVoice(v, t);
      }
    }
    function setBend(ch, raw, t, live) {
      ch.bendRaw = raw;
      ch.bend = (raw - 8192) / 8192 * ch.bendRange * 100;
      if (!live) return;
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].ch === ch.index && voices[i].stopAt > t) voices[i].setBend(ch.bend, t);
      }
    }
    function controlChange(ch, num, val, t, live) {
      switch (num) {
        case 0: ch.bank = val; break;
        case 1: ch.mod = val; break;
        case 7: ch.vol = val; if (live) applyChannelGain(ch, t); break;
        case 10: ch.pan = val; if (live) applyChannelPan(ch, t); break;
        case 11: ch.expr = val; if (live) applyChannelGain(ch, t); break;
        case 91: ch.rev = val; if (live) applyChannelFx(ch, t); break;
        case 93: ch.cho = val; if (live) applyChannelFx(ch, t); break;
        case 64:
          ch.sustain = val >= 64;
          if (!ch.sustain && live) {
            for (var i = 0; i < voices.length; i++) {
              var v = voices[i];
              if (v.ch === ch.index && v.held) releaseVoice(v, t);
            }
          }
          break;
        case 101: ch.rpnMsb = val; break;
        case 100: ch.rpnLsb = val; break;
        case 98: case 99: ch.rpnMsb = 127; ch.rpnLsb = 127; break; // NRPN: ignore data entry
        case 6:
          if (ch.rpnMsb === 0 && ch.rpnLsb === 0) { ch.bendRange = val + (ch.bendRange % 1); setBend(ch, ch.bendRaw, t, live); }
          break;
        case 38:
          if (ch.rpnMsb === 0 && ch.rpnLsb === 0) { ch.bendRange = Math.floor(ch.bendRange) + val / 100; setBend(ch, ch.bendRaw, t, live); }
          break;
        case 120: if (live) releaseChannel(ch, t, true); break;
        case 121:
          ch.expr = 127; ch.mod = 0; ch.rpnMsb = 127; ch.rpnLsb = 127;
          if (live) applyChannelGain(ch, t);
          controlChange(ch, 64, 0, t, live);
          setBend(ch, 8192, t, live);
          break;
        case 123: case 124: case 125: case 126: case 127:
          if (live) releaseChannel(ch, t, false);
          break;
        default: break;
      }
    }
    function dispatch(ev, t, live) {
      var ch = channels[ev.ch];
      switch (ev.type) {
        case EV_ON: if (live) noteOn(ch, ev.a, ev.b, t); break;
        case EV_OFF: if (live) noteOff(ch, ev.a, t); break;
        case EV_CC: controlChange(ch, ev.a, ev.b, t, live); break;
        case EV_PC: ch.prog = ev.a; break;
        case EV_PB: setBend(ch, ev.a, t, live); break;
        default: break;
      }
    }

    // ---------------------------------------------------------- transport
    function tick() {
      if (isPaused || !song) return;
      var now = ctx.currentTime, horizon = now + LOOKAHEAD, evs = song.events;
      while (idx < evs.length && startCtx + evs[idx].time < horizon) {
        dispatch(evs[idx], Math.max(startCtx + evs[idx].time, now), true);
        idx++;
      }
      pruneVoices(now);
      if (idx >= evs.length && now >= startCtx + song.duration) finish(now);
    }
    function stopTimer() { if (timer !== null) { clearInterval(timer); timer = null; } }
    function finish(now) {
      stopTimer();
      for (var i = 0; i < voices.length; i++) if (!voices[i].oneShot) releaseVoice(voices[i], now);
      isPaused = true;
      isEnded = true;
      pos = song.duration;
      if (typeof api.onended === 'function') {
        try { api.onended(); } catch (e) { setTimeout(function () { throw e; }, 0); }
      }
    }
    function seekInternal(s) {
      var now = ctx.currentTime;
      killAll(now);
      resetAllChannels(now);
      var evs = song ? song.events : [];
      var i = 0;
      while (i < evs.length && evs[i].time < s) { dispatch(evs[i], now, false); i++; }
      channels.forEach(function (ch) { applyChannelGain(ch, now); applyChannelPan(ch, now); applyChannelFx(ch, now); });
      idx = i;
      pos = s;
      if (!isPaused) startCtx = now + 0.06 - s;
    }

    var api = {
      onended: null,
      loadSoundFont: function (arrayBuffer) {
        return new Promise(function (resolve) {
          var parsed = parseSoundBank(arrayBuffer);   // .sf2 or .dls (auto-detected)
          killAll(ctx.currentTime);
          sf = parsed;
          bufferCache = {};
          resolve({ name: parsed.name, presetCount: parsed.presetCount, format: parsed.format || 'sf2' });
        });
      },
      loadDLS: function (arrayBuffer) { return api.loadSoundFont(arrayBuffer); },
      unloadSoundFont: function () {
        killAll(ctx.currentTime);
        sf = null;
        bufferCache = {};
      },
      loadMidi: function (arrayBuffer) {
        return new Promise(function (resolve) {
          var parsed = parseMidi(arrayBuffer);
          stopTimer();
          isPaused = true;
          isEnded = false;
          song = parsed;
          seekInternal(0);
          resolve({ duration: parsed.duration, title: parsed.title });
        });
      },
      play: function () {
        if (!song || !isPaused) return;
        if (isEnded || pos >= song.duration) { isEnded = false; seekInternal(0); }
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          try { var pr = ctx.resume(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) { /* */ }
        }
        isPaused = false;
        startCtx = ctx.currentTime + 0.06 - pos;
        stopTimer();
        timer = setInterval(tick, INTERVAL_MS);
        tick();
      },
      pause: function () {
        if (!song || isPaused) return;
        var p = api.currentTime;
        stopTimer();
        isPaused = true;
        seekInternal(p); // silences voices and rewinds the event pointer to p
      },
      seek: function (seconds) {
        if (!song) return;
        var s = clamp(Number(seconds) || 0, 0, song.duration);
        isEnded = false;
        seekInternal(s);
      },
      stop: function () {
        stopTimer();
        isPaused = true;
        isEnded = false;
        if (song) seekInternal(0); else killAll(ctx.currentTime);
      },
      get currentTime() {
        if (!song) return 0;
        if (isPaused) return pos;
        return clamp(ctx.currentTime - startCtx, 0, song.duration);
      },
      get duration() { return song ? song.duration : 0; },
      get paused() { return isPaused; },
      get ended() { return isEnded; },
      // reverb / chorus amount multipliers (0..2; 1 = as the song asks, like the Windows GS synth)
      setEffects: function (o) {
        if (o && typeof o.reverb === 'number') fxAmount.reverb = clamp(o.reverb, 0, 2);
        if (o && typeof o.chorus === 'number') fxAmount.chorus = clamp(o.chorus, 0, 2);
        var t = ctx.currentTime; channels.forEach(function (ch) { applyChannelFx(ch, t); });
      },
      getEffects: function () { return { reverb: fxAmount.reverb, chorus: fxAmount.chorus, available: !!reverb }; },
      get soundFontName() { return sf ? sf.name : null; },
      get soundFontFormat() { return sf ? (sf.format || 'sf2') : null; },
      // test/debug hooks
      _tick: tick,
      get _voiceCount() { return voices.length; },
      get _activeVoices() {
        var n = 0, now = ctx.currentTime;
        for (var i = 0; i < voices.length; i++) if (voices[i].stopAt > now && !voices[i].released) n++;
        return n;
      }
    };
    return api;
  }

  var MidiSF2 = {
    version: '1.0.0',
    createPlayer: createPlayer,
    _parseMidi: parseMidi,
    _parseSF2: parseSF2,
    _parseDLS: parseDLS,
    _parseSoundBank: parseSoundBank
  };
  root.MidiSF2 = MidiSF2;
  if (typeof module !== 'undefined' && module.exports) module.exports = MidiSF2;
})(typeof window !== 'undefined' ? window : this);
