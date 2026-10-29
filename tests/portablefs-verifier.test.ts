import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPortableFsSourceTree } from "../scripts/verify-portablefs-origin-main.js";

describe("PortableFS source verifier", () => {
  it("loads through the PortableFS adapter boundary", () => {
    expect(verifyPortableFsSourceTree).toBeTypeOf("function");
  });

  it("pins the enrollment lease and v2 feature contract", async () => {
    const [originVerifier, managerVerifier] = await Promise.all([
      readFile(join(import.meta.dirname, "../scripts/verify-portablefs-origin-main.ts"), "utf8"),
      readFile(
        join(import.meta.dirname, "../scripts/verify-portablefs-manager-integration.ts"),
        "utf8",
      ),
    ]);
    expect(originVerifier).toContain("hosted-automatic-mount-reauthorization-v2");
    expect(originVerifier).toContain(
      'const forbiddenMountHelp = ["--mount-enrollment-expires-at-ms"]',
    );
    expect(managerVerifier).toContain('"-mount-enrollment-lease=6s"');
    expect(managerVerifier).not.toContain("mount-enrollment-lifetime");
    expect(managerVerifier).not.toContain("enrollment.expiresAt");
    expect(managerVerifier).not.toContain("enrollment_expires_unix");
    expect(managerVerifier).toContain('expiredEnrollmentOutcome: "EXPIRED"');
    expect(managerVerifier).toContain("firstVolumeEnrollmentSurvivedSecondVolumeIssuance");
    expect(managerVerifier).toContain("sameVolumeEnrollmentSuperseded");
    expect(managerVerifier).toContain("staleEpochFenced");
  });
});
