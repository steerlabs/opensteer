import type { BaseWindow } from "electron";
import type {
  PasskeyAuthenticatorOutcome,
  PasskeyCreationOptions,
  PasskeyRequestOptions,
} from "@opensteer/browser-runtime-core/passkeys";

/** One ceremony for the person at this Mac, shown in the window that presents its tab. */
export type NativePasskeyRequest = {
  readonly operationId: string;
  readonly rpId: string;
  readonly origin: string;
  /** Epoch milliseconds; nothing succeeds after it. */
  readonly deadline: number;
  readonly window: BaseWindow;
} & (
  | { readonly op: "create"; readonly options: PasskeyCreationOptions }
  | { readonly op: "get"; readonly options: PasskeyRequestOptions }
);

/** The operating system's passkey manager, reached from desktop main. */
export interface NativePasskeys {
  available(): boolean;
  perform(request: NativePasskeyRequest, signal: AbortSignal): Promise<PasskeyAuthenticatorOutcome>;
}
