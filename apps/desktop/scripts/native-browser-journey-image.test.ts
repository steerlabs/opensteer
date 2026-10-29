import { expect, test } from "vitest";
import sharp from "sharp";
import { regionMeans } from "./native-browser-journey-image.js";

test("paint oracle samples only the page region, excluding surrounding chrome", async () => {
  const image = sharp({ create: { width: 100, height: 100, channels: 3, background: "black" } });
  const blue = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 18, g: 76, b: 120 } },
  })
    .png()
    .toBuffer();
  const input = await image
    .composite([{ input: blue, left: 70, top: 70 }])
    .png()
    .toBuffer();
  expect(await regionMeans(sharp(input), { left: 70, top: 70, width: 20, height: 20 })).toEqual([
    18, 76, 120, 255,
  ]);
});
