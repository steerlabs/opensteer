import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import recorded from "../packages/client/src/mock/chat-parity.fixture.json" with { type: "json" };
import {
  chatScreenCommands,
  chatScreenHooks,
  chatScreenMethods,
  chatScreenReads,
} from "../packages/client/src/host/chat-screen-host.js";
import {
  chatParityAcceptedOutside,
  chatParityOutside,
  chatParityRefusesNothing,
  chatParityViewReads,
  chatScreenSends,
  type ChatParityRecord,
} from "../packages/client/src/mock/chat-parity.js";

/**
 * The chat parity script covers what the Messaging, chat and connected-agent screens can send.
 * Those screens reach the Home only through a `ChatScreenHost` (packages/client/src/host
 * /chat-screen-host.ts), whose lists are what this test reads: a command added to a screen is a
 * type error there until it is listed, and once listed it fails here until the script, recorded
 * on a real Home, has a step the Home accepted and one it refused.
 */
const record = recorded as unknown as ChatParityRecord;

/** The screens' own files; each may reach the Home only through a `ChatScreenHost`. */
const screens = [
  "apps/web/src/components/messaging-page.tsx",
  "apps/web/src/components/computer-channel-setup.tsx",
  "apps/web/src/components/settings/sections/chat-facts.tsx",
  "apps/web/src/components/settings/sections/connected-agent-page.tsx",
  "apps/web/src/components/settings/sections/external-agents.tsx",
  "apps/mobile/src/screens/settings-messaging.tsx",
  "apps/mobile/src/screens/connected-agent.tsx",
  "apps/mobile/src/screens/settings-external-agents-controller.tsx",
];
const root = fileURLToPath(new URL("../", import.meta.url));

describe("the chat parity script covers what the chat screens can send", () => {
  const sent = [
    ...chatScreenCommands,
    ...chatScreenReads.filter((read) => !(chatParityViewReads as readonly string[]).includes(read)),
    ...Object.values(chatScreenMethods),
  ];

  it("lists each thing they send once, as a step kind or as outside the script with why", () => {
    const covered = Object.keys(chatScreenSends);
    const outside = Object.keys(chatParityOutside);
    expect([...covered, ...outside].sort()).toEqual([...sent].sort());
    for (const read of chatParityViewReads) expect(chatScreenReads).toContain(read);
  });

  it.each(Object.entries(chatScreenSends))(
    "%s has a step the Home accepted and one it refused, each compared",
    (type, kind) => {
      const steps = record.steps.filter((step) => step.command.kind === kind);
      // A step the preview could not be compared with stands for neither side.
      const compared = steps.filter((step) => !step.notComparable);
      const accepted = compared.some((step) => step.answer.ok) || type in chatParityAcceptedOutside;
      const refused =
        type in chatParityRefusesNothing
          ? compared.length >= 2
          : compared.some((step) => !step.answer.ok);
      expect({ type, kind, accepted, refused }).toEqual({
        type,
        kind,
        accepted: true,
        refused: true,
      });
    },
  );

  it.each(screens)("%s reaches the Home only through a ChatScreenHost", (path) => {
    const source = readFileSync(`${root}${path}`, "utf8");
    const receivers = new Set<string>();
    for (const match of source.matchAll(
      /([A-Za-z_$][\w$]*)\s*\??\.\s*(?:dispatch|stopRun)\s*\(|([A-Za-z_$][\w$]*)\s*\.\s*rpc\b/gu,
    ))
      receivers.add(match[1] ?? match[2]!);
    // A hook handed a whole client is one listed with why it may be (`chatScreenHooks`).
    for (const hook of source.matchAll(/\b(use[A-Z]\w*)\([^)]*\b(?:client|host|hostClient)\b/gu))
      expect(Object.keys(chatScreenHooks), `${path}: ${hook[1]}`).toContain(hook[1]);
    for (const name of source.matchAll(/createDedicatedProfile\(\s*([A-Za-z_$][\w$]*)/gu))
      receivers.add(name[1]!);
    for (const name of receivers) {
      const narrowed = new RegExp(
        `\\b${name}\\s*=\\s*chatScreenHost\\(|\\b${name}\\??:\\s*(?:Pick<\\s*)?ChatScreenHost\\b`,
        "u",
      );
      const wide = new RegExp(`\\b${name}\\??:\\s*(?:Pick<\\s*)?HostClient\\b`, "u");
      expect({ path, name, narrowed: narrowed.test(source), wide: wide.test(source) }).toEqual({
        path,
        name,
        narrowed: true,
        wide: false,
      });
    }
  });
});
