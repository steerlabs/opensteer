export interface RemovedViewProps {
  readonly title: string;
  readonly body: string;
  readonly onSetUpAgain: () => void;
  readonly onNotNow: () => void;
}

/** Both orders — the session ending first, or the runner's 4010 — land here. */
export function removedCopy(
  noun: string,
  deploymentName: string,
): Pick<RemovedViewProps, "body" | "title"> {
  return {
    title: `This ${noun} was removed from ${deploymentName}`,
    body: `It's signed out there, and your agent can't use it. Set it up again to use it with ${deploymentName}.`,
  };
}
