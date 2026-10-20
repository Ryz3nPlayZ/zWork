; zWork installer hooks (bundle.windows.nsis.installerHooks).
;
; The backend runs as its own process, zwork-backend.exe. The in-app updater
; exits zWork.exe without stopping it, and the stock installer only closes
; zWork.exe, so the old backend kept its file locked and the update stopped
; on "Error opening file for writing ... zwork-backend.exe".

!macro ZWORK_STOP_BACKEND
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::KillProcessCurrentUser "zwork-backend.exe"
  !else
    nsis_tauri_utils::KillProcess "zwork-backend.exe"
  !endif
  Pop $R0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ZWORK_STOP_BACKEND
  ; A backend that zWork respawned while the installer waited on its
  ; "close zWork" prompt can still hold the file. Windows lets a running exe
  ; be renamed but not overwritten, so move the old one aside either way.
  Delete "$INSTDIR\zwork-backend.exe.old"
  IfFileExists "$INSTDIR\zwork-backend.exe" 0 +2
    Rename "$INSTDIR\zwork-backend.exe" "$INSTDIR\zwork-backend.exe.old"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete /REBOOTOK "$INSTDIR\zwork-backend.exe.old"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ZWORK_STOP_BACKEND
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete /REBOOTOK "$INSTDIR\zwork-backend.exe.old"
!macroend
