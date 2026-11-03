import { expect, it } from "vitest";
import { programEnvironment } from "./program-environment.js";
it("copies the program allowlist without Runner, provider or tool credentials", () => {
  expect(
    programEnvironment({
      HOME: "/home/person",
      PATH: "/bin",
      LANG: "en_US.UTF-8",
      OPENSTEER_MCP_TOKEN: "private",
      OPENAI_API_KEY: "private",
      AWS_SECRET_ACCESS_KEY: "private",
      PORT: "1234",
      TERM: "",
    }),
  ).toEqual({ HOME: "/home/person", PATH: "/bin", LANG: "en_US.UTF-8" });
});
