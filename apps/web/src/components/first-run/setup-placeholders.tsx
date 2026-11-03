import { Icon } from "../icon.js";
import { SetupRow } from "./setup-list.js";

/** The AI row before this computer can say which AIs it has. */
export function SetupAiPlaceholder() {
  return (
    <SetupRow
      detail={<span aria-hidden className="skeleton setup-row__skeleton" />}
      icon={<Icon name="sparkles" />}
      title="AI"
      tone="missing"
    />
  );
}

/** The phone row before this computer can be reached from one. */
export function SetupPhonePlaceholder() {
  return <SetupRow icon={<Icon name="phone" />} title="Phone" tone="missing" />;
}
