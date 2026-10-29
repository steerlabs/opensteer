import sharp, { type Sharp, type Region } from "sharp";

export async function regionMeans(image: Sharp, region: Region): Promise<number[]> {
  // stats() reads its input, ignoring pending transforms such as extract().
  const crop = await image.extract(region).toBuffer();
  return (await sharp(crop).stats()).channels.map((channel) => channel.mean);
}
