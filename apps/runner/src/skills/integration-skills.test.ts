import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { materializeIntegrationSkills } from "./integration-skills.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Runner integration skills", () => {
  it("materializes an authenticated bundle as plain skill directories and cleans them up", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "opensteer-integration-skills-test-"));
    temporaryDirectories.push(stateDirectory);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer run-skill-token");
      expect(init?.redirect).toBe("error");
      return new Response(
        JSON.stringify({
          plugins: [
            {
              name: "example-plugin",
              skills: [
                {
                  files: [
                    {
                      content: Buffer.from(
                        "---\nname: research\ndescription: Research safely\n---\n",
                      ).toString("base64"),
                      executable: false,
                      path: "SKILL.md",
                    },
                    {
                      content: Buffer.from("#!/bin/sh\nexit 0\n").toString("base64"),
                      executable: true,
                      path: "scripts/check.sh",
                    },
                  ],
                  name: "research",
                },
              ],
            },
          ],
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const materialized = await materializeIntegrationSkills({
      plan: { token: "run-skill-token", url: "https://host.example.test/run-skills" },
      signal: new AbortController().signal,
      stateDirectory,
      threadId: createId("thread"),
    });
    expect(materialized.skills.map(({ name }) => name)).toEqual(["research"]);
    const skillPath = materialized.skills[0]?.path;
    expect(skillPath).toBeTruthy();
    expect(skillPath).toContain(join("example-plugin", "research"));
    await expect(access(join(skillPath!, "..", ".claude-plugin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(skillPath!, "SKILL.md"), "utf8")).toContain("Research safely");
    expect((await stat(join(skillPath!, "SKILL.md"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(skillPath!, "scripts/check.sh"))).mode & 0o777).toBe(0o700);

    await materialized.cleanup();
    await expect(access(skillPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a bundle file path that escapes its granted skill", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "opensteer-integration-skills-test-"));
    temporaryDirectories.push(stateDirectory);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plugins: [
                {
                  name: "example-plugin",
                  skills: [
                    {
                      files: [{ content: "b2s=", executable: false, path: "../escaped" }],
                      name: "research",
                    },
                  ],
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      materializeIntegrationSkills({
        plan: { token: "run-skill-token", url: "https://host.example.test/run-skills" },
        signal: new AbortController().signal,
        stateDirectory,
        threadId: createId("thread"),
      }),
    ).rejects.toThrow("Integration skill path is invalid");
  });
});
