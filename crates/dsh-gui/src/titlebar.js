/**
 * dsh-gui frameless-window chrome + frosted-glass surfaces, injected by
 * main.rs via `WebviewWindowBuilder::initialization_script`.
 *
 * The window runs with native decorations disabled and an acrylic material,
 * so this script rebuilds the missing chrome INSIDE the shipped web UI (which
 * must stay untouched so `scripts/update-dsh.mjs` / npm payload syncs keep
 * working). The chrome is a single 30px titlebar across the top edge:
 *   - the web UI is pushed DOWN below the bar (body padding-top), so the bar
 *     never covers app content, session headers, or hover tooltips;
 *   - the bar is one big drag region (double-click toggles maximize);
 *   - its colors are SAMPLED AT RUNTIME from the surfaces directly below:
 *     the segment above the sidebar takes the sidebar's painted color, the
 *     segment above the work columns (and the controls sitting on it) takes
 *     the column color. Sampling is opaque-color based (the sidebar renders
 *     effectively opaque, so a translucent tint strip would seam against it
 *     whenever the wallpaper behind the window shifts hue); fallbacks are
 *     the opaque sidebar-fill / base-background theme tokens;
 *   - the three window controls (minimize / maximize-restore / close) live
 *     at the bar's right end, drawn as crisp Win11-style SVG glyphs whose
 *     color follows the app's light/dark theme; the middle button swaps
 *     between maximize and restore by polling `is_maximized`.
 *
 * Frosted surfaces (mirrors the reference desktop-shell recipe): transparent
 * page pixels let the window's acrylic material show through; the sidebar is
 * located AT RUNTIME (the upstream frontend's DOM shape changes between
 * releases, so positional selectors are unreliable) and admits the material
 * through a 72% theme tint, while the work columns stay ordinary opaque
 * application surfaces. The titlebar's segments track the sidebar's width
 * and re-sample their colors whenever the shell reshuffles, the window
 * resizes, the theme flips, or the sidebar itself changes size (a
 * ResizeObserver follows it through collapse / expand animations); failed
 * samples keep the previous color so a mid-transition pass never sticks.
 *
 * All DOM work is deferred until DOMContentLoaded: this script executes at
 * document-created time, when `<head>`/`<body>` do not exist yet. Tauri
 * internals are resolved lazily at click time. Safe no-op outside the Tauri
 * webview.
 */
(function () {
  'use strict'
  const TITLEBAR_ID = 'dsh-gui-titlebar'
  const CONTROLS_ID = 'dsh-gui-controls'
  const TITLEBAR_HEIGHT = 30
  const COLUMN_FALLBACK = 'var(--dsw-alias-bg-base,#f9fafb)'
  // Opaque sidebar-color token chain: the titlebar's fallbacks must not be
  // translucent — a translucent strip shows the wallpaper behind the window,
  // which never matches the effectively-opaque surfaces below.
  const SIDEBAR_FALLBACK = 'var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#f9fafb))'
  const SIDEBAR_TINT =
    'color-mix(in srgb,var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#f9fafb)) 72%,transparent)'

  const SVG_OPEN =
    '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"'
  const SVG_CRISP = ' shape-rendering="crispEdges">'
  const SVG_SMOOTH = '>'
  const SVG_CLOSE_TAG = '</svg>'
  const ICON_MINIMIZE =
    SVG_OPEN + SVG_CRISP + '<path d="M1 5.5h8"/>' + SVG_CLOSE_TAG
  const ICON_MAXIMIZE =
    SVG_OPEN + SVG_CRISP + '<rect x="1.5" y="1.5" width="7" height="7"/>' + SVG_CLOSE_TAG
  const ICON_RESTORE =
    SVG_OPEN + SVG_CRISP +
    '<path d="M2.5 2.5V0.5h7v7H7.5"/><rect x="0.5" y="2.5" width="7" height="7"/>' +
    SVG_CLOSE_TAG
  const ICON_CLOSE =
    SVG_OPEN + SVG_SMOOTH + '<path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/>' + SVG_CLOSE_TAG

  let maximizeButton = null
  let sidebarSegment = null
  let columnSegment = null
  let controlsElement = null
  let resizeTimer = null

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
      // Push the whole web UI below the titlebar. The upstream reset is
      // `html,body,#root{height:100%;margin:0}`, so padding on body shrinks
      // #root's 100% to exactly the remaining viewport height.
      'body{box-sizing:border-box;padding-top:' + TITLEBAR_HEIGHT + 'px}',
      '[data-dsh-frosted-frame]{background:transparent!important}',
      '[data-dsh-frosted-sidebar]{background:' + SIDEBAR_TINT + '!important}',
      '#' + TITLEBAR_ID + '{position:fixed;top:0;left:0;right:0;height:' + TITLEBAR_HEIGHT + 'px;z-index:9999;display:flex;align-items:stretch;-webkit-user-select:none;user-select:none}',
      '#' + TITLEBAR_ID + ' .dsh-gui-titlebar-segment{flex:1;min-width:0}',
      // Both segments are re-painted with sampled colors in frostSurfaces();
      // these stylesheet values are only the pre-sample fallbacks.
      '#' + TITLEBAR_ID + ' .dsh-gui-titlebar-sidebar{flex:none;width:0;background:' + SIDEBAR_FALLBACK + '}',
      '#' + TITLEBAR_ID + ' .dsh-gui-titlebar-column{background:' + COLUMN_FALLBACK + '}',
      '#' + CONTROLS_ID + '{flex:none;display:flex;align-items:stretch;height:100%;background:' + COLUMN_FALLBACK + ';-webkit-user-select:none;user-select:none}',
      '#' + CONTROLS_ID + ' .dsh-gui-control{width:46px;height:100%;margin:0;padding:0;border:0;border-radius:0;background:transparent;color:rgba(0,0,0,.78);display:inline-flex;align-items:center;justify-content:center;cursor:default;outline:none}',
      '#' + CONTROLS_ID + ' .dsh-gui-control svg{width:10px;height:10px;display:block}',
      '#' + CONTROLS_ID + ' .dsh-gui-control:hover{background:rgba(0,0,0,.06)}',
      '#' + CONTROLS_ID + ' .dsh-gui-control:active{background:rgba(0,0,0,.1)}',
      '#' + CONTROLS_ID + ' .dsh-gui-control-close:hover{background:#c42b1c;color:#fff}',
      '#' + CONTROLS_ID + ' .dsh-gui-control-close:active{background:#e81123;color:#fff}',
      'body[data-ds-dark-theme] #' + CONTROLS_ID + ' .dsh-gui-control{color:rgba(255,255,255,.85)}',
      'body[data-ds-dark-theme] #' + CONTROLS_ID + ' .dsh-gui-control:hover{background:rgba(255,255,255,.09)}',
      'body[data-ds-dark-theme] #' + CONTROLS_ID + ' .dsh-gui-control:active{background:rgba(255,255,255,.14)}',
      'body[data-ds-dark-theme] #' + CONTROLS_ID + ' .dsh-gui-control-close:hover{background:#c42b1c;color:#fff}',
      'body[data-ds-dark-theme] #' + CONTROLS_ID + ' .dsh-gui-control-close:active{background:#e81123;color:#fff}',
    ].join('\n')
    document.head.appendChild(style)
  }

  function control(command, className, icon, label) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dsh-gui-control' + (className ? ' ' + className : '')
    button.title = label
    button.setAttribute('aria-label', label)
    button.innerHTML = icon
    // Keep presses on the buttons from ever reaching Tauri's drag-region
    // handling (mousedown starts a drag, a double-click would toggle
    // maximize underneath the buttons).
    button.addEventListener('mousedown', function (event) {
      event.stopPropagation()
    })
    button.addEventListener('click', function (event) {
      event.stopPropagation()
      windowAction(command)
    })
    button.addEventListener('dblclick', function (event) {
      event.stopPropagation()
    })
    return button
  }

  function setMaximizeGlyph(maximized) {
    if (!maximizeButton) return
    const icon = maximized ? ICON_RESTORE : ICON_MAXIMIZE
    const label = maximized ? 'Restore' : 'Maximize'
    if (maximizeButton.getAttribute('aria-label') === label) return
    maximizeButton.innerHTML = icon
    maximizeButton.title = label
    maximizeButton.setAttribute('aria-label', label)
  }

  function syncMaximizeGlyph() {
    const internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return
    try {
      Promise.resolve(internals.invoke('plugin:window|is_maximized', { label: windowLabel() }))
        .then(function (maximized) { setMaximizeGlyph(Boolean(maximized)) })
        .catch(function () {})
    } catch (_error) {
      /* state query is best-effort */
    }
  }

  function dragSegment(className) {
    const segment = document.createElement('div')
    segment.className = 'dsh-gui-titlebar-segment' + (className ? ' ' + className : '')
    segment.setAttribute('data-tauri-drag-region', '')
    return segment
  }

  function createControls() {
    const container = document.createElement('div')
    container.id = CONTROLS_ID
    container.appendChild(control('plugin:window|minimize', '', ICON_MINIMIZE, 'Minimize'))
    maximizeButton = control('plugin:window|toggle_maximize', '', ICON_MAXIMIZE, 'Maximize')
    container.appendChild(maximizeButton)
    container.appendChild(control('plugin:window|close', 'dsh-gui-control-close', ICON_CLOSE, 'Close'))
    controlsElement = container
    syncMaximizeGlyph()
    // Maximizing / restoring / snapping the window fires resize; the middle
    // glyph follows the real window state.
    window.addEventListener('resize', function () {
      if (resizeTimer !== null) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(syncMaximizeGlyph, 150)
    })
    return container
  }

  function createTitlebar() {
    if (document.getElementById(TITLEBAR_ID)) return
    const bar = document.createElement('div')
    bar.id = TITLEBAR_ID
    sidebarSegment = dragSegment('dsh-gui-titlebar-sidebar')
    columnSegment = dragSegment('dsh-gui-titlebar-column')
    bar.appendChild(sidebarSegment)
    bar.appendChild(columnSegment)
    bar.appendChild(createControls())
    document.body.appendChild(bar)
  }

  function mount() {
    if (!document.body) return
    createTitlebar()
  }

  /**
   * Parse a computed CSS color into {r,g,b,a}. Chrome serializes color-mix()
   * results as `color(srgb R G B / A)` with 0-1 float channels, so rgb()
   * parsing alone is not enough (an unparseable color reads as alpha 0,
   * which once hid the frosted sidebar from findSidebar entirely).
   */
  function parseColor(colorValue) {
    const text = String(colorValue)
    const rgb = text.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)/)
    if (rgb) {
      const alpha = rgb[4] === undefined ? 1
        : String(rgb[4]).endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number(rgb[4])
      return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha }
    }
    const srgb = text.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\s*\)/)
    if (srgb) {
      const alpha = srgb[4] === undefined ? 1
        : String(srgb[4]).endsWith('%') ? Number.parseFloat(srgb[4]) / 100 : Number(srgb[4])
      return {
        r: Math.round(Number(srgb[1]) * 255),
        g: Math.round(Number(srgb[2]) * 255),
        b: Math.round(Number(srgb[3]) * 255),
        a: alpha,
      }
    }
    return null
  }

  /** Alpha channel of a computed CSS color (1 for opaque). */
  function alphaOf(colorValue) {
    const color = parseColor(colorValue)
    return color ? color.a : 0
  }

  /**
   * Read the painted surface color at a point right below the titlebar:
   * walk up from the hit element to the nearest opaque background. Returns
   * null (caller keeps its fallback) when nothing opaque is found.
   *
   * The frosted sidebar is a special case: its background is the translucent
   * tint, but it READS as the tint's solid channels (the backdrop behind it
   * stays effectively light and opaque), so the strip above it should be
   * that solid color rather than the translucent stack.
   */
  function sampleSurfaceColor(x, y) {
    let element = document.elementFromPoint(x, y)
    while (element && element !== document.body) {
      if (element.id === TITLEBAR_ID) break
      const background = getComputedStyle(element).backgroundColor
      const color = parseColor(background)
      if (color && color.a >= 0.95) return background
      if (color && element.hasAttribute('data-dsh-frosted-sidebar')) {
        return 'rgb(' + color.r + ', ' + color.g + ', ' + color.b + ')'
      }
      element = element.parentElement
    }
    return null
  }

  /**
   * Locate the sidebar by its visual identity instead of DOM position (the
   * upstream frontend reshapes its tree and theme tokens between releases):
   * the shallowest element that hugs the left edge, starts right below the
   * titlebar, spans the remaining window height, is sidebar-shaped in width,
   * and paints an opaque background. Returns null when the layout does not
   * expose such a column.
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
      if (rect.top > TITLEBAR_HEIGHT + 2) continue
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
  let burstTimer = null
  let resizeObserver = null
  let observedSidebar = null

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
    // Follow the sidebar's geometry directly: collapsing / expanding it is
    // an in-place class flip (no shell mutation, no window resize), so only
    // a ResizeObserver notices it.
    if (typeof ResizeObserver === 'function' && observedSidebar !== sidebar) {
      if (resizeObserver) resizeObserver.disconnect()
      resizeObserver = null
      observedSidebar = sidebar
      if (sidebar) {
        resizeObserver = new ResizeObserver(frostBurst)
        resizeObserver.observe(sidebar)
      }
    }
    // Keep the titlebar aligned with the surfaces below: the sidebar segment
    // tracks the sidebar's width and painted color, the column segment plus
    // the controls on it take the sampled column color. A failed sample
    // (mid-relayout, or a surface painted via gradients the walk can't see)
    // clears back to the stylesheet's opaque theme-token fallback.
    const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 0
    const sampleY = TITLEBAR_HEIGHT + 16
    const sidebarColor = sidebarWidth > 16
      ? sampleSurfaceColor(Math.max(8, Math.floor(sidebarWidth / 2)), sampleY)
      : null
    const columnColor = sampleSurfaceColor(
      Math.min(sidebarWidth + 16, window.innerWidth - 160), sampleY)
    if (sidebarSegment) {
      sidebarSegment.style.width = sidebarWidth + 'px'
      sidebarSegment.style.background = sidebarColor || ''
    }
    if (columnSegment) columnSegment.style.background = columnColor || ''
    if (controlsElement) controlsElement.style.background = columnColor || ''
  }

  function scheduleFrost(delay) {
    if (frostTimer !== null) return
    frostTimer = setTimeout(function () {
      frostTimer = null
      frostSurfaces()
    }, delay || 250)
  }

  /**
   * Debounced re-frost with trailing passes: layout transitions (sidebar
   * collapse animation, maximize re-layout) settle asynchronously, so a
   * single pass can sample mid-transition and get stuck on a stale color.
   */
  function frostBurst() {
    if (burstTimer !== null) clearTimeout(burstTimer)
    burstTimer = setTimeout(function () {
      burstTimer = null
      frostSurfaces()
      setTimeout(frostSurfaces, 250)
      setTimeout(frostSurfaces, 700)
    }, 120)
  }

  function watchSurfaces() {
    const root = document.getElementById('root')
    if (!root) return
    window.addEventListener('resize', frostBurst)
    // Clicks inside the sidebar column (collapse toggle, workspace switch)
    // precede its transition; re-sample as it animates.
    document.addEventListener('click', function (event) {
      if (!observedSidebar) return
      if (event.clientX <= observedSidebar.getBoundingClientRect().right + 8) frostBurst()
    }, true)
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
        if (shellChanged) frostBurst()
      })
      observer.observe(root, { childList: true, subtree: true })
      // A light/dark flip changes the sampled surface colors; the theme
      // token lives on a body attribute.
      const themeObserver = new MutationObserver(function () { scheduleFrost(50) })
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme'],
      })
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
