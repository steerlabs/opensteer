import { readFileSync, writeFileSync } from "node:fs";
import { RunnerBrowserModuleSchema } from "@opensteer/protocol";
import { expect, test } from "vitest";
import { phoneBrowserDescriptor } from "./descriptor.js";
import type { NativeQualification } from "./native-port.js";

const vectorFile = new URL(
  "../../../../packages/browser-core/test-vectors/phone-descriptors.v1.json",
  import.meta.url,
);

/**
 * What each phone advertises, as the Host reads it. The iPhone admits this
 * descriptor and Android builds it in native code, so both test against this file.
 */
test("every phone browser descriptor is one the Host reads in full", () => {
  const qualifications: Record<"ios" | "android", NativeQualification> = {
    ios: {
      platform: "ios",
      runtimeId: "phone-ios",
      storageInstanceId: "44444444-4444-4444-8444-444444444444",
      browser: true,
      sharedControl: true,
      agentActions: true,
      cdpBoundary: false,
      fileStaging: true,
    },
    android: {
      platform: "android",
      runtimeId: "phone-android",
      storageInstanceId: "55555555-5555-4555-8555-555555555555",
      browser: true,
      sharedControl: true,
      agentActions: false,
      cdpBoundary: true,
      fileStaging: true,
    },
  };
  const phones = Object.fromEntries(
    Object.entries(qualifications).map(([platform, qualification]) => {
      const browser = phoneBrowserDescriptor(qualification);
      expect(RunnerBrowserModuleSchema.parse(browser), platform).toEqual(browser);
      return [platform, { qualification, browser }];
    }),
  );
  const generated = { version: 1, ...phones };
  if (process.env.OPENSTEER_WRITE_PHONE_VECTORS === "1")
    writeFileSync(vectorFile, `${JSON.stringify(generated, null, 2)}\n`);
  else
    expect(
      JSON.parse(readFileSync(vectorFile, "utf8")),
      "Regenerate with OPENSTEER_WRITE_PHONE_VECTORS=1",
    ).toEqual(generated);
});
