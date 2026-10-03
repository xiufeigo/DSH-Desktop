/**
 * dsh-gui frameless-window chrome + frosted-glass surfaces, injected by
 * main.rs via `WebviewWindowBuilder::initialization_script`.
 *
 * The window runs with native decorations disabled and an acrylic material,
 * so this script rebuilds the missing chrome INSIDE the shipped web UI (which
 * must stay untouched so `scripts/update-dsh.mjs` / npm payload syncs keep
 * working). The chrome is a single 30px titlebar across the top edge:
 *   - on the loading page (tauri.localhost) the bar is a transparent overlay
 *     so it and the Starting canvas are one acrylic surface;
 *   - on the web UI the page is pushed DOWN below the bar (body padding-top),
 *     so the bar never covers app content, session headers, or hover tooltips;
 *     html/body/#root stay overflow:hidden so that padding cannot create a
 *     second scrollport under the app (a blank acrylic strip at the bottom);
 *   - the bar is one big drag region (double-click toggles maximize);
 *   - its colors are SAMPLED AT RUNTIME from the surfaces directly below:
 *     the segment above the sidebar takes the sidebar's painted color, the
 *     segment above the work columns (and the controls sitting on it) takes
 *     the column color. Sampling is opaque-color based so a translucent
 *     strip cannot seam against wallpaper; fallbacks are the opaque
 *     sidebar-fill / base-background theme tokens;
 *   - the three window controls (minimize / maximize-restore / close) live
 *     at the bar's right end, drawn as crisp Win11-style SVG glyphs whose
 *     color follows the app's light/dark theme; the middle button swaps
 *     between maximize and restore by polling `is_maximized`.
 *   - Desktop extras (sidebar acrylic tint, English/Chinese/code fonts) live
 *     in Settings → General. The shell appends a panel as the LAST child of
 *     the General column (not firstChild of the React options host). Slot
 *     outlets use display:contents; a real box inserted BEFORE that anchor
 *     makes Chromium drop the official/plugin rows from layout. CSS order:-1
 *     keeps the desktop block visually at the top. The observer re-homes the
 *     node if React remounts the section; it is removed on every other tab.
 *     Desktop notifications (session finished / approval / questions) are a
 *     separate injected script (`notify.js`) toggled from this same panel.
 *   - The sidebar column is marked once; a descendant CSS rule then clears
 *     painted backgrounds INSIDE that column only, so the window acrylic
 *     shows through even when upstream stacks many solid wrappers. Dialogs
 *     composed inside that column (Settings is a position:fixed overlay
 *     under the sidebar trigger) keep their own paints so the mask and
 *     panel stay opaque. The work columns are never selected (width-capped)
 *     and stay opaque.
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
  const SETTINGS_PANEL_ID = 'dsh-gui-settings-panel'
  const FONT_STYLE_ID = 'dsh-gui-font-style'
  const FONT_LIST_ID = 'dsh-gui-font-families'
  const TITLEBAR_HEIGHT = 30
  const COLUMN_FALLBACK = 'var(--dsw-alias-bg-base,#f9fafb)'
  const SIDEBAR_FALLBACK = 'var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#f9fafb))'
  const TINT_MIN = 18
  const TINT_MAX = 80
  const TINT_DEFAULT = 36
  const COOKIE_NAME = 'dsh_gui_sidebar_tint_v2'
  const STORAGE_KEY = 'dsh-gui.sidebar-tint-v2'
  const FONT_COOKIE = 'dsh_gui_fonts_v1'
  const FONT_STORAGE = 'dsh-gui.fonts-v1'
  const NOTIFY_COOKIE = 'dsh_gui_notify_v2'
  const NOTIFY_STORAGE = 'dsh-gui.notify-v2'
  const NOTIFY_LEGACY_COOKIE = 'dsh_gui_notify_v1'
  const NOTIFY_LEGACY_STORAGE = 'dsh-gui.notify-v1'
  const DEFAULT_EN_FONT = 'Segoe UI'
  const DEFAULT_ZH_FONT = 'Microsoft YaHei'
  const DEFAULT_CODE_FONT = 'Consolas'
  const LATIN_RANGE = 'U+0000-024F,U+1E00-1EFF,U+2000-218F,U+2190-21FF,U+2200-22FF'
  const CJK_RANGE = 'U+2E80-9FFF,U+F900-FAFF,U+FE10-FE1F,U+FE30-FE4F,U+FF00-FFEF,U+20000-2FA1F'
  // 提示音清单：与 scripts/make-audio.mjs 的 GROUPS 及 audio.js 内嵌资源一一
  // 对应，选项分组/命名沿用 opencode（MIT）。中文标签也照搬 opencode zh。
  const SOUND_GROUPS = [
    { prefix: 'alert-', count: 10, en: 'Alert', zh: '警报' },
    { prefix: 'bip-bop-', count: 10, en: 'Bip-bop', zh: null },
    { prefix: 'staplebops-', count: 7, en: 'Staplebops', zh: null },
    { prefix: 'nope-', count: 12, en: 'Nope', zh: null },
    { prefix: 'yup-', count: 6, en: 'Yup', zh: null },
  ]
  const NOTIFY_DEFAULTS = {
    notifications: { agent: true, permissions: true, errors: false },
    sounds: {
      agentEnabled: true,
      agent: 'staplebops-01',
      permissionsEnabled: true,
      permissions: 'staplebops-02',
      errorsEnabled: true,
      errors: 'nope-03',
    },
  }
  const SOUND_CHANNELS = [
    { key: 'agent', copy: 'soundAgent' },
    { key: 'permissions', copy: 'soundPermissions' },
    { key: 'errors', copy: 'soundErrors' },
  ]
  const NOTIFY_CHANNELS = [
    { key: 'agent', copy: 'notifyAgent' },
    { key: 'permissions', copy: 'notifyPermissions' },
    { key: 'errors', copy: 'notifyErrors' },
  ]
  const FONT_PROBES = [
    'Segoe UI', 'Segoe UI Variable Text', 'Aptos', 'Calibri', 'Arial', 'Tahoma',
    'Verdana', 'Georgia', 'Times New Roman', 'Cambria', 'Trebuchet MS', 'Bahnschrift',
    'Microsoft YaHei UI', 'Microsoft YaHei', 'Microsoft JhengHei', 'PingFang SC',
    'SimSun', 'NSimSun', 'SimHei', 'KaiTi', 'FangSong', 'DengXian',
    'Noto Sans SC', 'Source Han Sans SC', 'LXGW WenKai', 'Sarasa Gothic SC',
    'Cascadia Code', 'Cascadia Mono', 'Consolas', 'JetBrains Mono', 'Fira Code',
    'Source Code Pro', 'Hack', 'IBM Plex Mono', 'Courier New', 'Lucida Console',
  ]
  // Settings / onboarding overlays are composed inside the sidebar tree as
  // position:fixed layers. :is() so the frost punch does not clear their paints.
  const OPAQUE_SURFACE = ':is([data-dsh-opaque-surface],[data-dsh-opaque-surface] *,[role=dialog],[role=dialog] *,[aria-modal=true],[aria-modal=true] *,:has([aria-modal=true]),:has([aria-modal=true]) *)'

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
  let tintValueLabel = null
  let tintSlider = null
  let resizeTimer = null
  let currentTint = TINT_DEFAULT
  let currentFonts = { en: '', zh: '', code: '' }
  let currentNotify = clonePrefs(NOTIFY_DEFAULTS)
  let fontFamilyCache = null
  let watching = false
  let settingsSyncRaf = 0

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

  function tauriInvoke(command, args) {
    const internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') {
      return Promise.reject(new Error('tauri unavailable'))
    }
    try {
      return Promise.resolve(internals.invoke(command, args || {}))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  function isStartupSurface() {
    return location.hostname === 'tauri.localhost' || location.protocol === 'tauri:'
  }

  function clampTint(value) {
    const number = Math.round(Number(value))
    if (!Number.isFinite(number)) return TINT_DEFAULT
    return Math.min(TINT_MAX, Math.max(TINT_MIN, number))
  }

  function transparencyOf(tint) {
    return 100 - tint
  }

  function tintDeclaration(percent) {
    return 'color-mix(in srgb,' + SIDEBAR_FALLBACK + ' ' + percent + '%,transparent)'
  }

  function applyTint(percent) {
    currentTint = clampTint(percent)
    if (!document.documentElement) return
    document.documentElement.style.setProperty('--dsh-gui-sidebar-tint', tintDeclaration(currentTint))
    if (tintSlider && Number(tintSlider.value) !== transparencyOf(currentTint)) {
      tintSlider.value = String(transparencyOf(currentTint))
    }
    if (tintValueLabel) tintValueLabel.textContent = transparencyOf(currentTint) + '%'
  }

  function readCookie(name) {
    const parts = String(document.cookie || '').split(';')
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i].trim()
      if (part.indexOf(name + '=') === 0) return part.slice(name.length + 1)
    }
    return null
  }

  function writeCookie(name, value) {
    document.cookie = name + '=' + value + '; max-age=31536000; path=/'
  }

  function readStoredTint() {
    const cookie = readCookie(COOKIE_NAME)
    if (cookie !== null) return clampTint(cookie)
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored !== null) return clampTint(stored)
    } catch (_error) {
      /* private mode / blocked storage */
    }
    return TINT_DEFAULT
  }

  function persistTint(percent) {
    const value = clampTint(percent)
    writeCookie(COOKIE_NAME, String(value))
    try {
      localStorage.setItem(STORAGE_KEY, String(value))
    } catch (_error) {
      /* private mode / blocked storage */
    }
  }

  function sanitizeFontName(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!text) return ''
    if (/[{};<>\\]/.test(text) || text.indexOf('url(') !== -1) return ''
    return text
  }

  function normalizeFonts(value) {
    const source = value && typeof value === 'object' ? value : {}
    return {
      en: sanitizeFontName(source.en),
      zh: sanitizeFontName(source.zh),
      code: sanitizeFontName(source.code),
    }
  }

  function readStoredFonts() {
    const cookie = readCookie(FONT_COOKIE)
    if (cookie) {
      try {
        return normalizeFonts(JSON.parse(decodeURIComponent(cookie)))
      } catch (_error) {
        /* ignore malformed cookie */
      }
    }
    try {
      const stored = localStorage.getItem(FONT_STORAGE)
      if (stored) return normalizeFonts(JSON.parse(stored))
    } catch (_error) {
      /* private mode / blocked storage */
    }
    return { en: '', zh: '', code: '' }
  }

  function persistFonts(fonts) {
    currentFonts = normalizeFonts(fonts)
    const encoded = encodeURIComponent(JSON.stringify(currentFonts))
    writeCookie(FONT_COOKIE, encoded)
    try {
      localStorage.setItem(FONT_STORAGE, JSON.stringify(currentFonts))
    } catch (_error) {
      /* private mode / blocked storage */
    }
  }

  // —— 通知/提示音偏好（v2 JSON）。与 notify.js 的 sanitizePrefs 保持同一
  // schema：两个脚本各自内联一份，改字段时必须两边同步。
  function clonePrefs(prefs) {
    return {
      notifications: { ...prefs.notifications },
      sounds: { ...prefs.sounds },
    }
  }

  function soundIdKnown(value) {
    if (typeof value !== 'string') return false
    const table = window.__DSH_GUI_AUDIO__
    if (!table) return SOUND_IDS().indexOf(value) !== -1
    return Object.prototype.hasOwnProperty.call(table, value)
  }

  function SOUND_IDS() {
    const ids = []
    for (const group of SOUND_GROUPS) {
      for (let n = 1; n <= group.count; n += 1) {
        ids.push(group.prefix + String(n).padStart(2, '0'))
      }
    }
    return ids
  }

  function sanitizeNotifyPrefs(value) {
    const source = value && typeof value === 'object' ? value : {}
    const notifications = source.notifications && typeof source.notifications === 'object' ? source.notifications : {}
    const sounds = source.sounds && typeof source.sounds === 'object' ? source.sounds : {}
    const bool = (input) => (typeof input === 'boolean' ? input : null)
    const id = (input) => (soundIdKnown(input) ? input : null)
    const merged = clonePrefs(NOTIFY_DEFAULTS)
    for (const key of Object.keys(merged.notifications)) {
      const parsed = bool(notifications[key])
      if (parsed !== null) merged.notifications[key] = parsed
    }
    for (const key of Object.keys(merged.sounds)) {
      if (key.endsWith('Enabled')) {
        const parsed = bool(sounds[key])
        if (parsed !== null) merged.sounds[key] = parsed
      } else {
        const parsed = id(sounds[key])
        if (parsed !== null) merged.sounds[key] = parsed
      }
    }
    return merged
  }

  function readStoredNotify() {
    const cookie = readCookie(NOTIFY_COOKIE)
    if (cookie) {
      try {
        return sanitizeNotifyPrefs(JSON.parse(decodeURIComponent(cookie)))
      } catch (_error) {
        /* malformed cookie */
      }
    }
    try {
      const stored = localStorage.getItem(NOTIFY_STORAGE)
      if (stored) return sanitizeNotifyPrefs(JSON.parse(stored))
    } catch (_error) {
      /* private mode / blocked storage */
    }
    // v1 单开关迁移：明确关过通知的用户，三个通知通道全部默认关。
    let legacy = readCookie(NOTIFY_LEGACY_COOKIE)
    if (legacy === null) {
      try {
        const stored = localStorage.getItem(NOTIFY_LEGACY_STORAGE)
        if (stored !== null) legacy = stored
      } catch (_error) {
        /* private mode / blocked storage */
      }
    }
    if (legacy === '0') {
      const migrated = clonePrefs(NOTIFY_DEFAULTS)
      migrated.notifications = { agent: false, permissions: false, errors: false }
      return migrated
    }
    return clonePrefs(NOTIFY_DEFAULTS)
  }

  function persistNotify(prefs) {
    currentNotify = sanitizeNotifyPrefs(prefs)
    const encoded = encodeURIComponent(JSON.stringify(currentNotify))
    writeCookie(NOTIFY_COOKIE, encoded)
    try {
      localStorage.setItem(NOTIFY_STORAGE, JSON.stringify(currentNotify))
    } catch (_error) {
      /* private mode / blocked storage */
    }
  }

  // 试听：与 notify.js 的 playSound 相同的播放路径；失败静默（自动播放
  // 已在 main.rs 通过 WebView2 启动参数放行）。
  function previewSound(soundId) {
    if (!soundId) return
    try {
      const table = window.__DSH_GUI_AUDIO__
      const src = table && Object.prototype.hasOwnProperty.call(table, soundId) ? table[soundId] : null
      if (!src) return
      const audio = new Audio(src)
      const played = audio.play()
      if (played && typeof played.catch === 'function') played.catch(function () {})
    } catch (_error) {
      /* preview is best-effort */
    }
  }

  // local() matches a font's Full Name / PostScript name, not the family
  // name the settings UI shows. Chromium often fails `local("Cascadia Code")`
  // while `font-family: "Cascadia Code"` works. Emit several local() guesses
  // for unicode-range splitting, and always put the family name in the stack.
  function cssLocalSrc(name) {
    const guesses = [name]
    if (!/ Regular$/i.test(name)) guesses.push(name + ' Regular')
    const parts = []
    const seen = Object.create(null)
    for (let i = 0; i < guesses.length; i += 1) {
      const guess = guesses[i]
      if (seen[guess]) continue
      seen[guess] = true
      parts.push('local(' + JSON.stringify(guess) + ')')
    }
    return parts.join(',')
  }

  function cssFamilyStack(names) {
    const parts = []
    const seen = Object.create(null)
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i]
      if (!name || seen[name]) continue
      seen[name] = true
      if (
        name === 'sans-serif' ||
        name === 'monospace' ||
        name === 'serif' ||
        name.charAt(0) === '-'
      ) {
        parts.push(name)
      } else {
        parts.push(JSON.stringify(name))
      }
    }
    return parts.join(',')
  }

  function applyFonts(fonts) {
    currentFonts = normalizeFonts(fonts)
    let style = document.getElementById(FONT_STYLE_ID)
    if (!style) {
      style = document.createElement('style')
      style.id = FONT_STYLE_ID
    }
    // Keep this sheet last so later-injected theme CSS cannot win the
    // custom-property race on equal specificity.
    document.head.appendChild(style)
    const customUi = Boolean(currentFonts.en || currentFonts.zh)
    const customCode = Boolean(currentFonts.code)
    if (!customUi && !customCode) {
      style.textContent = ''
      return
    }
    const en = currentFonts.en || DEFAULT_EN_FONT
    const zh = currentFonts.zh || DEFAULT_ZH_FONT
    const code = currentFonts.code || DEFAULT_CODE_FONT
    const rules = []
    if (customUi) {
      rules.push(
        '@font-face{font-family:"DSH-GUI-UI";src:' + cssLocalSrc(en) + ';unicode-range:' + LATIN_RANGE + '}',
        '@font-face{font-family:"DSH-GUI-UI";src:' + cssLocalSrc(zh) + ';unicode-range:' + CJK_RANGE + '}',
      )
    }
    if (customCode) {
      rules.push('@font-face{font-family:"DSH-GUI-CODE";src:' + cssLocalSrc(code) + '}')
    }
    const uiStack = cssFamilyStack([
      'DshChipCell',
      customUi ? 'DSH-GUI-UI' : '',
      currentFonts.en,
      currentFonts.zh,
      '-apple-system',
      'BlinkMacSystemFont',
      'Segoe UI',
      'Microsoft YaHei',
      'sans-serif',
    ])
    const codeStack = cssFamilyStack([
      customCode ? 'DSH-GUI-CODE' : '',
      currentFonts.code,
      customUi ? 'DSH-GUI-UI' : '',
      currentFonts.en,
      currentFonts.zh,
      'SF Mono',
      'JetBrains Mono',
      'Fira Code',
      'Consolas',
      'Microsoft YaHei',
    ])
    if (customUi) {
      rules.push(
        ':root,html,body,#root{--dsw-font-family:' + uiStack + '!important}',
        'html,body,#root{font-family:var(--dsw-font-family)!important}',
      )
    }
    if (customCode || customUi) {
      rules.push(
        ':root,html,body,#root{--ds-font-family-code:' + codeStack + '!important}',
        'code,pre,kbd,samp,tt,[class*="shiki"],[class*="cm-editor"],[class*="cm-"]{font-family:var(--ds-font-family-code)!important}',
      )
    }
    style.textContent = rules.join('\n')
  }

  function fontAvailable(name) {
    if (!document.fonts || typeof document.fonts.check !== 'function') return true
    try {
      return document.fonts.check('16px ' + JSON.stringify(name))
    } catch (_error) {
      return false
    }
  }

  function uniqueSortedFonts(names) {
    const seen = Object.create(null)
    const unique = []
    for (let i = 0; i < names.length; i += 1) {
      const name = sanitizeFontName(names[i])
      if (!name || seen[name]) continue
      seen[name] = true
      unique.push(name)
    }
    unique.sort(function (a, b) {
      return a.localeCompare(b, 'zh-Hans')
    })
    return unique
  }

  function loadFontFamilies(callback) {
    if (fontFamilyCache) {
      callback(fontFamilyCache)
      return
    }
    // Do not call queryLocalFonts(): the UI is http://127.0.0.1:<ephemeral>,
    // so Chromium's Local Font Access prompt is origin-scoped to that port
    // and comes back every launch. Probes + typed names are enough; CSS
    // font-family does not need the Local Font Access API.
    const probed = []
    for (let i = 0; i < FONT_PROBES.length; i += 1) {
      if (fontAvailable(FONT_PROBES[i])) probed.push(FONT_PROBES[i])
    }
    fontFamilyCache = uniqueSortedFonts(probed)
    callback(fontFamilyCache)
  }

  function fillFontList(list, families) {
    list.textContent = ''
    for (let i = 0; i < families.length; i += 1) {
      const option = document.createElement('option')
      option.value = families[i]
      list.appendChild(option)
    }
  }

  function applyStyles() {
    const style = document.createElement('style')
    style.textContent = [
      'html,body{background:transparent!important}',
      'html{--dsh-gui-sidebar-tint:' + tintDeclaration(currentTint) + ';--dsh-gui-sidebar-width:0px}',
      // Lock the page to the window: upstream is html,body,#root{height:100%},
      // and padding-top for the titlebar would otherwise grow the document so
      // the wheel can keep scrolling past the app into a blank (acrylic) strip.
      'html,body,#root{height:100%;margin:0;overflow:hidden;overscroll-behavior:none}',
      'body{box-sizing:border-box;padding-top:' + TITLEBAR_HEIGHT + 'px}',
      'html[data-dsh-gui-startup] body{padding-top:0}',
      '#root{min-height:0}',
      // Keep the work columns opaque even after sidebar ancestors are cleared:
      // a left-to-right split on #root, not a fully transparent page.
      '#root{background:linear-gradient(to right,transparent var(--dsh-gui-sidebar-width),var(--dsw-alias-bg-base,#f9fafb) var(--dsh-gui-sidebar-width))!important}',
      '[data-dsh-frosted-frame]{background:transparent!important;background-image:none!important}',
      // Window acrylic only shows through actually-transparent pixels. Upstream
      // paints the sidebar as a stack of solid wrappers, so clearing those
      // fills — descendants of the marked column only — is what lets the
      // material through. Settings (and other dialogs) are composed INSIDE the
      // sidebar tree as position:fixed overlays; they must keep their paints.
      '[data-dsh-frosted-sidebar] *:not(' + OPAQUE_SURFACE + '){background-color:transparent!important}',
      '[data-dsh-frosted-sidebar] *:not(' + OPAQUE_SURFACE + ')::before,[data-dsh-frosted-sidebar] *:not(' + OPAQUE_SURFACE + ')::after{background-color:transparent!important}',
      '[data-dsh-frosted-sidebar]>:not(' + OPAQUE_SURFACE + '){background-image:none!important}',
      // Workspace list pins an opaque sidebar-fill gradient on a nested span.fade;
      // on acrylic that reads as a white strip above Settings.
      '[data-dsh-frosted-sidebar] span[class*="fade"]{background:none!important;background-image:none!important}',
      '[data-dsh-frosted-sidebar]{background:var(--dsh-gui-sidebar-tint)!important}',
      '#' + TITLEBAR_ID + '{position:fixed;top:0;left:0;right:0;height:' + TITLEBAR_HEIGHT + 'px;z-index:9999;display:flex;align-items:stretch;border:0;box-shadow:none;background:transparent;-webkit-user-select:none;user-select:none}',
      '#' + TITLEBAR_ID + ' .dsh-gui-titlebar-segment{flex:1;min-width:0}',
      '#' + TITLEBAR_ID + ' .dsh-gui-titlebar-sidebar{flex:none;width:0;background:var(--dsh-gui-sidebar-tint)}',
      '#' + TITLEBAR_ID + ' .dsh-gui-titlebar-column{background:' + COLUMN_FALLBACK + '}',
      '#' + CONTROLS_ID + '{flex:none;display:flex;align-items:stretch;height:100%;background:' + COLUMN_FALLBACK + ';-webkit-user-select:none;user-select:none}',
      '#' + CONTROLS_ID + ' .dsh-gui-control{width:46px;height:100%;margin:0;padding:0;border:0;border-radius:0;background:transparent;color:rgba(0,0,0,.78);display:inline-flex;align-items:center;justify-content:center;cursor:default;outline:none;-webkit-appearance:none;appearance:none}',
      '#' + CONTROLS_ID + ' .dsh-gui-control svg{width:12px;height:12px;display:block}',
      '#' + CONTROLS_ID + ' .dsh-gui-control:hover{background:rgba(0,0,0,.06)}',
      '#' + CONTROLS_ID + ' .dsh-gui-control:active{background:rgba(0,0,0,.1)}',
      '#' + CONTROLS_ID + ' .dsh-gui-control-close:hover{background:#c42b1c;color:#fff}',
      '#' + CONTROLS_ID + ' .dsh-gui-control-close:active{background:#e81123;color:#fff}',
      'body[data-ds-dark-theme] #' + CONTROLS_ID + ' .dsh-gui-control{color:rgba(255,255,255,.85)}',
      'body[data-ds-dark-theme] #' + CONTROLS_ID + ' .dsh-gui-control:hover{background:rgba(255,255,255,.09)}',
      'body[data-ds-dark-theme] #' + CONTROLS_ID + ' .dsh-gui-control:active{background:rgba(255,255,255,.14)}',
      'body[data-ds-dark-theme] #' + CONTROLS_ID + ' .dsh-gui-control-close:hover{background:#c42b1c;color:#fff}',
      'body[data-ds-dark-theme] #' + CONTROLS_ID + ' .dsh-gui-control-close:active{background:#e81123;color:#fff}',
      'html[data-dsh-gui-startup] #' + TITLEBAR_ID + ' .dsh-gui-titlebar-segment,html[data-dsh-gui-startup] #' + CONTROLS_ID + '{background:transparent!important}',
      'html[data-dsh-gui-modal] #' + TITLEBAR_ID + ' .dsh-gui-titlebar-sidebar{width:0!important;background:transparent!important}',
      '@media (prefers-color-scheme: dark){html[data-dsh-gui-startup] #' + CONTROLS_ID + ' .dsh-gui-control{color:rgba(255,255,255,.85)}html[data-dsh-gui-startup] #' + CONTROLS_ID + ' .dsh-gui-control:hover{background:rgba(255,255,255,.09)}html[data-dsh-gui-startup] #' + CONTROLS_ID + ' .dsh-gui-control:active{background:rgba(255,255,255,.14)}}',
      '#' + SETTINGS_PANEL_ID + '{order:-1;flex-shrink:0;border-bottom:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:14px;padding:16px 0 20px;display:flex}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-row{flex-direction:column;gap:6px;display:flex}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-label{display:flex;justify-content:space-between;align-items:baseline;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));font-size:13px;line-height:20px}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-hint{margin:0;color:var(--dsw-alias-label-tertiary,#646a73);font-size:12px;line-height:18px}',
      '#' + SETTINGS_PANEL_ID + ' input[type=range]{width:100%;margin:0;accent-color:var(--dsw-static-neutral-bluish-400,#137c6b)}',
      '#' + SETTINGS_PANEL_ID + ' input[type=text]{box-sizing:border-box;width:100%;height:36px;margin:0;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-primary);font:inherit;outline:none}',
      '#' + SETTINGS_PANEL_ID + ' input[type=text]:focus{border-color:var(--dsw-static-neutral-bluish-400,#4c8dff)}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-reset{align-self:flex-start;margin:0;padding:0;border:0;background:transparent;color:var(--dsw-static-neutral-bluish-400,#137c6b);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-apply{align-self:flex-start;margin:4px 0 0;padding:7px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;cursor:pointer}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-apply:hover{border-color:var(--dsw-static-neutral-bluish-400,#137c6b)}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-apply:disabled{opacity:.55;cursor:default}',
      '#' + SETTINGS_PANEL_ID + ' input[type=text]:disabled{opacity:.55}',
      '#' + SETTINGS_PANEL_ID + ' select.dsh-gui-settings-select{box-sizing:border-box;width:100%;height:36px;margin:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-primary);font:inherit;outline:none;cursor:pointer}',
      '#' + SETTINGS_PANEL_ID + ' select.dsh-gui-settings-select:focus{border-color:var(--dsw-static-neutral-bluish-400,#4c8dff)}',
      '#' + SETTINGS_PANEL_ID + ' select.dsh-gui-settings-select option{background:var(--dsw-alias-bg-base,#f9fafb);color:var(--dsw-alias-label-primary,#1a1a1e)}',
      'body[data-ds-dark-theme] #' + SETTINGS_PANEL_ID + ' select.dsh-gui-settings-select{color-scheme:dark}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-check{align-items:flex-start;gap:8px;display:flex;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '#' + SETTINGS_PANEL_ID + ' .dsh-gui-settings-check input{flex:none;margin:3px 0 0;accent-color:var(--dsw-static-neutral-bluish-400,#137c6b)}',
    ].join('\n')
    document.head.appendChild(style)
  }

  function suppressDrag(element) {
    element.addEventListener('mousedown', function (event) {
      event.stopPropagation()
    })
    element.addEventListener('dblclick', function (event) {
      event.stopPropagation()
    })
  }

  function control(command, className, icon, label) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dsh-gui-control' + (className ? ' ' + className : '')
    button.title = label
    button.setAttribute('aria-label', label)
    button.innerHTML = icon
    suppressDrag(button)
    button.addEventListener('click', function (event) {
      event.stopPropagation()
      windowAction(command)
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

  function markStartupSurface() {
    if (!document.documentElement) return
    if (isStartupSurface()) {
      document.documentElement.setAttribute('data-dsh-gui-startup', '')
      if (document.body) document.body.setAttribute('data-tauri-drag-region', '')
    } else {
      document.documentElement.removeAttribute('data-dsh-gui-startup')
      if (document.body) document.body.removeAttribute('data-tauri-drag-region')
    }
  }

  function mount() {
    if (!document.body) return
    markStartupSurface()
    createTitlebar()
  }

  function findAppDialog() {
    const dialogs = document.querySelectorAll('[aria-modal="true"], [role="dialog"]')
    for (let i = 0; i < dialogs.length; i += 1) {
      const dialog = dialogs[i]
      if (dialog.id === SETTINGS_PANEL_ID) continue
      if (dialog.hidden) continue
      return dialog
    }
    return null
  }

  function settingsCopy(dialog) {
    const nav = dialog && dialog.querySelector('nav')
    const text = nav ? String(nav.textContent || '') : ''
    const english = /\bSettings\b/.test(text) && text.indexOf('设置') === -1
    if (english) {
      return {
        title: 'Desktop',
        tint: 'Sidebar transparency',
        tintHint: 'Higher values show more of the window acrylic.',
        fontEn: 'English font',
        fontZh: 'Chinese font',
        fontCode: 'Code font',
        fontHint: 'Leave blank for the system default. English and Chinese fonts apply to different scripts.',
        placeholder: 'System default',
        reset: 'Reset fonts',
        notifySection: 'System notifications',
        notifyAgent: 'Agent',
        notifyAgentHint: 'Show a system notification when the agent completes or needs attention.',
        notifyPermissions: 'Permissions',
        notifyPermissionsHint: 'Show a system notification when an approval or answer is needed.',
        notifyErrors: 'Errors',
        notifyErrorsHint: 'Show a system notification when an error occurs.',
        soundSection: 'Sound effects',
        soundAgent: 'Agent',
        soundAgentHint: 'Play a sound when the agent completes or needs attention.',
        soundPermissions: 'Permissions',
        soundPermissionsHint: 'Play a sound when an approval or answer is needed.',
        soundErrors: 'Errors',
        soundErrorsHint: 'Play a sound when an error occurs.',
        soundNone: 'None',
        backendTitle: 'Backend runtime',
        backendMode: 'Backend',
        backendNative: 'Windows native',
        backendWsl: 'WSL2 (Linux)',
        backendDistro: 'WSL distro (blank = default)',
        backendDeployDir: 'Linux payload directory',
        backendApply: 'Save and restart backend',
        backendWarn: 'Switching restarts DSH and interrupts the current session.',
        backendFallback: 'No bundled Linux payload; WSL must already have dsh installed.',
        backendReady: 'WSL backend is available.',
        backendUnavailable: 'WSL is unavailable: ',
        backendSaved: 'Saved. Restarting backend…',
        backendError: 'Failed: ',
        backendNativeHint: 'Uses the bundled Windows runtime.',
        backendWslHint: 'Uses Linux inside WSL2; API keys and sessions are separate.',
        proxyTitle: 'Network proxy',
        proxyEnable: 'Enable proxy (this app only)',
        proxyUrl: 'Proxy URL',
        proxyNoProxy: 'Bypass list (NO_PROXY)',
        proxyNoProxyHint: 'Comma-separated hosts that skip the proxy. Blank uses localhost,127.0.0.1,::1.',
        proxyApply: 'Save',
        proxyApplyWarn: 'dsh resolves the proxy from its launch environment at boot (@deepseek-ai/dsh-http-proxy) — restart the backend to apply a saved change.',
        proxyRestart: 'Restart backend now',
        proxyRestartHint: 'Saved change pending — restart the backend to apply it.',
        proxyActiveOn: 'Traffic is going through: %s',
        proxyPending: 'Proxy saved — restart the backend to apply.',
        proxyOff: 'Direct connection (no proxy).',
        applying: 'Saving…',
        proxyError: 'Failed: ',
      }
    }
    return {
      title: '桌面',
      tint: '侧栏透明度',
      tintHint: '越高越透出窗口亚克力',
      fontEn: '英文字体',
      fontZh: '中文字体',
      fontCode: '代码字体',
      fontHint: '留空则使用系统默认。英文字体作用于西文，中文字体作用于汉字。',
      placeholder: '系统默认',
      reset: '恢复默认字体',
      notifySection: '系统通知',
      notifyAgent: '智能体',
      notifyAgentHint: '当智能体完成或需要注意时显示系统通知。',
      notifyPermissions: '权限',
      notifyPermissionsHint: '当需要审批或需要你回答时显示系统通知。',
      notifyErrors: '错误',
      notifyErrorsHint: '发生错误时显示系统通知。',
      soundSection: '音效',
      soundAgent: '智能体',
      soundAgentHint: '当智能体完成或需要注意时播放提示音。',
      soundPermissions: '权限',
      soundPermissionsHint: '当需要审批或需要你回答时播放提示音。',
      soundErrors: '错误',
      soundErrorsHint: '发生错误时播放提示音。',
      soundNone: '无',
      backendTitle: '后端运行环境',
      backendMode: '后端',
      backendNative: 'Windows 原生',
      backendWsl: 'WSL2 (Linux)',
      backendDistro: 'WSL 发行版（留空=默认）',
      backendDeployDir: 'Linux 载荷目录',
      backendApply: '保存并重启后端',
      backendWarn: '切换会重启 DSH 后端并中断当前会话。',
      backendFallback: '未内置 Linux 载荷；需在 WSL 内预先安装 dsh。',
      backendReady: '已检测到可用的 WSL。',
      backendUnavailable: 'WSL 不可用：',
      backendSaved: '已保存。正在重启后端…',
      backendError: '失败：',
      backendNativeHint: '使用内置的 Windows 运行时。',
      backendWslHint: '使用 WSL2 内的 Linux；API Key 与会话相互独立。',
      proxyTitle: '网络代理',
      proxyEnable: '启用代理（仅 DSH 生效）',
      proxyUrl: '代理地址',
      proxyNoProxy: '直连例外（NO_PROXY）',
      proxyNoProxyHint: '逗号分隔、不走代理的主机；留空默认 localhost,127.0.0.1,::1。',
      proxyApply: '保存',
      proxyApplyWarn: 'dsh 在启动时从启动环境解析代理并装为全局 dispatcher（@deepseek-ai/dsh-http-proxy）——保存后需重启后端生效。',
      proxyRestart: '立即重启后端',
      proxyRestartHint: '已保存的改动待生效——重启后端后应用。',
      proxyActiveOn: '流量正经过：%s',
      proxyPending: '代理已保存——重启后端后生效。',
      proxyOff: '未启用——当前直连。',
      applying: '正在保存…',
      proxyError: '失败：',
    }
  }

  function isGeneralSettings(dialog) {
    if (!dialog) return false
    const nav = dialog.querySelector('nav')
    if (!nav) return false
    const current = nav.querySelector('button[aria-current="true"]')
    const target = current || nav.querySelector('button')
    if (!target) return false
    const text = String(target.textContent || '').replace(/\s+/g, '')
    return text === '通用设置' || text === 'General'
  }

  function findSettingsOptions(dialog) {
    const nav = dialog.querySelector('nav')
    if (!nav) return null
    const content = nav.nextElementSibling
    if (!content) return null
    for (let i = 0; i < content.children.length; i += 1) {
      const node = content.children[i]
      if (node.nodeType !== 1) continue
      if (node.id === SETTINGS_PANEL_ID) continue
      const style = getComputedStyle(node)
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') return node
    }
    return null
  }

  function findGeneralSectionHost(dialog) {
    const options = findSettingsOptions(dialog)
    if (!options) return null
    const sectionSlot = options.querySelector('[data-slot="settings.section"]')
    if (!sectionSlot) return null
    return sectionSlot.firstElementChild || null
  }

  function bindFontInput(input, key) {
    input.addEventListener('input', function () {
      const preview = sanitizeFontName(input.value)
      const next = normalizeFonts(currentFonts)
      next[key] = preview
      applyFonts(next)
      input.style.fontFamily = preview ? JSON.stringify(preview) : ''
    })
    const commit = function () {
      const next = normalizeFonts(currentFonts)
      next[key] = sanitizeFontName(input.value)
      input.value = next[key]
      persistFonts(next)
      applyFonts(next)
      input.style.fontFamily = next[key] ? JSON.stringify(next[key]) : ''
    }
    input.addEventListener('change', commit)
    input.addEventListener('blur', commit)
  }

  function createSettingsPanel(dialog) {
    const copy = settingsCopy(dialog)
    const panel = document.createElement('section')
    panel.id = SETTINGS_PANEL_ID
    panel.setAttribute('data-dsh-opaque-surface', '')

    const title = document.createElement('div')
    title.className = 'dsh-gui-settings-title'
    title.textContent = copy.title
    panel.appendChild(title)

    const tintRow = document.createElement('div')
    tintRow.className = 'dsh-gui-settings-row'
    const tintLabel = document.createElement('div')
    tintLabel.className = 'dsh-gui-settings-label'
    const tintName = document.createElement('span')
    tintName.textContent = copy.tint
    tintValueLabel = document.createElement('span')
    tintValueLabel.className = 'dsh-gui-settings-value'
    tintValueLabel.textContent = transparencyOf(currentTint) + '%'
    tintLabel.appendChild(tintName)
    tintLabel.appendChild(tintValueLabel)
    tintSlider = document.createElement('input')
    tintSlider.type = 'range'
    tintSlider.min = String(100 - TINT_MAX)
    tintSlider.max = String(100 - TINT_MIN)
    tintSlider.step = '1'
    tintSlider.value = String(transparencyOf(currentTint))
    tintSlider.setAttribute('aria-label', copy.tint)
    tintSlider.addEventListener('input', function () {
      applyTint(100 - Number(tintSlider.value))
    })
    tintSlider.addEventListener('change', function () {
      persistTint(currentTint)
    })
    const tintHint = document.createElement('p')
    tintHint.className = 'dsh-gui-settings-hint'
    tintHint.textContent = copy.tintHint
    tintRow.appendChild(tintLabel)
    tintRow.appendChild(tintSlider)
    tintRow.appendChild(tintHint)
    panel.appendChild(tintRow)

    // —— 后端运行环境：Windows 原生 vs WSL2。偏好存 %APPDATA%\dsh-desktop\
    // settings.json 的 backend 段；切换保存后由 Rust 端重启后端生效。
    // WSL 模式首次启用时会把内置 Linux 载荷（若随包携带）部署进所选发行版。
    const backendHeading = document.createElement('div')
    backendHeading.className = 'dsh-gui-settings-title'
    backendHeading.textContent = copy.backendTitle
    panel.appendChild(backendHeading)

    let backendLoaded = false
    let backendSaved = null

    function backendTextRow(labelText, placeholderText, value) {
      const row = document.createElement('div')
      row.className = 'dsh-gui-settings-row'
      const label = document.createElement('div')
      label.className = 'dsh-gui-settings-label'
      label.textContent = labelText
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = placeholderText
      input.value = value || ''
      input.setAttribute('spellcheck', 'false')
      input.setAttribute('autocomplete', 'off')
      input.setAttribute('aria-label', labelText)
      input.disabled = true
      row.appendChild(label)
      row.appendChild(input)
      panel.appendChild(row)
      return input
    }

    const backendModeRow = document.createElement('div')
    backendModeRow.className = 'dsh-gui-settings-row'
    const modeLabel = document.createElement('div')
    modeLabel.className = 'dsh-gui-settings-label'
    modeLabel.textContent = copy.backendMode
    const modeSelect = document.createElement('select')
    modeSelect.className = 'dsh-gui-settings-select'
    modeSelect.setAttribute('aria-label', copy.backendMode)
    modeSelect.disabled = true
    for (const [value, text] of [
      ['native', copy.backendNative],
      ['wsl', copy.backendWsl],
    ]) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = text
      modeSelect.appendChild(option)
    }
    backendModeRow.appendChild(modeLabel)
    backendModeRow.appendChild(modeSelect)
    panel.appendChild(backendModeRow)

    const distroInput = backendTextRow(copy.backendDistro, 'Ubuntu')
    const deployInput = backendTextRow(copy.backendDeployDir, '~/.local/share/dsh-desktop/backend')
    deployInput.value = deployInput.value || '~/.local/share/dsh-desktop/backend'

    const backendStatus = document.createElement('p')
    backendStatus.className = 'dsh-gui-settings-hint'
    panel.appendChild(backendStatus)

    const backendHint = document.createElement('p')
    backendHint.className = 'dsh-gui-settings-hint'
    panel.appendChild(backendHint)

    const backendApply = document.createElement('button')
    backendApply.type = 'button'
    backendApply.className = 'dsh-gui-settings-apply'
    backendApply.textContent = copy.backendApply
    backendApply.disabled = true
    panel.appendChild(backendApply)

    function backendSyncControls() {
      const wsl = modeSelect.value === 'wsl'
      distroInput.disabled = !wsl || !backendLoaded
      deployInput.disabled = !wsl || !backendLoaded
      backendApply.disabled = !backendLoaded
    }

    function backendStatusText(state) {
      if (!backendSaved) return ''
      const mode = String(modeSelect.value)
      if (mode === 'wsl' && state && state.wslAvailable === false) {
        return copy.backendUnavailable.slice(0, -2)
      }
      if (mode === 'wsl' && state && state.linuxPayloadBundled === false) {
        return copy.backendFallback
      }
      if (mode === 'wsl') return copy.backendReady
      return copy.backendNativeHint
    }

    modeSelect.addEventListener('change', function () {
      backendSyncControls()
      backendStatus.textContent = backendStatusText({})
      backendHint.textContent = modeSelect.value === 'wsl' ? copy.backendWslHint : copy.backendNativeHint
    })

    backendApply.addEventListener('click', function () {
      if (backendApply.disabled) return
      if (!window.confirm(copy.backendWarn)) return
      backendApply.disabled = true
      backendStatus.textContent = copy.applying
      tauriInvoke('set_backend_settings', {
        mode: modeSelect.value,
        distro: distroInput.value.trim(),
        deployDir: deployInput.value.trim() || '~/.local/share/dsh-desktop/backend',
      })
        .then(function (result) {
          backendStatus.textContent = copy.backendSaved
          backendStatus.dataset.restart = '1'
          return tauriInvoke('restart_backend')
        })
        .then(function () {
          if (panel.isConnected) {
            backendStatus.textContent = copy.backendSaved
            backendApply.disabled = false
          }
        })
        .catch(function (error) {
          if (!panel.isConnected) return
          backendStatus.textContent =
            copy.backendError + String((error && error.message) || error || '')
          backendApply.disabled = false
        })
    })

    tauriInvoke('get_backend_settings').then(function (state) {
      if (!panel.isConnected || !state) return
      backendSaved = state.saved || {}
      backendLoaded = true
      modeSelect.value = backendSaved.mode === 'wsl' ? 'wsl' : 'native'
      distroInput.value = String(backendSaved.distro || '')
      deployInput.value = String(backendSaved.deployDir || '~/.local/share/dsh-desktop/backend')
      backendSyncControls()
      backendStatus.textContent = backendStatusText(state)
      backendHint.textContent = modeSelect.value === 'wsl' ? copy.backendWslHint : copy.backendNativeHint
    }, function () {
      if (!panel.isConnected) return
      backendStatus.textContent = copy.backendError + 'get_backend_settings'
    })

    // —— 系统通知 / 音效：三个通道沿用 opencode 的语义（agent=回合完成、
    // permissions=审批/提问、errors=出错），偏好由 notify.js 消费；音效资源
    // 由 audio.js 以 data URI 内嵌，选择即试听。
    const notifyHeading = document.createElement('div')
    notifyHeading.className = 'dsh-gui-settings-title'
    notifyHeading.textContent = copy.notifySection
    panel.appendChild(notifyHeading)

    function checkChannelRow(labelText, hintText, checked, onChange) {
      const row = document.createElement('div')
      row.className = 'dsh-gui-settings-row'
      const label = document.createElement('label')
      label.className = 'dsh-gui-settings-check'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = Boolean(checked)
      box.setAttribute('aria-label', labelText)
      box.addEventListener('change', function () {
        onChange(box.checked)
      })
      const name = document.createElement('span')
      name.textContent = labelText
      label.appendChild(box)
      label.appendChild(name)
      const hint = document.createElement('p')
      hint.className = 'dsh-gui-settings-hint'
      hint.textContent = hintText
      row.appendChild(label)
      row.appendChild(hint)
      return row
    }

    for (const channel of NOTIFY_CHANNELS) {
      panel.appendChild(checkChannelRow(
        copy[channel.copy],
        copy[channel.copy + 'Hint'],
        currentNotify.notifications[channel.key],
        function (checked) {
          const next = clonePrefs(currentNotify)
          next.notifications[channel.key] = checked
          persistNotify(next)
        },
      ))
    }

    const soundHeading = document.createElement('div')
    soundHeading.className = 'dsh-gui-settings-title'
    soundHeading.textContent = copy.soundSection
    panel.appendChild(soundHeading)

    function soundOptionLabel(group, index) {
      const number = String(index).padStart(2, '0')
      const base = group.zh || group.en
      return base + ' ' + number
    }

    function soundChoices() {
      const choices = [{ value: '', label: copy.soundNone }]
      for (const group of SOUND_GROUPS) {
        for (let n = 1; n <= group.count; n += 1) {
          const value = group.prefix + String(n).padStart(2, '0')
          choices.push({ value: value, label: soundOptionLabel(group, n) })
        }
      }
      return choices
    }

    const soundChoicesCache = soundChoices()

    function soundSelectRow(key, labelText, hintText) {
      const row = document.createElement('div')
      row.className = 'dsh-gui-settings-row'
      const label = document.createElement('div')
      label.className = 'dsh-gui-settings-label'
      label.textContent = labelText
      const select = document.createElement('select')
      select.className = 'dsh-gui-settings-select'
      select.setAttribute('aria-label', labelText)
      for (const choice of soundChoicesCache) {
        const option = document.createElement('option')
        option.value = choice.value
        option.textContent = choice.label
        select.appendChild(option)
      }
      const enabled = Boolean(currentNotify.sounds[key + 'Enabled'])
      const current = String(currentNotify.sounds[key] || '')
      select.value = enabled && current ? current : ''
      select.addEventListener('change', function () {
        const next = clonePrefs(currentNotify)
        if (select.value === '') {
          // 选「无」= 关闭该通道（保留记忆的音效，重新勾选时恢复）。
          next.sounds[key + 'Enabled'] = false
        } else {
          next.sounds[key + 'Enabled'] = true
          next.sounds[key] = select.value
          previewSound(select.value)
        }
        persistNotify(next)
      })
      const hint = document.createElement('p')
      hint.className = 'dsh-gui-settings-hint'
      hint.textContent = hintText
      row.appendChild(label)
      row.appendChild(select)
      row.appendChild(hint)
      return row
    }

    for (const channel of SOUND_CHANNELS) {
      panel.appendChild(soundSelectRow(
        channel.key,
        copy[channel.copy],
        copy[channel.copy + 'Hint'],
      ))
    }

    const list = document.createElement('datalist')
    list.id = FONT_LIST_ID
    panel.appendChild(list)
    loadFontFamilies(function (families) {
      if (list.isConnected) fillFontList(list, families)
    })

    function fontRow(key, labelText) {
      const row = document.createElement('div')
      row.className = 'dsh-gui-settings-row'
      const label = document.createElement('label')
      label.className = 'dsh-gui-settings-label'
      label.textContent = labelText
      const input = document.createElement('input')
      input.type = 'text'
      input.setAttribute('list', FONT_LIST_ID)
      input.setAttribute('spellcheck', 'false')
      input.setAttribute('autocomplete', 'off')
      input.setAttribute('aria-label', labelText)
      input.placeholder = copy.placeholder
      input.value = currentFonts[key] || ''
      if (currentFonts[key]) input.style.fontFamily = JSON.stringify(currentFonts[key])
      bindFontInput(input, key)
      row.appendChild(label)
      row.appendChild(input)
      return row
    }

    panel.appendChild(fontRow('en', copy.fontEn))
    panel.appendChild(fontRow('zh', copy.fontZh))
    panel.appendChild(fontRow('code', copy.fontCode))

    const fontHint = document.createElement('p')
    fontHint.className = 'dsh-gui-settings-hint'
    fontHint.textContent = copy.fontHint
    panel.appendChild(fontHint)

    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'dsh-gui-settings-reset'
    reset.textContent = copy.reset
    reset.addEventListener('click', function () {
      persistFonts({ en: '', zh: '', code: '' })
      applyFonts(currentFonts)
      // 只清字体输入框；面板里的其它文本输入（如网络代理地址）不能被顺手清空。
      const inputs = panel.querySelectorAll('input[type=text][list="' + FONT_LIST_ID + '"]')
      for (let i = 0; i < inputs.length; i += 1) {
        inputs[i].value = ''
        inputs[i].style.fontFamily = ''
      }
    })
    panel.appendChild(reset)

    // —— 网络代理：wrapper 层偏好，保存到 %APPDATA%\dsh-desktop\settings.json。
    // 保存的值只在 spawn 后端时作为启动环境注入；dsh ≥ 0.1.5 自己从启动环境
    // 解析代理策略并在任何插件挂载前装为 undici 全局 dispatcher
    // （@deepseek-ai/dsh-http-proxy），因此保存后需重启后端才会被读取。只影响
    // 本应用及其子进程（插件 / session / 工具调用），不写系统全局环境。
    const proxyHeading = document.createElement('div')
    proxyHeading.className = 'dsh-gui-settings-title'
    proxyHeading.textContent = copy.proxyTitle
    panel.appendChild(proxyHeading)

    let proxySaved = null
    let proxyActiveUrl = null
    let proxyRestartRequired = false
    let proxyRestarting = false
    let proxyLoaded = false

    const enableRow = document.createElement('div')
    enableRow.className = 'dsh-gui-settings-row'
    const enableLabel = document.createElement('label')
    enableLabel.className = 'dsh-gui-settings-check'
    const proxyBox = document.createElement('input')
    proxyBox.type = 'checkbox'
    proxyBox.disabled = true
    proxyBox.setAttribute('aria-label', copy.proxyEnable)
    const enableName = document.createElement('span')
    enableName.textContent = copy.proxyEnable
    enableLabel.appendChild(proxyBox)
    enableLabel.appendChild(enableName)
    enableRow.appendChild(enableLabel)
    panel.appendChild(enableRow)

    function proxyTextRow(labelText, placeholderText) {
      const row = document.createElement('div')
      row.className = 'dsh-gui-settings-row'
      const label = document.createElement('div')
      label.className = 'dsh-gui-settings-label'
      label.textContent = labelText
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = placeholderText
      input.setAttribute('spellcheck', 'false')
      input.setAttribute('autocomplete', 'off')
      input.setAttribute('aria-label', labelText)
      input.disabled = true
      row.appendChild(label)
      row.appendChild(input)
      panel.appendChild(row)
      return input
    }

    const proxyUrlInput = proxyTextRow(copy.proxyUrl, 'http://127.0.0.1:7897')
    const proxyBypassInput = proxyTextRow(copy.proxyNoProxy, 'localhost,127.0.0.1,::1')

    const bypassHint = document.createElement('p')
    bypassHint.className = 'dsh-gui-settings-hint'
    bypassHint.textContent = copy.proxyNoProxyHint
    panel.appendChild(bypassHint)

    const proxyStatus = document.createElement('p')
    proxyStatus.className = 'dsh-gui-settings-hint'
    panel.appendChild(proxyStatus)

    const proxyApply = document.createElement('button')
    proxyApply.type = 'button'
    proxyApply.className = 'dsh-gui-settings-apply'
    proxyApply.textContent = copy.proxyApply
    proxyApply.disabled = true
    panel.appendChild(proxyApply)

    const applyWarn = document.createElement('p')
    applyWarn.className = 'dsh-gui-settings-hint'
    applyWarn.textContent = copy.proxyApplyWarn
    panel.appendChild(applyWarn)

    // 只有"已保存但尚未被后端读取"时才出现：dsh 的代理策略每个进程只解析一次。
    const proxyRestart = document.createElement('button')
    proxyRestart.type = 'button'
    proxyRestart.className = 'dsh-gui-settings-apply'
    proxyRestart.textContent = copy.proxyRestart
    proxyRestart.hidden = true
    panel.appendChild(proxyRestart)

    function syncProxyRestart() {
      proxyRestart.hidden = !proxyRestartRequired
      proxyRestart.disabled = !proxyRestartRequired || proxyRestarting
    }

    proxyRestart.addEventListener('click', function () {
      if (proxyRestart.disabled) return
      proxyRestarting = true
      syncProxyRestart()
      proxyStatus.textContent = copy.backendSaved
      tauriInvoke('restart_backend')
        .then(function () {
          proxyRestarting = false
          return tauriInvoke('get_proxy_settings')
        })
        .then(function (state) {
          if (panel.isConnected && state) {
            proxySaved = state.saved || {}
            proxyActiveUrl = state.activeUrl || null
            proxyRestartRequired = Boolean(state.restartRequired)
            proxyStatus.textContent = proxyStatusText()
          }
          syncProxyRestart()
        })
        .catch(function (error) {
          proxyRestarting = false
          proxyStatus.textContent =
            copy.proxyError + String((error && error.message) || error || '')
          syncProxyRestart()
        })
    })

    function syncProxyControls() {
      const on = proxyBox.checked
      proxyUrlInput.disabled = !on || !proxyLoaded
      proxyBypassInput.disabled = !on || !proxyLoaded
      proxyApply.disabled = !proxyLoaded
    }

    function proxyStatusText() {
      if (!proxyLoaded) return ''
      if (proxyRestartRequired) return copy.proxyRestartHint
      if (proxyActiveUrl) return copy.proxyActiveOn.replace('%s', proxyActiveUrl)
      if (proxySaved && proxySaved.enabled) return copy.proxyPending
      return copy.proxyOff
    }

    proxyBox.addEventListener('change', syncProxyControls)

    proxyApply.addEventListener('click', function () {
      if (proxyApply.disabled) return
      proxyApply.disabled = true
      proxyStatus.textContent = copy.applying
      tauriInvoke('set_proxy_settings', {
        enabled: proxyBox.checked,
        url: proxyUrlInput.value.trim(),
        noProxy: proxyBypassInput.value.trim(),
      })
        .then(function () {
          // 保存只落盘；回读一次让状态行反映"是否待重启生效"。
          return tauriInvoke('get_proxy_settings')
        })
        .then(function (state) {
          if (panel.isConnected && state) {
            proxySaved = state.saved || {}
            proxyActiveUrl = state.activeUrl || null
            proxyRestartRequired = Boolean(state.restartRequired)
            proxyStatus.textContent = proxyStatusText()
          }
          proxyApply.disabled = false
          syncProxyRestart()
        })
        .catch(function (error) {
          proxyStatus.textContent =
            copy.proxyError + String((error && error.message) || error || '')
          proxyApply.disabled = false
        })
    })

    tauriInvoke('get_proxy_settings').then(function (state) {
      if (!panel.isConnected || !state) return
      proxySaved = state.saved || {}
      proxyActiveUrl = state.activeUrl || null
      proxyRestartRequired = Boolean(state.restartRequired)
      proxyLoaded = true
      proxyBox.checked = Boolean(proxySaved.enabled)
      proxyUrlInput.value = String(proxySaved.url || '')
      proxyBypassInput.value = String(proxySaved.noProxy || '')
      syncProxyControls()
      syncProxyRestart()
      proxyStatus.textContent = proxyStatusText()
    }, function () {
      if (!panel.isConnected) return
      proxyStatus.textContent = copy.proxyError + 'get_proxy_settings'
    })

    return panel
  }

  function syncSettingsPanel() {
    const dialog = findAppDialog()
    let existing = document.getElementById(SETTINGS_PANEL_ID)
    if (!dialog || !isGeneralSettings(dialog)) {
      if (existing) {
        existing.remove()
        tintSlider = null
        tintValueLabel = null
      }
      return
    }
    const host = findGeneralSectionHost(dialog)
    if (!host) return
    if (existing && !dialog.contains(existing)) {
      existing.remove()
      tintSlider = null
      tintValueLabel = null
      existing = null
    }
    const panel = existing || createSettingsPanel(dialog)
    if (panel.parentElement !== host || host.lastElementChild !== panel) {
      host.appendChild(panel)
    }
  }

  function scheduleSettingsSync() {
    if (settingsSyncRaf) return
    settingsSyncRaf = requestAnimationFrame(function () {
      settingsSyncRaf = 0
      syncSettingsPanel()
    })
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
    for (const stacked of document.elementsFromPoint(x, y)) {
      if (stacked.id === TITLEBAR_ID || stacked.id === SETTINGS_PANEL_ID) continue
      const stackedColor = parseColor(getComputedStyle(stacked).backgroundColor)
      if (!stackedColor) continue
      if (stackedColor.a >= 0.95) return getComputedStyle(stacked).backgroundColor
      if (stacked.hasAttribute('data-dsh-frosted-sidebar')) {
        return 'rgb(' + stackedColor.r + ', ' + stackedColor.g + ', ' + stackedColor.b + ')'
      }
    }
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
   * Locate the sidebar by geometry, not paint. Upstream often leaves the
   * outer column wrapper transparent and stacks shorter solid slabs inside
   * it — requiring an opaque background made findSidebar miss the column
   * entirely, which then painted the whole titlebar white and left the
   * sidebar solid. Prefer the currently marked column while it still fits.
   */
  function sidebarRectFits(rect) {
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth
    const maxWidth = Math.min(420, viewportWidth * 0.45)
    if (rect.left > 4) return false
    if (rect.top > TITLEBAR_HEIGHT + 48) return false
    if (rect.width < 48 || rect.width >= maxWidth) return false
    if (rect.height < viewportHeight * 0.55) return false
    if (rect.bottom < viewportHeight - 160) return false
    return true
  }

  function findSidebar(root) {
    if (observedSidebar && observedSidebar.isConnected && root.contains(observedSidebar)) {
      if (sidebarRectFits(observedSidebar.getBoundingClientRect())) return observedSidebar
    }
    const marked = root.querySelector('[data-dsh-frosted-sidebar]')
    if (marked && sidebarRectFits(marked.getBoundingClientRect())) return marked
    const candidates = []
    const elements = root.querySelectorAll('*')
    for (const element of elements) {
      const rect = element.getBoundingClientRect()
      if (!sidebarRectFits(rect)) continue
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

  function markSidebarAncestors(root, sidebar) {
    const keep = new Set()
    if (sidebar) {
      let node = sidebar.parentElement
      while (node && node !== document.body && node !== document.documentElement) {
        if (node === root) break
        node.setAttribute('data-dsh-frosted-frame', '')
        keep.add(node)
        node = node.parentElement
      }
    }
    const stale = document.querySelectorAll('[data-dsh-frosted-frame]')
    for (const element of stale) {
      if (!keep.has(element)) element.removeAttribute('data-dsh-frosted-frame')
    }
  }

  function markOpaqueSurfaces() {
    const keep = new Set()
    const dialogs = document.querySelectorAll('[aria-modal="true"], [role="dialog"]')
    for (const dialog of dialogs) {
      if (dialog.id === SETTINGS_PANEL_ID) continue
      keep.add(dialog)
      dialog.setAttribute('data-dsh-opaque-surface', '')
      let node = dialog.parentElement
      while (node && node !== document.body && node !== document.documentElement) {
        const style = getComputedStyle(node)
        if (style.position === 'fixed' || style.position === 'absolute') {
          node.setAttribute('data-dsh-opaque-surface', '')
          keep.add(node)
          break
        }
        node = node.parentElement
      }
    }
    const panel = document.getElementById(SETTINGS_PANEL_ID)
    if (panel) keep.add(panel)
    const stale = document.querySelectorAll('[data-dsh-opaque-surface]')
    for (const element of stale) {
      if (!keep.has(element)) element.removeAttribute('data-dsh-opaque-surface')
    }
  }

  function isAppModalOpen() {
    return findAppDialog() !== null
  }

  function paintAcrylicSegment(element, maskColor) {
    if (!element) return
    if (maskColor) {
      element.style.background =
        'linear-gradient(' + maskColor + ', ' + maskColor + '), var(--dsh-gui-sidebar-tint)'
    } else {
      element.style.background = ''
    }
  }

  /**
   * Detect a modal mask dimming the app below the titlebar: a translucent
   * element covering (nearly) the whole viewport at the strip's bottom edge.
   * Returns its translucent color for layering, or null.
   */
  function findMaskColor() {
    const probes = [0.08, 0.5, 0.92]
    for (const fraction of probes) {
      let element = document.elementFromPoint(
        Math.round(window.innerWidth * fraction), TITLEBAR_HEIGHT + 8)
      while (element && element !== document.body) {
        if (element.id === TITLEBAR_ID) break
        const background = getComputedStyle(element).backgroundColor
        const color = parseColor(background)
        const rect = element.getBoundingClientRect()
        if (color && color.a > 0.03 && color.a < 0.9 &&
            rect.left <= 2 && rect.top <= TITLEBAR_HEIGHT + 2 &&
            rect.width >= window.innerWidth * 0.9 &&
            rect.height >= (window.innerHeight - TITLEBAR_HEIGHT) * 0.9) {
          return background
        }
        element = element.parentElement
      }
    }
    return null
  }

  /**
   * Paint one titlebar part: the sampled/base color, with the modal mask
   * layered on top when a dialog dims the app — an undimmed strip over a
   * dimmed UI reads as a foreign band.
   */
  function paintSegment(element, sampled, fallbackToken, maskColor) {
    if (!element) return
    if (maskColor) {
      element.style.background =
        'linear-gradient(' + maskColor + ', ' + maskColor + '), ' + (sampled || fallbackToken)
    } else {
      element.style.background = sampled || ''
    }
  }

  let frostTimer = null
  let trailingTimer = null
  let resizeObserver = null
  let observedSidebar = null
  let maskApplied = false

  function frostSurfaces() {
    const root = document.getElementById('root')
    if (!root) return
    const sidebar = findSidebar(root)
    const stale = root.querySelectorAll('[data-dsh-frosted-sidebar]')
    for (const element of stale) {
      if (element !== sidebar) element.removeAttribute('data-dsh-frosted-sidebar')
    }
    if (sidebar) sidebar.setAttribute('data-dsh-frosted-sidebar', '')
    markSidebarAncestors(root, sidebar)
    markOpaqueSurfaces()
    if (typeof ResizeObserver === 'function' && observedSidebar !== sidebar) {
      if (resizeObserver) resizeObserver.disconnect()
      resizeObserver = null
      observedSidebar = sidebar
      if (sidebar) {
        resizeObserver = new ResizeObserver(frostBurst)
        resizeObserver.observe(sidebar)
      }
    } else {
      observedSidebar = sidebar
    }
    const sidebarWidth = sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0
    document.documentElement.style.setProperty('--dsh-gui-sidebar-width', sidebarWidth + 'px')
    const modalOpen = isAppModalOpen()
    if (document.documentElement) {
      if (modalOpen) document.documentElement.setAttribute('data-dsh-gui-modal', '')
      else document.documentElement.removeAttribute('data-dsh-gui-modal')
    }
    if (modalOpen) scheduleSettingsSync()
    const sampleY = TITLEBAR_HEIGHT + 16
    const columnColor = sampleSurfaceColor(
      Math.min((modalOpen ? 0 : sidebarWidth) + 24, window.innerWidth - 160), sampleY)
    const maskColor = findMaskColor()
    maskApplied = maskColor !== null
    if (sidebarSegment) sidebarSegment.style.width = modalOpen ? '0px' : sidebarWidth + 'px'
    if (modalOpen) {
      paintSegment(sidebarSegment, columnColor, COLUMN_FALLBACK, maskColor)
    } else {
      paintAcrylicSegment(sidebarSegment, maskColor)
    }
    paintSegment(columnSegment, columnColor, COLUMN_FALLBACK, maskColor)
    paintSegment(controlsElement, columnColor, COLUMN_FALLBACK, maskColor)
  }

  function scheduleFrost(delay) {
    if (frostTimer !== null) return
    frostTimer = setTimeout(function () {
      frostTimer = null
      frostSurfaces()
    }, delay || 250)
  }

  function scheduleTrailing() {
    if (trailingTimer !== null) return
    trailingTimer = setTimeout(function () {
      trailingTimer = null
      frostSurfaces()
      setTimeout(frostSurfaces, 250)
      setTimeout(frostSurfaces, 700)
    }, 150)
  }

  function frostBurst() {
    frostSurfaces()
    scheduleTrailing()
  }

  function mutationTouchesSettings(mutation) {
    if (mutation.target && mutation.target.id === SETTINGS_PANEL_ID) return false
    if (mutation.target && mutation.target.closest && mutation.target.closest('#' + SETTINGS_PANEL_ID)) {
      return false
    }
    const dialog = findAppDialog()
    if (!dialog) return false
    const target = mutation.target
    if (target && (target === dialog || dialog.contains(target))) return true
    for (let i = 0; i < mutation.addedNodes.length; i += 1) {
      const node = mutation.addedNodes[i]
      if (node.nodeType !== 1) continue
      if (node === dialog || dialog.contains(node)) return true
      if (node.contains && node.contains(dialog)) return true
    }
    return false
  }

  function watchSurfaces() {
    const root = document.getElementById('root')
    if (!root || watching) return
    watching = true
    window.addEventListener('resize', frostBurst)
    document.addEventListener('click', function (event) {
      if (!observedSidebar) return
      if (event.clientX <= observedSidebar.getBoundingClientRect().right + 8) frostBurst()
    }, true)
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(function (mutations) {
        let shellChanged = false
        let settingsChanged = false
        for (let i = 0; i < mutations.length; i += 1) {
          const mutation = mutations[i]
          if (mutation.target === root || mutation.target.parentElement === root) {
            shellChanged = true
          }
          if (maskApplied && mutation.removedNodes.length > 0) shellChanged = true
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue
            if (node.id === TITLEBAR_ID || node.id === SETTINGS_PANEL_ID) continue
            if (node.parentElement === root) shellChanged = true
            const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0 }
            if (rect.width >= window.innerWidth * 0.6 &&
                rect.height >= window.innerHeight * 0.6) shellChanged = true
          }
          if (mutationTouchesSettings(mutation)) settingsChanged = true
        }
        if (shellChanged) frostBurst()
        else if (settingsChanged) scheduleSettingsSync()
      })
      observer.observe(root, { childList: true, subtree: true })
      const bodyObserver = new MutationObserver(frostBurst)
      bodyObserver.observe(document.body, { childList: true })
      const themeObserver = new MutationObserver(frostBurst)
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme'],
      })
    }
  }

  function startAppChrome() {
    if (isStartupSurface()) return
    if (!document.getElementById('root')) return false
    markStartupSurface()
    scheduleFrost(300)
    scheduleFrost(1200)
    scheduleFrost(3000)
    watchSurfaces()
    return true
  }

  function boot() {
    currentTint = readStoredTint()
    currentFonts = readStoredFonts()
    currentNotify = readStoredNotify()
    applyStyles()
    applyTint(currentTint)
    applyFonts(currentFonts)
    mount()
    if (isStartupSurface()) return
    if (startAppChrome()) return
    if (typeof MutationObserver !== 'function') return
    const observer = new MutationObserver(function () {
      if (startAppChrome()) observer.disconnect()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
