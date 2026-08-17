import { searchKoreanLocations } from "../lib/locationSearch.ts";
import type { ForecastLocationSearchResult } from "../lib/locationSearch.ts";

/**
 * Run the credentialed Korean location matrix required before release.
 *
 * Every candidate this prints has already passed `createForecastLocation`, so a
 * returned result is inside the accepted service area by construction. What the
 * matrix checks is the part fixtures cannot: that the live provider actually
 * resolves bare and fully qualified administrative names.
 *
 * Usage: KAKAO_REST_API_KEY=… npm run location:matrix
 */

interface MatrixCase {
  query: string;
  note: string;
  /** Return a failure reason, or null when the case passes. */
  check(results: readonly ForecastLocationSearchResult[]): string | null;
}

const nonEmpty = (results: readonly ForecastLocationSearchResult[]): string | null =>
  results.length > 0 ? null : "no candidates";

function labelsOf(results: readonly ForecastLocationSearchResult[]): string[] {
  return results.map((result) => result.label);
}

const CASES: MatrixCase[] = [
  { query: "서울", note: "bare 시/도", check: nonEmpty },
  { query: "서울시", note: "colloquial 시/도 suffix", check: nonEmpty },
  { query: "수원시", note: "시", check: nonEmpty },
  { query: "제주시", note: "시 on an island", check: nonEmpty },
  { query: "강남구", note: "bare 구 — must not be a Buyeo mountain pass", check: nonEmpty },
  { query: "수원시 영통구", note: "시 + 구", check: nonEmpty },
  { query: "서귀포시", note: "시 on an island", check: nonEmpty },
  {
    query: "삼성동",
    note: "duplicate leaf — must stay separate candidates",
    check: (results) => {
      if (results.length === 0) return "no candidates";
      const distinct = new Set(labelsOf(results));
      return distinct.size > 1
        ? null
        : "duplicate leaf collapsed to one candidate";
    },
  },
  {
    query: "서울 강남구 삼성동",
    note: "fully qualified — exact match must rank first",
    check: (results) => {
      if (results.length === 0) return "no candidates";
      const top = results[0].label;
      const missing = ["강남구", "삼성동"].filter((segment) => !top.includes(segment));
      return missing.length === 0 ? null : `top result missing ${missing.join(", ")}`;
    },
  },
  { query: "신대방제2동", note: "numbered 행정동", check: nonEmpty },
];

/** Hangul and CJK render two columns wide, so padding by code unit misaligns. */
function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(value: string, width: number): string {
  const padding = width - displayWidth(value);
  return padding > 0 ? value + " ".repeat(padding) : `${value} `;
}

async function main(): Promise<void> {
  if (!process.env.KAKAO_REST_API_KEY?.trim()) {
    throw new Error(
      "KAKAO_REST_API_KEY is required. Set it in .env.local or the environment; " +
        "never pass a key as a command-line argument.",
    );
  }

  const rows: Array<{ query: string; note: string; status: string; detail: string }> = [];
  let failures = 0;

  for (const matrixCase of CASES) {
    try {
      const results = await searchKoreanLocations(matrixCase.query);
      const reason = matrixCase.check(results);
      if (reason) failures += 1;
      rows.push({
        query: matrixCase.query,
        note: matrixCase.note,
        status: reason ? "FAIL" : "pass",
        detail: reason
          ? reason
          : `${results.length} · ${labelsOf(results).slice(0, 2).join(" | ")}`,
      });
    } catch (error) {
      failures += 1;
      // The message may name the upstream status but never the key itself.
      rows.push({
        query: matrixCase.query,
        note: matrixCase.note,
        status: "ERROR",
        detail: error instanceof Error ? error.message : "search failed",
      });
    }
    // Space the calls out; this is a release check, not a load test.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.log(`\n${pad("QUERY", 22)}${pad("RESULT", 8)}DETAIL`);
  console.log("-".repeat(96));
  for (const row of rows) {
    console.log(`${pad(row.query, 22)}${pad(row.status, 8)}${row.detail}`);
    console.log(`${" ".repeat(30)}\x1b[2m${row.note}\x1b[0m`);
  }
  console.log("-".repeat(96));
  console.log(
    `${CASES.length - failures}/${CASES.length} passed. ` +
      "Every candidate shown already passed service-area validation.\n",
  );

  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "location matrix failed");
  process.exitCode = 1;
});
