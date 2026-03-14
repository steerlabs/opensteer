import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { OpensteerPageSnapshotOutput, OpensteerSnapshotCounter } from "../../packages/protocol/src/index.js";
import { Opensteer } from "../../packages/opensteer/src/index.js";
import {
  cleanupPhase6TemporaryRoots,
  createPhase6TemporaryRoot,
  startPhase6FixtureServer,
  type Phase6FixtureServer,
} from "./phase6-fixture.js";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(
  process.cwd(),
  "packages/opensteer/dist/cli/bin.js",
);

let fixtureServer: Phase6FixtureServer | undefined;

beforeAll(async () => {
  fixtureServer = await startPhase6FixtureServer();
  await execFile("pnpm", ["build"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 4,
  });
}, 120_000);

afterEach(async () => {
  await cleanupPhase6TemporaryRoots();
});

afterAll(async () => {
  await fixtureServer?.close();
});

describe("Phase 6 SDK and CLI surfaces", () => {
  test(
    "SDK composes snapshot, action persistence, extraction replay, traces, and artifacts",
    async () => {
      const rootDir = await createPhase6TemporaryRoot();
      const baseUrl = requireFixtureServer().url;
      const opensteer = new Opensteer({
        name: "phase6-sdk",
        rootDir,
        browser: {
          headless: true,
        },
      });

      try {
        const state = await opensteer.open(`${baseUrl}/phase6/main`);
        expect(state.url).toBe(`${baseUrl}/phase6/main`);

        const actionSnapshot = await opensteer.snapshot("action");
        expect(actionSnapshot.html).toContain("<os-iframe-root");
        expect(actionSnapshot.html).toContain("<os-shadow-root");

        const mainAction = requireCounter(
          actionSnapshot,
          (counter) => counter.pathHint.includes("#main-action"),
        );
        const hoverTarget = requireCounter(
          actionSnapshot,
          (counter) => counter.pathHint.includes("#hover-target"),
        );
        const rewriteButton = requireCounter(
          actionSnapshot,
          (counter) => counter.pathHint.includes("#rewrite"),
        );
        const descriptorButton = requireCounter(
          actionSnapshot,
          (counter) => counter.pathHint.includes("#descriptor-button"),
        );
        const scrollAnchor = requireCounter(
          actionSnapshot,
          (counter) => counter.pathHint.includes("#scroll-anchor"),
        );
        const mainInput = requireCounter(
          actionSnapshot,
          (counter) => counter.pathHint.includes("#main-input"),
        );

        await opensteer.click({
          element: mainAction.element,
          description: "main action button",
        });
        expect(
          await opensteer.extract({
            description: "status text",
            schema: {
              status: { selector: "#status" },
            },
          }),
        ).toEqual({
          status: "main clicked",
        });

        await opensteer.hover({
          element: hoverTarget.element,
        });
        expect(await opensteer.extract({ description: "status text" })).toEqual({
          status: "hovered",
        });

        await opensteer.input({
          element: mainInput.element,
          text: "phase6",
          description: "main input field",
        });
        expect(
          await opensteer.extract({
            description: "mirror text",
            schema: {
              mirror: { selector: "#mirror" },
            },
          }),
        ).toEqual({
          mirror: "phase6",
        });

        await opensteer.click({
          element: descriptorButton.element,
          description: "descriptor button",
        });
        expect(await opensteer.extract({ description: "status text" })).toEqual({
          status: "descriptor clicked v1",
        });

        await opensteer.scroll({
          element: scrollAnchor.element,
          direction: "down",
          amount: 200,
        });
        const scrolled = (await opensteer.extract({ description: "status text" })) as {
          readonly status: string;
        };
        expect(scrolled.status.startsWith("scrolled ")).toBe(true);

        await opensteer.click({
          element: rewriteButton.element,
        });
        await opensteer.click({
          description: "descriptor button",
        });
        expect(await opensteer.extract({ description: "status text" })).toEqual({
          status: "descriptor clicked v2",
        });

        const extractionSnapshot = await opensteer.snapshot("extraction");
        const childLink = requireCounter(
          extractionSnapshot,
          (counter) => counter.pathHint.includes("#child-link"),
        );
        const childImage = requireCounter(
          extractionSnapshot,
          (counter) => counter.pathHint.includes("#child-image"),
        );

        const extracted = await opensteer.extract({
          description: "child content",
          schema: {
            currentUrl: { source: "current_url" },
            childLink: { element: childLink.element, attribute: "href" },
            imageUrl: { element: childImage.element, attribute: "srcset" },
            items: [
              {
                title: { selector: "#child-list li:nth-child(1) a.title" },
                url: { selector: "#child-list li:nth-child(1) a.title", attribute: "href" },
                price: { selector: "#child-list li:nth-child(1) .price" },
              },
              {
                title: { selector: "#child-list li:nth-child(2) a.title" },
                url: { selector: "#child-list li:nth-child(2) a.title", attribute: "href" },
                price: { selector: "#child-list li:nth-child(2) .price" },
              },
            ],
          },
        });

        expect(extracted).toEqual({
          currentUrl: `${baseUrl}/phase6/main`,
          childLink: `${baseUrl}/child-relative`,
          imageUrl: `${baseUrl}/large.png`,
          items: [
            { title: "One", url: `${baseUrl}/item-1`, price: "$1" },
            { title: "Two", url: `${baseUrl}/item-2`, price: "$2" },
          ],
        });
        expect(await opensteer.extract({ description: "child content" })).toEqual(extracted);

        const artifactManifests = await readdir(path.join(rootDir, ".opensteer", "artifacts", "manifests"));
        const traceRuns = await readdir(path.join(rootDir, ".opensteer", "traces", "runs"));
        expect(artifactManifests.length).toBeGreaterThan(0);
        expect(traceRuns.length).toBeGreaterThan(0);
      } finally {
        await opensteer.close();
      }
    },
    60_000,
  );

  test(
    "CLI preserves browser continuity across processes and tears down the session service on close",
    async () => {
      const rootDir = await createPhase6TemporaryRoot();
      const baseUrl = requireFixtureServer().url;
      const sessionName = "phase6-cli";

      const opened = await runCliCommand(rootDir, [
        "open",
        `${baseUrl}/phase6/main`,
        "--name",
        sessionName,
        "--headless",
        "true",
      ]);
      expect(opened.url).toBe(`${baseUrl}/phase6/main`);

      const snapshot = await runCliCommand(rootDir, [
        "snapshot",
        "action",
        "--name",
        sessionName,
      ]);
      const descriptorButton = requireCounter(
        snapshot as OpensteerPageSnapshotOutput,
        (counter) => counter.pathHint.includes("#descriptor-button"),
      );
      const rewriteButton = requireCounter(
        snapshot as OpensteerPageSnapshotOutput,
        (counter) => counter.pathHint.includes("#rewrite"),
      );

      await runCliCommand(rootDir, [
        "click",
        String(descriptorButton.element),
        "--name",
        sessionName,
        "--description",
        "descriptor button",
      ]);
      await runCliCommand(rootDir, [
        "click",
        String(rewriteButton.element),
        "--name",
        sessionName,
      ]);
      await runCliCommand(rootDir, [
        "click",
        "--name",
        sessionName,
        "--description",
        "descriptor button",
      ]);

      const extracted = await runCliCommand(rootDir, [
        "extract",
        '{"status":{"selector":"#status"}}',
        "--name",
        sessionName,
        "--description",
        "status text",
      ]);
      expect(extracted).toEqual({
        status: "descriptor clicked v2",
      });

      const replayed = await runCliCommand(rootDir, [
        "extract",
        "--name",
        sessionName,
        "--description",
        "status text",
      ]);
      expect(replayed).toEqual({
        status: "descriptor clicked v2",
      });

      const closed = await runCliCommand(rootDir, [
        "close",
        "--name",
        sessionName,
      ]);
      expect(closed).toEqual({
        closed: true,
      });

      const metadataPath = path.join(
        rootDir,
        ".opensteer",
        "runtime",
        "sessions",
        encodeURIComponent(sessionName),
        "service.json",
      );
      expect((await readdir(path.dirname(metadataPath))).includes("service.json")).toBe(false);
    },
    60_000,
  );
});

function requireFixtureServer(): Phase6FixtureServer {
  if (!fixtureServer) {
    throw new Error("phase 6 fixture server is not running");
  }
  return fixtureServer;
}

function requireCounter(
  snapshot: OpensteerPageSnapshotOutput,
  predicate: (counter: OpensteerSnapshotCounter) => boolean,
): OpensteerSnapshotCounter {
  const match = snapshot.counters.find(predicate);
  if (!match) {
    throw new Error("failed to find expected snapshot counter");
  }
  return match;
}

async function runCliCommand(rootDir: string, args: readonly string[]): Promise<unknown> {
  const { stdout, stderr } = await execFile(
    process.execPath,
    [CLI_SCRIPT, ...args],
    {
      cwd: rootDir,
      env: {
        ...process.env,
      },
      maxBuffer: 1024 * 1024,
    },
  );

  expect(stderr.trim()).toBe("");
  return JSON.parse(stdout.trim()) as unknown;
}
