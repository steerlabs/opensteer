/** Browser v1 is Baseline, progressive, 8-bit 4:2:0 with no reordered pictures. */
export function validateBrowserH264(
  bytes: Uint8Array,
  header: { key: boolean; codec?: string | undefined; width: number; height: number },
): void {
  if (bytes.length < 5 || bytes.length > 4 * 1024 * 1024)
    throw new Error("Invalid browser access unit size.");
  const units: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i + 2 < bytes.length;) {
    const length =
      bytes[i] === 0 && bytes[i + 1] === 0
        ? bytes[i + 2] === 1
          ? 3
          : bytes[i + 2] === 0 && bytes[i + 3] === 1
            ? 4
            : 0
        : 0;
    if (!length) {
      i++;
      continue;
    }
    if (start >= 0 && i > start) units.push({ start, end: i });
    if (units.length > 4096) throw new Error("Too many H.264 units.");
    start = i + length;
    i = start;
  }
  if (start >= 0 && start < bytes.length) units.push({ start, end: bytes.length });
  let sps = false,
    pps = false,
    idr = false,
    slice = false;
  for (const unit of units) {
    const first = bytes[unit.start]!;
    const kind = first & 31;
    if (first & 128 || ![1, 5, 6, 7, 8, 9].includes(kind))
      throw new Error("Unsupported H.264 NAL unit.");
    if (kind === 7) {
      if (sps || unit.end - unit.start > 4096 || bytes[unit.start + 1] !== 66)
        throw new Error("Unsupported browser SPS.");
      sps = true;
      const codec = `avc1.${[...bytes.subarray(unit.start + 1, unit.start + 4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      if (codec.toLowerCase() !== header.codec?.toLowerCase())
        throw new Error("Browser codec does not match SPS.");
      const reader = bits(bytes.subarray(unit.start + 4, unit.end));
      if (reader.ue() > 31 || reader.ue() > 12) throw new Error("Invalid SPS resource limits.");
      const order = reader.ue();
      if (order === 0) {
        if (reader.ue() > 12) throw new Error("Invalid picture order.");
      } else if (order !== 2) throw new Error("Unsupported picture order.");
      if (reader.ue() > 16) throw new Error("Too many decoder references.");
      reader.read(1);
      const columns = reader.ue() + 1,
        rows = reader.ue() + 1;
      if (columns > 240 || rows > 135 || reader.read(1) !== 1)
        throw new Error("Browser SPS exceeds decoder limits.");
      reader.read(1);
      let left = 0,
        right = 0,
        top = 0,
        bottom = 0;
      if (reader.read(1)) {
        left = reader.ue();
        right = reader.ue();
        top = reader.ue();
        bottom = reader.ue();
      }
      if (
        columns * 16 - 2 * (left + right) !== header.width ||
        rows * 16 - 2 * (top + bottom) !== header.height
      )
        throw new Error("Browser SPS dimensions disagree with certificate.");
    }
    if (kind === 8) pps = true;
    if (kind === 5) idr = true;
    if (kind === 1 || kind === 5) {
      slice = true;
      const reader = bits(bytes.subarray(unit.start + 1, Math.min(unit.end, unit.start + 64)));
      reader.ue();
      const type = reader.ue() % 5;
      if (type !== 0 && type !== 2) throw new Error("Reordered H.264 picture refused.");
    }
  }
  if (!slice || (header.key ? !(sps && pps && idr) : sps || pps || idr))
    throw new Error("Browser reference chain has no decodable boundary.");
}
function bits(data: Uint8Array): { read(count: number): number; ue(): number } {
  const rbsp: number[] = [];
  let zeros = 0;
  for (const value of data) {
    if (zeros >= 2 && value === 3) {
      zeros = 0;
      continue;
    }
    rbsp.push(value);
    zeros = value === 0 ? zeros + 1 : 0;
  }
  let at = 0;
  const read = (count: number) => {
    if (count < 0 || count > 24 || at + count > rbsp.length * 8)
      throw new Error("Truncated H.264 syntax.");
    let result = 0;
    while (count-- > 0) {
      result = result * 2 + ((rbsp[at >> 3]! >> (7 - (at % 8))) & 1);
      at++;
    }
    return result;
  };
  return {
    read,
    ue: () => {
      let zeros = 0;
      while (!read(1)) {
        if (++zeros > 16) throw new Error("Unbounded H.264 code.");
      }
      return 2 ** zeros - 1 + read(zeros);
    },
  };
}
