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
    ["서울특별시 강남구 삼성1동대표 위치", "대전광역시 동구 삼성동대표 위치"],
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
        seedScores: [],
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

  assert.match(container.querySelector(".local-strip-place")?.textContent ?? "", /약 30 m/);
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
    today: {
      date: "2026-08-17",
      precipitationProbability: 85,
      precipitationAmountMm: 2.7,
      temperatureMax: 28,
      temperatureMin: 23,
      condition: "rain",
    },
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
      seedScores: [],
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
    "raintoday.last-location.v1",
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
  assert.ok(view.container.querySelector("#forecast-heading"), "the forecast is already showing");
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

  assert.ok(view.container.querySelector("#forecast-heading"), "the forecast rendered");
  // A precise position in the URL would leak into history and any shared link.
  assert.equal(window.location.search, "", "no coordinates in the query string");
  // Remembered, but no finer than the forecast grid can use: a raw fix would
  // pinpoint a dwelling, and anything on this origin can read the store.
  const stored = JSON.parse(window.localStorage.getItem("raintoday.last-location.v1") ?? "{}");
  assert.equal(stored.latitude, 37.501, "coarsened to ~110 m before it is written");
  assert.equal(stored.longitude, 127.036);
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

  assert.ok(view.container.querySelector("#forecast-heading"), "the link alone produced a forecast");
  assert.match(body, /37\.5143/, "the linked coordinate was requested");
  // Someone else's link must not overwrite the place this device saved.
  assert.equal(window.localStorage.getItem("raintoday.last-location.v1"), null);
  await view.cleanup();
});

test("equal weighting is stated in words instead of drawn as identical bars", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
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
    "raintoday.last-location.v1",
    JSON.stringify({
      name: "현재 위치",
      latitude: 37.5006,
      longitude: 127.0364,
      elevationM: null,
      selection: { kind: "device", accuracyM: 18 },
    }),
  );
  const view = await mountExperience(async () => Response.json(forecastPayload()));

  assert.match(view.container.querySelector(".local-strip-now")?.textContent ?? "", /27°/);
  assert.match(view.container.querySelector(".local-strip-now")?.textContent ?? "", /구름 조금/);
  // The two day cards are two different calculations, so each carries its own
  // sky rather than sharing one condition line.
  const cards = view.container.querySelectorAll(".local-day");
  assert.match(cards[0].textContent ?? "", /비/);
  assert.match(cards[1].textContent ?? "", /이슬비/);
  await view.cleanup();
});

test("one live region survives the swap and announces the arrival", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
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

function stubGeolocation(latitude: number, longitude: number): void {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition(success: PositionCallback) {
        success({
          coords: { latitude, longitude, altitude: null, accuracy: 18 },
        } as GeolocationPosition);
      },
    },
  });
}

test("a forecast that resolves after the user leaves does not paint over the chooser", async () => {
  stubGeolocation(37.5006, 127.0364);
  let release: (() => void) | null = null;
  const view = await mountExperience(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json(forecastPayload());
  });

  const locationButton = [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("내 위치로 보기"));
  await act(async () => {
    locationButton?.click();
    await Promise.resolve();
  });
  assert.ok(view.container.querySelector(".local-loading"), "the loading screen is showing");

  // Leave while the request is still in flight.
  const header = view.container.querySelector<HTMLButtonElement>(".local-site-header button");
  await act(async () => {
    header?.click();
    await Promise.resolve();
  });
  assert.ok(view.container.querySelector("#location-heading"), "back on the chooser");

  await act(async () => {
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  assert.equal(
    view.container.querySelector("#forecast-heading"),
    null,
    "the abandoned response must not replace the view the user chose",
  );
  assert.ok(view.container.querySelector("#location-heading"), "still the chooser");
  await view.cleanup();
});

test("Back returns to a device forecast whose URL is identical to the chooser's", async () => {
  stubGeolocation(37.5006, 127.0364);
  const view = await mountExperience(async () => Response.json(forecastPayload()));

  const locationButton = [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("내 위치로 보기"));
  await act(async () => {
    locationButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.ok(view.container.querySelector("#forecast-heading"), "forecast showing");

  const reset = [...view.container.querySelectorAll(".local-strip-now button")][0];
  await act(async () => {
    (reset as HTMLButtonElement).click();
    await Promise.resolve();
  });
  assert.ok(view.container.querySelector("#location-heading"), "chooser showing");

  // A device fix carries no query string, so only the pushed history state can
  // tell this entry apart from the chooser's.
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  assert.ok(
    view.container.querySelector("#forecast-heading"),
    "Back reached the forecast rather than another chooser",
  );
  await view.cleanup();
});

test("a coordinate that fails is never saved for the next visit", async () => {
  stubGeolocation(48.8566, 2.3522);
  const view = await mountExperience(async () =>
    Response.json({ error: "invalid_location" }, { status: 400 }),
  );

  const locationButton = [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("내 위치로 보기"));
  await act(async () => {
    locationButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  assert.match(view.container.textContent ?? "", /서비스 지역 밖/);
  // Saving before the request resolved made a rejected coordinate reproduce its
  // own dead-end error on every later visit.
  assert.equal(window.localStorage.getItem("raintoday.last-location.v1"), null);
  await view.cleanup();
});

test("a transient failure offers a retry and keeps the saved location", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
    JSON.stringify({
      name: "역삼1동",
      latitude: 37.5006,
      longitude: 127.0364,
      elevationM: null,
      selection: { kind: "device", accuracyM: 18 },
    }),
  );
  let attempts = 0;
  const view = await mountExperience(async () => {
    attempts += 1;
    return attempts === 1
      ? Response.json({ error: "forecast_unavailable" }, { status: 503 })
      : Response.json(forecastPayload());
  });

  const retry = [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent === "다시 시도");
  assert.ok(retry, "a retryable failure offers a retry");
  assert.ok(
    window.localStorage.getItem("raintoday.last-location.v1"),
    "a provider being briefly down says nothing about the location",
  );

  await act(async () => {
    retry?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.ok(view.container.querySelector("#forecast-heading"), "the retry recovered");
  await view.cleanup();
});

test("an out-of-area failure offers no retry", async () => {
  stubGeolocation(48.8566, 2.3522);
  const view = await mountExperience(async () =>
    Response.json({ error: "invalid_location" }, { status: 400 }),
  );
  const locationButton = [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("내 위치로 보기"));
  await act(async () => {
    locationButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  assert.equal(
    [...view.container.querySelectorAll("button")].find((b) => b.textContent === "다시 시도"),
    undefined,
    "the same coordinate can never become valid",
  );
  await view.cleanup();
});

test("dismissing someone else's link leaves this device's saved location alone", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
    JSON.stringify({
      name: "역삼1동",
      latitude: 37.5006,
      longitude: 127.0364,
      elevationM: null,
      selection: { kind: "device", accuracyM: 18 },
    }),
  );
  dom.reconfigure({
    url: "http://localhost/sky?lat=36.34420&lon=127.42270&name=%EB%8C%80%EC%A0%84%20%EB%8F%99%EA%B5%AC&area=h",
  });
  const view = await mountExperience(async () => Response.json(forecastPayload()));

  const reset = [...view.container.querySelectorAll(".local-strip-now button")][0];
  await act(async () => {
    (reset as HTMLButtonElement).click();
    await Promise.resolve();
  });

  assert.match(
    window.localStorage.getItem("raintoday.last-location.v1") ?? "",
    /역삼1동/,
    "the user's own place survives dismissing a shared one",
  );
  await view.cleanup();
});

test("a link stripped of its coordinates lands on the chooser, not an error", async () => {
  dom.reconfigure({ url: "http://localhost/sky?name=%EC%84%9C%EC%9A%B8" });
  let requested = 0;
  const view = await mountExperience(async () => {
    requested += 1;
    return Response.json(forecastPayload());
  });

  // Number(null) is 0, which would have requested a forecast for (0, 0).
  assert.equal(requested, 0, "no forecast is requested for a malformed link");
  assert.ok(view.container.querySelector("#location-heading"), "the chooser is shown");
  await view.cleanup();
});

test("a provider with no seven-day record is not ranked against ones that have it", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
    JSON.stringify({
      name: "역삼1동",
      latitude: 37.5006,
      longitude: 127.0364,
      elevationM: null,
      selection: { kind: "device", accuracyM: 18 },
    }),
  );
  const view = await mountExperience(async () => Response.json(forecastPayload({
    evidence: {
      status: "active",
      statusLabel: "가중치 반영 중",
      station: { name: "서울", distanceKm: 3.2 },
      comparisonSampleCount: 40,
      emptyMessage: null,
      emptyDetail: null,
      scores: [
        // No recent record, but the best 30-day score — this must not win a
        // ranking presented under a 최근 7일 heading.
        { id: "kma", name: "기상청", last7DaysBrier: null, windowBrier: 0.12, windowSampleCount: 30, misses: 1, falseAlarms: 1, rainyAmountMae: null, rainyAmountSampleCount: 0 },
        { id: "open-meteo", name: "Open-Meteo", last7DaysBrier: 0.2, windowBrier: 0.3, windowSampleCount: 40, misses: 4, falseAlarms: 2, rainyAmountMae: 1.5, rainyAmountSampleCount: 9 },
      ],
      seedScores: [],
      benchmark: null,
    },
  })));

  const rows = [...view.container.querySelectorAll(".local-score-table:not(.is-raw) .local-score-row")]
    .slice(1)
    .map((row) => [...row.children].map((cell) => cell.textContent));

  assert.deepEqual(rows[0]?.[0], "Open-Meteo", "the only provider with a 7-day record leads");
  assert.equal(rows[0]?.[1], "가장 잘 맞음");
  assert.equal(rows[1]?.[0], "기상청");
  assert.equal(rows[1]?.[1], "최근 7일 기록 없음", "and the other is not given a rank");
  await view.cleanup();
});

test("the headline number is today's, not tomorrow's", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
    JSON.stringify({
      name: "역삼1동", latitude: 37.5006, longitude: 127.0364,
      elevationM: null, selection: { kind: "device", accuracyM: 18 },
    }),
  );
  const view = await mountExperience(async () => Response.json(forecastPayload()));

  assert.equal(view.container.querySelector("#forecast-heading")?.textContent, "오늘 비가 올까요?");
  // 85 is today; 41 is tomorrow. Today leads because the two cards are read in
  // order, and someone opening a weather app is asking about today first.
  const values = [...view.container.querySelectorAll(".local-day-value")];
  assert.match(values[0].textContent ?? "", /85%/);
  assert.match(values[1].textContent ?? "", /41%/);
  await view.cleanup();
});

test("today's number is never presented as performance-weighted", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
    JSON.stringify({
      name: "역삼1동", latitude: 37.5006, longitude: 127.0364,
      elevationM: null, selection: { kind: "device", accuracyM: 18 },
    }),
  );
  // Learned weighting is active, but it is trained and validated on next-day
  // forecasts only, so claiming it for today would assert unmeasured accuracy.
  const view = await mountExperience(async () =>
    Response.json(forecastPayload({ blendMode: "learned" })),
  );

  const tags = [...view.container.querySelectorAll(".local-tag")];
  assert.match(tags[0].textContent ?? "", /동일 비중/);
  assert.doesNotMatch(tags[0].textContent ?? "", /성능 가중/);
  // Only tomorrow's card may claim the weighting, and it must say so on itself
  // rather than leaving the reader to infer which number it applies to.
  assert.match(tags[1].textContent ?? "", /성능 가중/);
  await view.cleanup();
});

test("the hero falls back to tomorrow when today is no longer published", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
    JSON.stringify({
      name: "역삼1동", latitude: 37.5006, longitude: 127.0364,
      elevationM: null, selection: { kind: "device", accuracyM: 18 },
    }),
  );
  const view = await mountExperience(async () => Response.json(forecastPayload({ today: null })));

  assert.equal(view.container.querySelector("#forecast-heading")?.textContent, "내일 비가 올까요?");
  const cards = view.container.querySelectorAll(".local-day");
  assert.equal(cards.length, 1, "no empty 오늘 card when nobody still publishes today");
  assert.match(cards[0].textContent ?? "", /내일/);
  assert.match(view.container.querySelector(".local-day-value")?.textContent ?? "", /41%/);
  await view.cleanup();
});

test("an unnamed device fix shows its accuracy rather than repeating itself", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
    JSON.stringify({
      name: "현재 위치", latitude: 37.5006, longitude: 127.0364,
      elevationM: null, selection: { kind: "device", accuracyM: 18 },
    }),
  );
  const view = await mountExperience(async () =>
    Response.json(forecastPayload({ locationName: "현재 위치" })),
  );

  const place = view.container.querySelector(".local-strip-place")?.textContent ?? "";
  // "현재 위치 · 현재 기기 위치" told the reader nothing they did not already see.
  assert.doesNotMatch(place, /현재 기기 위치/);
  assert.match(place, /약 20 m/);
  await view.cleanup();
});

test("a resolved place name keeps the provenance label", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
    JSON.stringify({
      name: "현재 위치", latitude: 37.5006, longitude: 127.0364,
      elevationM: null, selection: { kind: "device", accuracyM: 18 },
    }),
  );
  const view = await mountExperience(async () =>
    Response.json(forecastPayload({ locationName: "서울특별시 강남구 역삼1동" })),
  );

  const place = view.container.querySelector(".local-strip-place")?.textContent ?? "";
  assert.match(place, /서울특별시 강남구 역삼1동/);
  assert.match(place, /현재 기기 위치/, "with a real name, how we got it is useful");
  await view.cleanup();
});

test("the announcement names the day actually on screen", async () => {
  const seed = JSON.stringify({
    name: "역삼1동", latitude: 37.5006, longitude: 127.0364,
    elevationM: null, selection: { kind: "device", accuracyM: 18 },
  });

  window.localStorage.setItem("raintoday.last-location.v1", seed);
  const withToday = await mountExperience(async () => Response.json(forecastPayload()));
  assert.match(
    withToday.container.querySelector("[aria-live=polite]")?.textContent ?? "",
    /오늘 예보를 표시했습니다/,
    "saying 내일 while today is on screen misleads a screen-reader user",
  );
  await withToday.cleanup();

  window.localStorage.setItem("raintoday.last-location.v1", seed);
  const withoutToday = await mountExperience(async () =>
    Response.json(forecastPayload({ today: null })),
  );
  assert.match(
    withoutToday.container.querySelector("[aria-live=polite]")?.textContent ?? "",
    /내일 예보를 표시했습니다/,
  );
  await withoutToday.cleanup();
});

test("a collapsed row shows the 법정동 name instead of a jargon tag", async () => {
  const view = await mountChooser(async () => Response.json({
    results: [{
      ...kakaoResult({
        id: "1168058000",
        name: "삼성1동",
        label: "서울특별시 강남구 삼성1동",
        latitude: 37.5143,
        longitude: 127.0628,
      }),
      alternateName: "삼성동",
    }],
  }));

  await changeInput(view.input, "삼성동");
  await settleDebounce();

  const option = view.container.querySelector("[role=option]")?.textContent ?? "";
  assert.match(option, /서울특별시 강남구 삼성1동/);
  // Both names on one row: the two used to be separate candidates with
  // identical coordinates, so the choice between them changed nothing.
  assert.match(option, /법정동 삼성동/);
  assert.doesNotMatch(option, /행정구역|법정구역/);
  await view.cleanup();
});

test("the location button reports that it is working", async () => {
  let settle: ((position: GeolocationPosition) => void) | null = null;
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition(success: PositionCallback) {
        settle = success;
      },
    },
  });
  const view = await mountExperience(async () => Response.json(forecastPayload()));

  const button = [...view.container.querySelectorAll("button")]
    .find((b) => b.textContent?.includes("내 위치로 보기")) as HTMLButtonElement;
  await act(async () => {
    button.click();
    await Promise.resolve();
  });

  const busy = [...view.container.querySelectorAll("button")]
    .find((b) => b.textContent?.includes("위치 확인 중")) as HTMLButtonElement | undefined;
  assert.ok(busy, "a high-accuracy fix can take 12s; the button must not look idle");
  assert.equal(busy?.disabled, true);

  await act(async () => {
    settle?.({
      coords: { latitude: 37.5006, longitude: 127.0364, altitude: null, accuracy: 18 },
    } as GeolocationPosition);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.ok(view.container.querySelector("#forecast-heading"));
  await view.cleanup();
});

test("the chooser stays on screen while a forecast loads", async () => {
  let release: (() => void) | null = null;
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
  const view = await mountExperience(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json(forecastPayload());
  });

  const button = [...view.container.querySelectorAll("button")]
    .find((b) => b.textContent?.includes("내 위치로 보기")) as HTMLButtonElement;
  await act(async () => {
    button.click();
    await Promise.resolve();
  });

  // Unmounting the whole page left a black screen with one line on it.
  const chooser = view.container.querySelector(".local-chooser");
  assert.ok(chooser, "the chooser is still mounted under the overlay");
  assert.ok(chooser?.className.includes("is-busy"));
  assert.ok(view.container.querySelector(".local-loading.is-overlay"));

  await act(async () => {
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(view.container.querySelector(".local-chooser"), null, "replaced once ready");
  await view.cleanup();
});

test("a location saved before the rename is still restored", async () => {
  // The storage key moved with the product name. Dropping the old one would
  // have silently sent every returning visitor back to the empty chooser.
  window.localStorage.setItem(
    "seoulsky.last-location.v1",
    JSON.stringify({
      name: "역삼1동", latitude: 37.5006, longitude: 127.0364,
      elevationM: null, selection: { kind: "device", accuracyM: 18 },
    }),
  );
  let requests = 0;
  const view = await mountExperience(async () => {
    requests += 1;
    return Response.json(forecastPayload());
  });

  assert.equal(requests, 1, "the pre-rename location was read");
  assert.ok(view.container.querySelector("#forecast-heading"));
  await view.cleanup();
});

const SEED_LOCATION = JSON.stringify({
  name: "역삼1동", latitude: 37.5006, longitude: 127.0364,
  elevationM: null, selection: { kind: "device", accuracyM: 18 },
});

/**
 * A ribbon fixture. `reading` is what the view model derives from the blocks;
 * it is passed explicitly so a test can state the window it means to render
 * without re-deriving it here.
 */
function timeline(overrides: Record<string, unknown> = {}) {
  return {
    sourceName: "Open-Meteo",
    threshold: 40,
    blocks: [
      { label: "지금", rangeLabel: "9–12시", startHour: 9, endHour: 12, precipMax: 10, condition: "cloudy", wet: false, dayTag: null },
      { label: "오후", rangeLabel: "12–15시", startHour: 12, endHour: 15, precipMax: 75, condition: "rain", wet: true, dayTag: null },
      { label: "저녁", rangeLabel: "18–21시", startHour: 18, endHour: 21, precipMax: 40, condition: "rain", wet: true, dayTag: null },
    ],
    reading: {
      firstRun: {
        startIndex: 1, endIndex: 2, startHour: 12, endHour: 21, startLabel: "오후",
        startsTomorrow: false, durationHours: 6, endsWithinWindow: true, peakProbability: 75,
      },
      laterRun: null,
      peak: { probability: 75, rangeLabel: "12–15시", startsTomorrow: false },
    },
    ...overrides,
  };
}

test("the answer sentence names both ends of the rain window", async () => {
  window.localStorage.setItem("raintoday.last-location.v1", SEED_LOCATION);
  const view = await mountExperience(async () =>
    Response.json(forecastPayload({ timeline: timeline() })),
  );

  // "오늘 비가 올까요?" answers a question the number already answers; the series
  // knows when it starts and when it stops.
  assert.equal(
    view.container.querySelector("#forecast-heading")?.textContent,
    "비는 오후 12시부터, 21시까지",
  );
  assert.equal(view.container.querySelectorAll(".local-ribbon-col").length, 3);
  await view.cleanup();
});

test("a run that never stops inside the series does not claim an end time", async () => {
  window.localStorage.setItem("raintoday.last-location.v1", SEED_LOCATION);
  const view = await mountExperience(async () =>
    Response.json(forecastPayload({
      timeline: timeline({
        reading: {
          firstRun: {
            startIndex: 1, endIndex: 2, startHour: 12, endHour: 21, startLabel: "오후",
            startsTomorrow: false, durationHours: 6, endsWithinWindow: false, peakProbability: 75,
          },
          laterRun: null,
          peak: { probability: 75, rangeLabel: "12–15시", startsTomorrow: false },
        },
      }),
    })),
  );

  const heading = view.container.querySelector("#forecast-heading")?.textContent ?? "";
  assert.match(heading, /예보 끝까지 이어집니다/);
  assert.doesNotMatch(heading, /21시까지/, "nothing published showed the rain stopping");
  await view.cleanup();
});

test("the ribbon says whose forecast it is, because it is not the blend", async () => {
  window.localStorage.setItem("raintoday.last-location.v1", SEED_LOCATION);
  const view = await mountExperience(async () =>
    Response.json(forecastPayload({ timeline: timeline({ sourceName: "기상청" }) })),
  );

  assert.match(
    view.container.querySelector(".local-ribbon-src")?.textContent ?? "",
    /기상청/,
    "attributing the ribbon to the blend would overstate what the bars are",
  );
  await view.cleanup();
});

test("the rain window is marked on the ribbon, and only once rain is actually likely", async () => {
  window.localStorage.setItem("raintoday.last-location.v1", SEED_LOCATION);
  const dry = await mountExperience(async () =>
    Response.json(forecastPayload({
      timeline: timeline({
        blocks: [
          { label: "지금", rangeLabel: "9–12시", startHour: 9, endHour: 12, precipMax: 5, condition: "cloudy", wet: false, dayTag: null },
          { label: "오후", rangeLabel: "12–15시", startHour: 12, endHour: 15, precipMax: 22, condition: "cloudy", wet: false, dayTag: null },
        ],
        reading: {
          firstRun: null,
          laterRun: null,
          peak: { probability: 22, rangeLabel: "12–15시", startsTomorrow: false },
        },
      }),
    })),
  );
  // Marking the least-dry hour of a dry day reads as a rain warning.
  assert.equal(dry.container.querySelectorAll(".local-ribbon-col.is-wet").length, 0);
  assert.match(
    dry.container.querySelector("#forecast-heading")?.textContent ?? "",
    /비 소식은 없습니다/,
  );
  await dry.cleanup();

  window.localStorage.setItem("raintoday.last-location.v1", SEED_LOCATION);
  const wet = await mountExperience(async () =>
    Response.json(forecastPayload({ timeline: timeline() })),
  );
  const marked = wet.container.querySelectorAll(".local-ribbon-col.is-wet");
  assert.equal(marked.length, 2, "every block the rain covers is marked, not just the peak");
  assert.match(marked[0].textContent ?? "", /75%/);
  await wet.cleanup();
});

test("a block nobody forecast is drawn empty rather than as a confident 0%", async () => {
  window.localStorage.setItem("raintoday.last-location.v1", SEED_LOCATION);
  const view = await mountExperience(async () =>
    Response.json(forecastPayload({
      timeline: timeline({
        blocks: [
          { label: "지금", rangeLabel: "9–12시", startHour: 9, endHour: 12, precipMax: null, condition: "cloudy", wet: false, dayTag: null },
          { label: "오후", rangeLabel: "12–15시", startHour: 12, endHour: 15, precipMax: 75, condition: "rain", wet: true, dayTag: null },
        ],
      }),
    })),
  );

  const first = view.container.querySelector(".local-ribbon-col");
  assert.ok(first?.querySelector(".local-ribbon-track.is-na"), "a gap is hatched, not filled");
  assert.match(first?.textContent ?? "", /—/);
  assert.equal(
    first?.querySelector(".local-ribbon-bar"),
    null,
    "an unpublished block must draw no bar at all",
  );
  // A published 0% is a real statement and keeps a real, if thin, bar.
  const zero = await mountExperience(async () =>
    Response.json(forecastPayload({
      timeline: timeline({
        blocks: [
          { label: "지금", rangeLabel: "9–12시", startHour: 9, endHour: 12, precipMax: 0, condition: "clear", wet: false, dayTag: null },
        ],
      }),
    })),
  );
  assert.ok(zero.container.querySelector(".local-ribbon-bar.is-zero"));
  await zero.cleanup();
  await view.cleanup();
});

test("no hourly series leaves the answer on the probability, with no ribbon", async () => {
  window.localStorage.setItem("raintoday.last-location.v1", SEED_LOCATION);
  const view = await mountExperience(async () =>
    Response.json(forecastPayload({ timeline: null })),
  );

  assert.equal(view.container.querySelector(".local-ribbon"), null);
  assert.equal(view.container.querySelector("#forecast-heading")?.textContent, "오늘 비가 올까요?");
  await view.cleanup();
});


test("seed evidence shows the wet-day miss rate rather than claiming measured performance", async () => {
  window.localStorage.setItem(
    "raintoday.last-location.v1",
    JSON.stringify({
      name: "역삼1동", latitude: 37.5006, longitude: 127.0364,
      elevationM: null, selection: { kind: "device", accuracyM: 18 },
    }),
  );
  const view = await mountExperience(async () =>
    Response.json(forecastPayload({
      blendMode: "seed",
      evidence: {
        status: "active",
        statusLabel: "과거 기록 반영 중",
        station: { name: "서울", distanceKm: 3.2 },
        comparisonSampleCount: 92,
        emptyMessage: null,
        emptyDetail: null,
        scores: [],
        seedScores: [
          { id: "kma", name: "기상청", wetDays: 34, misses: 13, falseAlarms: 5, sampleCount: 92 },
          { id: "open-meteo", name: "Open-Meteo", wetDays: 34, misses: 5, falseAlarms: 11, sampleCount: 92 },
        ],
        benchmark: null,
      },
    })),
  );

  const evidence = view.container.textContent ?? "";
  assert.match(evidence, /비 온 34일 중 13일/, "the wet-day miss rate must be on screen");
  // The whole point of a separate seed mode: this is a retrospective estimate,
  // so the page must not claim it measured this station's recent performance.
  assert.ok(!evidence.includes("최근 관측 성능 반영"), "seed must not read as measured skill");
  assert.match(evidence, /과거 예보 기록으로 추정한 적중률을 일부만 반영했습니다/);
  // The recency half-life is a live-capture rule; a flat archive sample must not
  // borrow it, and the heading must not claim this is recent local measurement.
  assert.ok(!evidence.includes("최근 예보일수록 크게 반영"));
  assert.match(evidence, /기간 전체를 같은 비중으로 반영/);
});
