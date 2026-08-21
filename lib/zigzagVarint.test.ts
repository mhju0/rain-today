import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { SERVICE_AREA_PAYLOAD, SERVICE_AREA_SOURCE } from "./locationServiceAreaData.ts";
import { createZigzagVarintReader, writeZigzagVarint } from "./zigzagVarint.ts";

function encode(values: readonly number[]): Uint8Array {
  const out: number[] = [];
  for (const value of values) writeZigzagVarint(out, value);
  return Uint8Array.from(out);
}

function decode(payload: Uint8Array, count: number): { values: number[]; position: number } {
  const reader = createZigzagVarintReader(payload);
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) values.push(reader.read());
  return { values, position: reader.position() };
}

/** Zigzag makes negatives odd, and odd magnitudes stop being exact above 2^53. */
const MIN_EXACT = -(2 ** 52);

const roundTrip = (value: number): number => decode(encode([value]), 1).values[0];

test("a written value reads back unchanged across the representable range", () => {
  fc.assert(
    fc.property(fc.integer({ min: MIN_EXACT, max: Number.MAX_SAFE_INTEGER }), (value) => {
      assert.equal(roundTrip(value), value);
    }),
  );
});

test("the negative floor documented on the codec is the real one", () => {
  assert.equal(roundTrip(MIN_EXACT), MIN_EXACT);
  assert.equal(roundTrip(MIN_EXACT + 1), MIN_EXACT + 1);
  assert.equal(roundTrip(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  // One step below the floor comes back positive, not merely rounded.
  assert.equal(roundTrip(MIN_EXACT - 1), -MIN_EXACT);
});

test("a sequence reads back in order and consumes exactly its own bytes", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: -2_000_000, max: 2_000_000 })), (sequence) => {
      const payload = encode(sequence);
      const { values, position } = decode(payload, sequence.length);
      assert.deepEqual(values, sequence);
      assert.equal(position, payload.length);
    }),
  );
});

test("small magnitudes stay short and the continuation bit marks the last byte", () => {
  assert.deepEqual(Array.from(encode([0])), [0x00]);
  assert.deepEqual(Array.from(encode([-1])), [0x01]);
  assert.deepEqual(Array.from(encode([63])), [0x7e]);
  // 64 zigzags to 128, the first magnitude needing a continuation byte.
  assert.deepEqual(Array.from(encode([64])), [0x80, 0x01]);
  assert.deepEqual(Array.from(encode([-64])), [0x7f]);
});

test("a delta of either sign costs the same as its magnitude", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1_000_000 }), (magnitude) => {
      assert.equal(encode([magnitude]).length, encode([-magnitude]).length);
    }),
  );
});

test("reading past the end yields zeroes rather than throwing", () => {
  const reader = createZigzagVarintReader(Uint8Array.from([]));
  assert.equal(reader.read(), 0);
});

/**
 * The generator that produced the committed asset cannot run here — the raw
 * SGIS package is deliberately not in the repository — so this walks the real
 * payload with the reader and rebuilds it with the writer. A drift between the
 * two halves changes these bytes.
 */
test("the committed service-area asset re-encodes byte for byte", () => {
  const payload = Uint8Array.from(Buffer.from(SERVICE_AREA_PAYLOAD, "base64"));
  const { featureCount, ringCount, vertexCount } = SERVICE_AREA_SOURCE;
  const reader = createZigzagVarintReader(payload);
  const values: number[] = [];
  const take = (): number => {
    const value = reader.read();
    values.push(value);
    return value;
  };

  assert.equal(take(), featureCount);
  let rings = 0;
  let vertices = 0;
  for (let feature = 0; feature < featureCount; feature += 1) {
    const featureRings = take();
    for (let r = 0; r < featureRings; r += 1) {
      const length = take();
      for (let i = 0; i < length * 2; i += 1) take();
      vertices += length;
      rings += 1;
    }
  }

  assert.equal(rings, ringCount);
  assert.equal(vertices, vertexCount);
  assert.equal(reader.position(), payload.length);
  assert.deepEqual(encode(values), payload);
});
