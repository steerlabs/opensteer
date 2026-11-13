/**
 * Windows launchers exactly as the package managers write them for
 * `node_modules/.bin`: npm's cmd-shim 9.0.2 and pnpm's @zkochan/cmd-shim
 * 7.0.0 (with the NODE_PATH pnpm passes), for a Node script and a program.
 */
export const generatedShims = {
  npm: {
    node: '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\..\\echo-argv\\bin\\echo-argv.js" %*\r\n',
    program:
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\..\\tool\\bin\\tool.exe"   %*\r\n',
  },
  pnpm: {
    node: '@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET "NODE_PATH=C:\\project\\node_modules\\.pnpm\\node_modules"\r\n) ELSE (\r\n  @SET "NODE_PATH=C:\\project\\node_modules\\.pnpm\\node_modules;%NODE_PATH%"\r\n)\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\echo-argv\\bin\\echo-argv.js" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\..\\echo-argv\\bin\\echo-argv.js" %*\r\n)\r\n',
    program: '@SETLOCAL\r\n@"%~dp0\\..\\tool\\bin\\tool.exe"   %*\r\n',
  },
} as const;

/** The script the `node` shims run, at `node_modules/echo-argv/bin/echo-argv.js`. */
export const echoArgvScript =
  "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n";
