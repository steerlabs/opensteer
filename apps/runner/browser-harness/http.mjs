import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Node's HTTP transport has no implicit five-minute fetch header deadline. */
export function postJson(url, options) {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      url,
      { method: "POST", headers: options.headers, signal: options.signal, agent: false },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.byteLength;
          if (bytes > 8 * 1_024 * 1_024) {
            const error = new Error("Opensteer tool response exceeds the bounded tool transport");
            request.destroy(error);
            response.destroy(error);
            reject(error);
          } else chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}
