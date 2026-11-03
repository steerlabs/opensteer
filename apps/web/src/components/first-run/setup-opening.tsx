import { Icon } from "../icon.js";
import { OnboardingCard } from "../onboarding-card.js";
import { SetupList, SetupRow, SetupStatus } from "./setup-list.js";
import { SetupAiPlaceholder, SetupPhonePlaceholder } from "./setup-placeholders.js";

/**
 * Setup while the app it set up is still opening. It is the same screen the
 * person was already looking at, so nothing jumps between this computer being
 * ready and its AI and phone rows filling in.
 */
export function SetupOpening({ computerName }: { readonly computerName: string }) {
  return (
    <OnboardingCard bare live title="Set up Opensteer">
      <div className="setup">
        <SetupList label="Setup">
          <SetupRow
            detail="Opening Opensteer"
            icon={<Icon name="laptop" />}
            title={computerName}
            trailing={<SetupStatus label="Opening Opensteer" state="working" />}
          />
          <SetupAiPlaceholder />
          <SetupPhonePlaceholder />
        </SetupList>
        <div className="setup__actions">
          <button className="btn btn--primary" disabled type="button">
            Start
          </button>
        </div>
      </div>
    </OnboardingCard>
  );
}
