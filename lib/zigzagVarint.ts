/**
 * The one wire format shared by the service-area geometry asset.
 *
 * `scripts/generate-service-area.ts` writes the payload offline and
 * `lib/locationServiceArea.ts` decodes it at runtime. Both halves live here so
 * a change to one cannot silently drift from the other; `zigzagVarint.test.ts`
 * re-encodes the committed asset to prove they still agree.
 *
 * Each value is zigzag-mapped so a small negative delta stays one byte, then
 * emitted seven bits at a time, least significant group first, with the high
 * bit set on every byte but the last. Magnitudes are carried in doubles rather
 * than 32-bit bitwise arithmetic, so the codec is not limited to 32-bit values;
 * the byte-level masks stay safe because 2^32 is a multiple of 128, which
 * leaves the low seven bits untouched by the wrap.
 *
 * Zigzag maps a negative value to an odd magnitude, and odd integers stop
 * being representable above 2^53, so values below -2^52 do not survive: they
 * come back with the wrong sign rather than merely rounded. Non-negative
 * values map to even magnitudes and stay exact across the safe integer range.
 * Callers must keep values at or above -2^52; the geometry carries quantized
 * degree deltas around 1e7, so nothing here approaches that floor.
 */

/** Append one zigzag-varint encoded integer to a byte array. */
export function writeZigzagVarint(out: number[], value: number): void {
  let zigzag = value < 0 ? -value * 2 - 1 : value * 2;
  while (zigzag >= 0x80) {
    out.push((zigzag & 0x7f) | 0x80);
    zigzag = Math.floor(zigzag / 128);
  }
  out.push(zigzag);
}

export interface ZigzagVarintReader {
  /** Read the next value and advance past its bytes. */
  read(): number;
  /** Byte offset immediately after the last value read. */
  position(): number;
}

/**
 * Read a payload written by `writeZigzagVarint`, one value at a time.
 *
 * Reading past the end yields zeroes rather than throwing, because a caller
 * that knows how many values it expects detects a truncated payload more
 * precisely by comparing `position()` against the payload length once the
 * whole structure has been read.
 */
export function createZigzagVarintReader(payload: Uint8Array): ZigzagVarintReader {
  let cursor = 0;

  return {
    read(): number {
      let result = 0;
      let shift = 1;
      for (;;) {
        const byte = payload[cursor];
        cursor += 1;
        result += (byte & 0x7f) * shift;
        if ((byte & 0x80) === 0) break;
        shift *= 128;
      }
      return result % 2 === 0 ? result / 2 : -(result + 1) / 2;
    },
    position: () => cursor,
  };
}
