import assert from "node:assert/strict";
import { test } from "node:test";
import { featureAgentState } from "../src/lib/featureAgentState";

const now = Date.parse("2026-10-10T07:00:00Z");
const control = { enabled: true, lastSeenAt: new Date(now - 30_000), currentIssueId: "ticket",
  model: "gpt-6-luna", reasoning: "medium", runsDate: "2026-10-10", runsCount: 7, dailyLimit: 20 };

test("enabled is independent from laptop connectivity", () => {
  const offline = featureAgentState({ ...control, lastSeenAt: new Date(now - 120_000) }, "2026-10-10", now);
  assert.equal(offline.enabled, true);
  assert.equal(offline.online, false);
  assert.equal(offline.currentIssueId, null);
  const paused = featureAgentState({ ...control, enabled: false }, "2026-10-10", now);
  assert.equal(paused.enabled, false);
  assert.equal(paused.online, true);
  assert.equal(paused.currentIssueId, "ticket");
});

test("yesterday's quota does not appear as today's usage", () => {
  assert.equal(featureAgentState(control, "2026-10-11", now).runsCount, 0);
  assert.equal(featureAgentState(control, "2026-10-10", now).runsCount, 7);
});

test("unconfigured worker stays disabled and offline", () => {
  const state = featureAgentState(null, "2026-10-10", now);
  assert.equal(state.enabled, false);
  assert.equal(state.online, false);
  assert.equal(state.currentIssueId, null);
});
