import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import {
  DisplayStreams,
  DisplayEditingSession,
  displayEditingAbilities,
} from "@opensteer/client/integrations";
import {
  createEditingState,
  reduceEditing,
  type EditingProxyEvent,
} from "@opensteer/client/editing";
import type { WebSocketClient } from "@opensteer/client/host";
import { displayEditingHost } from "./display-editing-host.test-support.js";

async function until(check: () => boolean) {
  const end = performance.now() + 3000;
  while (!check()) {
    if (performance.now() > end)
      throw new Error("Display journey did not reach its expected state");
    await delay(5);
  }
}

/** Socket E2E: production Host routes/hubs, signed producer media and the viewer's real reducer/transport. */
export async function runDisplayEditingJourney(directory: string) {
  await mkdir(directory, { recursive: true });
  const cases: { name: string; passed: boolean; error?: string; artifact?: string }[] = [];
  for (const mac of [false, true])
    for (const mode of ["editing", "old-producer", "baseline-host"] as const) {
      const name = `${mac ? "mac" : "phone"}-${mode}`;
      let host: Awaited<ReturnType<typeof displayEditingHost>> | undefined;
      let streams: DisplayStreams | undefined;
      let editing: DisplayEditingSession | undefined;
      try {
        host = await displayEditingHost({
          mac,
          editing: mode !== "old-producer",
          baselineHost: mode === "baseline-host",
        });
        const fixture = host;
        const wire: Record<string, unknown>[] = [];
        streams = new DisplayStreams({
          connect: (_source, options) => {
            const socket = fixture.socket(options?.editing === 1);
            const send = socket.send.bind(socket);
            socket.send = (data) => {
              if (typeof data === "string") wire.push(JSON.parse(data) as Record<string, unknown>);
              send(data);
            };
            return socket as unknown as WebSocketClient;
          },
        });
        const lease = streams.retain({ scope: name, source: fixture.source, editing: 1 });
        lease.onFrame((frame) => frame.done());
        editing = new DisplayEditingSession(lease);
        editing.setGeometry(1);
        await until(() => lease.getSnapshot().display?.state === "live");
        const negotiated = lease.getSnapshot().display?.editingVersion === 1;
        assert.equal(negotiated, mode === "editing");
        const old = fixture.socket(false);
        const baseline: Record<string, unknown>[] = [];
        old.on("message", (data, binary) => {
          if (!binary) baseline.push(JSON.parse(data.toString()) as Record<string, unknown>);
        });
        await until(() => baseline.some((message) => message.state === "live"));
        assert.ok(baseline.every((message) => message.editingVersion === undefined));
        lease.takeOver();
        if (mac && !negotiated) {
          await delay(20);
          assert.equal(lease.getSnapshot().control.state, "released");
          assert.equal(
            fixture.sent.some((message) => message.type === "host.integrations.mac-owner.control"),
            false,
          );
        } else {
          await until(() => lease.getSnapshot().control.state === "held");
          if (!negotiated) {
            assert.equal(
              lease.input(1, [
                { kind: "text", insert: "baseline" },
                { kind: "text", deleteBackward: 1 },
                { kind: "text", submit: true },
              ]),
              true,
            );
            await until(() =>
              fixture.sent.some((message) => message.type === "host.integrations.display.input"),
            );
            const input = fixture.sent.find(
              (message) => message.type === "host.integrations.display.input",
            );
            assert.deepEqual(input?.events, [
              { kind: "text", insert: "baseline" },
              { kind: "text", deleteBackward: 1 },
              { kind: "text", submit: true },
            ]);
            assert.equal(lease.input(1, [{ kind: "copy" }]), false);
          } else {
            await until(() => editing!.getSnapshot().context !== null);
            let state = createEditingState("mac", displayEditingAbilities);
            const completions: Promise<unknown>[] = [];
            const feed = (event: EditingProxyEvent) => {
              const step = reduceEditing(state, event);
              state = step.state;
              for (const operation of step.operations) completions.push(editing!.send(operation));
            };
            feed({ type: "context", context: editing.getSnapshot().context });
            const key = {
              alt: false,
              control: false,
              meta: false,
              shift: false,
              altGraph: false,
              location: 0 as const,
              repeat: false,
              composing: false,
            };
            feed({ type: "keydown", key: "e", code: "KeyE", ...key });
            feed({
              type: "input",
              inputType: "insertText",
              composing: false,
              proxy: { value: "e", selectionStart: 1, selectionEnd: 1 },
            });
            feed({
              type: "input",
              inputType: "insertReplacementText",
              composing: false,
              proxy: { value: "é", selectionStart: 1, selectionEnd: 1 },
            });
            feed({
              type: "compositionstart",
              proxy: { value: "é", selectionStart: 1, selectionEnd: 1 },
            });
            feed({
              type: "input",
              inputType: "insertCompositionText",
              composing: true,
              proxy: { value: "é한", selectionStart: 2, selectionEnd: 2 },
            });
            feed({
              type: "compositionend",
              data: "한",
              proxy: { value: "é한", selectionStart: 2, selectionEnd: 2 },
            });
            for (const [value, code] of [
              ["ArrowLeft", "ArrowLeft"],
              ["Backspace", "Backspace"],
              ["Backspace", "Backspace"],
            ])
              feed({ type: "keydown", key: value!, code: code!, ...key });
            feed({
              type: "paste",
              items: [
                { type: "text/plain", bytes: new TextEncoder().encode("line one\nline two 🦊") },
              ],
            });
            await Promise.all(completions);
            const copy = await editing.send({ kind: "copy" });
            assert.equal(new TextDecoder().decode(copy?.items[0]?.bytes), "fixture selection");
            await assert.rejects(
              editing.send({
                kind: "paste",
                items: [{ type: "text/html", bytes: new TextEncoder().encode("<b>rich</b>") }],
              }),
              /support/u,
            );
            assert.equal(editing.getSnapshot().receipt, "This device doesn’t support this edit.");
            const events = wire
              .filter((message) => message.type === "display.input")
              .flatMap((message) => message.events as unknown[]);
            assert.deepEqual(events, [
              {
                kind: "key",
                action: "down",
                key: "e",
                code: "KeyE",
                modifiers: [],
                location: 0,
                repeat: false,
                text: "e",
              },
              {
                kind: "edit",
                edit: { contextId: fixture.context.contextId, text: "é", before: "e", after: "" },
              },
              {
                kind: "edit",
                edit: { contextId: fixture.context.contextId, text: "한", before: "", after: "" },
              },
              { kind: "command", command: "moveBackward" },
              { kind: "command", command: "deleteBackward" },
              { kind: "command", command: "deleteBackward" },
              { kind: "paste", text: "line one\nline two 🦊" },
              { kind: "copy" },
              { kind: "paste", items: [{ type: "text/html", size: 11 }] },
            ]);
            const producerEvents = fixture.sent.flatMap((message) =>
              message.type === "host.integrations.display.input" ||
              message.type === "host.integrations.mac-owner.input"
                ? message.events
                : [],
            );
            assert.deepEqual(producerEvents, mac ? events : events.slice(0, -1));
            assert.ok(
              baseline.every(
                (message) =>
                  !["display.editing", "display.clipboard", "display.input.result"].includes(
                    String(message.type),
                  ),
              ),
            );
          }
          lease.giveBack();
          await until(fixture.released);
        }
        assert.deepEqual(fixture.failures, []);
        const artifact = path.join(directory, `${name}.json`);
        await writeFile(
          artifact,
          JSON.stringify(
            {
              name,
              passed: true,
              negotiated,
              source: fixture.source,
              wire,
              sent: fixture.sent,
              baseline,
              diagnostics: editing.diagnostics,
              qualification:
                "Host display routes/hubs over real TCP; fake authorization store and producer. baseline-host strips opt-in to emulate the old Host projection; no old binary/native target certification.",
            },
            null,
            2,
          ),
        );
        cases.push({ name, passed: true, artifact });
      } catch (error) {
        const artifact = path.join(directory, `${name}.json`);
        await writeFile(
          artifact,
          JSON.stringify(
            {
              name,
              passed: false,
              error: String(error),
              sent: host?.sent,
              failures: host?.failures,
            },
            null,
            2,
          ),
        );
        cases.push({ name, passed: false, error: String(error), artifact });
      } finally {
        editing?.dispose();
        streams?.dispose();
        await host?.close();
      }
    }
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify({ passed: cases.every((item) => item.passed), cases }, null, 2),
  );
  return cases;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory =
    process.env.OPENSTEER_DISPLAY_EDITING_EVIDENCE_DIR ?? "/tmp/opensteer-display-editing";
  const result = await runDisplayEditingJourney(directory);
  console.log(`Display editing journey: ${directory}/result.json`);
  if (result.some((item) => !item.passed)) process.exitCode = 1;
}
