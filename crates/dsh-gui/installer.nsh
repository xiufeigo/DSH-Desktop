; DSH Desktop NSIS hooks (tauri-bundler installerHooks).
;
; 注意：这里刻意不再做任何 PATH 写入 —— 早期版本曾因 NSIS 的字符串
; 长度上限损坏过用户的长 PATH（写入前读取被截断），该功能已永久移除。
;
; 卸载侧用一次性递归删除兜底：tauri 模板的逐文件 Delete 在部分嵌套
; 依赖路径（如 @deepseek-ai/*/node_modules/commander）上会静默失手，
; 残留整个 payload 树；这里先整体清掉，模板后续的逐条 Delete 与
; RMDir $INSTDIR 自然全部成功。
;
; 单遍编译（安装/卸载同脚本），只定义一个宏、一个函数，无引用告警。

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$INSTDIR\payload"
!macroend
