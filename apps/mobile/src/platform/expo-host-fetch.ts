import { attachmentMaxBytes } from "@opensteer/core";
import { File } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import type { HostFetch } from "./host-network.js";

/** Keep every Host request on Expo's native fetch. Converting a private draft
 * file to bounded bytes preserves the RPC's octet-stream content type. */
export const mobileHostFetch: HostFetch = async (input, init) => {
  const body = init?.body;
  if (!(body instanceof File)) return expoFetch(input, init);
  if (body.size > attachmentMaxBytes) throw new Error("The attachment exceeds 25 MB.");
  if (init?.signal?.aborted) throw init.signal.reason;
  const bytes = await body.bytes();
  if (bytes.byteLength > attachmentMaxBytes || bytes.byteLength !== body.size) {
    throw new Error("The attachment changed before it could be sent.");
  }
  if (init?.signal?.aborted) throw init.signal.reason;
  return expoFetch(input, { ...init, body: bytes });
};
