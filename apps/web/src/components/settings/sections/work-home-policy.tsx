import { workHomeSeeView } from "@opensteer/client/host";
import { useWorkPolicy } from "@opensteer/client/react";
import { Navigate } from "react-router";
import { useShell } from "../../app-shell.js";
import { SectionHeader, SettingsGroup, SettingsRow } from "../primitives.js";
import { SettingsPage } from "../settings-shell.js";

/**
 * "What {organization} can see", from inside a work Home: what its organization decided, exactly
 * which records this Home sends, and what never leaves it. A personal Home has no such page.
 */
export function WorkHomePolicyPage() {
  const { hostClient } = useShell();
  const policy = useWorkPolicy(hostClient);
  if (policy === null) return <Navigate replace to="/settings/general" />;
  if (policy === undefined)
    return (
      <p className="settings-footnote" role="status">
        Loading…
      </p>
    );
  const view = workHomeSeeView(policy);
  return (
    <SettingsPage title={view.title}>
      <SectionHeader lead={view.lead} title={view.title} />
      <SettingsGroup
        heading={view.decides.title}
        headingId="work-home-decides"
        note={view.decides.version}
      >
        {view.decides.rows.map((row) => (
          <SettingsRow
            action={<span className="work-see__value">{row.value}</span>}
            key={row.title}
            title={row.title}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup heading={view.sees.title} headingId="work-home-sees">
        {view.sees.items.map((item) => (
          <SettingsRow key={item} title={item} />
        ))}
        <SettingsRow
          detail={
            <ul className="work-see__list">
              {view.sees.records.map((record) => (
                <li key={record}>{record}</li>
              ))}
            </ul>
          }
          title={view.sees.recordsTitle}
        />
      </SettingsGroup>
      <SettingsGroup heading={view.never.title} headingId="work-home-never">
        {view.never.items.map((item) => (
          <SettingsRow key={item} title={item} />
        ))}
      </SettingsGroup>
    </SettingsPage>
  );
}
