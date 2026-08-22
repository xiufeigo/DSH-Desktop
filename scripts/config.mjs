/** Shared packaging configuration for DSH Desktop. */

export const APP_ID = 'ai.deepseek.dsh-desktop'
/** Official dsh version plus pack suffix, e.g. 0.1.0-rc.7.1. Bumped by sync-and-bump.mjs. */
export const VERSION = '0.1.1-rc.2.4'

/** Node.js release channel bundled as the sidecar runtime. */
export const NODE_CHANNEL = '24'
/** Distribution bases, tried in order: upstream first, npmmirror as fallback. */
export const NODE_DIST_BASES = [
  'https://nodejs.org/dist',
  'https://npmmirror.com/mirrors/node',
]
