import { SetupFooter, SetupFrame } from "./setup-frame.js";
import { SetupList, SetupRow } from "./setup-list.js";

/**
 * Setup's first step while the app it set up is still opening: the same
 * frame, title and rows, waiting to fill in, so nothing jumps when this
 * computer is ready.
 */
export function SetupOpening() {
  return (
    <SetupFrame
      description="Sign in to the AI you already pay for, and pick one to start with."
      footer={
        <SetupFooter
          action={
            <button className="btn btn--primary" disabled type="button">
              Continue
            </button>
          }
        />
      }
      title="Your AI"
    >
      <SetupList label="AI on this computer">
        <WaitingRow />
        <WaitingRow />
        <WaitingRow />
      </SetupList>
      <p className="setup-frame__note" role="status">
        <span aria-hidden className="spinner" /> Looking for AI on this computer…
      </p>
    </SetupFrame>
  );
}

function WaitingRow() {
  return (
    <SetupRow
      detail={<span aria-hidden className="skeleton setup-row__skeleton" />}
      icon={<span aria-hidden className="skeleton setup-row__skeleton-icon" />}
      title={
        <span aria-hidden className="skeleton setup-row__skeleton setup-row__skeleton--title" />
      }
      tone="missing"
    />
  );
}
