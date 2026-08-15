/**
 * dsh-gui frameless-window controls + frosted-glass surfaces, injected by
 * main.rs via `WebviewWindowBuilder::initialization_script`.
 *
 * The window runs with native decorations disabled and an acrylic material,
 * so this script rebuilds the missing chrome INSIDE the shipped web UI (which
 * must stay untouched so `scripts/update-dsh.mjs` / npm payload syncs keep
 * working):
 *   - an 8px invisible drag strip across the very top for dragging /
 *     double-click maximize,
 *   - the three window controls (minimize / maximize-restore / close)
 *     floating at the top-right, above the page content,
 *   - a 36px top padding on #root so the app never slides under the buttons.
 *
 * Frosted surfaces (mirrors the reference desktop-shell recipe): transparent
 * page pixels let the window's acrylic material show through; the sidebar is
 * located AT RUNTIME (the upstream frontend's DOM shape changes between
 * releases, so positional selectors are unreliable) and admits the material
 * through the same 72% theme tint as before, while the work columns stay
 * ordinary opaque application surfaces.
 *
 * All DOM work is deferred until DOMContentLoaded: this script executes at
 * document-created time, when `<head>`/`<body>` do not exist yet. Tauri
 * internals are resolved lazily at click time. Safe no-op outside the Tauri
 * webview.
 */
(function () {
  'use strict'
  const DRAG_STRIP_ID = 'dsh-gui-drag-strip'
  const CONTROLS_ID = 'dsh-gui-controls'
  const DRAG_STRIP_HEIGHT = 8
  const BUTTONS_HEIGHT = 30
  const SAFE_PADDING = 36
  const SIDEBAR_TINT =
    'color-mix(in srgb,var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#f9fafb)) 72%,transparent)'

  function windowLabel() {
    const internals = window.__TAURI_INTERNALS__
    const metadata = internals && internals.metadata
    return (metadata && metadata.currentWindow && metadata.currentWindow.label) || 'main'
  }

  function windowAction(command) {
    const internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return
    try {
      Promise.resolve(internals.invoke(command, { label: windowLabel() })).catch(function () {})
    } catch (_error) {
      /* window commands are best-effort */
    }
  }

  function applyStyles() {
    const style = document.createElement('style')
    style.textContent = [
      'html,body,#root{background:transparent!important}',
      '[data-dsh-frosted-frame]{background:transparent!important}',
      '[data-dsh-frosted-sidebar]{background:' + SIDEBAR_TINT + '!important}',
      '#root{box-sizing:border-box;padding-top:' + SAFE_PADDING + 'px}',
      '#' + DRAG_STRIP_ID + '{position:fixed;top:0;left:0;right:0;height:' + DRAG_STRIP_HEIGHT + 'px;z-index:4;background:transparent;-webkit-user-select:none;user-select:none}',
      '#' + CONTROLS_ID + '{position:fixed;top:0;right:0;height:' + BUTTONS_HEIGHT + 'px;z-index:5;display:flex;align-items:stretch;justify-content:flex-end;-webkit-user-select:none;user-select:none}',
      '#' + CONTROLS_ID + ' .dsh-gui-control{pointer-events:auto;width:46px;height:100%;margin:0;padding:0;border:0;border-radius:0;background:transparent;color:rgba(128,128,128,.95);font-family:"Segoe UI",system-ui,sans-serif;font-size:12px;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:default;outline-offset:-2px}',
      '#' + CONTROLS_ID + ' .dsh-gui-control:hover{background:rgba(127,127,127,.22)}',
      '#' + CONTROLS_ID + ' .dsh-gui-control-close:hover{background:#e81123;color:#fff}',
    ].join('\n')
    document.head.appendChild(style)
  }

  function control(command, className, glyph, label) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dsh-gui-control' + (className ? ' ' + className : '')
    button.title = label
    button.setAttribute('aria-label', label)
    button.textContent = glyph
    button.addEventListener('click', function (event) {
      event.stopPropagation()
      windowAction(command)
    })
    // Keep double-clicks from reaching Tauri's drag-region handler, which
    // would toggle maximize underneath the buttons.
    button.addEventListener('dblclick', function (event) {
      event.stopPropagation()
    })
    return button
  }

  function createDragStrip() {
    if (document.getElementById(DRAG_STRIP_ID)) return
    const strip = document.createElement('div')
    strip.id = DRAG_STRIP_ID
    strip.setAttribute('data-tauri-drag-region', '')
    document.body.appendChild(strip)
  }

  function createControls() {
    if (document.getElementById(CONTROLS_ID)) return
    const container = document.createElement('div')
    container.id = CONTROLS_ID
    container.appendChild(control('plugin:window|minimize', '', '\u2500', 'Minimize'))
    container.appendChild(control('plugin:window|toggle_maximize', '', '\u25a1', 'Maximize or restore'))
    container.appendChild(control('plugin:window|close', 'dsh-gui-control-close', '\u2715', 'Close'))
    document.body.appendChild(container)
  }

  function mount() {
    if (!document.body) return
    createDragStrip()
    createControls()
  }

  /** Parse the alpha channel of a computed CSS color (1 for `rgb()`). */
  function alphaOf(colorValue) {
    const match = String(colorValue).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
    if (!match) return 0
    return match[4] === undefined ? 1 : Number(match[4])
  }

  /**
   * Locate the sidebar by its visual identity instead of DOM position (the
   * upstream frontend reshapes its tree and theme tokens between releases):
   * the shallowest element that hugs the left edge, spans the window height,
   * is sidebar-shaped in width, and paints an opaque background. Returns null
   * when the layout does not expose such a column.
   */
  function findSidebar(root) {
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth
    const maxWidth = Math.min(560, viewportWidth * 0.98)
    const candidates = []
    const elements = root.querySelectorAll('*')
    for (const element of elements) {
      const rect = element.getBoundingClientRect()
      if (rect.left > 2) continue
      if (rect.top > SAFE_PADDING + 2) continue
      if (rect.width < 20 || rect.width >= maxWidth) continue
      if (rect.height < viewportHeight - 140) continue
      if (alphaOf(getComputedStyle(element).backgroundColor) < 0.05) continue
      let depth = 0
      let node = element
      while (node && node !== root) {
        depth += 1
        node = node.parentElement
      }
      candidates.push({ element, depth, area: rect.width * rect.height })
    }
    if (candidates.length === 0) return null
    candidates.sort(function (a, b) {
      return a.depth - b.depth || b.area - a.area
    })
    return candidates[0].element
  }

  let frostTimer = null
  function frostSurfaces() {
    const root = document.getElementById('root')
    if (!root) return
    // The app may mount a fragment of top-level shells: make every direct
    // child transparent so the acrylic shows through the whole frame.
    for (const child of root.children) {
      child.setAttribute('data-dsh-frosted-frame', '')
    }
    const sidebar = findSidebar(root)
    if (sidebar) sidebar.setAttribute('data-dsh-frosted-sidebar', '')
  }

  function scheduleFrost(delay) {
    if (frostTimer !== null) return
    frostTimer = setTimeout(function () {
      frostTimer = null
      frostSurfaces()
    }, delay || 250)
  }

  function watchSurfaces() {
    const root = document.getElementById('root')
    if (!root) return
    window.addEventListener('resize', function () { scheduleFrost(300) })
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(function (mutations) {
        // Re-frost only when the shell itself reshuffles (a direct child of
        // #root or one of their children is added/removed); message streaming
        // deep in the columns must not trigger scans.
        const shellChanged = mutations.some(function (mutation) {
          if (mutation.target === root) return true
          if (mutation.target.parentElement === root) return true
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 && node.parentElement === root) return true
          }
          return false
        })
        if (shellChanged) scheduleFrost(300)
      })
      observer.observe(root, { childList: true, subtree: true })
    }
  }

  function boot() {
    applyStyles()
    mount()
    // The app renders asynchronously; keep re-frosting until the frame and
    // sidebar settle.
    scheduleFrost(300)
    scheduleFrost(1200)
    scheduleFrost(3000)
    watchSurfaces()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
