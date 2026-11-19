import {
  accountSource,
  aiEngineAccountRow,
  aiEngineActions,
  engineGroups,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type AiEngineAction,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useState, type ReactNode } from "react";
import { Alert } from "react-native";
import { notDone, settingsFooter, useScreenAction } from "../ui/client-feedback.js";
import type { AiAccountAction, AiAccountsForm } from "./settings-form.types.js";
import { useAccountSignIn } from "./use-account-sign-in.js";

interface AccountInput {
  readonly environmentId: string;
  readonly harnessInstanceId: string;
}

type Accounts = Pick<HostSnapshot, "environments" | "harnesses">;

const selectAccounts = ({ environments, harnesses }: HostSnapshot): Accounts => ({
  environments,
  harnesses,
});
const sameAccounts = (left: Accounts, right: Accounts) =>
  left.environments === right.environments && left.harnesses === right.harnesses;

function primaryAction(action: AiEngineAction | null): AiAccountAction | null {
  return action?.id === "sign-in" || action?.id === "refresh-models"
    ? { id: action.id, label: action.label }
    : null;
}

function menuAction(action: AiEngineAction): readonly AiAccountAction[] {
  return action.id === "make-default" || action.id === "remove"
    ? [{ id: action.id, label: action.label }]
    : [];
}

export function useAiAccounts(host: HostClient): {
  readonly form: AiAccountsForm;
  readonly sheet: ReactNode;
} {
  const { environments, harnesses } = useHostSelector(host, selectAccounts, sameAccounts);
  const [requestedEnvironment, setRequestedEnvironment] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [signInFailure, setSignInFailure] = useState<string | null>(null);
  const signIn = useAccountSignIn(host, (outcome) => {
    setConfirmation(outcome.kind === "done" ? outcome.message : null);
    setSignInFailure(outcome.kind === "failed" ? outcome.message : null);
  });
  const hasHarness = (id: string) => host.getSnapshot().harnesses.find((row) => row.id === id);
  const refreshModels = useScreenAction(host, "harness-catalog-refresh", {
    label: "refresh the models",
    done: "refreshed",
    happened: "the models were refreshed",
    execute: async (input: AccountInput) => {
      unwrapRpcResult(await host.rpc["harness.catalog.refresh"](input));
      // The new models arrive with the next snapshot; a failed reload doesn't undo the refresh.
      void host.refresh().catch(() => undefined);
    },
    // Refreshing a catalog changes nothing else, so checking is asking again.
    reconcile: async (input) => {
      unwrapRpcResult(await host.rpc["harness.catalog.refresh"](input));
      return { kind: "confirmed", value: undefined };
    },
  });
  const makeDefault = useScreenAction(host, "harness-default", {
    label: "change the default account",
    done: "changed",
    happened: "the default account changed",
    execute: async (input: AccountInput) => {
      await host.dispatch({
        ...input,
        idempotencyKey: mutationIdempotencyKey(`harness-default:${input.harnessInstanceId}`),
        type: "harness.default.set",
      });
    },
    reconcile: async (input) =>
      hasHarness(input.harnessInstanceId)?.isDefault === true
        ? { kind: "confirmed", value: undefined }
        : notDone("changed"),
  });
  const remove = useScreenAction(host, "harness-delete", {
    label: "remove the account",
    done: "removed",
    happened: "the account was removed",
    execute: async (input: AccountInput) => {
      await host.dispatch({
        ...input,
        idempotencyKey: mutationIdempotencyKey(`harness-delete:${input.harnessInstanceId}`),
        type: "harness.delete",
      });
    },
    reconcile: async (input) =>
      hasHarness(input.harnessInstanceId)
        ? notDone("removed")
        : { kind: "confirmed", value: undefined },
  });
  const actionLine = refreshModels.line ?? makeDefault.line ?? remove.line;
  const line = signInFailure
    ? { text: signInFailure, tone: "danger" as const }
    : (settingsFooter(actionLine) ?? null);
  const environment =
    environments.find(({ id }) => id === requestedEnvironment) ?? environments[0] ?? null;
  const groups = environment
    ? engineGroups(
        environment,
        harnesses.filter((harness) => harness.environmentId === environment.id),
      )
        .filter((engine) => engine.profiles.length > 0 || engine.addable)
        .map((engine) => ({
          engine,
          accounts: engine.profiles.map((profile) => {
            const catalog = environment.harnessCatalogs.find(
              (candidate) => candidate.harnessInstanceId === profile.id,
            );
            const source = accountSource(environment, profile);
            return {
              actions: aiEngineActions({
                catalog,
                environment,
                profile,
                setupOpenable: true,
                source,
              }),
              profile,
              row: aiEngineAccountRow({
                catalog,
                engineName: engine.engineName,
                environment,
                profile,
                source,
                unavailableReason: engine.unavailableReason,
              }),
              source,
            };
          }),
        }))
    : [];

  const run = (
    id: string,
    action: { readonly run: (input: AccountInput) => Promise<unknown> },
    input: AccountInput,
  ): void => {
    if (busyId !== null) return;
    setBusyId(id);
    setConfirmation(null);
    setSignInFailure(null);
    refreshModels.dismiss();
    makeDefault.dismiss();
    remove.dismiss();
    void action.run(input).finally(() => setBusyId(null));
  };

  const onAction: AiAccountsForm["onAction"] = (harnessInstanceId, action) => {
    if (!environment) return;
    const group = groups.find(({ accounts }) =>
      accounts.some(({ profile }) => profile.id === harnessInstanceId),
    );
    const account = group?.accounts.find(({ profile }) => profile.id === harnessInstanceId);
    if (!group || !account) return;
    const { engineName } = group.engine;
    const environmentId = environment.id;
    switch (action.id) {
      case "sign-in":
        setConfirmation(null);
        setSignInFailure(null);
        signIn.signIn({
          environmentId,
          harnessInstanceId,
          title:
            account.source?.kind === "compatible-endpoint"
              ? `Connect ${account.profile.name}`
              : `Sign in to ${engineName}`,
          whereLabel: environment.name,
        });
        return;
      case "refresh-models":
        run(harnessInstanceId, refreshModels, { environmentId, harnessInstanceId });
        return;
      case "make-default":
        run(harnessInstanceId, makeDefault, { environmentId, harnessInstanceId });
        return;
      case "remove":
        Alert.alert(
          `Remove ${account.row.name} from ${environment.name}?`,
          `${
            account.profile.stateKind === "ambient"
              ? `The ${engineName} CLI on that computer keeps its sign-in — only Opensteer stops using it.`
              : "Its sign-in is deleted."
          } An account an active Thread is using cannot be removed.`,
          [
            { style: "cancel", text: "Cancel" },
            {
              onPress: () => run(harnessInstanceId, remove, { environmentId, harnessInstanceId }),
              style: "destructive",
              text: "Remove",
            },
          ],
        );
        return;
    }
  };

  return {
    form: {
      busyId,
      confirmation,
      line,
      groups: groups.map(({ accounts, engine }) => ({
        addable: engine.addable,
        driverKind: engine.driverKind,
        name: engine.engineName,
        rows: accounts.map(({ actions, profile, row }) => ({
          attention: row.status?.tone === "bad" ? "bad" : row.status ? "warn" : null,
          id: profile.id,
          isDefault: profile.isDefault,
          line: row.line,
          menu: actions.menu.flatMap(menuAction),
          name: row.name,
          primary: primaryAction(actions.primary),
        })),
      })),
      locationId: environment?.id ?? null,
      locations:
        environments.length > 1
          ? environments.map(({ connected, id, name }) => ({
              id,
              title: connected ? name : `${name} · Offline`,
            }))
          : [],
      onAction,
      onAdd: (driverKind) => {
        const engine = groups.find((group) => group.engine.driverKind === driverKind)?.engine;
        if (!engine || !environment) return;
        setConfirmation(null);
        setSignInFailure(null);
        signIn.addAccount(engine, environment);
      },
      onChooseLocation: setRequestedEnvironment,
    },
    sheet: signIn.sheet,
  };
}
