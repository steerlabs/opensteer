import type { HostClient } from "@opensteer/client/host";
import {
  refTarget,
  type FileOpenInput,
  type PersonalReferenceNavigationPorts,
  type ReferenceDestination,
  type ReferenceNavigationPorts,
} from "@opensteer/client/references";
import type { TeamSessionClient } from "@opensteer/client/team";
import { classifyHref, teamPageUrl, type ThreadId } from "@opensteer/core";
import { StackActions, useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Alert } from "react-native";
import { isRecord } from "@opensteer/shared/isRecord";
import type { MobileClient } from "../client/mobile-client.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { ReferenceNavigationContext, type ReferenceNavigation } from "./reference-context.js";
import { readFailure } from "../ui/unavailable-state.js";

/** An open that a newer open, or another Deployment's selection, made moot. */
class Superseded extends Error {
  override readonly name = "AbortError";
}

/**
 * The attached Host of exactly this Deployment, opening it when it is not the
 * one attached. A selection that moves while it opens cancels this open rather
 * than letting another Deployment answer for these words.
 */
async function attachedHost(
  mobile: Pick<MobileClient, "getSnapshot" | "openDeployment" | "subscribe">,
  deploymentId: string,
  signal: AbortSignal,
): Promise<HostClient> {
  const held = mobile.getSnapshot().selection;
  if (held.deploymentId === deploymentId && held.hostClient !== null) return held.hostClient;
  await mobile.openDeployment(deploymentId);
  return currentHost(mobile, deploymentId, signal);
}

function currentHost(
  mobile: Pick<MobileClient, "getSnapshot">,
  deploymentId: string,
  signal: AbortSignal,
): HostClient {
  const selection = mobile.getSnapshot().selection;
  if (signal.aborted || selection.deploymentId !== deploymentId || selection.hostClient === null)
    throw new Superseded("Another Deployment was opened");
  return selection.hostClient;
}

function cannotOpen(): void {
  Alert.alert("Couldn't open this", "Try again.");
}

/**
 * The words of one personal Deployment: its tasks, Runs, Requests, automations,
 * computers, attachments and files, each opened on that Deployment's screens.
 */
export function PersonalReferenceProvider(props: {
  readonly children: ReactNode;
  readonly client: HostClient;
  readonly deploymentId: string;
  readonly threadId: string | null;
}): ReactNode {
  const { client, deploymentId } = props;
  const threadId = (props.threadId as ThreadId | null) ?? null;
  const navigation = useNavigation();
  const mobile = useMobileClient();
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);
  const value = useMemo((): ReferenceNavigation => {
    /** Opens a Thread, going back to it when it is the screen just under this one. */
    const openThread = (params: { deploymentId: string; threadId: string }) => {
      const state = navigation.getState();
      const sameThread = (route: { name: string; params?: object | undefined } | undefined) =>
        route?.name === "Thread" &&
        isRecord(route.params) &&
        route.params["threadId"] === params.threadId &&
        route.params["deploymentId"] === params.deploymentId;
      if (state === undefined || sameThread(state.routes[state.index])) return;
      if (sameThread(state.routes[state.index - 1])) navigation.goBack();
      else navigation.dispatch(StackActions.push("Thread", params));
    };
    const ports: PersonalReferenceNavigationPorts = {
      openReference: async (destination: ReferenceDestination) => {
        switch (destination.kind) {
          case "task":
            openThread({ deploymentId, threadId: destination.threadId });
            return;
          case "message":
            if (destination.location === "input-queue")
              openThread({ deploymentId, threadId: destination.threadId });
            else
              navigation.dispatch(
                StackActions.push("Thread", {
                  deploymentId,
                  messageId: destination.messageId,
                  threadId: destination.threadId,
                }),
              );
            return;
          case "request":
            navigation.navigate("RequestSheet", {
              deploymentId,
              opened: "reference",
              requestId: destination.requestId,
              threadId: destination.threadId,
            });
            return;
          case "run":
            navigation.navigate("ConversationActivity", {
              anchorMessageId: destination.anchorMessageId,
              deploymentId,
              runId: destination.runId,
              threadId: destination.threadId,
            });
            return;
          case "automation":
            navigation.dispatch(
              StackActions.push("Schedule", { deploymentId, triggerId: destination.triggerId }),
            );
            return;
          case "computer":
            navigation.navigate("Computer", { deploymentId, machineId: destination.runnerId });
            return;
          case "attachment":
            // A stored attachment is the person's own, wherever it was sent: its preview and
            // Download are the file viewer's, read without a conversation.
            navigation.navigate("FileViewer", {
              deploymentId,
              source: { attachmentId: destination.attachmentId, kind: "attachment" },
              threadId: null,
            });
            return;
        }
      },
      openTeamPage: async (page) => {
        navigation.navigate("JoinTeam", { link: teamPageUrl(page) });
      },
      openFile: async (input: FileOpenInput) => {
        navigation.navigate("FileViewer", { deploymentId, threadId, ...input });
      },
    };
    const open = async (href: string): Promise<void> => {
      const link = classifyHref(href);
      if (link.kind !== "reference" && link.kind !== "team-page" && link.kind !== "file") return;
      // As T3 does, a newer tap replaces one still on its way.
      current.current?.abort();
      const controller = new AbortController();
      current.current = controller;
      const release = mobile.subscribe(() => {
        const selection = mobile.getSnapshot().selection.deploymentId;
        if (selection !== null && selection !== deploymentId) controller.abort();
      });
      let host: HostClient | null = null;
      try {
        void Haptics.selectionAsync();
        if (link.kind === "team-page") return await ports.openTeamPage(link.page);
        host = await attachedHost(mobile, deploymentId, controller.signal);
        if (link.kind === "file") {
          const { path, ...position } = link.file;
          return await ports.openFile({ source: { kind: "path", path }, ...position });
        }
        // Held or recently confirmed answers open at once; anything else is asked for now.
        const answer = await host.references.resolve(link.reference.id);
        currentHost(mobile, deploymentId, controller.signal);
        // Unavailable is drawn by the chip itself, from the same store.
        if (answer.status === "available") await ports.openReference(refTarget(answer));
      } catch (error) {
        if (error instanceof Superseded || controller.signal.aborted) return;
        // A stale positive the Host now refuses becomes the same unavailable chip.
        if (link.kind === "reference" && host !== null && readFailure(error) === "unavailable")
          host.references.unavailable(link.reference.id);
        else cannotOpen();
      } finally {
        release();
        if (current.current === controller) current.current = null;
      }
    };
    return {
      context: { kind: "personal", client, deploymentId, threadId },
      ports,
      open,
    };
  }, [client, deploymentId, mobile, navigation, threadId]);
  return (
    <ReferenceNavigationContext.Provider value={value}>
      {props.children}
    </ReferenceNavigationContext.Provider>
  );
}

/**
 * The words of one team: its pages open through that team's own session and
 * its authorized reads. A personal Opensteer's references and files mean
 * nothing here, so they stay words.
 */
export function TeamReferenceProvider(props: {
  readonly children: ReactNode;
  readonly client: TeamSessionClient | null;
  readonly origin: string;
  readonly teamId: string;
}): ReactNode {
  const { client, origin, teamId } = props;
  const navigation = useNavigation();
  const value = useMemo((): ReferenceNavigation => {
    const ports: ReferenceNavigationPorts = {
      openReference: async () => undefined,
      openTeamPage: async (page) => {
        navigation.navigate("JoinTeam", { link: teamPageUrl(page) });
      },
    };
    return {
      context: { kind: "team", client, origin, teamId },
      ports,
      open: async (href) => {
        const link = classifyHref(href);
        if (link.kind !== "team-page") return;
        void Haptics.selectionAsync();
        await ports.openTeamPage(link.page).catch(cannotOpen);
      },
    };
  }, [client, navigation, origin, teamId]);
  return (
    <ReferenceNavigationContext.Provider value={value}>
      {props.children}
    </ReferenceNavigationContext.Provider>
  );
}
