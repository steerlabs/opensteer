import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import type { RunnerDescriptor, RunnerDevice, RunnerDeviceForm } from "@opensteer/protocol";
import { z } from "zod";

/** What `describeRunnerDevice` asks of the machine; injected in tests. */
export interface RunnerDeviceProbe {
  readonly insideContainer: () => Promise<boolean>;
  /** SMBIOS chassis type, as `/sys/class/dmi/id/chassis_type` holds it. */
  readonly linuxChassisType: () => Promise<string | null>;
  /** The model name macOS shows in About This Mac ("MacBook Pro"). */
  readonly macMachineName: () => Promise<string | null>;
}

/**
 * The shape of the computer this Runner runs on, for the icon people see.
 *
 * It is read once at start and never guessed: a Mac whose model macOS does
 * not name, or a Windows machine, reports its platform alone and is drawn as a
 * plain computer. A Linux Runner with no readable chassis is almost always a
 * VM, a container or a board without a screen, which is what "server" draws.
 */
export async function describeRunnerDevice(input: {
  readonly platform: NodeJS.Platform;
  readonly probe?: RunnerDeviceProbe;
  readonly runnerKind: RunnerDescriptor["runnerKind"];
}): Promise<RunnerDevice | undefined> {
  const probe = input.probe ?? systemProbe;
  switch (input.platform) {
    case "darwin":
      return {
        form:
          input.runnerKind === "managed"
            ? "server"
            : macForm(await probe.macMachineName().catch(() => null)),
        platform: "macos",
      };
    case "linux":
      return {
        form:
          input.runnerKind === "managed" || (await probe.insideContainer().catch(() => false))
            ? "server"
            : linuxForm(await probe.linuxChassisType().catch(() => null)),
        platform: "linux",
      };
    case "win32":
      return { form: null, platform: "windows" };
    default:
      return undefined;
  }
}

function macForm(machineName: string | null): RunnerDeviceForm | null {
  const name = machineName?.trim() ?? "";
  if (name.startsWith("MacBook")) return "laptop";
  if (name.startsWith("iMac") || name === "Mac Pro") return "desktop";
  if (name === "Mac mini" || name === "Mac Studio") return "compact";
  if (name.startsWith("Apple Virtual Machine")) return "server";
  return null;
}

// SMBIOS 3.x chassis types (DSP0134 §7.4.1).
const laptopChassis = new Set([8, 9, 10, 11, 14, 30, 31, 32]);
const desktopChassis = new Set([3, 4, 5, 6, 7, 13, 15, 16, 24, 34, 35, 36]);

function linuxForm(chassisType: string | null): RunnerDeviceForm {
  const type = Number.parseInt(chassisType?.trim() ?? "", 10);
  if (laptopChassis.has(type)) return "laptop";
  if (desktopChassis.has(type)) return "desktop";
  return "server";
}

const systemProbe: RunnerDeviceProbe = {
  insideContainer: async () =>
    (await exists("/.dockerenv")) || (await exists("/run/.containerenv")),
  linuxChassisType: () => readFile("/sys/class/dmi/id/chassis_type", "utf8"),
  macMachineName: () =>
    new Promise((resolve, reject) => {
      execFile(
        "/usr/sbin/system_profiler",
        ["SPHardwareDataType", "-json", "-detailLevel", "mini"],
        { env: { PATH: "/usr/sbin:/usr/bin:/bin" }, maxBuffer: 64 * 1024, timeout: 5_000 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(machineNameFromHardwareReport(stdout));
        },
      );
    }),
};

const HardwareReportSchema = z.object({
  SPHardwareDataType: z.array(z.object({ machine_name: z.string() })).min(1),
});

function machineNameFromHardwareReport(report: string): string | null {
  try {
    const parsed = HardwareReportSchema.safeParse(JSON.parse(report));
    return parsed.success ? (parsed.data.SPHardwareDataType[0]?.machine_name ?? null) : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
