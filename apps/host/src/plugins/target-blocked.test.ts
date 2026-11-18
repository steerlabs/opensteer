import { expect, it } from "vitest";
import { BlockedSchema } from "@opensteer/core";
import { pluginTargetBlocked } from "./target-blocked.js";
import { localTargetBlocked } from "../devices/target-blocked.js";
import { createIntegrationId } from "@opensteer/integration-core";

it("names the missing plugin account without suggesting credentials or another identity", () => {
  const input = {
    id: "plugin-mail",
    name: "Mail",
    reason: "Account required",
    requirements: { mail: { scope: "user" as const } },
    readiness: { mail: { state: "required-but-missing" as const, consent: null } },
  };
  expect(pluginTargetBlocked({ ...input, canRequestAccount: false }).next).toContain(
    "Only a task Run",
  );
  expect(
    pluginTargetBlocked({
      ...input,
      readiness: { mail: { state: "consent-needs-review", consent: null } },
    }),
  ).toMatchObject({
    code: "sign_in_required",
    message: "Mail needs its account link reviewed.",
    next: expect.stringContaining("review the changed account link in Plugins"),
  });
  const blocked = pluginTargetBlocked(input);
  expect(BlockedSchema.parse(blocked)).toEqual({
    code: "sign_in_required",
    message: "Mail needs a connected account.",
    next: 'Call plugin_account_request {"pluginId":"plugin-mail","requirement":"mail","scope":"user","reason":"<why you need it>"}.',
  });
  expect(
    pluginTargetBlocked({ ...input, readiness: { mail: { state: "usable", consent: null } } }),
  ).toMatchObject({
    code: "unavailable",
    message: "Account required",
    next: expect.stringContaining("Plugins"),
  });
});
it.each([{ dataApp: "Calendar", computerId: "dev_mac" }, { server: "Issues" }])(
  "keeps a local target's grant remedy separate from the task ceiling (%j)",
  (target) => {
    const readiness = {
      code: "ACCESS_GRANT_REQUIRED" as const,
      connectionId: null,
      serverId: createIntegrationId("server"),
      detail: null,
      requiredAccess: "read-write" as const,
    };
    const blocked = localTargetBlocked(readiness, "Local", target)!;
    expect(BlockedSchema.parse(blocked).code).toBe("access_required");
    expect(blocked.next).toBe(
      `Call app_access_request ${JSON.stringify({ ...target, access: "read-write", reason: "<why you need it>" })}.`,
    );
    expect(localTargetBlocked(readiness, "Local", target, false)).toMatchObject({
      code: "access_required",
      next: expect.stringMatching(/^Ask the owner .*Opensteer/),
    });
    const readOnly = localTargetBlocked(
      { ...readiness, code: "READ_ONLY_TASK", requiredAccess: null },
      "Local",
      target,
    )!;
    expect(readOnly).toMatchObject({
      code: "read_only_task",
      next: expect.stringContaining("cannot raise this task's ceiling"),
    });
    expect(readOnly.next).not.toContain("app_access_request");
    expect(
      localTargetBlocked({ ...readiness, code: "READY", requiredAccess: null }, "Local", target),
    ).toBeUndefined();
    expect(
      localTargetBlocked(
        {
          ...readiness,
          code: "INTEGRATION_UNAVAILABLE",
          requiredAccess: null,
          detail: "Computer is offline.",
        },
        "Local",
        target,
      ),
    ).toEqual({
      code: "unavailable",
      message: "Local is unavailable: Computer is offline.",
      next: "Continue without it and tell the person what the message says.",
    });
  },
);
