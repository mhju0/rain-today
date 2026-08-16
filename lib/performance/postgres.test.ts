import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletedComparisonsQuery } from "./postgres.ts";
import { PERFORMANCE_PROVIDERS } from "./store.ts";

/**
 * Behaviour lives in `storeContract.test.ts`, which runs the same suite against
 * every adapter. What remains here is the one thing a contract run cannot check
 * without a database: that placeholders and bound parameters line up, so a
 * reordered parameter list cannot silently query the wrong provider.
 */
test("PostgreSQL comparison query binds every placeholder it declares", () => {
  const query = buildCompletedComparisonsQuery("108", "06", 60);
  const placeholders = new Set(query.text.match(/\$\d+/g) ?? []);

  assert.deepEqual(query.parameters, ["108", "06", 60, ...PERFORMANCE_PROVIDERS]);
  assert.equal(placeholders.size, query.parameters.length);
  for (let index = 1; index <= query.parameters.length; index += 1) {
    assert.ok(placeholders.has(`$${index}`), `query never binds $${index}`);
  }
});
