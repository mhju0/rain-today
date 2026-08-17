import assert from "node:assert/strict";
import test from "node:test";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/sky",
});

for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LocationChooser, default: LocalForecastExperience } = await import("./LocalForecastExperience");

function kakaoResult(input: {
  id: string;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
}) {
  return {
    ...input,
    elevationM: null,
    kind: "administrative-area" as const,
    administrativeCode: input.id,
    source: "kakao" as const,
  };
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function settleDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

async function mountChooser(fetchImpl: typeof fetch) {
  globalThis.fetch = fetchImpl;
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  const choices: Array<{ name: string }> = [];
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<LocationChooser onChoose={(input) => choices.push(input)} />);
  });
  return {
    choices,
    input: container.querySelector<HTMLInputElement>("[role=combobox]")!,
    container,
    async cleanup() {
      await act(async () => root?.unmount());
    },
  };
}

test("keyboard navigation selects one fully qualified duplicate candidate", async () => {
  const view = await mountChooser(async () => Response.json({
    results: [
      kakaoResult({
        id: "1168058000",
        name: "삼성1동",
        label: "서울특별시 강남구 삼성1동",
        latitude: 37.5143,
        longitude: 127.0628,
      }),
      kakaoResult({
        id: "3011063000",
        name: "삼성동",
        label: "대전광역시 동구 삼성동",
        latitude: 36.3442,
        longitude: 127.4227,
      }),
    ],
  }));

  await changeInput(view.input, "삼성동");
  await settleDebounce();
  assert.deepEqual(
    [...view.container.querySelectorAll("[role=option]")].map((option) => option.textContent),
    ["서울특별시 강남구 삼성1동행정구역 대표 위치", "대전광역시 동구 삼성동행정구역 대표 위치"],
  );

  await act(async () => {
    view.input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      key: "ArrowDown",
    }));
  });
  await act(async () => {
    view.input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      key: "Enter",
    }));
  });
  // The whole label travels to the dashboard, not the leaf. Dozens of Korean
  // towns have a 삼성동, so "삼성동" alone could not confirm the right place.
  assert.equal(view.choices[0]?.name, "대전광역시 동구 삼성동");
  await view.cleanup();
});

test("a stale response cannot replace results for the newer query", async () => {
  let resolveFirst: ((response: Response) => void) | undefined;
  const view = await mountChooser(async (input) => {
    const query = new URL(String(input), "http://localhost").searchParams.get("q");
    if (query === "삼성동") {
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Response.json({
      results: [kakaoResult({
        id: "1100000000",
        name: "서울특별시",
        label: "서울특별시",
        latitude: 37.5665,
        longitude: 126.978,
      })],
    });
  });

  await changeInput(view.input, "삼성동");
  await settleDebounce();
  await changeInput(view.input, "서울시");
  await settleDebounce();
  assert.match(view.container.textContent ?? "", /서울특별시/);

  await act(async () => {
    resolveFirst?.(Response.json({
      results: [kakaoResult({
        id: "1168058000",
        name: "삼성1동",
        label: "서울특별시 강남구 삼성1동",
        latitude: 37.5143,
        longitude: 127.0628,
      })],
    }));
    await Promise.resolve();
  });
  assert.equal(view.container.querySelectorAll("[role=option]").length, 1);
  assert.equal(view.container.querySelector("[role=option]")?.textContent?.startsWith("서울특별시"), true);
  await view.cleanup();
});

test("empty and failed searches expose distinct status and retry UI", async () => {
  let shouldFail = false;
  const view = await mountChooser(async () => {
    if (shouldFail) throw new Error("provider unavailable");
    return Response.json({ results: [] });
  });

  await changeInput(view.input, "없는동");
  await settleDebounce();
  assert.match(view.container.textContent ?? "", /일치하는 행정구역을 찾지 못했어요/);
  assert.equal(view.container.querySelector(".local-form-status button"), null);

  shouldFail = true;
  await changeInput(view.input, "오류동");
  await settleDebounce();
  assert.match(view.container.textContent ?? "", /지역 검색이 잠시 원활하지 않아요/);
  assert.equal(view.container.querySelector(".local-form-status button")?.textContent, "다시 시도");
  await view.cleanup();
});

test("device accuracy is displayed but not sent to the forecast API", async () => {
  let requestBody = "";
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? "");
    return Response.json({
      generatedAt: "2026-08-14T00:00:00.000Z",
      locationName: "현재 위치",
      targetDate: "2026-08-15",
      recommendation: {
        precipitationProbability: 30,
        precipitationAmountMm: 0,
        temperatureMax: 30,
        temperatureMin: 22,
        condition: "clear",
      },
      outlook: [],
      blendMode: "equal",
      comparedProviderCount: 0,
      influence: [],
      evidence: {
        status: "unavailable",
        statusLabel: "근거 준비 중",
        station: null,
        comparisonSampleCount: 0,
        emptyMessage: "지역 성능 데이터베이스를 연결하면 이곳에 실제 비교가 표시됩니다.",
        scores: [],
        benchmark: null,
      },
    });
  };
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition(success: PositionCallback) {
        success({
          coords: {
            latitude: 37.5,
            longitude: 127,
            altitude: null,
            accuracy: 27,
          },
        } as GeolocationPosition);
      },
    },
  });

  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<LocalForecastExperience />);
  });
  const locationButton = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("내 위치로 보기"));
  await act(async () => {
    locationButton?.click();
    await Promise.resolve();
  });

  assert.match(container.querySelector(".local-precision-summary")?.textContent ?? "", /약 30 m/);
  // The horizontal-accuracy estimate is shown to the user but must never reach
  // the server, so assert on the whole body rather than on one absent key.
  assert.deepEqual(
    Object.keys(JSON.parse(requestBody)).sort(),
    ["elevationM", "latitude", "longitude", "name"],
  );
  await act(async () => root?.unmount());
});

test("a rejected query is not reported as a temporary outage", async () => {
  const view = await mountChooser(async () =>
    Response.json({ error: "invalid_query" }, { status: 400 }),
  );

  await changeInput(view.input, "가".repeat(90));
  await settleDebounce();

  const text = view.container.textContent ?? "";
  assert.doesNotMatch(text, /잠시 원활하지 않아요/, "a 400 is not an outage");
  assert.match(text, /검색어/, "the user is told the query itself was rejected");
  assert.equal(
    view.container.querySelector(".local-form-status button"),
    null,
    "retrying an identical rejected query cannot help",
  );
  await view.cleanup();
});

function forecastPayload(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-08-17T00:00:00.000Z",
    locationName: "서울특별시 강남구 역삼1동",
    targetDate: "2026-08-18",
    current: {
      temperature: 27.4,
      apparentTemperature: 30,
      condition: "partly-cloudy",
      observedAt: "2026-08-17T09:00:00+09:00",
      sourceName: "Open-Meteo",
    },
    cohortLabel: "오전 6시 발표 기준",
    recommendation: {
      precipitationProbability: 41,
      precipitationAmountMm: 0.7,
      temperatureMax: 31,
      temperatureMin: 23,
      condition: "drizzle",
    },
    outlook: [],
    blendMode: "equal",
    comparedProviderCount: 4,
    influence: [
      { id: "open-meteo", name: "Open-Meteo", probability: 31, influence: 0.25 },
      { id: "kma", name: "기상청", probability: 57, influence: 0.25 },
    ],
    evidence: {
      status: "unavailable",
      statusLabel: "근거 준비 중",
      station: null,
      comparisonSampleCount: 0,
      emptyMessage: "이 지역의 최근 성능 기록이 아직 없어, 서비스를 똑같은 비중으로 평균했습니다.",
      emptyDetail: null,
      scores: [],
      benchmark: null,
    },
    ...overrides,
  };
}

async function mountExperience(fetchImpl: typeof fetch) {
  globalThis.fetch = fetchImpl;
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<LocalForecastExperience />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return {
    container,
    async cleanup() {
      await act(async () => root?.unmount());
      window.localStorage.clear();
      dom.reconfigure({ url: "http://localhost/sky" });
    },
  };
}

test("Escape collapses the suggestion list without destroying it", async () => {
  const view = await mountChooser(async () => Response.json({
    results: [kakaoResult({
      id: "1168058000",
      name: "삼성1동",
      label: "서울특별시 강남구 삼성1동",
      latitude: 37.5143,
      longitude: 127.0628,
    })],
  }));

  await changeInput(view.input, "삼성동");
  await settleDebounce();
  assert.equal(view.container.querySelectorAll("[role=option]").length, 1);

  await act(async () => {
    view.input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  });
  assert.equal(view.container.querySelectorAll("[role=option]").length, 0, "Escape collapses");

  // The matches still exist, so ArrowDown brings them back. Previously the only
  // way to see them again was to retype the whole query.
  await act(async () => {
    view.input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
  });
  assert.equal(view.container.querySelectorAll("[role=option]").length, 1, "ArrowDown reopens");
  assert.equal(view.input.value, "삼성동", "the query was never cleared");
  await view.cleanup();
});

test("an unconfigured search is not offered a retry that cannot succeed", async () => {
  const view = await mountChooser(async () =>
    Response.json({ error: "search_not_configured" }, { status: 503 }),
  );

  await changeInput(view.input, "역삼동");
  await settleDebounce();

  const text = view.container.textContent ?? "";
  assert.doesNotMatch(text, /잠시 원활하지 않아요/, "configuration is not an outage");
  assert.match(text, /내 위치로 보기/, "the user is pointed at the path that still works");
  assert.equal(view.container.querySelector(".local-form-status button"), null);
  await view.cleanup();
});

test("a coordinate outside Korea is not reported as a temporary failure", async () => {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition(success: PositionCallback) {
        success({
          coords: { latitude: 48.8566, longitude: 2.3522, altitude: null, accuracy: 20 },
        } as GeolocationPosition);
      },
    },
  });
  const view = await mountExperience(async () =>
    Response.json({ error: "invalid_location" }, { status: 400 }),
  );

  const locationButton = [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("내 위치로 보기"));
  await act(async () => {
    locationButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  const text = view.container.textContent ?? "";
  assert.match(text, /서비스 지역 밖/, "the user learns the coordinate itself is out of range");
  assert.doesNotMatch(text, /잠시 후 다시 시도/, "a rejected coordinate never becomes valid by waiting");
  await view.cleanup();
});

test("the last location is restored on the next visit without any interaction", async () => {
  window.localStorage.setItem(
    "seoulsky.last-location.v1",
    JSON.stringify({
      name: "현재 위치",
      latitude: 37.5006,
      longitude: 127.0364,
      elevationM: null,
      selection: { kind: "device", accuracyM: 18 },
    }),
  );
  let requests = 0;
  const view = await mountExperience(async () => {
    requests += 1;
    return Response.json(forecastPayload());
  });

  assert.equal(requests, 1, "the stored location is fetched on mount");
  assert.equal(view.container.querySelector("#location-heading"), null, "the chooser is skipped");
  assert.ok(view.container.querySelector("#tomorrow-heading"), "the forecast is already showing");
  await view.cleanup();
});

test("a device coordinate is never written into the address bar", async () => {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition(success: PositionCallback) {
        success({
          coords: { latitude: 37.5006, longitude: 127.0364, altitude: null, accuracy: 18 },
        } as GeolocationPosition);
      },
    },
  });
  const view = await mountExperience(async () => Response.json(forecastPayload()));

  const locationButton = [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("내 위치로 보기"));
  await act(async () => {
    locationButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  assert.ok(view.container.querySelector("#tomorrow-heading"), "the forecast rendered");
  // A precise position in the URL would leak into history and any shared link.
  assert.equal(window.location.search, "", "no coordinates in the query string");
  assert.match(
    window.localStorage.getItem("seoulsky.last-location.v1") ?? "",
    /37\.5006/,
    "it is remembered on the device instead",
  );
  await view.cleanup();
});

test("a shareable area link renders that place without touching stored state", async () => {
  dom.reconfigure({
    url: "http://localhost/sky?lat=37.51430&lon=127.06280&name=%EC%84%9C%EC%9A%B8%20%EA%B0%95%EB%82%A8&area=h",
  });
  let body = "";
  const view = await mountExperience(async (_input, init) => {
    body = String(init?.body ?? "");
    return Response.json(forecastPayload());
  });

  assert.ok(view.container.querySelector("#tomorrow-heading"), "the link alone produced a forecast");
  assert.match(body, /37\.5143/, "the linked coordinate was requested");
  await view.cleanup();
});

test("equal weighting is stated in words instead of drawn as identical bars", async () => {
  window.localStorage.setItem(
    "seoulsky.last-location.v1",
    JSON.stringify({
      name: "현재 위치",
      latitude: 37.5006,
      longitude: 127.0364,
      elevationM: null,
      selection: { kind: "device", accuracyM: 18 },
    }),
  );
  const view = await mountExperience(async () => Response.json(forecastPayload()));

  const text = view.container.textContent ?? "";
  assert.match(text, /똑같은 비중으로/, "the fallback is named");
  assert.equal(
    view.container.querySelectorAll(".local-weight-track").length,
    0,
    "no influence bars are drawn when every weight is identical",
  );
  // The per-provider spread is what actually carries information here.
  assert.match(text, /31%/);
  assert.match(text, /57%/);
  await view.cleanup();
});

test("observed conditions and tomorrow's condition both reach the screen", async () => {
  window.localStorage.setItem(
    "seoulsky.last-location.v1",
    JSON.stringify({
      name: "현재 위치",
      latitude: 37.5006,
      longitude: 127.0364,
      elevationM: null,
      selection: { kind: "device", accuracyM: 18 },
    }),
  );
  const view = await mountExperience(async () => Response.json(forecastPayload()));

  assert.match(view.container.querySelector(".local-now")?.textContent ?? "", /27°/);
  assert.match(view.container.querySelector(".local-now")?.textContent ?? "", /구름 조금/);
  assert.equal(view.container.querySelector(".local-hero-condition")?.textContent, "이슬비");
  await view.cleanup();
});

test("one live region survives the swap and announces the arrival", async () => {
  window.localStorage.setItem(
    "seoulsky.last-location.v1",
    JSON.stringify({
      name: "현재 위치",
      latitude: 37.5006,
      longitude: 127.0364,
      elevationM: null,
      selection: { kind: "device", accuracyM: 18 },
    }),
  );
  const view = await mountExperience(async () => Response.json(forecastPayload()));
  const live = view.container.querySelector("[aria-live=polite]");

  assert.ok(live, "the region is mounted outside the views that swap");
  assert.match(live?.textContent ?? "", /역삼1동/);
  await view.cleanup();
});
