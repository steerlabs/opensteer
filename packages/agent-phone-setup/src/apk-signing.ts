/**
 * Who signed an APK, read from its APK Signing Block.
 *
 * Android verifies an app's signature before installing it, so the signers of
 * the scheme it verified in an installed `base.apk` are the identity Android
 * holds the app to. Setup reads them rather than asking the installed app who
 * it is: an app that merely shares our package name would answer whatever it
 * liked. Which scheme Android verified depends on what the APK carries, so each
 * certificate keeps the scheme that carried it.
 *
 * Layout (https://source.android.com/docs/security/features/apksigning/v2):
 * the block sits immediately before the ZIP central directory, framed by its
 * size at both ends and the magic `APK Sig Block 42`; it holds ID-value pairs,
 * and a v2 or v3 value is a length-prefixed list of signers whose signed data
 * leads with their digests and then their certificate chains.
 */

const endOfCentralDirectorySignature = 0x06054b50;
const endOfCentralDirectoryBytes = 22;
const maximumZipCommentBytes = 0xffff;
const signingBlockMagic = "APK Sig Block 42";
const signingBlockFooterBytes = 24;

/**
 * The signing-block schemes setup reads. v3.1 is the rotation block only
 * Android 13 and newer verifies; Android 11 and 12 ignore it entirely.
 */
const signatureSchemes = new Map<number, ApkSignatureScheme>([
  [0x7109871a, "v2"],
  [0xf05368c0, "v3"],
  [0x1b93ad61, "v3.1"],
]);

type ApkSignatureScheme = "v2" | "v3" | "v3.1";

/** The signing certificate of each signer, under the scheme whose block carried it. */
export type ApkSignatureSchemes = Partial<Record<ApkSignatureScheme, readonly Uint8Array[]>>;

/**
 * The signing certificate (DER) of every v2, v3 and v3.1 signer, in block
 * order under its scheme; null when the bytes carry no such signature or are
 * malformed. Every signer is reported, not just the first.
 */
export function apkSignatureSchemes(apk: Uint8Array): ApkSignatureSchemes | null {
  const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
  const centralDirectoryOffset = centralDirectoryStart(view);
  if (centralDirectoryOffset === null) return null;
  const pairs = signingBlockPairs(apk, view, centralDirectoryOffset);
  if (pairs === null) return null;
  const schemes: Partial<Record<ApkSignatureScheme, Uint8Array[]>> = {};
  let offset = pairs.start;
  while (offset < pairs.end) {
    if (pairs.end - offset < 12) return null;
    const length = safeUint64(view, offset);
    if (length === null || length < 4 || length > pairs.end - offset - 8) return null;
    const scheme = signatureSchemes.get(view.getUint32(offset + 8, true));
    if (scheme !== undefined) {
      const signers = schemeSigningCertificates(apk, offset + 12, offset + 8 + length);
      if (signers === null) return null;
      (schemes[scheme] ??= []).push(...signers);
    }
    offset += 8 + length;
  }
  return Object.keys(schemes).length > 0 ? schemes : null;
}

/**
 * Whether an APK read from an installed package was verified by the phone as
 * signed by the expected certificate alone, which `isExpected` recognizes.
 *
 * Android 11 and newer verifies the strongest scheme it supports that the APK
 * carries: v3 when present, otherwise v2, and v3.1 above both from Android 13.
 * A v3 block with no signer for the device's SDK rejects installation rather
 * than falling back to v1, so v3 alone also establishes an installed identity.
 * With neither v2 nor v3 it falls back to v1, whose signer setup does not read,
 * so such an APK — v1 alone, or v1 with a v3.1 block Android 11 and 12 ignore —
 * has no identity setup can establish. Otherwise every signer of every block
 * present must be the expected one: then whichever block the phone verified
 * names it, on any Android version, without needing to know which, and a
 * block it ignored can never vouch for the app on its own. Key rotation is
 * not supported: the Opensteer signer is permanent, so any other signer,
 * rotated or not, makes the app foreign.
 */
export async function apkSignedOnlyBy(
  apk: Uint8Array,
  isExpected: (certificate: Uint8Array) => Promise<boolean>,
): Promise<boolean> {
  const schemes = apkSignatureSchemes(apk);
  if (schemes === null || (schemes.v2 === undefined && schemes.v3 === undefined)) return false;
  for (const certificates of Object.values(schemes)) {
    for (const certificate of certificates) {
      if (!(await isExpected(certificate))) return false;
    }
  }
  return true;
}

/** Where the central directory starts, as the end-of-central-directory record says. */
function centralDirectoryStart(view: DataView): number | null {
  const lastStart = view.byteLength - endOfCentralDirectoryBytes;
  const firstStart = Math.max(0, lastStart - maximumZipCommentBytes);
  for (let start = lastStart; start >= firstStart; start -= 1) {
    if (view.getUint32(start, true) !== endOfCentralDirectorySignature) continue;
    // A signature inside the comment is not the record: the real one's comment
    // length reaches exactly to the end of the file.
    if (view.getUint16(start + 20, true) !== lastStart - start) continue;
    const size = view.getUint32(start + 12, true);
    const offset = view.getUint32(start + 16, true);
    return offset + size === start ? offset : null;
  }
  return null;
}

function signingBlockPairs(
  apk: Uint8Array,
  view: DataView,
  centralDirectoryOffset: number,
): { readonly end: number; readonly start: number } | null {
  const footer = centralDirectoryOffset - signingBlockFooterBytes;
  if (footer < 8) return null;
  const magic = new TextDecoder().decode(apk.subarray(footer + 8, centralDirectoryOffset));
  if (magic !== signingBlockMagic) return null;
  const size = safeUint64(view, footer);
  if (size === null || size < signingBlockFooterBytes || size + 8 > centralDirectoryOffset) {
    return null;
  }
  const start = centralDirectoryOffset - size - 8;
  if (safeUint64(view, start) !== size) return null;
  return { end: footer, start: start + 8 };
}

/** The first certificate of each signer in one v2, v3 or v3.1 value spanning [start, end). */
function schemeSigningCertificates(
  apk: Uint8Array,
  start: number,
  end: number,
): Uint8Array[] | null {
  const signers = lengthPrefixed(apk, start, end);
  if (signers === null || signers.end !== end) return null;
  const certificates: Uint8Array[] = [];
  let offset = signers.start;
  while (offset < signers.end) {
    const signer = lengthPrefixed(apk, offset, signers.end);
    if (signer === null) return null;
    const signedData = lengthPrefixed(apk, signer.start, signer.end);
    if (signedData === null) return null;
    const digests = lengthPrefixed(apk, signedData.start, signedData.end);
    if (digests === null) return null;
    const chain = lengthPrefixed(apk, digests.end, signedData.end);
    if (chain === null) return null;
    const first = lengthPrefixed(apk, chain.start, chain.end);
    if (first === null || first.start === first.end) return null;
    certificates.push(apk.subarray(first.start, first.end));
    offset = signer.end;
  }
  return certificates.length > 0 ? certificates : null;
}

/** A uint32-length-prefixed field at `offset`, which must end by `limit`. */
function lengthPrefixed(
  apk: Uint8Array,
  offset: number,
  limit: number,
): { readonly end: number; readonly start: number } | null {
  if (limit - offset < 4) return null;
  const length = new DataView(apk.buffer, apk.byteOffset + offset, 4).getUint32(0, true);
  const start = offset + 4;
  return length > limit - start ? null : { end: start + length, start };
}

function safeUint64(view: DataView, offset: number): number | null {
  if (offset < 0 || offset + 8 > view.byteLength) return null;
  const value = view.getBigUint64(offset, true);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}
