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
  assert.equal(view.choices[0]?.name, "삼성동");
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
      location: {
        name: "현재 위치",
        latitude: 37.5,
        longitude: 127,
        elevationM: null,
      },
      targetDate: "2026-08-15",
      captureCohort: "06",
      recommendation: {
        precipitationProbability: 30,
        precipitationAmountMm: 0,
        temperatureMax: 30,
        temperatureMin: 22,
        condition: "clear",
      },
      outlook: [],
      providers: [],
      effectiveInfluence: {},
      performance: {
        status: "unavailable",
        reason: "database-not-configured",
        station: null,
        profile: null,
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
  assert.equal(JSON.parse(requestBody).accuracyM, undefined);
  await act(async () => root?.unmount());
});
