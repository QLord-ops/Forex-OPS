/* global localStorage, window, document */
// Sets the colour theme before the first paint (a separate file: the CSP allows no inline scripts).
(function () {
  var stored = null
  try { stored = localStorage.getItem('ops-theme') } catch (e) { /* private mode */ }
  var dark = stored ? stored === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#08101b' : '#ffffff')
})()
