/**
 * Desktop session notifications + sound effects, injected by main.rs.
 *
 * Watches the official web UI (without editing @deepseek-ai/*) for:
 *   - pending tool approval: [data-approval-key]
 *   - pending user question / plan review: [data-question-key]
 *   - turn finished: composer "Stop generating" / "停止生成" button gone
 *   - terminal turn failure: conversation TurnErrorItem card (the
 *     [class*="turnErrorTitle"] span). Deliberately NOT tr[data-error]:
 *     those rows also flag recovered tool-call failures, while this marker
 *     appears only for a turn that actually died — retry attempts render a
 *     separate card and stay silent, like opencode's session.error channel.
 *   - max-tokens turn ends use their own title class and don't count as errors
 *
 * Channels mirror opencode's General settings (MIT):
 *   - agent       → turn finished            (notification default on,  sound staplebops-01)
 *   - permissions → approval / question      (notification default on,  sound staplebops-02)
 *   - errors      → errored turn             (notification default off, sound nope-03)
 *
 * Native toasts go through the Tauri command (Web Notification would re-prompt
 * every launch because the origin is http://127.0.0.1:<ephemeral>). Sounds come
 * from audio.js (window.__DSH_GUI_AUDIO__, data URIs) so no extra serving
 * plumbing is involved; WebView2 autoplay is unlocked via additional browser
 * args in main.rs because these events fire without a user gesture.
 *
 * Everything the watcher sees is one rendered frame of ONE session, so the
 * sidebar's active-session text (sessionStamp) scopes all state: on a stamp
 * change pending timers are cancelled, running/dedupe state resets, and
 * whatever is already on screen becomes a silent baseline — switching
 * sessions never fires anything by itself (bugfix: leaving a generating
 * session used to look like "turn finished" because the stop button
 * vanished). Approval/question keys stay remembered per session so toggling
 * away and back does not re-ping for the same card.
 *
 * Prefs live in the same cookie/localStorage pair the Settings → Desktop panel
 * (titlebar.js) writes: `dsh_gui_notify_v2` JSON, migrated from the v1 single
 * switch. Both scripts must agree on the schema — see sanitizePrefs() here and
 * its twin in titlebar.js.
 */
(function () {
  'use strict'

  const COOKIE = 'dsh_gui_notify_v2'
  const STORAGE = 'dsh-gui.notify-v2'
  const LEGACY_COOKIE = 'dsh_gui_notify_v1'
  const LEGACY_STORAGE = 'dsh-gui.notify-v1'
  const STOP_LABELS = ['停止生成', 'Stop generating']
  const COMPLETE_WAIT_MS = 700
  // A single failed turn can surface several cards in one mutation burst
  // (turn error + trailing renders); collapse the burst into a single ping.
  const ERROR_DEBOUNCE_MS = 800

  const DEFAULT_PREFS = freezePrefs({
    notifications: { agent: true, permissions: true, errors: false },
    sounds: {
      agentEnabled: true,
      agent: 'staplebops-01',
      permissionsEnabled: true,
      permissions: 'staplebops-02',
      errorsEnabled: true,
      errors: 'nope-03',
    },
  })

  // 所有信号都是当前渲染出来的 DOM：切会话 = 整个世界换了一帧。watchStamp
  // 记录正在观察的会话；一旦变化就清空运行态/去重基线/待触发定时器，把新
  // 会话屏幕上已有的一切当历史静默基线，绝不补发。
  let watchStamp = ''
  let errorBaseline = 0
  let seenRunning = false
  // 去重 key 按会话记忆：卡片从 DOM 消失不清标记（切走再切回不重发），
  // 同会话出现不同 key 才再次提醒；仅会话切换时重置。
  let lastApproval = ''
  let lastQuestion = ''
  let completeTimer = null
  let completeStamp = ''
  let completeBaseErrors = -1
  let errorTimer = null
  let pollRaf = 0
  let watching = false

  function freezePrefs(prefs) {
    return Object.freeze({
      notifications: Object.freeze({ ...prefs.notifications }),
      sounds: Object.freeze({ ...prefs.sounds }),
    })
  }

  function isStartupSurface() {
    return location.hostname === 'tauri.localhost' || location.protocol === 'tauri:'
  }

  function readCookie(name) {
    const parts = String(document.cookie || '').split(';')
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i].trim()
      if (part.indexOf(name + '=') === 0) return part.slice(name.length + 1)
    }
    return null
  }

  // Keep in sync with the sanitizer in titlebar.js (same schema, no imports).
  function sanitizePrefs(value) {
    const source = value && typeof value === 'object' ? value : {}
    const notifications = source.notifications && typeof source.notifications === 'object' ? source.notifications : {}
    const sounds = source.sounds && typeof source.sounds === 'object' ? source.sounds : {}
    const bool = (input) => (typeof input === 'boolean' ? input : null)
    const id = (input) => {
      if (typeof input !== 'string') return null
      const table = window.__DSH_GUI_AUDIO__
      if (!table || Object.prototype.hasOwnProperty.call(table, input)) return input
      return null
    }
    const out = {
      notifications: {
        agent: bool(notifications.agent),
        permissions: bool(notifications.permissions),
        errors: bool(notifications.errors),
      },
      sounds: {
        agentEnabled: bool(sounds.agentEnabled),
        agent: id(sounds.agent),
        permissionsEnabled: bool(sounds.permissionsEnabled),
        permissions: id(sounds.permissions),
        errorsEnabled: bool(sounds.errorsEnabled),
        errors: id(sounds.errors),
      },
    }
    return fillDefaults(out)
  }

  function fillDefaults(partial) {
    const merged = {
      notifications: {},
      sounds: {},
    }
    for (const key of Object.keys(DEFAULT_PREFS.notifications)) {
      merged.notifications[key] =
        partial.notifications[key] === null ? DEFAULT_PREFS.notifications[key] : partial.notifications[key]
    }
    for (const key of Object.keys(DEFAULT_PREFS.sounds)) {
      merged.sounds[key] = partial.sounds[key] === null ? DEFAULT_PREFS.sounds[key] : partial.sounds[key]
    }
    return freezePrefs(merged)
  }

  function readPrefs() {
    const cookie = readCookie(COOKIE)
    if (cookie) {
      try {
        return sanitizePrefs(JSON.parse(decodeURIComponent(cookie)))
      } catch (_error) {
        /* fall through to other stores */
      }
    }
    try {
      const stored = localStorage.getItem(STORAGE)
      if (stored) return sanitizePrefs(JSON.parse(stored))
    } catch (_error) {
      /* private mode / blocked storage */
    }
    // Migrate the v1 single switch: an explicit opt-out silences every
    // notification channel; sounds stay at their defaults.
    const legacy = readCookie(LEGACY_COOKIE)
    if (legacy === null) {
      try {
        const stored = localStorage.getItem(LEGACY_STORAGE)
        if (stored !== null) return migrateLegacy(stored)
      } catch (_error) {
        /* private mode / blocked storage */
      }
      return DEFAULT_PREFS
    }
    return migrateLegacy(legacy)
  }

  function migrateLegacy(value) {
    if (value === '0') {
      return freezePrefs({
        notifications: { agent: false, permissions: false, errors: false },
        sounds: { ...DEFAULT_PREFS.sounds },
      })
    }
    return DEFAULT_PREFS
  }

  function clip(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  }

  function englishUi() {
    return Boolean(document.querySelector(
      'button[aria-label="Stop generating"], button[aria-label="Send message"]',
    ))
  }

  function titles(kind) {
    if (kind === 'error') {
      return englishUi()
        ? { title: 'Session error', fallback: 'Something went wrong during the turn.' }
        : { title: '会话出错', fallback: '当前回合发生了错误。' }
    }
    if (englishUi()) {
      if (kind === 'approval') return { title: 'Approval needed', fallback: 'A tool is waiting for approval.' }
      if (kind === 'question') return { title: 'Answer needed', fallback: 'The agent is waiting for your reply.' }
      return { title: 'Session finished', fallback: 'The current turn has ended.' }
    }
    if (kind === 'approval') return { title: '需要审批', fallback: '有工具操作在等待你批准。' }
    if (kind === 'question') return { title: '需要你回答', fallback: '智能体在等待你的回复。' }
    return { title: '会话已完成', fallback: '当前回合已经结束。' }
  }

  // kind → opencode-style channel names used by the prefs schema.
  function channelOf(kind) {
    if (kind === 'approval' || kind === 'question') return 'permissions'
    if (kind === 'error') return 'errors'
    return 'agent'
  }

  function playSound(soundId) {
    if (!soundId) return
    const table = window.__DSH_GUI_AUDIO__
    const src = table && Object.prototype.hasOwnProperty.call(table, soundId) ? table[soundId] : null
    if (!src) return
    try {
      const audio = new Audio(src)
      const played = audio.play()
      if (played && typeof played.catch === 'function') played.catch(function () {})
    } catch (_error) {
      /* playback is best-effort */
    }
  }

  function send(kind, body) {
    const prefs = readPrefs()
    const channel = channelOf(kind)
    if (prefs.sounds[channel + 'Enabled']) playSound(prefs.sounds[channel])
    if (!prefs.notifications[channel]) return
    const copy = titles(kind)
    const internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return
    try {
      Promise.resolve(internals.invoke('show_desktop_notification', {
        title: copy.title,
        body: clip(body) || copy.fallback,
      })).catch(function () {})
    } catch (_error) {
      /* notifications are best-effort */
    }
  }

  function isGenerating() {
    for (let i = 0; i < STOP_LABELS.length; i += 1) {
      if (document.querySelector('button[aria-label="' + STOP_LABELS[i] + '"]')) return true
    }
    return false
  }

  function sessionStamp() {
    const root = document.getElementById('root')
    if (!root) return ''
    const marked = root.querySelector('[aria-current="true"], [aria-current="page"]')
    if (marked && !marked.closest('[role="dialog"], [aria-modal="true"]')) {
      return clip(marked.textContent).slice(0, 80)
    }
    return ''
  }

  // Terminal turn failures render a TurnErrorItem card whose title span is
  // unique to that component (the max-tokens notice uses maxTokensTitle).
  function errorRowCount() {
    return document.querySelectorAll('[class*="turnErrorTitle"]').length
  }

  function latestErrorText() {
    const cards = document.querySelectorAll('[class*="turnErrorTitle"]')
    const last = cards.length ? cards[cards.length - 1] : null
    const copy = last && last.parentElement
    return copy ? clip(copy.textContent) : ''
  }

  function queueError() {
    if (errorTimer !== null) return
    errorTimer = setTimeout(function () {
      errorTimer = null
      // 定时器只在同会话内存活（切会话即取消）；期间卡片消失（如历史
      // 重载）就安静放弃。
      if (errorRowCount() === 0) return
      if (completeTimer !== null) {
        clearTimeout(completeTimer)
        completeTimer = null
      }
      send('error', latestErrorText())
    }, ERROR_DEBOUNCE_MS)
  }

  function readState() {
    const approval = document.querySelector('[data-approval-key]')
    const question = document.querySelector('[data-question-key]')
    const approvalKey = approval ? String(approval.getAttribute('data-approval-key') || '') : ''
    const questionKey = question ? String(question.getAttribute('data-question-key') || '') : ''
    const questionTitle = question && question.querySelector('h2')
    return {
      running: isGenerating(),
      approvalKey: approvalKey,
      approvalBody: approval ? clip(approval.textContent) : '',
      questionKey: questionKey,
      questionBody: questionTitle ? clip(questionTitle.textContent) : (question ? clip(question.textContent) : ''),
      stamp: sessionStamp(),
      errors: errorRowCount(),
    }
  }

  function tick() {
    const state = readState()

    // 会话切换：新会话屏幕上的一切（历史错误卡、旧审批卡）都只是基线，
    // 静默记录后直接返回，等下一帧再开始观察——切换本身绝不触发任何提醒。
    // 唯一带过桥的状态是新会话"正在生成"：切入后它结束时仍要报完成。
    if (state.stamp !== watchStamp) {
      watchStamp = state.stamp
      errorBaseline = state.errors
      seenRunning = state.running === true
      lastApproval = ''
      lastQuestion = ''
      if (completeTimer !== null) {
        clearTimeout(completeTimer)
        completeTimer = null
      }
      if (errorTimer !== null) {
        clearTimeout(errorTimer)
        errorTimer = null
      }
      return
    }

    // 终态回合失败：同一会话内出现新的 TurnErrorItem 卡片才提醒。
    if (state.errors > errorBaseline) {
      errorBaseline = state.errors
      queueError()
    }

    if (state.approvalKey && state.approvalKey !== lastApproval) {
      lastApproval = state.approvalKey
      if (completeTimer !== null) {
        clearTimeout(completeTimer)
        completeTimer = null
      }
      send('approval', state.approvalBody)
    }

    if (state.questionKey && state.questionKey !== lastQuestion) {
      lastQuestion = state.questionKey
      if (completeTimer !== null) {
        clearTimeout(completeTimer)
        completeTimer = null
      }
      send('question', state.questionBody)
    }

    if (state.running) {
      seenRunning = true
      if (completeTimer !== null) {
        clearTimeout(completeTimer)
        completeTimer = null
      }
      return
    }

    if (!seenRunning) return
    seenRunning = false
    completeStamp = state.stamp
    completeBaseErrors = state.errors
    if (completeTimer !== null) clearTimeout(completeTimer)
    completeTimer = setTimeout(function () {
      completeTimer = null
      const later = readState()
      // 定时器只在同会话内存活（切换时已取消），这里仅防按钮闪断。
      if (later.running) {
        seenRunning = true
        return
      }
      if (later.approvalKey || later.questionKey) return
      // The turn ended with a failure: the errors channel already pinged.
      if (later.errors > completeBaseErrors) return
      if (completeStamp && later.stamp && later.stamp !== completeStamp) return
      send('complete', later.stamp)
    }, COMPLETE_WAIT_MS)
  }

  function scheduleTick() {
    if (pollRaf) return
    pollRaf = requestAnimationFrame(function () {
      pollRaf = 0
      tick()
    })
  }

  function start() {
    if (isStartupSurface()) return true
    if (watching) return true
    const root = document.getElementById('root')
    if (!root || typeof MutationObserver !== 'function') return false
    watching = true
    const observer = new MutationObserver(scheduleTick)
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-approval-key', 'data-question-key'],
    })
    tick()
    return true
  }

  function boot() {
    if (isStartupSurface()) return
    if (start()) return
    if (typeof MutationObserver !== 'function') return
    const observer = new MutationObserver(function () {
      if (document.getElementById('root')) {
        observer.disconnect()
        start()
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
