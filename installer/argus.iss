; Argus v0.1 installer (per A20)
;
; Builds a single Argus-Setup.exe that installs argusd, the Argus desktop app,
; and the argus/workspace CLIs to %LOCALAPPDATA%\Programs\Argus, adds the bin
; directory to the user's PATH, and creates a Start menu shortcut.
;
; Compile with: ISCC.exe installer\argus.iss
;
; Expects build artifacts under dist\ (see ADR A20 §"Lo que la build pipeline
; tiene que producir antes del instalador"):
;   dist\daemon\argusd.exe
;   dist\gui\Argus.exe   (+ Electron resources next to it)
;   dist\cli\argus.exe
;   dist\cli\workspace.exe
;
; Pass the version on the command line:
;   ISCC.exe /DAppVersion=0.1.0 installer\argus.iss

#ifndef AppVersion
  #define AppVersion "0.1.0-dev"
#endif

#define AppName       "Argus"
#define AppPublisher  "Argus"
#define AppExeName    "Argus.exe"
#define AppId         "{{8E2C6E2A-9C7E-4B8F-9D7A-ARGUS010MVP00}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={userpf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
OutputDir=..\dist\installer
OutputBaseFilename=Argus-Setup
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
ChangesEnvironment=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Files]
; Daemon
Source: "..\dist\daemon\argusd.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
; Electron desktop app and its resources (entire dist\gui tree)
Source: "..\dist\gui\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; CLI binary, distributed twice with different filenames (A8 — argv[0] dispatch)
Source: "..\dist\cli\argus.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "..\dist\cli\workspace.exe"; DestDir: "{app}\bin"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Registry]
; Append {app}\bin to the user's PATH (HKCU\Environment) using expandable string
; type so the entry survives env var expansion and stays user-scoped.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}\bin"; \
  Check: NeedsAddPath(ExpandConstant('{app}\bin'))

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  // Pos-based contains check; pad with semicolons to match whole entries only.
  Result := Pos(';' + Lowercase(Param) + ';', ';' + Lowercase(OrigPath) + ';') = 0;
end;

procedure RemoveFromPath(PathToRemove: string);
var
  OrigPath: string;
  NewPath: string;
  P: integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
    exit;

  // Match ";<path>" first, then "<path>;", then "<path>" alone.
  NewPath := OrigPath;
  P := Pos(Lowercase(';' + PathToRemove), Lowercase(NewPath));
  if P > 0 then
    Delete(NewPath, P, Length(PathToRemove) + 1)
  else
  begin
    P := Pos(Lowercase(PathToRemove + ';'), Lowercase(NewPath));
    if P > 0 then
      Delete(NewPath, P, Length(PathToRemove) + 1)
    else if Lowercase(NewPath) = Lowercase(PathToRemove) then
      NewPath := '';
  end;

  RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', NewPath);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveFromPath(ExpandConstant('{app}\bin'));
  // Note: %LOCALAPPDATA%\Argus\ (state, logs, metrics) is intentionally NOT
  // touched — it persists across reinstalls per ADR A17/A20.
end;

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; \
  Flags: nowait postinstall skipifsilent
