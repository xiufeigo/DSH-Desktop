; DSH Desktop NSIS hooks (tauri-bundler installerHooks):
;   NSIS_HOOK_POSTINSTALL   -> append the install dir to the per-user PATH so
;                              `dsh-cli` in the GUI's payload can be invoked
;   NSIS_HOOK_PREUNINSTALL  -> remove it again before uninstall
; Tauri compiles installer and uninstaller sections in ONE pass, so both
; functions are always referenced — no two-pass guarding needed.

!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "StrFunc.nsh"
${StrStr}
${UnStrRep}

!macro NSIS_HOOK_POSTINSTALL
  Push "$INSTDIR"
  Call AddToPath
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Push "$INSTDIR"
  Call un.RemoveFromPath
!macroend

Function AddToPath
  Exch $0                     ; $0 = install dir
  Push $1
  Push $2
  ReadRegStr $1 HKCU "Environment" "Path"
  ${StrStr} $2 $1 $0
  ${If} $2 == ""
    ${If} $1 == ""
      StrCpy $2 "$0"
    ${Else}
      StrCpy $2 "$1;$0"
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" $2
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function un.RemoveFromPath
  Exch $0                     ; $0 = install dir
  Push $1
  Push $2
  Push $3
  ReadRegStr $1 HKCU "Environment" "Path"
  ${UnStrRep} $2 "$1" ";$0" ""
  ${UnStrRep} $3 "$2" "$0;" ""
  ${If} $3 == $0
    StrCpy $3 ""
  ${EndIf}
  WriteRegExpandStr HKCU "Environment" "Path" $3
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
