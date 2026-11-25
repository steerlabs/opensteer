import { describe, expect, it } from "vitest";
import {
  commandRow,
  type CommandRow,
  type CommandResource,
} from "@opensteer/protocol/command-table";
import { commandGives, commandSentence } from "@opensteer/protocol/command-words";
import {
  CommandRequestService,
  commandPresentation,
  proposedCommand,
  titleFirst,
} from "./requests.js";

describe("a command Request's title (X3)", () => {
  it("keeps the Home's sentence whole and cuts only what follows", () => {
    const sentence = "Rename an AI engine account";
    const title = titleFirst(sentence, ` · Asked by the agent “${"n".repeat(400)}”`);
    expect(title.startsWith(sentence)).toBe(true);
    expect(title).toHaveLength(240);
    expect(title.endsWith("…")).toBe(true);
    expect(titleFirst(sentence, " · short")).toBe(`${sentence} · short`);
  });
});

describe("an ask names only what the asking agent supplied (rule 5)", () => {
  it("puts a plugin install to the person in the connection's own words, and nothing of the Home", async () => {
    // A grant that holds nothing asks for more (the table's (d)): the Request it reads back names
    // the catalog entry it sent and no plugin, catalog name or other thing the Home holds.
    const command = {
      type: "plugins.install",
      idempotencyKey: "install-1",
      source: { kind: "catalog", catalogId: "fixture" },
    } as const;
    const row = commandRow(command.type) as CommandRow;
    const governs = (row.governs as (c: typeof command) => CommandResource)(command);
    const requests = new CommandRequestService({
      store: {} as never,
      database: {} as never,
      requests: {} as never,
    });
    expect(await requests.name(governs, "usr_owner" as never)).toBeNull();
    const sentence = commandSentence(command as never, () => null);
    expect(sentence).toBe("Install a plugin");
    const stored = proposedCommand(row, command as never);
    expect(stored).toEqual({ type: "plugins.install", source: command.source });
    const gives = commandGives(command as never, 0);
    const shown = commandPresentation(
      { summary: sentence, command: stored, gives, agentReason: null, secretPaths: [] } as never,
      sentence,
      "Asked by the agent “Parity agent”",
    );
    expect(shown.detail).toBe(
      [
        "What changes: Install a plugin",
        "Asked by the agent “Parity agent”.",
        `As proposed: ${JSON.stringify(stored)}`,
        ...(gives ? [gives] : []),
      ].join("\n\n"),
    );
    // What it gives is the table's sentence, the same for every caller, and names nothing held.
    expect(gives ?? "").not.toMatch(/fixture|“/u);
  });
});
