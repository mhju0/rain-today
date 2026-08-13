import assert from "node:assert/strict";
import test from "node:test";
import { searchKoreanLocations } from "./locationSearch.ts";

test("location search returns only validated Korean results and compact labels", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("countryCode"), "KR");
    assert.equal(url.searchParams.get("language"), "ko");
    return Response.json({
      results: [
        {
          id: 1,
          name: "해운대구",
          latitude: 35.1631,
          longitude: 129.1635,
          elevation: 8,
          country_code: "KR",
          admin1: "부산광역시",
          admin2: "해운대구",
        },
        {
          id: 2,
          name: "Tokyo",
          latitude: 35.6,
          longitude: 139.6,
          country_code: "JP",
        },
      ],
    });
  };

  assert.deepEqual(await searchKoreanLocations("해운대", fetchImpl), [
    {
      id: "1",
      name: "해운대구",
      label: "해운대구, 부산광역시",
      latitude: 35.1631,
      longitude: 129.1635,
      elevationM: 8,
    },
  ]);
});

test("location search rejects one-character and oversized queries before fetching", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json({ results: [] });
  };
  assert.deepEqual(await searchKoreanLocations("서", fetchImpl), []);
  await assert.rejects(() => searchKoreanLocations("가".repeat(81), fetchImpl), /too long/);
  assert.equal(calls, 0);
});

test("major Korean city names use the upstream spelling that returns the actual city", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("name"), "Busan");
    return Response.json({
      results: [{
        id: 1838524,
        name: "부산광역시",
        latitude: 35.10168,
        longitude: 129.03004,
        elevation: 15,
        country_code: "KR",
        admin1: "부산광역시",
      }],
    });
  };

  const results = await searchKoreanLocations("부산", fetchImpl);
  assert.equal(results[0]?.name, "부산광역시");
});
