import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletedComparisonsQuery } from "./postgres.ts";
import { PERFORMANCE_PROVIDERS } from "./store.ts";

test("PostgreSQL comparison query limits completed evidence per provider", () => {
  const query = buildCompletedComparisonsQuery("108", "06", 60);

  assert.match(query.text, /cross join lateral/i);
  assert.match(query.text, /limit \$3/i);
  assert.match(query.text, /capture\.providers @> jsonb_build_array/i);
  assert.equal(
    (query.text.match(/\(\$\d+::text\)/g) ?? []).length,
    PERFORMANCE_PROVIDERS.length,
  );
  assert.deepEqual(query.parameters, ["108", "06", 60, ...PERFORMANCE_PROVIDERS]);
});
