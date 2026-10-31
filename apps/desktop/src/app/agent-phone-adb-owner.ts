import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const untrusted = () =>
  new Error("The local Android debugging service is not owned by your computer account.");

/** A loopback listener alone is not authority to receive phone setup credentials. */
export async function agentPhoneAdbServerOwner(
  platform = process.platform,
): Promise<string | null> {
  if (platform === "linux") {
    const lines = (await readFile("/proc/net/tcp", "utf8")).trim().split("\n").slice(1);
    const listeners = lines
      .map((line) => line.trim().split(/\s+/u))
      .filter(
        (fields) =>
          ["0100007F:13AD", "00000000:13AD"].includes(fields[1] ?? "") && fields[3] === "0A",
      );
    if (listeners.length === 0) return null;
    const [listener] = listeners;
    if (listeners.length !== 1 || Number(listener?.[7]) !== process.getuid?.()) throw untrusted();
    return `linux:${listener?.[9]}`;
  }
  if (platform === "win32") {
    const { stdout } = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
      $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 5037 -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::') });
      $ids = @($listeners.OwningProcess | Select-Object -Unique);
      if ($ids.Count -eq 0) { exit 0 };
      if ($ids.Count -ne 1) { Write-Output 'untrusted'; exit 0 };
      $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ids[0]);
      $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid;
      if ($owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { Write-Output 'untrusted'; exit 0 };
      Write-Output ($proc.ProcessId.ToString() + ':' + $proc.CreationDate.ToUniversalTime().Ticks.ToString());
    `,
      ],
      { timeout: 5_000, maxBuffer: 16_384, windowsHide: true },
    );
    const owner = stdout.trim();
    if (!owner) return null;
    if (!/^\d+:\d+$/u.test(owner)) throw untrusted();
    return `windows:${owner}`;
  }
  if (platform !== "darwin") throw new Error("Android debugging is unavailable on this computer.");
  let output: string;
  try {
    output = (
      await execute("/usr/sbin/lsof", ["-nP", "-i4TCP:5037", "-sTCP:LISTEN", "-Fpun"], {
        timeout: 3_000,
        maxBuffer: 16_384,
      })
    ).stdout;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 1 &&
      "stdout" in error &&
      error.stdout === ""
    )
      return null;
    throw new Error("Opensteer could not verify the local Android debugging service.");
  }
  const listeners = output
    .split(/(?=^p[0-9])/mu)
    .filter((record) => /^n(?:127\.0\.0\.1|\*):5037$/mu.test(record));
  if (listeners.length !== 1) throw untrusted();
  const listener = listeners[0]!;
  const uid = /^u([0-9]+)$/mu.exec(listener)?.[1];
  const pid = /^p([0-9]+)$/mu.exec(listener)?.[1];
  if (!pid || uid === undefined || Number(uid) !== process.getuid?.()) throw untrusted();
  return `macos:${pid}`;
}
