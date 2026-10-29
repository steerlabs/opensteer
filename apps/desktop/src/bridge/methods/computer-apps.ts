import {
  DesktopComputerAppSetupStatusSchema,
  DesktopComputerAppSetupTargetSchema,
  DesktopComputerUseApprovalKeyResultSchema,
  DesktopOpenComputerAppSetupInputSchema,
  DesktopOpenComputerAppSetupResultSchema,
  DesktopReviewComputerAppSetupInputSchema,
  DesktopReviewComputerAppSetupResultSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

/**
 * The public half of this desktop's approval key. Registering it is the page's
 * own Host call, made with the person's session on this Mac; the private half
 * never leaves main.
 */
export const handleComputerUseApprovalKey =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DesktopComputerUseApprovalKeyResultSchema.parse(
      await context.options.computerApps.approvalKey(),
    );
  };

export const handleReviewComputerAppSetup =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const input = DesktopReviewComputerAppSetupInputSchema.parse(envelope.input);
    // The page created this request through its own Host calls, which reach
    // the Deployment it is attached to now; the request arrives from that
    // Deployment's Runner slot, and the wait is bound to it even if the window
    // moves to another Deployment while the panel is open.
    const { resolved } = await context.options.hostTransport.current();
    return DesktopReviewComputerAppSetupResultSchema.parse(
      await context.options.computerApps.review(resolved.deploymentId, input.setupRequestId),
    );
  };

/**
 * Opens this Mac's setup panel for one app the helper serves, from the app's
 * row on this Mac's page. Every step it then takes — the pane it opens, the
 * question it asks — is main's own: the page names only the app and access.
 */
export const handleOpenComputerAppSetup =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const input = DesktopOpenComputerAppSetupInputSchema.parse(envelope.input);
    return DesktopOpenComputerAppSetupResultSchema.parse(
      await context.options.computerApps.setup.open(input),
    );
  };

/** What the setup panel draws, polled while it is open. */
export const handleComputerAppSetupStatus =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DesktopComputerAppSetupStatusSchema.parse(
      await context.options.computerApps.setup.status(),
    );
  };

/** The person chose Set up on the offer an agent's missing grant brought up. */
export const handleComputerAppSetupBegin =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    await context.options.computerApps.setup.begin(
      DesktopComputerAppSetupTargetSchema.parse(envelope.input),
    );
  };

/** The step again: its System Settings pane, or macOS's question. */
export const handleComputerAppSetupShowAgain =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    await context.options.computerApps.setup.showAgain();
  };

/**
 * A native drag of the installed helper, started from the panel's own row, so
 * the person can drop it into System Settings' list when macOS has not listed
 * it. The file is main's: the page cannot name what is dragged. macOS needs a
 * picture under the pointer; the helper bundle's own icon is it.
 */
export const handleComputerAppSetupStartDrag =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const item = context.options.computerApps.setup.dragItem();
    if (!item) return;
    const icon = await context.options.computerApps.dragIcon(item.file);
    event.sender.startDrag({ file: item.file, icon });
  };

export const handleCloseComputerAppSetup =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    await context.options.computerApps.setup.close(
      DesktopComputerAppSetupTargetSchema.parse(envelope.input),
    );
  };
