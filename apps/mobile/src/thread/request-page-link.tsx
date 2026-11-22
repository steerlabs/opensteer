import { isQuestionRequest, workWords, type HostClient } from "@opensteer/client/host";
import { useRequestPageTab } from "@opensteer/client/react";
import type { Request, TabId } from "@opensteer/core";
import type { ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import { touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/** A question or a sign-in, which is answered in a page: its page is one tap away. */
export function answeredInAPage(
  request: Pick<Request, "kind" | "payload" | "presentation">,
): boolean {
  return (
    isQuestionRequest(request) ||
    request.payload.kind === "browser.sign-in" ||
    request.payload.kind === "browser.password-sign-in"
  );
}

/**
 * "Open the page": the page a Request is about, one tap away, so the person signs in there,
 * then answers. The tab the Request names while the tab list still holds it, or, when it names
 * none, its task's only page. Nothing when that is not one page.
 */
export function RequestPageLink(props: {
  readonly hostClient: HostClient;
  readonly onOpen: (tabId: TabId) => void;
  readonly request: Parameters<typeof useRequestPageTab>[1] & {};
}): ReactNode {
  const page = useRequestPageTab(props.hostClient, props.request);
  return page === null ? null : (
    <Pressable
      accessibilityLabel={workWords("ask.openPage")}
      accessibilityRole="link"
      onPress={() => props.onOpen(page.tabId)}
      style={styles.link}
    >
      <AppText role="secondaryMedium" tone="ember">
        {workWords("ask.openPage")}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { alignSelf: "flex-start", justifyContent: "center", minHeight: touchTarget },
});
