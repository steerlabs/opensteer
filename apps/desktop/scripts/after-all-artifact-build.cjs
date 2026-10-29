const { spawnSync } = require("node:child_process");

module.exports = async function verifyWindowsInstaller(result) {
  if (process.env.OPENSTEER_DESKTOP_RELEASE !== "1") return [];
  const buildsWindows = [...result.platformToTargets.keys()].some(
    (platform) => platform.name === "windows",
  );
  if (!buildsWindows) return [];
  const installers = (result.artifactPaths ?? []).filter((artifact) =>
    /(?:^|[\\/])opensteer-[^\\/]+-setup\.exe$/iu.test(artifact),
  );
  if (installers.length !== 1) {
    throw new Error("Windows release must emit exactly one signed NSIS installer.");
  }
  requireValidAuthenticode(installers[0]);
  return [];
};

function requireValidAuthenticode(filePath) {
  const script = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
    "if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { exit 9 }",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, filePath],
    { encoding: "utf8", stdio: "pipe", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Windows installer Authenticode verification failed for ${filePath}.`);
  }
}
