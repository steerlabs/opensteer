import { expect, it } from "vitest";
import { profileFailureDiagnostic } from "./profile-failure-diagnostic.js";

it("reports cause locations and filesystem codes without messages or website data", () => {
  const cause = Object.assign(new TypeError("cookie=secret https://private.test token=key"), {
    code: "EACCES",
  });
  const error = new Error("outer secret", { cause });
  const diagnostic = profileFailureDiagnostic(error);
  expect(diagnostic).toMatchObject({
    name: "Error",
    cause: {
      name: "TypeError",
      code: "EACCES",
      frames: expect.arrayContaining([
        expect.stringMatching(/profile-failure-diagnostic.test.ts:\d+:\d+/u),
      ]),
    },
  });
  expect(JSON.stringify(diagnostic)).not.toMatch(/secret|private.test|token|cookie|key/u);
});
