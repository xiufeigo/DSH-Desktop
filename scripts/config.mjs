/** Shared packaging configuration for DSH Desktop. */

export const APP_ID = 'ai.deepseek.dsh-desktop'
export const VERSION = '0.1.2'

/** Node.js release channel bundled as the sidecar runtime. */
export const NODE_CHANNEL = '24'
/** Distribution bases, tried in order: upstream first, npmmirror as fallback. */
export const NODE_DIST_BASES = [
  'https://nodejs.org/dist',
  'https://npmmirror.com/mirrors/node',
]
