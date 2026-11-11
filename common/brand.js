// Product name and wording, in one place. Rename the product here (and in the <title> of the pages).
(function (root) {
  var BRAND = {
    name: 'Retro Visualizer',
    tagline: 'inspired by the classic Windows Media Player visualizers',
    disclaimer: 'Independent fan project, not affiliated with, endorsed or sponsored by Microsoft. ' +
      'Windows and Windows Media are trademarks of the Microsoft group of companies; all trademarks belong to their owners. ' +
      'No Microsoft code or data is included: classic presets are read from your own copy of Windows.',
    // display names of the two visualizers (internal ids stay 'battery' and 'barswaves')
    plasma: 'Plasma',
    spectrum: 'Spectrum'
  };
  root.BRAND = BRAND;
  if (typeof module !== 'undefined' && module.exports) module.exports = BRAND;
})(typeof globalThis !== 'undefined' ? globalThis : this);
