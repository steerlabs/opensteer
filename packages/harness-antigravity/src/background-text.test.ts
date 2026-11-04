import { ModelSelectionSchema, createId } from "@opensteer/core";
import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AntigravityHarnessDriver } from "./driver.js";
import * as runtime from "./runtime.js";

it("generates once with the exact model and unchanged prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-text-test-"));
  const executable = join(directory, "engine");
  const capture = join(directory, "capture");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(m)+'\\n');
 let result={};
 if(m.method==='initialize')result={protocolVersion:1,agentCapabilities:{},authMethods:[]};
 if(m.method==='session/new')result={sessionId:'11111111-1111-4111-8111-111111111111',configOptions:[]};
 if(m.method==='session/prompt') {
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer'}}}});
  result={stopReason:'end_turn'};
 }
 send({jsonrpc:'2.0',id:m.id,result});
});`,
    { mode: 0o700 },
  );
  const prepared = vi.spyOn(runtime, "prepareAntigravityRuntime").mockResolvedValue({
    directory,
    executable,
    harness: executable,
    protocolVersion: 1,
    version: "1.4.1",
  });
  const providerState = {
    kind: "isolated" as const,
    continuationKey: "test",
    privateStateRoot: directory,
    providerHomeDirectory: join(directory, "profile"),
    store: { directory: join(directory, "store"), id: "test" },
  };
  const context = {
    environment: { PATH: process.env.PATH ?? "" },
    providerState,
    runtimeBoundary: nativeUserHarnessRuntimeBoundary,
    scratchDirectory: directory,
    wrapProcessLaunch: (launch: import("@opensteer/harness").HarnessProcessLaunch) => launch,
  };
  const driver = new AntigravityHarnessDriver({
    nodeExecutable: process.execPath,
    runtimeCacheDirectory: directory,
  });
  let adapter: import("@opensteer/harness").HarnessAdapter | undefined;
  try {
    await driver.prepare({
      ...context,
      config: {},
      sourceId: "google",
      workingDirectory: directory,
      signal: AbortSignal.timeout(2_000),
    });
    adapter = await driver.create({
      config: {},
      instanceId: createId("harnessInstance"),
      sourceId: "google",
    });
    let launches = 0;
    await expect(
      adapter.generateText!({
        context: {
          ...context,
          wrapProcessLaunch: (launch) => {
            launches++;
            return launch;
          },
        },
        modelSelection: ModelSelectionSchema.parse({
          providerId: "google",
          modelId: "catalog-id",
          nativeModelId: "exact-native-id",
          options: {},
        }),
        prompt: "Keep this prompt unchanged",
        signal: AbortSignal.timeout(2_000),
      }),
    ).resolves.toEqual({ ok: true, text: "answer" });
    expect(launches).toBe(1);
    const messages = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    expect(messages.find((m) => m.method === "session/set_model")?.params.modelId).toBe(
      "exact-native-id",
    );
    expect(messages.find((m) => m.method === "session/prompt")?.params.prompt).toEqual([
      { type: "text", text: "Keep this prompt unchanged" },
    ]);
    expect(messages.map((m) => m.method)).not.toContain("model/list");
  } finally {
    await adapter?.close();
    prepared.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
