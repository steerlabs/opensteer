import { expect, it } from "vitest";
import { HostClientRequestError } from "../host/index.js";
import { settingsMutationRejected } from "./index.js";

it("distinguishes confirmed refusal from an unknown commit outcome", () => {
  expect(settingsMutationRejected(new HostClientRequestError({
    code: "conflict", status: 409, message: "Revision changed",
  }))).toBe(true);
  expect(settingsMutationRejected(new Error("Lost response"))).toBe(false);
  expect(settingsMutationRejected(new HostClientRequestError({
    code: "internal", status: 500, message: "Unavailable",
  }))).toBe(false);
});
