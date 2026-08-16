/**
 * Clipboard-write shim, injected by main.rs via
 * `WebviewWindowBuilder::initialization_script` BEFORE any page script.
 *
 * WebView2's `navigator.clipboard.writeText` is unreliable: it can reject
 * with NotAllowedError (or never settle) even inside a click gesture, which
 * leaves the web UI's copy buttons (assistant message "复制", JSON viewer
 * copy, hover-card copy) dead. This shim replaces `writeText` with:
 *   1. `document.execCommand('copy')` executed SYNCHRONOUSLY inside the
 *      caller's gesture (the copy buttons invoke it directly from a click,
 *      so the user activation is intact here) — the classic fallback that
 *      works in WebView2 / Chromium;
 *   2. the Tauri clipboard plugin (`plugin:clipboard|write_text`), which
 *      writes the OS clipboard natively and needs no gesture;
 *   3. the original `writeText`, so ordinary browser contexts keep their
 *      native behavior.
 *
 * Safe no-op outside the Tauri webview: browsers that lack execCommand keep
 * their original writeText untouched (the defineProperty below only wraps
 * when a Clipboard object exists).
 */
(function () {
  'use strict'

  function legacyCopy(text) {
    if (!document.body || typeof document.execCommand !== 'function') return false
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    // Off-screen but rendered: execCommand('copy') needs the selection to
    // live in the active document.
    el.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.appendChild(el)
    el.focus()
    el.select()
    el.setSelectionRange(0, el.value.length)
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch (_error) {
      ok = false
    }
    el.remove()
    return ok
  }

  function tauriCopy(text) {
    const internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return Promise.resolve(false)
    return Promise.resolve(internals.invoke('plugin:clipboard|write_text', { text }))
      .then(function () { return true })
      .catch(function () { return false })
  }

  const clipboard = navigator.clipboard
  const originalWrite =
    clipboard && typeof clipboard.writeText === 'function'
      ? clipboard.writeText.bind(clipboard)
      : null

  function writeText(data) {
    const text = String(data)
    // 1. Same-gesture execCommand path: copy buttons call this directly from
    //    their click handler, so the gesture context is still valid here.
    if (legacyCopy(text)) return Promise.resolve()
    // 2. Native Tauri clipboard plugin (gesture-free OS write).
    return tauriCopy(text).then(function (ok) {
      if (ok) return undefined
      // 3. Original implementation (regular browser / secure-context hosts).
      if (originalWrite) return originalWrite(text)
      throw new Error('clipboard write unavailable')
    })
  }

  if (clipboard) {
    try {
      Object.defineProperty(clipboard, 'writeText', { value: writeText, configurable: true })
    } catch (_error) {
      /* non-configurable host — leave the native implementation alone */
    }
  }
})()
