import {
  conversationComputerId,
  linkPlaces,
  mutationIdempotencyKey,
  type HostClient,
  type LinkPlace,
} from "@opensteer/client/host";
import { classifyHref } from "@opensteer/core";
import { markdownLink } from "@opensteer/shared/markdownLinks";
import { useNavigation } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useMemo, type ReactNode } from "react";
import { Alert, Linking, Platform, StyleSheet } from "react-native";
import { showPendingBrowserTab } from "../browser/pending-tab-route.js";
import { systemBrowserLabel } from "../browser/system-browser.js";
import { useHereDeviceId } from "../computers/here-device.js";
import { useReferenceNavigation } from "../markdown/reference-context.js";
import { computerSymbols } from "../screens/settings-model.js";
import { color, radius } from "../theme.js";
import { HoldMenu } from "./hold-menu.js";
import { ConversationLinksContext, type ConversationLinks } from "./link-context.js";

/** The system's way, which is how every link opened before a phone could browse. */
export function openOutside(url: string): void {
  void Linking.openURL(url).catch(() => Alert.alert("Link could not be opened", url));
}

/** A link that names something in Opensteer: it opens here, never in a browser or the system. */
export function isInternalHref(href: string): boolean {
  const kind = classifyHref(href).kind;
  return kind === "reference" || kind === "team-page" || kind === "file";
}

/** This phone, as its menu names it beside the computers. */
const hereName = Platform.OS === "ios" ? (Platform.isPad ? "iPad" : "iPhone") : "this phone";

export function ConversationLinksProvider(props: {
  readonly children: ReactNode;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly threadId: string;
}): ReactNode {
  const { deploymentId, hostClient, threadId } = props;
  const navigation = useNavigation();
  const hereId = useHereDeviceId(deploymentId);
  const references = useReferenceNavigation();
  const links = useMemo((): ConversationLinks => {
    const places = (url: string) => {
      const snapshot = hostClient.getSnapshot();
      return linkPlaces(snapshot, {
        conversationRunnerId: conversationComputerId(snapshot, threadId),
        hereId,
        url,
      });
    };
    const openOn = (url: string, place: LinkPlace): void => {
      let opening;
      try {
        opening = hostClient.beginBrowserTabOpen(place.target, {
          url,
          idempotencyKey: mutationIdempotencyKey("reply-link"),
        });
      } catch {
        openOutside(url);
        return;
      }
      const key = opening.idempotencyKey;
      showPendingBrowserTab(navigation, { deploymentId, threadId }, opening, {
        fallback: () => {
          hostClient.dismissPendingBrowserTab(key);
          openOutside(url);
        },
      });
    };
    return {
      Hold: ReadingHold,
      open: (url) => {
        if (isInternalHref(url)) {
          void references?.open(url);
          return;
        }
        const tap = places(url).tap;
        if (tap === null) openOutside(url);
        else openOn(url, tap);
      },
      menu: ({ href: url }) => {
        if (isInternalHref(url))
          return references === null
            ? []
            : [
                { group: 0, id: "open", image: "arrow.up.right", title: "Open" },
                { group: 1, id: "copy", image: "doc.on.doc", title: "Copy" },
              ];
        const { hold } = places(url);
        if (hold.length === 0) return [];
        return [
          ...hold.map((place) => ({
            group: 0,
            id: `open:${place.id}`,
            image: computerSymbols[place.glyph],
            title: `Open on ${place.here ? hereName : place.name}`,
          })),
          { group: 0, id: "outside", image: "safari", title: systemBrowserLabel },
          { group: 1, id: "copy-link", image: "link", title: "Copy link" },
        ];
      },
      act: ({ href: url, label }, id) => {
        if (isInternalHref(url)) {
          if (id === "open") void references?.open(url);
          // The person's own clipboard keeps the link as written, as T3 does.
          else if (id === "copy")
            void Clipboard.setStringAsync(markdownLink(label, url)).then(
              () => Haptics.selectionAsync(),
              noop,
            );
          return;
        }
        if (id === "outside") openOutside(url);
        else if (id === "copy-link")
          void Clipboard.setStringAsync(url).then(() => Haptics.selectionAsync(), noop);
        else {
          const place = places(url).hold.find((candidate) => `open:${candidate.id}` === id);
          if (place) openOn(url, place);
        }
      },
    };
  }, [deploymentId, hereId, hostClient, navigation, references, threadId]);
  return (
    <ConversationLinksContext.Provider value={links}>
      {props.children}
    </ConversationLinksContext.Provider>
  );
}

/**
 * Selectable words take no menu of their own; only a link held in them does.
 * Lifted, they keep the page's ground, so nothing under them shows through.
 */
function ReadingHold(props: { readonly children: ReactNode }): ReactNode {
  return (
    <HoldMenu actions={noActions} onAction={noop} previewRadius={radius.md} style={styles.reading}>
      {props.children}
    </HoldMenu>
  );
}

const noActions: readonly never[] = [];
function noop(): void {}

const styles = StyleSheet.create({ reading: { backgroundColor: color.background } });
