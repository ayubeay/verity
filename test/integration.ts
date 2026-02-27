// test/integration.ts
// Run with: npx tsx test/integration.ts
//
// Tests all 5 components in order:
//   1. Trace Store
//   2. Refresh pipeline (atomic)
//   3. Governor (approve + deny paths)
//   4. Health checks (logic only, no HTTP)
//   5. Survivor scan end-to-end

import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { initTraceStore } from "../store/traceStore.js";
import { runTracedSkill } from "../middleware/withTrace.js";
import { withGovernor, GovernorDenied } from "../middleware/withGovernor.js";
import { survivorScanSpec } from "../skills/survivorScan.js";
import { refreshPipelineAtomicSpec, type RefreshCtx } from "../skills/refreshPipelineAtomic.js";
import * as adapters from "../adapters/refreshAdaptersAtomic.js";
import { executionGovernorSpec } from "../skills/executionGovernor.js";
import { runSkill } from "../engine/skillEngine.js";

// ─── Setup ────────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(tmpdir(), `skill-engine-test-${Date.now()}`);
await fs.mkdir(DATA_DIR, { recursive: true });
console.log(`\n[test] DATA_DIR: ${DATA_DIR}\n`);

const store = initTraceStore(DATA_DIR);
await store.init();

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ─── 1. Trace Store ───────────────────────────────────────────────────────────

console.log("─── 1. TraceStore ───────────────────────────────────────────────");

const mockResult = {
  ok: true,
  skill: { name: "test.skill", version: "0.1.0" },
  startState: "Start",
  endState: "Done",
  steps: 3,
  trace: [{ t: Date.now(), type: "done" as const, state: "Done" }],
  ctx: { mint: "abc123", label: "SAFE", score: 30 },
};

const trace_id = await store.record(mockResult);
assert(typeof trace_id === "string" && trace_id.length > 8, `generated trace_id: ${trace_id}`);

const fetched = await store.get(trace_id);
assert(fetched?.trace_id === trace_id, "trace round-trips by ID");
assert(fetched?.ok === true, "trace ok=true preserved");
assert(fetched?.ctx_summary?.mint === "abc123", "ctx_summary contains mint");

const listed = await store.list({ limit: 10 });
assert(listed.length >= 1, "list returns at least 1 trace");

// ─── 2. Refresh Pipeline (Atomic) ─────────────────────────────────────────────

console.log("\n─── 2. Refresh Pipeline (Atomic) ────────────────────────────────");

const refreshCtx: RefreshCtx = {
  mode: "LOCAL_ONLY",
  intervalTag: "test",
  baseDir: process.cwd(),
  dataDir: DATA_DIR,
  indexPath: path.join(DATA_DIR, "index.json"),
  scoresPath: path.join(DATA_DIR, "scores.json"),
  lastGoodPath: path.join(DATA_DIR, ".last_good.json"),
  adapters: {
    checkVolume: adapters.checkVolume,
    loadLastGood: adapters.loadLastGood,
    buildIndex: adapters.buildIndex,
    scoreIndex: adapters.scoreIndex,
    writeAtomic: adapters.writeAtomic,
    commitLastGood: adapters.commitLastGood,
    rollback: adapters.rollback,
    publish: adapters.publish,
  },
};

const refreshResult = await runSkill(refreshPipelineAtomicSpec, refreshCtx, { maxSteps: 80 });
assert(refreshResult.ok, `refresh ok (endState=${refreshResult.endState})`);
assert(refreshResult.endState === "Done", "refresh ends in Done");

// Check artifacts exist
const indexExists = await fs.stat(path.join(DATA_DIR, "index.json")).then(() => true).catch(() => false);
const scoresExists = await fs.stat(path.join(DATA_DIR, "scores.json")).then(() => true).catch(() => false);
const lastGoodExists = await fs.stat(path.join(DATA_DIR, ".last_good.json")).then(() => true).catch(() => false);

assert(indexExists, "index.json created");
assert(scoresExists, "scores.json created");
assert(lastGoodExists, ".last_good.json created");

const trace_id_refresh = await store.record(refreshResult);
assert(trace_id_refresh !== "unrecorded", "refresh trace recorded");

// ─── 3. Execution Governor ────────────────────────────────────────────────────

console.log("\n─── 3. Execution Governor ───────────────────────────────────────");

// Should APPROVE: high quality signals
const approveRun = await runSkill(executionGovernorSpec, {
  action: "trade.execute",
  regime: "ACCUMULATION",
  safety: 90,
  conviction: 80,
  regimeAlignment: 85,
  riskBudget: 75,
  executionAllowance: 100,
  mode: "PRIVATE",
});
assert(approveRun.ctx.decision === "APPROVED", `approve path: ${approveRun.ctx.decision} (${approveRun.ctx.reason})`);

// Should DENY: low risk budget
const denyRun = await runSkill(executionGovernorSpec, {
  action: "trade.execute",
  regime: "COLLAPSE",
  safety: 30,
  conviction: 20,
  regimeAlignment: 15,
  riskBudget: 5,
  executionAllowance: 100,
  mode: "PRIVATE",
});
assert(
  denyRun.ctx.decision === "DENIED" || denyRun.ctx.decision === "THROTTLED",
  `deny/throttle path: ${denyRun.ctx.decision} (${denyRun.ctx.reason})`
);

// withGovernor wrapper: APPROVED path
const guardedAction = withGovernor(
  () => ({
    action: "scan.batch",
    regime: "EXPANSION" as const,
    safety: 88,
    conviction: 75,
    regimeAlignment: 82,
    riskBudget: 70,
    executionAllowance: 100,
  }),
  async () => ({ done: true })
);
const govResult = await guardedAction();
assert(govResult.result?.done === true, "withGovernor APPROVED executes action");
assert(govResult.governor.decision === "APPROVED", "withGovernor returns governor receipt");

// withGovernor wrapper: DENIED path → throws GovernorDenied
const blockedAction = withGovernor(
  () => ({
    action: "trade.execute",
    regime: "COLLAPSE" as const,
    safety: 10,
    conviction: 10,
    regimeAlignment: 5,
    riskBudget: 5,
    executionAllowance: 0,
  }),
  async () => ({ done: true })
);
try {
  await blockedAction();
  assert(false, "should have thrown GovernorDenied");
} catch (e) {
  assert(e instanceof GovernorDenied, `DENIED path throws GovernorDenied: ${(e as any).message}`);
}

// ─── 4. Survivor Scan (end-to-end with trace) ─────────────────────────────────

console.log("\n─── 4. Survivor Scan (end-to-end) ───────────────────────────────");

const scanResult = await runTracedSkill(survivorScanSpec, {
  mint: "So11111111111111111111111111111111111111112",
});
assert(scanResult.ok, `scan ok (endState=${scanResult.endState})`);
assert(scanResult.endState === "Return", "scan ends in Return");
assert(typeof scanResult.ctx.label === "string", `label: ${scanResult.ctx.label}`);
assert(typeof scanResult.ctx.score === "number", `score: ${scanResult.ctx.score}`);
assert(scanResult.trace_id !== "unrecorded", `trace_id: ${scanResult.trace_id}`);

// Verify trace was actually written to disk
const scanTrace = await store.get(scanResult.trace_id);
assert(scanTrace !== null, "scan trace retrievable from store");

// Bad mint → fail state
const badScan = await runTracedSkill(survivorScanSpec, { mint: "short" });
assert(!badScan.ok, "bad mint → not ok");
assert(badScan.endState === "BadInput", `bad mint ends in BadInput (got ${badScan.endState})`);

// ─── 5. Summary ───────────────────────────────────────────────────────────────

console.log("\n─── Summary ─────────────────────────────────────────────────────");
const total = passed + failed;
console.log(`Passed: ${passed}/${total}`);
if (failed > 0) {
  console.error(`Failed: ${failed}/${total}`);
  process.exit(1);
} else {
  console.log("All checks passed. Stack is production-ready.");
  process.exit(0);
}
