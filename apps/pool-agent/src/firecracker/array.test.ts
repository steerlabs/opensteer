import { describe, expect, it } from "vitest";
import { deviceName, requireEncryptedArray, type ArrayIo } from "./array.js";

const paths = {
  arrayIdFile: "/srv/opensteer-pool/array-id",
  jailRoot: "/srv/opensteer-pool/jail",
  savedRoot: "/srv/opensteer-pool/saved",
};
// 253:0 is the first device-mapper device.
const dm = (253 << 8) | 0;
const rootDisk = (259 << 8) | 1;

function io(overrides: {
  dev?: Record<string, number>;
  mode?: Record<string, number>;
  uid?: number;
  uuid?: string | undefined;
  id?: string | undefined;
}): ArrayIo {
  return {
    stat: async (path) => ({
      dev: overrides.dev?.[path] ?? dm,
      mode: 0o040000 | (overrides.mode?.[path] ?? 0o700),
      uid: overrides.uid ?? 0,
      isDirectory: () => path !== paths.arrayIdFile,
    }),
    dmUuid: async (device) =>
      device === "253:0" && "uuid" in overrides
        ? overrides.uuid
        : device === "253:0"
          ? "CRYPT-PLAIN-osp-saved"
          : undefined,
    readArrayId: async () => ("id" in overrides ? overrides.id : "4b7a-array"),
  };
}

describe("review G3: saved memory only on the encrypted array", () => {
  it("starts on an encrypted array with root-only roots", async () => {
    expect(await requireEncryptedArray(paths, io({}))).toBe("4b7a-array");
  });

  it("refuses a missing array id instead of reading it as none", async () => {
    await expect(requireEncryptedArray(paths, io({ id: undefined }))).rejects.toThrow(
      "not prepared",
    );
  });

  it("refuses roots on the persistent disk (the array not mounted)", async () => {
    const unmounted = { [paths.jailRoot]: rootDisk, [paths.savedRoot]: rootDisk };
    await expect(requireEncryptedArray(paths, io({ dev: unmounted }))).rejects.toThrow(
      "not on the saved-state array",
    );
  });

  it("refuses an array that is not a dm-crypt device", async () => {
    await expect(requireEncryptedArray(paths, io({ uuid: "LVM-abc" }))).rejects.toThrow("dm-crypt");
  });

  it("refuses a root others can enter", async () => {
    await expect(
      requireEncryptedArray(paths, io({ mode: { [paths.savedRoot]: 0o755 } })),
    ).rejects.toThrow("closed to everyone else");
  });

  it("reads Linux device numbers as major:minor", () => {
    expect(deviceName(dm)).toBe("253:0");
    expect(deviceName((259 << 8) | 3)).toBe("259:3");
    // Large minors use the extended encoding.
    expect(deviceName((8 << 8) | 0x12 | (0x345 << 20))).toBe("8:" + (0x12 | (0x345 << 8)));
  });
});
