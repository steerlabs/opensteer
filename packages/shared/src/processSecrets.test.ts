import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeProcessSecrets,
  encodeProcessSecrets,
  processSecretsDescriptorVariable,
  readProcessSecrets,
} from "./processSecrets.js";

const directories: string[] = [];
const descriptors: number[] = [];

afterEach(() => {
  for (const descriptor of descriptors.splice(0)) closeSync(descriptor);
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

/** A descriptor holding `content`, as a supervisor's pipe would. */
function descriptorWith(content: string): number {
  const directory = mkdtempSync(path.join(tmpdir(), "opensteer-secrets-"));
  directories.push(directory);
  const file = path.join(directory, "secrets");
  writeFileSync(file, content);
  const descriptor = openSync(file, "r");
  descriptors.push(descriptor);
  return descriptor;
}

describe("process secrets", () => {
  it("reads the secrets the named descriptor holds, once", () => {
    const secrets = { OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "s".repeat(32) };
    const environment: NodeJS.ProcessEnv = {
      [processSecretsDescriptorVariable]: String(descriptorWith(encodeProcessSecrets(secrets))),
    };

    expect(readProcessSecrets(environment)).toEqual(secrets);
    // The descriptor is at its end now, so it is forgotten rather than read
    // again and mistaken for a supervisor that sent nothing.
    expect(environment).toEqual({});
    expect(readProcessSecrets(environment)).toEqual({});
  });

  it("reads nothing when no descriptor is named", () => {
    expect(readProcessSecrets({})).toEqual({});
  });

  it("refuses anything but one object of strings", () => {
    expect(() => decodeProcessSecrets("[]")).toThrow(/not a JSON object/u);
    expect(() => decodeProcessSecrets("not json")).toThrow(/not a JSON object/u);
    expect(() => decodeProcessSecrets('{"TOKEN":1}')).toThrow(/TOKEN is not a string/u);
    expect(() => readProcessSecrets({ [processSecretsDescriptorVariable]: "stdin" })).toThrow(
      /must name an inherited file descriptor/u,
    );
  });
});
