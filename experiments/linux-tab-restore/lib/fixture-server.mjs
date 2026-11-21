import { once } from "node:events";
import { createServer } from "node:http";

/** Generates a tiny valid 1-second 8kHz 8-bit mono PCM WAV file (440 Hz sine wave). */
function makeWavBuffer() {
  const sampleRate = 8000;
  const numSamples = sampleRate;
  const dataSize = numSamples;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(128 + 40 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    buf[44 + i] = sample;
  }
  return buf;
}

const WAV_BYTES = makeWavBuffer();

export async function startFixtureServer() {
  const requests = [];
  let postCounter = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        at: Date.now(),
        host: req.headers.host ?? "",
        method: req.method ?? "GET",
        path: pathname + url.search,
        body,
      });

      if (pathname === "/tone.wav") {
        res.writeHead(200, {
          "content-type": "audio/wav",
          "content-length": WAV_BYTES.length,
          "cache-control": "public, max-age=3600",
        });
        res.end(WAV_BYTES);
        return;
      }

      if (pathname === "/article") {
        const paragraphs = Array.from(
          { length: 80 },
          (_, i) =>
            `<p id="p-${i}" style="height:80px;margin:20px 0;">Paragraph ${i}: Opensteer Cloud Computer long article test content.</p>`,
        ).join("\n");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Long Article</title><body><h1>Long Article</h1>${paragraphs}</body>`,
        );
        return;
      }

      if (pathname === "/form") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<meta charset="utf-8"><title>Half-Filled Form</title>
<body>
  <form id="f" method="post" action="/post-result">
    <input id="text-input" name="title" type="text" value="" />
    <textarea id="notes" name="notes"></textarea>
    <select id="priority" name="priority">
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
    </select>
    <input id="agree" name="agree" type="checkbox" />
    <input id="secret" name="secret" type="password" value="" />
    <div id="editor" contenteditable="true" style="border:1px solid #888;min-height:40px;">initial</div>
    <button id="submit-btn" type="submit">Submit</button>
  </form>
</body>`);
        return;
      }

      if (pathname === "/spa" || pathname.startsWith("/spa/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<meta charset="utf-8"><title>SPA History</title>
<body>
  <div id="view"></div>
  <script>
    window.__popEvents = [];
    window.addEventListener("popstate", (e) => {
      window.__popEvents.push({ path: location.pathname, state: e.state });
      document.getElementById("view").textContent = location.pathname + " " + JSON.stringify(e.state);
    });
    document.getElementById("view").textContent = location.pathname + " " + JSON.stringify(history.state);
  </script>
</body>`);
        return;
      }

      if (pathname === "/session-storage") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<meta charset="utf-8"><title>Session Storage Page</title>
<body>
  <div id="out"></div>
  <script>
    window.__readAtLoad = sessionStorage.getItem("wizard_step");
    document.getElementById("out").textContent = window.__readAtLoad ?? "EMPTY";
  </script>
</body>`);
        return;
      }

      if (pathname === "/post-form") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<meta charset="utf-8"><title>POST Form</title>
<body>
  <form id="pf" method="post" action="/post-result">
    <input name="order" value="ORD-9981" />
    <input name="note" value="ship-fast" />
    <button id="go" type="submit">Send POST</button>
  </form>
</body>`);
        return;
      }

      if (pathname === "/post-result") {
        postCounter += 1;
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(`<!doctype html>
<meta charset="utf-8"><title>POST Result</title>
<body>
  <div id="method">${req.method}</div>
  <div id="body">${body}</div>
  <div id="nonce">${postCounter}</div>
</body>`);
        return;
      }

      if (pathname === "/beforeunload") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<meta charset="utf-8"><title>BeforeUnload Guard</title>
<body>
  <input id="draft" name="draft" type="text" value="" />
  <script>
    window.__beforeUnloadFired = false;
    window.__handlerActive = true;
    window.addEventListener("beforeunload", (e) => {
      window.__beforeUnloadFired = true;
      e.preventDefault();
      e.returnValue = "";
    });
  </script>
</body>`);
        return;
      }

      if (pathname === "/media") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<meta charset="utf-8"><title>Playing Media</title>
<body>
  <audio id="player" src="/tone.wav" controls loop></audio>
  <script>
    window.__playResult = null;
    window.startAudio = async () => {
      const a = document.getElementById("player");
      try {
        await a.play();
        window.__playResult = "playing";
      } catch (e) {
        window.__playResult = "error:" + e.name;
      }
      return window.__playResult;
    };
  </script>
</body>`);
        return;
      }

      if (pathname === "/heavy") {
        const sizeMb = Math.min(20, Math.max(1, Number(url.searchParams.get("mb") ?? "4")));
        const label = url.searchParams.get("label") ?? "tab";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<meta charset="utf-8"><title>Heavy ${label}</title>
<body>
  <h1 id="label">${label}</h1>
  <input id="field" name="field" value="" />
  <div style="height:4000px"></div>
  <script>
    // Allocate a deterministic JS heap + DOM payload to mimic a real web app renderer.
    window.__buf = new Uint8Array(${sizeMb} * 1024 * 1024);
    for (let i = 0; i < window.__buf.length; i += 4096) window.__buf[i] = (i & 0xff) || 1;
    const ul = document.createElement("ul");
    for (let i = 0; i < 600; i++) {
      const li = document.createElement("li");
      li.textContent = "${label} item " + i + " " + "x".repeat(80);
      ul.appendChild(li);
    }
    document.body.appendChild(ul);
  </script>
</body>`);
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Home ${pathname}</title><p>ok</p>`);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = addr.port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    originForSite: (i) => `http://site-${i}.localhost:${port}`,
    requests,
    clearRequests: () => {
      requests.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
