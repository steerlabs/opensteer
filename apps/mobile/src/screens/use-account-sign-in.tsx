import {
  accountCreateRequest,
  startAccountSignIn,
  type AccountSignInFlow,
  type AccountSignInTarget,
  type AddAccountChoice,
  type EngineGroup,
  type EnvironmentSummary,
  type HostClient,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { AccountSignInSheet } from "./account-sign-in-sheet.js";

export type AccountSignInOutcome =
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

interface OpenSheet {
  readonly added: boolean;
  readonly choosing: React.ComponentProps<typeof AccountSignInSheet>["choosing"];
  readonly flow: AccountSignInFlow | null;
  readonly key: number;
  readonly title: string;
  readonly whereLabel: string;
}

/**
 * The one way a screen opens the sign-in sheet. Render `sheet` beside the
 * screen's content; what happens once it has closed comes back through `report`.
 */
export function useAccountSignIn(
  client: HostClient,
  report: (outcome: AccountSignInOutcome) => void,
) {
  const [open, setOpen] = useState<OpenSheet | null>(null);
  const flowRef = useRef<AccountSignInFlow | null>(null);
  const nextKey = useRef(0);
  useEffect(
    () => () => {
      void flowRef.current?.cancel();
    },
    [],
  );

  const begin = (
    key: number,
    target: AccountSignInTarget,
    title: string,
    whereLabel: string,
  ): void => {
    const flow = startAccountSignIn({
      client,
      errorMessage: (cause) => operationDetail(cause, "That did not finish. Try again."),
      target,
    });
    flowRef.current = flow;
    setOpen({ added: target.kind === "create", choosing: null, flow, key, title, whereLabel });
  };
  const addAccount = (engine: EngineGroup, environment: EnvironmentSummary): void => {
    const key = (nextKey.current += 1);
    const title = `Add ${engine.engineName} account`;
    const start = (choice: AddAccountChoice) =>
      begin(
        key,
        {
          kind: "create",
          request: accountCreateRequest({
            choice,
            driverKind: engine.driverKind,
            engineName: engine.engineName,
            environmentId: environment.id,
            harnesses: client.getSnapshot().harnesses,
          }),
        },
        title,
        environment.name,
      );
    const only = engine.sources.length === 1 ? engine.sources[0] : undefined;
    if (only && only.fields.length === 0) {
      start({ fields: {}, source: only });
      return;
    }
    setOpen({
      added: true,
      choosing: { onContinue: start, sources: engine.sources },
      flow: null,
      key,
      title,
      whereLabel: environment.name,
    });
  };
  const signIn = (input: {
    readonly environmentId: string;
    readonly harnessInstanceId: string;
    readonly title: string;
    readonly whereLabel: string;
  }): void => {
    begin(
      (nextKey.current += 1),
      {
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
        kind: "existing",
      },
      input.title,
      input.whereLabel,
    );
  };
  const close = (): void => {
    const flow = flowRef.current;
    flowRef.current = null;
    setOpen(null);
    // The sheet is gone by now, so a cleanup that failed can only be said on the screen under it.
    void flow?.cancel().then(() => {
      const state = flow.getState();
      if (state.kind === "failed") report({ kind: "failed", message: state.message });
    });
  };

  const sheet: ReactNode =
    open === null ? null : (
      <AccountSignInSheet
        choosing={open.choosing}
        flow={open.flow}
        key={open.key}
        onClose={close}
        onDone={({ accountLabel }) => {
          flowRef.current = null;
          setOpen(null);
          const message = open.added
            ? accountLabel
              ? `Added ${accountLabel}`
              : "Account added"
            : accountLabel
              ? `Signed in as ${accountLabel}`
              : "Signed in";
          void AccessibilityInfo.announceForAccessibility(message);
          report({ kind: "done", message });
        }}
        title={open.title}
        whereLabel={open.whereLabel}
      />
    );
  return { addAccount, sheet, signIn };
}

/** What the sheet is called when an existing account is signed in from where it is used. */
export function placementSignIn(placement: ThreadPlacementOption) {
  return {
    environmentId: placement.environmentId,
    harnessInstanceId: placement.harnessInstanceId,
    title:
      placement.source?.kind === "compatible-endpoint"
        ? `Connect ${placement.accountName}`
        : `Sign in to ${placement.engineName}`,
    whereLabel: placement.whereLabel,
  };
}
