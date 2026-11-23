// What an Opensteer Node process on a person's device or Home trusts for TLS:
// Node's own certificate authorities plus the ones its computer trusts, with no
// setup by the person. Every start of a Home service or a Runner takes its
// environment from `nodeTrustEnvironment`; nothing else decides it.
//
// The switch is Node's `--use-system-ca`, given as Node's own variable for it,
// `NODE_USE_SYSTEM_CA=1` (Node 24.6.0 and later). No start path can pass the
// argument form: a Personal service runs through a launcher whose Node flags are
// compiled into it, and Electron's utility process, which runs the desktop's own
// Runner, keeps only a short list of Node arguments and, in a packaged app,
// drops `NODE_OPTIONS`. Node reads the variable in every one of them.
//
// What it reads: on macOS the default and System keychains, where a new root
// counts only with a trust setting the person (with their password) or an
// administrator made; on Windows the system certificate stores; on Linux
// OpenSSL's default certificate file and directory (`/etc/ssl/certs`), which
// `SSL_CERT_FILE` and `SSL_CERT_DIR` redirect. Node loads it once, off the main
// thread, when `tls` is first loaded, and the first TLS connection waits for it.
//
// `OPENSTEER_SYSTEM_CERTIFICATES=off`, set where the app or the Home is started,
// leaves Node's own list only. It can only take trust away, so it is read
// even where nothing else from the environment counts.
//
// This file ships beside the container entrypoint, which imports it, so it has
// no imports of its own.

/** The variable this decides, which the Runner keeps out of the shells it starts. */
export const nodeTrustVariable = "NODE_USE_SYSTEM_CA";

/** The one setting: `off` leaves Node's own certificate list only. */
export const nodeTrustSetting = "OPENSTEER_SYSTEM_CERTIFICATES";

/**
 * Environment names that change which authorities Node trusts, or where it
 * reads the computer's. A program running as the person can set any of them,
 * and none needs the password a keychain trust setting does.
 */
export const nodeTrustInputs = Object.freeze([
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  nodeTrustVariable,
  "OPENSSL_CONF",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
]);

/**
 * The Home's own services among the images the container entrypoint starts.
 * Opensteer account services and the browser images are not a Home's Node
 * process that dials out over TLS, so their trust is left as it is.
 */
export const homeServicePackages = Object.freeze([
  "@opensteer/channel-runtime",
  "@opensteer/host",
  "@opensteer/runner",
]);

/**
 * The environment a Home service or a Runner starts with, as far as TLS trust
 * goes. `drop` is for a desktop app, whose Home and Runners take no trust from
 * the environment the app was started in; `keep` is for a Linux Home, whose
 * environment its operator writes, as `NODE_EXTRA_CA_CERTS` in a Compose layer.
 * Names compare without case, as Windows reads them. `settings` is where
 * `nodeTrustSetting` is read: the starting process's own environment unless
 * a caller names another.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {{
 *   readonly environmentInputs: "drop" | "keep";
 *   readonly settings?: Readonly<Record<string, string | undefined>>;
 * }} options
 * @returns {Record<string, string>}
 */
export function nodeTrustEnvironment(environment, options) {
  if (options.environmentInputs !== "drop" && options.environmentInputs !== "keep") {
    throw new TypeError("environmentInputs must be drop or keep.");
  }
  const systemCertificates = (options.settings ?? process.env)[nodeTrustSetting] !== "off";
  const inputs = new Set(nodeTrustInputs.map((name) => name.toUpperCase()));
  /** @type {Record<string, string>} */
  const started = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    // This function alone says whether the switch is on.
    if (upper === nodeTrustVariable) continue;
    if (options.environmentInputs === "drop" && inputs.has(upper)) continue;
    started[name] = value;
  }
  if (systemCertificates) started[nodeTrustVariable] = "1";
  return started;
}
