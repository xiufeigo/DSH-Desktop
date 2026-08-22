(() => {
  const isDshOrigin = location.protocol === 'http:'
    && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
  if (!isDshOrigin) return

  const interactiveSelector = [
    'button:not([disabled])',
    'input:not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    'a[href]:not([aria-disabled="true"])',
    '[contenteditable="true"]',
    '[role="button"]:not([aria-disabled="true"])',
    '[role="tab"]:not([aria-disabled="true"])',
    '[role="textbox"]:not([aria-disabled="true"])',
  ].join(',')
  let reported = false

  const isVisible = (element) => {
    if (element.closest('[inert], [aria-hidden="true"]') !== null) return false
    if (element.getAttribute('aria-disabled') === 'true') return false
    const style = getComputedStyle(element)
    const bounds = element.getBoundingClientRect()
    return bounds.width > 0
      && bounds.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number.parseFloat(style.opacity) > 0
      && style.pointerEvents !== 'none'
  }

  const reportIfInteractive = () => {
    if (reported) return true
    const interactive = [...document.querySelectorAll(interactiveSelector)].find((element) => {
      return element.closest('#dsh-gui-titlebar, #dsh-gui-settings-panel') === null && isVisible(element)
    })
    if (interactive === undefined) return false

    reported = true
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.__TAURI_INTERNALS__.invoke('startup_interactive').catch((error) => {
        console.error('DSH startup trace failed:', error)
      })
    }))
    return true
  }

  const observe = () => {
    if (reportIfInteractive()) return
    const observer = new MutationObserver(() => {
      if (reportIfInteractive()) observer.disconnect()
    })
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled', 'aria-hidden', 'inert'],
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe, { once: true })
  } else {
    observe()
  }
})()
