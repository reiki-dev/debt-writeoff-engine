(function (root, factory) {
  const esc = factory();
  if (typeof module === 'object' && module.exports) module.exports = esc;
  else root.esc = esc;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]);
  };
}));
