import { expect, it } from "vitest";
import { createId } from "./ids.js";
import { DeviceIdSchema } from "./devices.js";
import { RequestPayloadSchema, RequestViewSchema } from "./requests.js";
import { PhoneContentPartSchema } from "./models.js";
import { PlaceIdentitySchema } from "./places.js";

it("normalizes retained computer access Requests without changing their persisted payload", () => {
  const runnerId = createId("runner");
  const legacy = {
    kind: "computer.app.access",
    runnerId,
    definitionId: "android-phone",
    app: null,
    access: "read",
    reason: "Read the phone",
    setupRequestId: crypto.randomUUID(),
  };
  const before = JSON.stringify(legacy);
  expect(RequestPayloadSchema.parse(legacy)).toEqual({
    kind: legacy.kind,
    deviceId: DeviceIdSchema.parse(runnerId),
    definitionId: legacy.definitionId,
    app: null,
    access: legacy.access,
    reason: legacy.reason,
    setupRequestId: legacy.setupRequestId,
  });
  const request = {
    id: createId("request"),
    kind: legacy.kind,
    status: "pending",
    callId: "legacy-call",
    mode: "durable",
    originatingRunId: createId("run"),
    originatingOccurrenceId: null,
    originatingThreadId: createId("thread"),
    requestedBy: createId("user"),
    createdAt: "2026-08-22T12:00:00.000Z",
    payload: legacy,
    requiredActor: "requester",
    cancellationReason: null,
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    presentation: {
      kind: "choice",
      title: "Read phone",
      options: [
        { hint: "allow-once", id: "allow", label: "Allow once" },
        { hint: "reject-once", id: "reject", label: "Reject" },
      ],
    },
  };
  expect(RequestViewSchema.parse(request).payload).toMatchObject({ deviceId: runnerId });
  expect(JSON.stringify(legacy)).toBe(before);
});
it("reads old and new Device targets and keeps the phone approval boundary", () => {
  for (const id of [createId("runner"), createId("device")]) {
    expect(
      PhoneContentPartSchema.parse({ type: "phone", machineId: id, name: "Phone", display: "main" })
        .machineId,
    ).toBe(id);
    expect(
      PlaceIdentitySchema.parse({ kind: "phone", machineId: id, display: "main" }),
    ).toMatchObject({ machineId: id });
  }
  const payload = {
    kind: "computer.app.access",
    deviceId: createId("device"),
    definitionId: "iphone-screen",
    app: null,
    access: "read",
    reason: "Read the phone",
    setupRequestId: crypto.randomUUID(),
  };
  expect(RequestPayloadSchema.safeParse(payload).success).toBe(true);
  expect(
    RequestPayloadSchema.safeParse({
      ...payload,
      app: { bundleId: "com.example.app", displayName: "App", teamId: null },
    }).success,
  ).toBe(false);
});
