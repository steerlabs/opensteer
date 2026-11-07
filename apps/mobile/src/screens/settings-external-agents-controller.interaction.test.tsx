// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalAgentsFormProps } from "./settings-external-agents-form.types.js";

const state = vi.hoisted(() => ({
  form: null as ExternalAgentsFormProps | null,
}));

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("@opensteer/client/react", () => ({
  useConnectedAgents: () => ({ connections: [], error: null, pending: null }),
  usePersonalRemoteAccess: () => ({ status: null, error: "The computer did not answer." }),
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileState: () => ({ selection: { deploymentId: "deployment-a", hostClient: {} } }),
}));
vi.mock("./use-settings-host.js", () => ({
  useSettingsHost: () => ({
    deploymentShape: { kind: "personal" },
    identityConfig: { exposure: "loopback", publicOrigin: "http://127.0.0.1:4310" },
    workspaces: [],
  }),
}));
vi.mock("./settings-page-layout.js", () => ({
  SettingsPageLayout: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("./settings-external-agents-form.js", () => ({
  ExternalAgentsForm: (props: ExternalAgentsFormProps) => {
    state.form = props;
    return null;
  },
}));
vi.mock("./external-agent-setup-sheet.js", () => ({ ExternalAgentSetupSheet: () => null }));

const { ExternalAgentsSettingsController } =
  await import("./settings-external-agents-controller.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

describe("External agents on the phone", () => {
  it("blocks setup and says why when Remote access can't be read", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<ExternalAgentsSettingsController />));
    // A notice disables every Add row, so no sheet can wait forever for an address.
    expect(state.form?.notice).toEqual({
      title: "Remote access couldn’t be checked",
      detail: "The computer did not answer.",
      action: null,
    });
  });
});
