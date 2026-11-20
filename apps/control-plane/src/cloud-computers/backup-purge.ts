import { createHash, createHmac } from "node:crypto";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";

export interface BackupStorage {
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type BackupPurgeStep = (storage: BackupStorage) => Promise<boolean>;

export const purgeBackupObjects: BackupPurgeStep = async (storage) => {
  const signal = AbortSignal.timeout(8_000);
  const prefix = `${storage.prefix}/`;
  const query = { "encoding-type": "url", "max-keys": "16", prefix, versions: "" };
  const xml = await s3(storage, "GET", "", query, signal);
  const page = parseVersions(xml, prefix);
  if (!page.length) return true;

  for (const { key, version } of page) {
    const path = key.split("/").map(encode).join("/");
    await s3(storage, "DELETE", path, { versionId: version }, signal);
  }
  return false;
};

function parseVersions(xml: string, prefix: string) {
  const document = xml.trim().replace(/^<\?xml[^?]*\?>\s*/u, "");
  const root =
    /^<ListVersionsResult(?: xmlns="http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/")?>([\s\S]*)<\/ListVersionsResult>$/u.exec(
      document,
    )?.[1];
  if (
    root === undefined ||
    !/<IsTruncated>(?:true|false)<\/IsTruncated>/u.test(root) ||
    /<!/u.test(root) ||
    !root.includes("<EncodingType>url</EncodingType>") ||
    decodeURIComponent(/<Prefix>([^<]+)<\/Prefix>/u.exec(root)?.[1] ?? "") !== prefix
  )
    throw new Error("Invalid backup storage listing");
  const array = [];
  for (const match of root.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/gu)) {
    const body = match[2]!;
    const encoded = /<Key>([^<]+)<\/Key>/u.exec(body)?.[1];
    const version = /<VersionId>([A-Za-z0-9./_+=-]+)<\/VersionId>/u.exec(body)?.[1];
    const key = encoded ? decodeURIComponent(encoded) : "";
    if (
      !key.startsWith(prefix) ||
      key.split("/").some((segment) => segment === "." || segment === "..") ||
      !version
    )
      throw new Error("Invalid backup storage object identity");
    array.push({ key, version });
  }
  if (
    array.length !== [...root.matchAll(/<(?:Version|DeleteMarker)(?:[\s/>])/gu)].length ||
    array.length > 16 ||
    (!array.length && !root.includes("<IsTruncated>false</IsTruncated>"))
  )
    throw new Error("Invalid backup storage listing");
  return array;
}

const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value).digest();
const emptyHash = hash("");

async function s3(
  storage: BackupStorage,
  method: string,
  object: string,
  query: Readonly<Record<string, string>>,
  signal: AbortSignal,
) {
  const path = `/${encode(storage.bucket)}${object ? `/${object}` : ""}`;
  const search = Object.keys(query)
    .sort()
    .map((key) => `${encode(key)}=${encode(query[key]!)}`)
    .join("&");
  const url = new URL(`${path}?${search}`, storage.endpoint);
  const dateTime = new Date().toISOString().replace(/[-:]|\.\d{3}/gu, "");
  const date = dateTime.slice(0, 8);
  const scope = `${date}/${storage.region}/s3/aws4_request`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const headers = `host:${url.host}\nx-amz-content-sha256:${emptyHash}\nx-amz-date:${dateTime}\n`;
  const request = `${method}\n${path}\n${search}\n${headers}\n${signedHeaders}\n${emptyHash}`;
  const key = hmac(
    hmac(hmac(hmac(`AWS4${storage.secretAccessKey}`, date), storage.region), "s3"),
    "aws4_request",
  );
  const signature = hmac(key, `AWS4-HMAC-SHA256\n${dateTime}\n${scope}\n${hash(request)}`).toString(
    "hex",
  );
  const response = await fetch(url, {
    method,
    headers: {
      "x-amz-content-sha256": emptyHash,
      "x-amz-date": dateTime,
      authorization: `AWS4-HMAC-SHA256 Credential=${storage.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    redirect: "error",
    signal,
  });
  if (!response.ok || method === "DELETE") {
    await response.body?.cancel();
    if (!response.ok) throw new Error("Cloud Computer backup storage operation failed");
    return "";
  }
  return new TextDecoder().decode(
    await readBoundedResponse(response, { maximumBytes: 128 * 1024, signal }),
  );
}
