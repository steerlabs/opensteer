/** Host-only app authentication protocol; products supply identity and session lifecycle. */
export * from "./contracts/ui-auth.ts";
export {
  appPrivateHeaders,
  appRedirect,
  appSignInCallback,
  appSignInFailed,
} from "./implementation/ui-auth.ts";
