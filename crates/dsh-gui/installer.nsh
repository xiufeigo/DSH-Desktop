; DSH Desktop NSIS hooks (tauri-bundler installerHooks).
;
; 已安装页默认覆盖安装、不推荐先卸载：见 installer.nsi 与 languages/*.nsh。
;
; 覆盖安装前若 DSH Desktop / payload\node.exe 仍在运行，文件会被锁住。
; Tauri 自带的 CheckIfAppIsRunning 只 TerminateProcess 主程序、等 500ms，
; 后台 node 经常成孤儿，随后拷贝 payload 就报「打开文件写入时出错」。
; 这里先提示，用户点确定后结束整棵进程树（含 $INSTDIR 下残留进程），
; 等锁释放再继续。
;
; 注意：这里刻意不再做任何 PATH 写入 —— 早期版本曾因 NSIS 的字符串
; 长度上限损坏过用户的长 PATH（写入前读取被截断），该功能已永久移除。
;
; 卸载侧用一次性递归删除兜底：tauri 模板的逐文件 Delete 在部分嵌套
; 依赖路径（如 @deepseek-ai/*/node_modules/commander）上会静默失手，
; 残留整个 payload 树；这里先整体清掉，模板后续的逐条 Delete 与
; RMDir $INSTDIR 自然全部成功。
;
; 逻辑放在宏里（在 Section 里展开），以便用到 installer.nsi 里后声明的
; $PassiveMode。安装/卸载各插入一次，用 ${__LINE__} 区分标签。

!macro DshInstallFilesLocked
  StrCpy $R4 0
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ClearErrors
    FileOpen $R7 "$INSTDIR\${MAINBINARYNAME}.exe" a
    ${If} ${Errors}
      StrCpy $R4 1
    ${Else}
      FileClose $R7
    ${EndIf}
  ${EndIf}
  ${If} $R4 = 0
  ${AndIf} ${FileExists} "$INSTDIR\payload\node\node.exe"
    ClearErrors
    FileOpen $R7 "$INSTDIR\payload\node\node.exe" a
    ${If} ${Errors}
      StrCpy $R4 1
    ${Else}
      FileClose $R7
    ${EndIf}
  ${EndIf}
!macroend

!macro DshFindMainAppRunning
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  !else
    nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
  !endif
  Pop $R0
!macroend

!macro DshKillRunningTree
  ; /T 会带上 node 子进程；旧版没有 Job Object 时尤其需要。
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${MAINBINARYNAME}.exe"'
  Pop $R0
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  !else
    nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"
  !endif
  Pop $R0

  ; 再清掉 $INSTDIR 下仍占着文件的残留进程（孤儿 node 等）。
  InitPluginsDir
  StrCpy $R9 "$PLUGINSDIR\dsh-close-running.ps1"
  FileOpen $R8 $R9 w
  FileWrite $R8 "param([string]$$Root)$\r$\n"
  FileWrite $R8 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R8 "if (-not $$Root) { return }$\r$\n"
  FileWrite $R8 "$$Root = [IO.Path]::GetFullPath($$Root)$\r$\n"
  FileWrite $R8 "Get-CimInstance Win32_Process | ForEach-Object {$\r$\n"
  FileWrite $R8 "  $$p = $$_.ExecutablePath$\r$\n"
  FileWrite $R8 "  if ($$p -and $$p.StartsWith($$Root, $$true, [Globalization.CultureInfo]::InvariantCulture)) {$\r$\n"
  FileWrite $R8 "    Stop-Process -Id $$_.ProcessId -Force$\r$\n"
  FileWrite $R8 "  }$\r$\n"
  FileWrite $R8 "}$\r$\n"
  FileClose $R8
  nsExec::Exec '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$R9" -Root "$INSTDIR"'
  Pop $R0
!macroend

!macro DshCloseRunningApp
  !define DSH_CLOSE_UID ${__LINE__}
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R7
  Push $R8
  Push $R9

  nsis_tauri_utils::StrReplace "$(appRunning)" "{{product_name}}" "${PRODUCTNAME}"
  Pop $R1
  nsis_tauri_utils::StrReplace "$(appRunningOkKill)" "{{product_name}}" "${PRODUCTNAME}"
  Pop $R2
  nsis_tauri_utils::StrReplace "$(failedToKillApp)" "{{product_name}}" "${PRODUCTNAME}"
  Pop $R3

detect_${DSH_CLOSE_UID}:
  !insertmacro DshFindMainAppRunning
  !insertmacro DshInstallFilesLocked
  ${If} $R0 != 0
  ${AndIf} $R4 = 0
    Goto done_${DSH_CLOSE_UID}
  ${EndIf}

  IfSilent kill_${DSH_CLOSE_UID} 0
  ${If} $PassiveMode = 1
    Goto kill_${DSH_CLOSE_UID}
  ${EndIf}

  MessageBox MB_OKCANCEL|MB_ICONQUESTION $R2 IDOK kill_${DSH_CLOSE_UID} IDCANCEL cancel_${DSH_CLOSE_UID}

kill_${DSH_CLOSE_UID}:
  DetailPrint "Closing ${PRODUCTNAME}..."
  !insertmacro DshKillRunningTree

  StrCpy $R5 0
wait_${DSH_CLOSE_UID}:
  !insertmacro DshFindMainAppRunning
  !insertmacro DshInstallFilesLocked
  ${If} $R0 != 0
  ${AndIf} $R4 = 0
    Goto done_${DSH_CLOSE_UID}
  ${EndIf}
  IntOp $R5 $R5 + 1
  ${If} $R5 >= 40
    Goto still_running_${DSH_CLOSE_UID}
  ${EndIf}
  Sleep 250
  ${If} $R5 = 8
  ${OrIf} $R5 = 20
    !insertmacro DshKillRunningTree
  ${EndIf}
  Goto wait_${DSH_CLOSE_UID}

still_running_${DSH_CLOSE_UID}:
  IfSilent silent_fail_${DSH_CLOSE_UID} 0
  ${If} $PassiveMode = 1
    Goto silent_fail_${DSH_CLOSE_UID}
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION $R3 IDRETRY kill_${DSH_CLOSE_UID}
  Abort $R1

silent_fail_${DSH_CLOSE_UID}:
  Abort $R1

cancel_${DSH_CLOSE_UID}:
  Abort $R1

done_${DSH_CLOSE_UID}:
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  !undef DSH_CLOSE_UID
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro DshCloseRunningApp
  ; Overlay copy does not remove files that disappeared from the new payload
  ; (a previously nested @deepseek-ai/dsh-web-frontend is the usual leftover).
  ; Node resolves that nested copy first, so the UI boots a mixed frontend
  ; and comes up blank. Wipe payload after the process tree has released
  ; its locks; the following File instructions restage a clean tree.
  RMDir /r "$INSTDIR\payload"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro DshCloseRunningApp
  RMDir /r "$INSTDIR\payload"
!macroend
