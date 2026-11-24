import path from "node:path";
import { journeyAccountSpki } from "./account-tls.js";

/**
 * What the first-run journey hands the Mac app, besides its own environment: the account service
 * and portal it signs in to, where it keeps its data, and the Home runtime it starts. The journey
 * launches the app with exactly this, and `configuration.test.ts` reads it through the product's
 * own configuration readers on this Mac, so a value the product refuses fails there and not in the
 * VM.
 */
export function journeyAppEnvironment(input: {
  readonly accountOrigin: string;
  readonly dataDirectory: string;
  readonly portalOrigin: string;
  readonly runtime: string;
  /** The fixture authority's certificate file, for an account service served over HTTPS. */
  readonly extraCertificateAuthorities?: string;
  /**
   * The account service's certificate, whose one key the session that talks to the account
   * service accepts in this development launch (`electron-service-network.ts`). Nothing else in
   * the app, the person's browser profiles among it, accepts it.
   */
  readonly accountCertificate?: string;
}): Record<string, string> {
  return {
    ...(input.extraCertificateAuthorities === undefined
      ? {}
      : { NODE_EXTRA_CA_CERTS: input.extraCertificateAuthorities }),
    ...(input.accountCertificate === undefined
      ? {}
      : {
          OPENSTEER_DESKTOP_ACCOUNT_CERTIFICATE_KEY: journeyAccountSpki(input.accountCertificate),
        }),
    OPENSTEER_DESKTOP_ACCOUNT_URL: input.accountOrigin,
    OPENSTEER_DESKTOP_DATA_DIR: input.dataDirectory,
    OPENSTEER_DESKTOP_MODE: "development",
    OPENSTEER_DESKTOP_NATIVE_FS_HELPER: path.join(input.runtime, "bin", "opensteer-native-fs"),
    OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR: input.runtime,
    OPENSTEER_DESKTOP_PORTAL_URL: input.portalOrigin,
  };
}
