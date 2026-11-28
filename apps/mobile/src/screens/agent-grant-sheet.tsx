import type { AgentGrantDraft } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { NativeSettingsPage } from "./native-settings-page.js";
import {
  agentGrantSheetSections,
  agentGrantSheetTitle,
  type AgentGrantContext,
  type AgentGrantSheet,
} from "./agent-grant-sections.js";

/** One list of what an agent can use, as a sheet over consent or the agent's page. */
export function AgentGrantSheetPage(props: {
  readonly context: AgentGrantContext;
  readonly draft: AgentGrantDraft;
  readonly onChange: (draft: AgentGrantDraft) => void;
  readonly onClose: () => void;
  readonly onOpenDevices: () => void;
  readonly sheet: AgentGrantSheet;
}): ReactNode {
  return (
    <NativeSettingsPage
      sheet={{ title: agentGrantSheetTitle[props.sheet], onClose: props.onClose }}
      sections={agentGrantSheetSections(props.sheet, {
        ...props.context,
        draft: props.draft,
        onChange: props.onChange,
        onOpenDevices: props.onOpenDevices,
      })}
    />
  );
}
