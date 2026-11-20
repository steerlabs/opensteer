import { expect, it } from "vitest";
import { personalHomeKind, personalHomeKindOption } from "./home-kind.js";

const managedHome = {} as never;

it("says what kind of Home this is from its own configuration", () => {
  expect(personalHomeKind({ exposure: "networked", managedHome }, "linux")).toBe("cloud-computer");
  expect(personalHomeKind({ exposure: "networked" }, "linux")).toBe("server");
  expect(personalHomeKind({ exposure: "loopback" }, "darwin")).toBe("mac");
  // A loopback Home off macOS (development) says nothing rather than guess.
  expect(personalHomeKind({ exposure: "loopback" }, "linux")).toBeUndefined();
  expect(personalHomeKindOption({ exposure: "loopback" }, "linux")).toEqual({});
});
