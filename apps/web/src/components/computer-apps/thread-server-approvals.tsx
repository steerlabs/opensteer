import { useThreadServerApprovals } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";
import { ComputerSetupApprovals } from "./computer-app-approval.js";

/** Plugin servers this task's agent installed that wait for the viewer to let them run on a computer. */
export function ThreadServerApprovals({ threadId }: { readonly threadId: string }) {
  const { hostClient, snapshot } = useShell();
  const { requests: waiting, reload } = useThreadServerApprovals(hostClient, threadId);
  if (waiting.length === 0) return null;
  return (
    <div className="request-stack">
      <div className="card">
        <ComputerSetupApprovals
          detail={(request) =>
            `Wants to run on ${snapshot.machines.find((machine) => machine.id === request.runnerId)?.name ?? "your computer"}`
          }
          hostClient={hostClient}
          onChanged={reload}
          requests={waiting}
        />
      </div>
    </div>
  );
}
