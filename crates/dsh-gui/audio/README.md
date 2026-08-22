# Notification sound effects

The 45 `*.mp3` alert sounds in this directory are copied from
[opencode](https://github.com/anomalyco/opencode)
(`packages/ui/src/assets/audio`, revision of 2026-02, dev branch).
opencode ships them under the MIT license; DSH Desktop is MIT too, so reuse
is permitted with attribution.

They are bundled by `scripts/make-audio.mjs` into
`crates/dsh-gui/src/audio.js` (base64 `data:` URIs) and played by
`crates/dsh-gui/src/notify.js` / previewed from the Settings → 桌面 panel.
