// Round H's real-host run only: a stand-in upstream proxy for the slots' egress. It speaks TLS
// with a certificate from this run's own root, logs every request line it gets and whether its
// Proxy-Authorization is the slot's credentials, refuses any other with 407, and passes an
// accepted one to the run's own forward proxy on the host's loopback. It logs no password.
import { appendFileSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { createServer } from "node:tls";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const record = (row) =>
  appendFileSync(config.log, `${JSON.stringify({ at: Date.now(), ...row })}\n`);
const allowed = new Set(
  Object.values(config.assigned).map(
    (egress) => `Basic ${Buffer.from(`${egress.username}:${egress.password}`).toString("base64")}`,
  ),
);

createServer({ key: readFileSync(config.key), cert: readFileSync(config.cert) }, (socket) => {
  let head = Buffer.alloc(0);
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) {
      if (head.length > 16_384) socket.destroy();
      return;
    }
    socket.off("data", onData);
    const lines = head.subarray(0, end).toString("latin1").split("\r\n");
    const auth = lines
      .find((line) => /^proxy-authorization:/iu.test(line))
      ?.replace(/^[^:]+:\s*/u, "");
    const authOk = auth !== undefined && allowed.has(auth);
    record({ line: lines[0], authOk });
    if (!authOk) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const forward = connect(config.forwardPort, "127.0.0.1", () => {
      forward.write(head);
      socket.pipe(forward).pipe(socket);
    });
    forward.on("error", () => socket.destroy());
    socket.on("error", () => forward.destroy());
  };
  socket.on("data", onData);
  socket.on("error", () => {});
}).listen(config.port, config.address, () =>
  record({ listening: `${config.address}:${config.port}` }),
);
