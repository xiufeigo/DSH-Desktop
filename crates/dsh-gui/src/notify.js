/**
 * Desktop session notifications, injected by main.rs.
 *
 * Watches the official web UI (without editing @deepseek-ai/*) for:
 *   - pending tool approval: [data-approval-key]
 *   - pending user question / plan review: [data-question-key]
 *   - turn finished: composer "Stop generating" / "停止生成" button gone
 * Native toasts go through the Tauri command (Web Notification would re-prompt
 * every launch because the origin is http://127.0.0.1:<ephemeral>). Pref lives
 * in the same cookie/storage as Settings → Desktop.
 */
(function () {
  'use strict'

  const COOKIE = 'dsh_gui_notify_v1'
  const STORAGE = 'dsh-gui.notify-v1'
  const STOP_LABELS = ['停止生成', 'Stop generating']
  const COMPLETE_WAIT_MS = 700

  let seenRunning = false
  let lastApproval = ''
  let lastQuestion = ''
  let completeTimer = null
  let completeStamp = ''
  let pollRaf = 0
  let watching = false

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

  function notifyEnabled() {
    const cookie = readCookie(COOKIE)
    if (cookie === '0') return false
    if (cookie === '1') return true
    try {
      const stored = localStorage.getItem(STORAGE)
      if (stored === '0') return false
      if (stored === '1') return true
    } catch (_error) {
      /* private mode / blocked storage */
    }
    return true
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
    if (englishUi()) {
      if (kind === 'approval') return { title: 'Approval needed', fallback: 'A tool is waiting for approval.' }
      if (kind === 'question') return { title: 'Answer needed', fallback: 'The agent is waiting for your reply.' }
      return { title: 'Session finished', fallback: 'The current turn has ended.' }
    }
    if (kind === 'approval') return { title: '需要审批', fallback: '有工具操作在等待你批准。' }
    if (kind === 'question') return { title: '需要你回答', fallback: '智能体在等待你的回复。' }
    return { title: '会话已完成', fallback: '当前回合已经结束。' }
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

  function send(kind, body) {
    if (!notifyEnabled()) return
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
    }
  }

  function tick() {
    const state = readState()
    if (state.approvalKey && state.approvalKey !== lastApproval) {
      lastApproval = state.approvalKey
      if (completeTimer !== null) {
        clearTimeout(completeTimer)
        completeTimer = null
      }
      send('approval', state.approvalBody)
    } else if (!state.approvalKey) {
      lastApproval = ''
    }

    if (state.questionKey && state.questionKey !== lastQuestion) {
      lastQuestion = state.questionKey
      if (completeTimer !== null) {
        clearTimeout(completeTimer)
        completeTimer = null
      }
      send('question', state.questionBody)
    } else if (!state.questionKey) {
      lastQuestion = ''
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
    if (completeTimer !== null) clearTimeout(completeTimer)
    completeTimer = setTimeout(function () {
      completeTimer = null
      const later = readState()
      if (later.running) {
        seenRunning = true
        return
      }
      if (later.approvalKey || later.questionKey) return
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
