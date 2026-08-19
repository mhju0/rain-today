import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchAsosObservation,
  fetchKmaAsosStations,
  parseAsosDailyObservation,
  parseKmaStationCatalog,
} from "./kma.ts";

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

test("KMA performance readers reject oversized upstream bodies", async () => {
  const previousCatalogKey = process.env.KMA_APIHUB_KEY;
  const previousObservationKey = process.env.KMA_OBSERVATION_API_KEY;
  process.env.KMA_APIHUB_KEY = "test-key";
  process.env.KMA_OBSERVATION_API_KEY = "test-key";
  const oversized = async () => new Response(" ".repeat(1_048_577), { status: 200 });

  try {
    await assert.rejects(
      () => fetchKmaAsosStations(new Date("2026-08-13T06:00:00+09:00"), oversized as typeof fetch),
      /body too large/,
    );
    await assert.rejects(
      () => fetchAsosObservation(
        "108",
        "2026-08-12",
        new Date("2026-08-13T06:00:00+09:00"),
        oversized as typeof fetch,
      ),
      /body too large/,
    );
  } finally {
    if (previousCatalogKey === undefined) delete process.env.KMA_APIHUB_KEY;
    else process.env.KMA_APIHUB_KEY = previousCatalogKey;
    if (previousObservationKey === undefined) delete process.env.KMA_OBSERVATION_API_KEY;
    else process.env.KMA_OBSERVATION_API_KEY = previousObservationKey;
  }
});

test("KMA station catalog decodes the EUC-KR names apihub actually serves", async () => {
  const previousCatalogKey = process.env.KMA_APIHUB_KEY;
  process.env.KMA_APIHUB_KEY = "test-key";
  // apihub serves typ01 text as EUC-KR: 속초 is bc d3 c3 ca, 서울 is bc ad bf ef.
  const row = (id: string, lon: string, lat: string, name: number[]): number[] => [
    ...[...`${id} ${lon} ${lat} 11 17.5 18.7 1.7 10.0 0.4 ${id} `].map((c) => c.charCodeAt(0)),
    ...name,
    ...[...` Sokcho ${id} 11D20401 5121025021 0\n`].map((c) => c.charCodeAt(0)),
  ];
  const body = new Uint8Array([
    ...row("90", "128.5647", "38.2509", [0xbc, 0xd3, 0xc3, 0xca]),
    ...row("108", "126.9658", "37.5714", [0xbc, 0xad, 0xbf, 0xef]),
  ]);
  const respond = async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain;charset=EUC-KR" },
    });

  try {
    const stations = await fetchKmaAsosStations(
      new Date("2026-08-13T06:00:00+09:00"),
      respond as typeof fetch,
    );
    assert.deepEqual(stations.map((station) => station.name), ["속초", "서울"]);
  } finally {
    if (previousCatalogKey === undefined) delete process.env.KMA_APIHUB_KEY;
    else process.env.KMA_APIHUB_KEY = previousCatalogKey;
  }
});

test("KMA station catalog retries a dropped connection but not a refusal", async () => {
  const previousCatalogKey = process.env.KMA_APIHUB_KEY;
  process.env.KMA_APIHUB_KEY = "test-key";
  const body = "90 128.5647 38.2509 11 17.5 18.7 1.7 10.0 0.4 90 속초 Sokcho 90 11D20401 5121025021 0";

  try {
    let transportAttempts = 0;
    const flaky = async () => {
      transportAttempts += 1;
      if (transportAttempts < 3) throw new TypeError("fetch failed");
      return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    };
    const stations = await fetchKmaAsosStations(
      new Date("2026-08-13T06:00:00+09:00"),
      flaky as unknown as typeof fetch,
    );
    assert.equal(transportAttempts, 3);
    assert.deepEqual(stations.map((station) => station.id), ["90"]);

    let refusedAttempts = 0;
    const refused = async () => {
      refusedAttempts += 1;
      return new Response("denied", { status: 403 });
    };
    await assert.rejects(
      () => fetchKmaAsosStations(
        new Date("2026-08-13T06:00:00+09:00"),
        refused as unknown as typeof fetch,
      ),
      /HTTP 403/,
    );
    assert.equal(refusedAttempts, 1, "a refusal is terminal and must not be retried");
  } finally {
    if (previousCatalogKey === undefined) delete process.env.KMA_APIHUB_KEY;
    else process.env.KMA_APIHUB_KEY = previousCatalogKey;
  }
});
