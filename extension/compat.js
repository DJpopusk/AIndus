// Firefox compatibility. Gecko has both namespaces: browser.* returns promises, chrome.* takes callbacks.
// The extension code is written against promises, so in Firefox chrome is pointed at browser.
// Chrome never loads this file (only the Firefox build adds it), and the check is harmless there anyway.
if (typeof browser !== 'undefined' && browser.runtime && typeof chrome !== 'undefined' && chrome !== browser) {
  globalThis.chrome = browser;
}
