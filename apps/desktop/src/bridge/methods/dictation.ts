import { z } from "zod";
import {
  DictationAvailabilitySchema,
  DictationSessionInputSchema,
} from "@opensteer/protocol/dictation";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";
import { desktopBridgeChannels as channels } from "../desktop-bridge-channels.js";
export function dictationHandlers(
  context: DesktopBridgeContext,
): ReadonlyArray<readonly [string, DesktopBridgeHandler]> {
  const service = () => {
    if (!context.options.dictation) throw new Error("Dictation unavailable");
    return context.options.dictation;
  };
  return [
    [
      channels.dictationAvailability,
      async (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        z.undefined().parse(envelope.input);
        return DictationAvailabilitySchema.parse(await service().availability());
      },
    ],
    ...(["start", "download", "stop", "cancel"] as const).map(
      (method): readonly [string, DesktopBridgeHandler] => {
        const channel = {
          start: channels.dictationStart,
          download: channels.dictationDownload,
          stop: channels.dictationStop,
          cancel: channels.dictationCancel,
        }[method];
        return [
          channel,
          async (event, envelope) => {
            assertAuthorizedRenderer(context, event, envelope);
            await service().command(
              event.sender,
              method,
              DictationSessionInputSchema.parse(envelope.input),
            );
          },
        ];
      },
    ),
    [
      channels.dictationSettings,
      async (event, envelope) => {
        assertAuthorizedRenderer(context, event, envelope);
        z.undefined().parse(envelope.input);
        await service().openMicrophoneSettings();
      },
    ],
  ];
}
