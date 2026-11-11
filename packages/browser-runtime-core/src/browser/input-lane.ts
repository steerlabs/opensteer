import { BrowserInputLane as PortableInputLane } from "@opensteer/browser-core/input-lane";
import type { BrowserClientMessage } from "@opensteer/protocol/browser";
export type { InputLaneDiagnostic } from "@opensteer/browser-core/input-lane";
export class BrowserInputLane extends PortableInputLane {
  constructor(
    limit: number,
    execute: (message: BrowserClientMessage) => Promise<void>,
    refuse: (message: BrowserClientMessage, reason: string) => Promise<void>,
    surfaceId?: string,
    onIdle?: () => void,
  ) {
    super(
      limit,
      execute,
      refuse,
      surfaceId,
      (record) => {
        if (process.env.OPENSTEER_BROWSER_DIAGNOSTICS === "1")
          console.info(JSON.stringify({ browserInput: true, ...record }));
      },
      onIdle,
    );
  }
}
