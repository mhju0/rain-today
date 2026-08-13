import assert from "node:assert/strict";
import test from "node:test";
import { parseAsosDailyObservation, parseKmaStationCatalog } from "./kma.ts";

test("KMA station catalog parser keeps active South Korean ASOS coordinates", () => {
  const body = `# STN_ID LON LAT STN_SP HT HT_PA HT_TA HT_WD HT_RN STN_CD STN_KO STN_EN STN_AD FCT_ID LAW_ID BASIN
90 128.5647 38.2509 11 17.5 18.7 1.7 10.0 0.4 90 속초 Sokcho 90 11D20401 5121025021 0
108 126.9658 37.5714 11 85.7 86.7 1.5 10.0 0.5 108 서울 Seoul 108 11B10101 1111010100 0
#777 0 0 0 0 0 0 0 0 0 ignored ignored 0 0 0 0`;

  assert.deepEqual(parseKmaStationCatalog(body, new Date("2026-08-13T06:00:00+09:00")), [
    {
      id: "90",
      name: "속초",
      network: "ASOS",
      latitude: 38.2509,
      longitude: 128.5647,
      elevationM: 17.5,
      activeFrom: "2026-08-13",
      activeTo: null,
    },
    {
      id: "108",
      name: "서울",
      network: "ASOS",
      latitude: 37.5714,
      longitude: 126.9658,
      elevationM: 85.7,
      activeFrom: "2026-08-13",
      activeTo: null,
    },
  ]);
});

test("ASOS observation parser distinguishes a dry day from a missing row", () => {
  assert.equal(
    parseAsosDailyObservation({
      response: { body: { items: { item: [{ tm: "2026-08-12", stnId: "108", sumRn: "" }] } } },
    }),
    0,
  );
  assert.equal(
    parseAsosDailyObservation({
      response: { body: { items: { item: { tm: "2026-08-12", stnId: "108", sumRn: "12.4" } } } },
    }),
    12.4,
  );
  assert.equal(parseAsosDailyObservation({ response: { body: {} } }), null);
});
