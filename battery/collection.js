// Collection slot: an extra set of ORIGINAL presets (and, optionally, new effect classes) shipped next to the
// built-in presets. Drop-in: replace this file, or load another file before it that fills B.COLLECTION.
//   - new effect classes: B.register('CMyEffect', class extends B.Shift / B.Drawer {...}) in a file loaded
//     before core.js runs new Engine(); they are available to presets but never used by Random mode.
//   - presets: push objects in the presets.js format onto B.COLLECTION (keys must be unique).
// The Plasma menu lists: (Originals when classic presets are loaded from Windows), built-in presets, never-used
// parts, Anthony's collection (+ any other collection entries).
(function (root) {
  var B = root.Battery = root.Battery || {};
  if (typeof module !== 'undefined' && module.exports) module.exports = B;
  B.COLLECTION = B.COLLECTION || [];
  // Anthony's collection (extras.js / extras-presets.js): new effects + 12 original presets, and one preset
  // for each effect that exists in the engine but was never used in a named classic preset (unused-presets.js).
  [].concat(B.EXTRA_PRESETS || [], B.UNUSED_PRESETS || []).forEach(function (p) { B.COLLECTION.push(p); });
})(typeof globalThis !== 'undefined' ? globalThis : this);
