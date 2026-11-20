import { expect, it, vi } from "vitest";
import { workEnrollNotice, workEnrollRefusal } from "../host/work-home.js";
import { readDeviceEnrollmentPreview } from "./device-setup.js";

const target = { hostUrl: "https://work.example.test", enrollmentToken: "a".repeat(48) };

it("reads only the facts for the pre-enrollment notice using the owner-issued code", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      organizationName: "Workshop",
      devices: "assignee-may-enroll",
      futureField: true,
    }),
  );
  const preview = await readDeviceEnrollmentPreview(target, { fetch });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    new URL("/v1/runner/enrollment/preview", target.hostUrl),
    {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrollmentToken: target.enrollmentToken }),
    },
  );
  expect(preview).toEqual({ organizationName: "Workshop", devices: "assignee-may-enroll" });
  expect(workEnrollNotice(preview)).toContain(
    "This device is joining a work Home owned by Workshop.",
  );
  expect(workEnrollRefusal({ organizationName: "Workshop", devices: "cloud-computer-only" })).toBe(
    "Workshop doesn’t allow other devices to join this work Home.",
  );
});

it("distinguishes a personal Home from a refused code and avoids sending a code without HTTPS", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(readDeviceEnrollmentPreview(target, { fetch })).resolves.toBeNull();
  await expect(readDeviceEnrollmentPreview(target, { fetch })).rejects.toThrow("Couldn’t check");
  await expect(
    readDeviceEnrollmentPreview({ ...target, hostUrl: "http://work.example.test" }, { fetch }),
  ).rejects.toThrow("secure Home address");
  expect(fetch).toHaveBeenCalledTimes(2);
});
