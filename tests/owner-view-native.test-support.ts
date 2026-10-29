/** Controlled native transport driver; see docs/computer-use.md for the opt-in journey. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { createId } from "../packages/core/src/index.js";
import { HostIntegrationsComputerViewSchema } from "../packages/protocol/src/index.js";
import { ComputerUseService } from "../apps/desktop/src/computer-use/computer-use-service.js";
import { ComputerUseHandler } from "../apps/runner/src/computer-apps/computer-use-handler.js";
import { defaultSignedHelperRun } from "../apps/desktop/src/signed-helpers/signed-helper.js";

const directory = process.env.OPENSTEER_OWNER_VIEW_SERVER_DIR;
if (!directory)
  throw new Error(
    "Set OPENSTEER_OWNER_VIEW_SERVER_DIR to the controlled Swift server artifact directory.",
  );
const { home } = z
  .object({ home: z.string().regex(/^\/tmp\/ow-[A-F0-9]{8}$/u) })
  .parse(JSON.parse(await readFile(path.join(directory, "ready.json"), "utf8")));
const bundled = path.resolve("apps/desktop/native/computer-use/dist/Opensteer Computer Use.app");
const installed = path.join(
  home,
  "Library/Application Support/Opensteer/Computer Use/Opensteer Computer Use.app",
);
await mkdir(path.dirname(installed), { recursive: true });
await promisify(execFile)("/usr/bin/ditto", [bundled, installed]);
const events: string[] = [];
const desktop = new ComputerUseService({
  appBundleId: "com.opensteer.owner-journey",
  appVersion: "test",
  bundledHelperPath: () => bundled,
  homeDirectory: home,
  teamId: null,
  idleDisconnectMs: 100,
  // A stale test socket must never launch or replace a helper on the real Mac.
  run: async (file, arguments_) => {
    if (file !== "/usr/bin/codesign" && file !== "/usr/bin/plutil") {
      throw new Error(`The isolated owner journey refuses helper mutation or launch: ${file}`);
    }
    return await defaultSignedHelperRun(file, arguments_);
  },
  log: (event) => {
    events.push(event);
  },
});
let runner: ComputerUseHandler | null = null;
const token = randomBytes(32).toString("base64url");
const server = createServer((request, response) => {
  void (async () => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const frame = HostIntegrationsComputerViewSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    assert(runner);
    const result = await runner.runView(frame, new AbortController().signal);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  })().catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    void writeFile(path.join(directory, "desktop-error.json"), JSON.stringify({ detail }, null, 2));
    response.writeHead(500).end(JSON.stringify({ error: detail }));
  });
});
try {
  assert.deepEqual(await desktop.permissions(), {
    accessibility: "granted",
    screenRecording: "granted",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert(events.includes("desktop.computer-use.helper-idle-disconnect"));
  const bridge = await desktop.startForSlot(createId("deployment"));
  assert(bridge);
  runner = new ComputerUseHandler({ bridge: { token: bridge.token, url: new URL(bridge.url) } });
  assert.deepEqual(await runner.permissions(), {
    accessibility: "granted",
    screenRecording: "granted",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await writeFile(
    path.join(directory, "desktop-ready.json"),
    JSON.stringify(
      {
        url: `http://127.0.0.1:${address.port}`,
        token,
        events,
      },
      null,
      2,
    ),
  );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path.join(directory, "stop"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
} finally {
  runner?.close();
  await desktop.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await writeFile(path.join(directory, "desktop-events.json"), JSON.stringify(events, null, 2));
}
