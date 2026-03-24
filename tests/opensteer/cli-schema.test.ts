import { describe, expect, test } from "vitest";

import {
  opensteerCliSchema,
  renderHelp,
  type CliCommandDefinition,
} from "../../packages/opensteer/src/cli/schema.js";

describe("CLI schema contract", () => {
  test("declares only kebab-case long option names", () => {
    for (const command of walkCommands(opensteerCliSchema)) {
      for (const option of command.options ?? []) {
        expect(option.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      }
    }
  });

  test("does not duplicate option names within a command surface", () => {
    for (const command of walkCommands(opensteerCliSchema)) {
      const names = (command.options ?? []).map((option) => option.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("shows the root version flag in help output", () => {
    const help = renderHelp({
      schema: opensteerCliSchema,
      programName: "opensteer",
    });

    expect(help).toContain("--version");
    expect(help).toContain("Show the installed Opensteer version");
  });
});

function walkCommands(root: CliCommandDefinition): readonly CliCommandDefinition[] {
  const commands: CliCommandDefinition[] = [];

  const visit = (command: CliCommandDefinition) => {
    commands.push(command);
    for (const subcommand of command.subcommands ?? []) {
      visit(subcommand);
    }
  };

  visit(root);
  return commands;
}
