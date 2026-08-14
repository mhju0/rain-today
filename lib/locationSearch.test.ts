import assert from "node:assert/strict";
import test from "node:test";
import { searchKoreanLocations } from "./locationSearch.ts";

test("Korean district search returns a fully qualified administrative candidate", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({
    meta: { total_count: 1, pageable_count: 1, is_end: true },
    documents: [{
      address_name: "서울 강남구",
      address_type: "REGION",
      x: "127.0473",
      y: "37.5172",
      address: {
        address_name: "서울 강남구",
        region_1depth_name: "서울",
        region_2depth_name: "강남구",
        region_3depth_name: "",
        region_3depth_h_name: "",
        h_code: "1168000000",
        b_code: "",
        x: "127.0473",
        y: "37.5172",
      },
      road_address: null,
    }],
  });

  assert.deepEqual(
    await searchKoreanLocations("강남구", { apiKey: "test-key", fetchImpl }),
    [{
      id: "kakao:h:1168000000",
      name: "강남구",
      label: "서울특별시 강남구",
      latitude: 37.5172,
      longitude: 127.0473,
      elevationM: null,
      kind: "administrative-area",
      administrativeCode: "1168000000",
      source: "kakao",
    }],
  );
});

test("location search returns only candidates inside the Korean service area", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({
    documents: [
      {
        address_type: "REGION",
        x: "129.1635",
        y: "35.1631",
        address: {
          region_1depth_name: "부산",
          region_2depth_name: "해운대구",
          region_3depth_name: "",
          region_3depth_h_name: "",
          h_code: "2635000000",
          b_code: "",
          x: "129.1635",
          y: "35.1631",
        },
      },
      {
        address_type: "REGION",
        x: "139.6",
        y: "35.6",
        address: {
          region_1depth_name: "Tokyo",
          region_2depth_name: "",
          region_3depth_name: "",
          region_3depth_h_name: "",
          h_code: "invalid",
          b_code: "",
          x: "139.6",
          y: "35.6",
        },
      },
    ],
  });

  assert.deepEqual(await searchKoreanLocations("해운대", { apiKey: "test-key", fetchImpl }), [
    {
      id: "kakao:h:2635000000",
      name: "해운대구",
      label: "부산광역시 해운대구",
      latitude: 35.1631,
      longitude: 129.1635,
      elevationM: null,
      kind: "administrative-area",
      administrativeCode: "2635000000",
      source: "kakao",
    },
  ]);
});

test("location search rejects one-character and oversized queries before fetching", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json({ results: [] });
  };
  await assert.rejects(
    () => searchKoreanLocations("서", { apiKey: "test-key", fetchImpl }),
    /two characters/,
  );
  await assert.rejects(
    () => searchKoreanLocations("가".repeat(81), { apiKey: "test-key", fetchImpl }),
    /too long/,
  );
  assert.equal(calls, 0);
});

test("서울시 uses its canonical Korean administrative name", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("query"), "서울특별시");
    assert.equal(new Headers(init?.headers).get("Authorization"), "KakaoAK test-key");
    return Response.json({
      documents: [{
        address_type: "REGION",
        x: "126.978",
        y: "37.5665",
        address: {
          region_1depth_name: "서울",
          region_2depth_name: "",
          region_3depth_name: "",
          region_3depth_h_name: "",
          h_code: "1100000000",
          b_code: "",
          x: "126.978",
          y: "37.5665",
        },
      }],
    });
  };

  const results = await searchKoreanLocations("서울시", { apiKey: "test-key", fetchImpl });
  assert.equal(results[0]?.name, "서울특별시");
});

test("duplicate neighborhood leaves remain fully qualified selectable candidates", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({
    documents: [
      {
        address_type: "REGION",
        address: {
          region_1depth_name: "서울",
          region_2depth_name: "강남구",
          region_3depth_name: "삼성동",
          region_3depth_h_name: "삼성1동",
          h_code: "1168058000",
          b_code: "1168010500",
          x: "127.0628",
          y: "37.5143",
        },
      },
      {
        address_type: "REGION",
        address: {
          region_1depth_name: "대전",
          region_2depth_name: "동구",
          region_3depth_name: "삼성동",
          region_3depth_h_name: "삼성동",
          h_code: "3011063000",
          b_code: "3011011400",
          x: "127.4227",
          y: "36.3442",
        },
      },
    ],
  });

  const results = await searchKoreanLocations("삼성동", { apiKey: "test-key", fetchImpl });

  assert.deepEqual(results.map((result) => result.label), [
    "서울특별시 강남구 삼성1동",
    "서울특별시 강남구 삼성동",
    "대전광역시 동구 삼성동",
  ]);
  assert.deepEqual(results.map((result) => result.kind), [
    "administrative-area",
    "legal-area",
    "administrative-area",
  ]);
});

test("exact full hierarchy ranks ahead of a fuzzy provider candidate", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({
    documents: [
      {
        address_type: "REGION",
        address: {
          region_1depth_name: "부산",
          region_2depth_name: "강남구",
          region_3depth_name: "삼성동",
          region_3depth_h_name: "삼성1동",
          h_code: "2600010000",
          b_code: "2600010000",
          x: "129.05",
          y: "35.15",
        },
      },
      {
        address_type: "REGION",
        address: {
          region_1depth_name: "서울",
          region_2depth_name: "강남구",
          region_3depth_name: "삼성동",
          region_3depth_h_name: "삼성1동",
          h_code: "1168058000",
          b_code: "1168010500",
          x: "127.0628",
          y: "37.5143",
        },
      },
    ],
  });

  const results = await searchKoreanLocations(
    "서울 강남구 삼성동",
    { apiKey: "test-key", fetchImpl },
  );

  assert.equal(results[0]?.label, "서울특별시 강남구 삼성동");
  assert.equal(results[0]?.kind, "legal-area");
});

test("bare neighborhood search retries the administrative dong suffix", async () => {
  const responses = [
    Response.json({ documents: [] }),
    Response.json({
      documents: [{
        address_type: "REGION",
        x: "127.0365",
        y: "37.5007",
        address: {
          region_1depth_name: "서울",
          region_2depth_name: "강남구",
          region_3depth_name: "역삼동",
          region_3depth_h_name: "역삼1동",
          h_code: "1168064000",
          b_code: "1168010100",
          x: "127.0365",
          y: "37.5007",
        },
      }],
    }),
  ];
  const fetchImpl: typeof fetch = async () => responses.shift() ?? Response.json({ documents: [] });

  const results = await searchKoreanLocations("역삼", { apiKey: "test-key", fetchImpl });

  assert.equal(results[0]?.label, "서울특별시 강남구 역삼1동");
});

test("street-address matches never become administrative-area candidates", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({
    documents: [{
      address_type: "REGION_ADDR",
      x: "127.0365",
      y: "37.5007",
      address: {
        region_1depth_name: "서울",
        region_2depth_name: "강남구",
        region_3depth_name: "역삼동",
        region_3depth_h_name: "역삼1동",
        h_code: "1168064000",
        b_code: "1168010100",
        x: "127.0365",
        y: "37.5007",
      },
    }],
  });

  assert.deepEqual(
    await searchKoreanLocations("서울 강남구 테헤란로 152", { apiKey: "test-key", fetchImpl }),
    [],
  );
});
