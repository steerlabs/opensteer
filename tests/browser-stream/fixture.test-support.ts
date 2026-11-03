import type { Scenario } from "./metrics.test-support.js";

// Eight CSS pixels per bit survive the JPEG producer's raster scaling and quantization.
export const marker = { cell: 8, columns: 32, rows: 5, magic: 0x53a96c2d } as const;

/** Runs inside the captured page. Only real DOM state changes advance the marker. */
export function installFixture({ scenario, epoch }: { scenario: Scenario; epoch: number }) {
  document.documentElement.innerHTML = `<head><style>
    html,body{margin:0;background:#f6f2e8;color:#242b32;font:18px Georgia;scroll-behavior:auto}
    #marker{position:fixed;left:0;top:0;z-index:10;image-rendering:pixelated;pointer-events:none}
    header{padding:64px 48px 20px;background:#233f51;color:white}h1{font-size:32px}
    article{max-width:680px;margin:auto;line-height:1.6;padding:20px 32px}
    #nested{position:fixed;left:48px;top:150px;width:700px;height:390px;overflow:auto;border:3px solid #324e63}
    input,button{position:fixed;left:48px;top:100px;width:650px;height:48px;font:22px sans-serif}
  </style></head><body><canvas id="marker" width="256" height="40"></canvas>
    <header><h1>Reading a distant browser</h1></header>
    <main><article>${Array.from({ length: 250 }, (_, i) => `<h2>Section ${i + 1}</h2><p>A browser carries the work in front of us. A long article makes its motion visible: lines, shapes and headings move together while the reader scrolls. The stream should preserve the feeling of a page that follows the hand.</p>`).join("")}</article></main>
    <input aria-label="Sentence"><button>Change this page</button></body>`;
  const nested = scenario === "nested-scroll";
  const main = document.querySelector("main")!;
  if (nested) main.id = "nested";
  const field = document.querySelector("input")!;
  const button = document.querySelector("button")!;
  field.hidden = scenario !== "typing";
  button.hidden = scenario !== "click";
  if (scenario === "typing" || scenario === "click") main.hidden = true;
  let clicks = 0;
  button.onclick = () => {
    clicks++;
    button.textContent = `Page changed ${clicks}`;
    document.body.style.background = clicks % 2 ? "#dcebd2" : "#f6f2e8";
  };
  scrollTo(0, 0);
  if (scenario === "typing") field.focus();
  const canvas = document.querySelector("canvas")!;
  const context = canvas.getContext("2d", { alpha: false })!;
  let last = -1;
  let stopped = false;
  // A pending callback from a preceding scenario must never paint the next marker.
  const globals = globalThis as unknown as { stopFixture?: () => void };
  globals.stopFixture?.();
  globals.stopFixture = () => {
    stopped = true;
  };
  const paint = () => {
    if (stopped) return;
    const value =
      scenario === "typing"
        ? field.value.length
        : scenario === "click"
          ? clicks
          : Math.round(nested ? main.scrollTop : scrollY);
    if (value !== last) {
      last = value;
      const paintedAt = Math.round(performance.now());
      const words = [
        0x53a96c2d,
        epoch,
        value,
        paintedAt,
        (epoch ^ value ^ paintedAt ^ 0x53a96c2d) >>> 0,
      ];
      words.forEach((word, row) => {
        for (let bit = 0; bit < 32; bit++) {
          context.fillStyle = (word >>> bit) & 1 ? "white" : "black";
          context.fillRect(bit * 8, row * 8, 8, 8);
        }
      });
    }
    requestAnimationFrame(paint);
  };
  paint();
}

/** Decode the *presented canvas*, never the source DOM or transport metadata. */
export function readMarker(canvas: HTMLCanvasElement, viewportWidth: number) {
  const context = canvas.getContext("2d")!;
  const scale = canvas.width / viewportWidth;
  const width = Math.ceil(marker.columns * marker.cell * scale);
  const pixels = context.getImageData(
    0,
    0,
    width,
    Math.ceil(marker.rows * marker.cell * scale),
  ).data;
  const words = [];
  for (let row = 0; row < marker.rows; row++) {
    let word = 0;
    for (let bit = 0; bit < marker.columns; bit++) {
      const offset =
        (Math.floor((row + 0.5) * marker.cell * scale) * width +
          Math.floor((bit + 0.5) * marker.cell * scale)) *
        4;
      if (pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]! > 384)
        word = (word | (1 << bit)) >>> 0;
    }
    words.push(word);
  }
  const [magic, epoch, value, paintedAt, checksum] = words as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (magic !== marker.magic || checksum !== (epoch ^ value ^ paintedAt ^ marker.magic) >>> 0)
    return null;
  return { epoch, value, paintedAt };
}
