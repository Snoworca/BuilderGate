/* FR-UIDS-018 AC-6: put the stored app theme on <html> before the first paint.
 * A classic script, loaded from <head> ahead of the app module, because the CSP
 * (script-src 'self') blocks an inline one. It must reach the same answer as
 * src/theme/appTheme.ts from the same key; tests/unit/appTheme.test.ts runs both.
 * Anything it cannot read falls back to dark, the default. */
(function () {
  var theme = 'dark';
  try {
    var preference = window.localStorage.getItem('buildergate.theme');
    if (preference === 'light') {
      theme = 'light';
    } else if (preference === 'system' && typeof window.matchMedia === 'function'
      && !window.matchMedia('(prefers-color-scheme: dark)').matches) {
      theme = 'light';
    }
  } catch (error) {
    theme = 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
