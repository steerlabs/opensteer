import type { RuntimeState, TeamComputerView } from "@opensteer/protocol";

export interface TeamSetupStep {
  readonly key: "computer" | "project" | "invite";
  readonly title: string;
  readonly done: boolean;
}

/**
 * What a new team still needs before its people can work, from what its Host
 * reports and nothing this device remembers. Null while a fact is unread, and
 * once every step is done.
 */
export function teamSetupSteps(input: {
  readonly team: string;
  readonly computer: TeamComputerView["computer"] | undefined;
  readonly projects: readonly { readonly runtime?: RuntimeState | undefined }[];
  readonly invited: boolean | undefined;
}): readonly TeamSetupStep[] | null {
  if (input.computer === undefined || input.invited === undefined) return null;
  const steps: TeamSetupStep[] = [
    {
      key: "computer",
      title: `Connect ${input.team}’s computer`,
      done: input.computer?.state === "connected",
    },
    {
      key: "project",
      title: "Create a project that can run tasks",
      done: input.projects.some(({ runtime }) => runtime?.state === "ready"),
    },
    { key: "invite", title: "Invite someone", done: input.invited },
  ];
  return steps.every(({ done }) => done) ? null : steps;
}
