import { createId } from "@opensteer/core";
import { ShellConnectErrorSchema } from "@opensteer/protocol";
import { expect, it } from "vitest";
import { shellConnectRefusalMessage } from "./shell-transport.js";

it.each(["device-access-off", "device-offline"] as const)(
  "keeps %s actionable after the strict shell envelope becomes engine text",
  (code) => {
    const machineId = createId("runner");
    const error = ShellConnectErrorSchema.parse({
      error: { code, machineId, capability: "files", message: "Files are unavailable." },
    }).error;
    const text = shellConnectRefusalMessage(error);
    expect(text).toContain(code);
    expect(text).toContain(machineId);
    expect(text).toContain("files");
    expect(text).toContain(
      code === "device-access-off" ? "device_access_request" : "Do not request access",
    );
  },
);
