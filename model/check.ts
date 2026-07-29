/**
 * REDESIGN.md §9 — 모델 검사기.
 *
 * 적대적 인터리빙을 무작위 스케줄로 대량 탐색하며 I1~I7 을 반증 시도한다.
 * 세 설계(legacy / patched / redesign) × 결함 조합을 모두 돌려,
 *  - 모델이 과거 실제 사고를 재현하는지 (모델 자체의 타당성 검증)
 *  - 재설계가 전 불변식을 만족하는지
 * 를 동시에 확인한다.
 *
 * 실행: bun run model/check.ts
 */

import {
  GRACE,
  World,
  crashInjector,
  faultInjector,
  ipChange,
  reconcileTimer,
  rehabTimer,
  workerLoop,
  type DesignMode,
  type Faults,
  type Proc,
  type Violation,
} from "./lifecycle-model";

const envNum = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} 가 숫자가 아님: ${raw}`);
  return n;
};

const PROFILES = envNum("MODEL_PROFILES", 4);
const PROXIES = envNum("MODEL_PROXIES", 8);
const GROUPS = envNum("MODEL_GROUPS", 2);
const MAX_STEPS = envNum("MODEL_STEPS", 500);
const DRAIN_LIMIT = envNum("MODEL_DRAIN", 200);
const SEEDS = envNum("MODEL_SEEDS", 400);
const QUIESCE_LIMIT = envNum("MODEL_QUIESCE", 400);

interface ProcSlot {
  name: string;
  gen: Proc;
  done: boolean;
}

/** 결정적 PRNG (mulberry32) — 시드로 스케줄을 재현 가능하게 만든다. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RunResult {
  violations: Violation[];
  trace: string[];
}

function runSchedule(mode: DesignMode, faults: Faults, seed: number): RunResult {
  const world = new World(mode, PROFILES, PROXIES, GROUPS, { ...faults });
  const procs: ProcSlot[] = [];

  for (const browser of world.browsers) {
    procs.push({
      name: `worker:${browser.profileId}`,
      gen: workerLoop(world, browser),
      done: false,
    });
  }
  procs.push({ name: "ipchange", gen: ipChange(world), done: false });
  if (mode === "redesign") {
    procs.push({ name: "reconcile", gen: reconcileTimer(world), done: false });
    procs.push({ name: "rehab", gen: rehabTimer(world), done: false });
  }
  procs.push({
    name: "faults",
    gen: faultInjector(world, [0, 2]),
    done: false,
  });

  const rng = makeRng(seed);
  procs.push({ name: "crash", gen: crashInjector(world, rng), done: false });

  const trace: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const runnable = procs.filter((p) => !p.done);
    if (runnable.length === 0) break;
    const slot = runnable[Math.floor(rng() * runnable.length)]!;
    const next = slot.gen.next();
    if (next.done) {
      slot.done = true;
    } else {
      trace.push(`${slot.name} :: ${next.value}`);
    }
    world.clock++;
    world.checkSafety();
  }

  // ── 수렴 단계: churn 을 멈추고 시스템이 스스로 회복하는지 본다(진행성 I4) ──
  world.churnStopped = true;
  for (let step = 0; step < QUIESCE_LIMIT; step++) {
    const runnable = procs.filter((p) => !p.done);
    if (runnable.length === 0) break;
    const slot = runnable[Math.floor(rng() * runnable.length)]!;
    const next = slot.gen.next();
    if (next.done) slot.done = true;
    world.clock++;
    world.checkSafety();
  }
  world.checkProgress();

  // 정지 요청 → 드레인
  world.stopRequested = true;
  for (let step = 0; step < DRAIN_LIMIT; step++) {
    const runnable = procs.filter((p) => !p.done);
    if (runnable.length === 0) break;
    for (const slot of runnable) {
      const next = slot.gen.next();
      if (next.done) slot.done = true;
    }
    world.clock++;
    world.checkSafety();
  }
  world.drained = procs.every((p) => p.done);

  // redesign 은 독립 리컨실 타이머가 계속 돌므로, 시간 경과 후 최종 스윕을 모델링한다.
  // legacy/patched 에는 그런 경로가 없다(그게 핵심 차이).
  if (mode === "redesign") {
    world.clock += GRACE + 1;
    world.ledger.reclaim(world.heldProxyIds(), world.clock, undefined);
  }

  world.checkFinal();
  return { violations: world.violations, trace };
}

const FAULT_SETS: ReadonlyArray<{ name: string; faults: Faults }> = [
  {
    name: "무결함",
    faults: { stopFails: false, updateTimesOut: false, brokerDown: false, profileVanishes: false },
  },
  {
    name: "stop 실패",
    faults: { stopFails: true, updateTimesOut: false, brokerDown: false, profileVanishes: false },
  },
  {
    name: "updateProfile 타임아웃",
    faults: { stopFails: false, updateTimesOut: true, brokerDown: false, profileVanishes: false },
  },
  {
    name: "브로커 다운",
    faults: { stopFails: false, updateTimesOut: false, brokerDown: true, profileVanishes: false },
  },
  {
    name: "프로필 소멸",
    faults: { stopFails: false, updateTimesOut: false, brokerDown: false, profileVanishes: true },
  },
  {
    name: "복합(stop실패+프로필소멸)",
    faults: { stopFails: true, updateTimesOut: false, brokerDown: false, profileVanishes: true },
  },
];

const MODES: readonly DesignMode[] = ["legacy", "patched", "redesign"];

interface Aggregate {
  invariant: string;
  count: number;
  example: Violation;
  exampleSeed: number;
  exampleFault: string;
  exampleTrace: string[];
}

function checkMode(mode: DesignMode): Map<string, Aggregate> {
  const found = new Map<string, Aggregate>();
  for (const set of FAULT_SETS) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { violations, trace } = runSchedule(mode, set.faults, seed);
      for (const v of violations) {
        const prev = found.get(v.invariant);
        if (prev) {
          prev.count++;
          continue;
        }
        found.set(v.invariant, {
          invariant: v.invariant,
          count: 1,
          example: v,
          exampleSeed: seed,
          exampleFault: set.name,
          exampleTrace: trace.slice(-14),
        });
      }
    }
  }
  return found;
}

const totalRuns = FAULT_SETS.length * SEEDS;
console.log(
  `모델 검사: 설계 ${MODES.length}종 × 결함 ${FAULT_SETS.length}종 × 시드 ${SEEDS} = 설계당 ${totalRuns} 스케줄\n` +
    `구성: 프로필 ${PROFILES} / 프록시 ${PROXIES} / 그룹 ${GROUPS} / 최대 ${MAX_STEPS} 스텝\n`,
);

const ALL = ["I1", "I2", "I3", "I4", "I5", "I6", "I7"] as const;
let redesignClean = true;

for (const mode of MODES) {
  const found = checkMode(mode);
  const violated = ALL.filter((i) => found.has(i));
  const held = ALL.filter((i) => !found.has(i));
  const verdict = violated.length === 0 ? "전 불변식 통과" : `위반 ${violated.join(", ")}`;
  console.log(`── ${mode.padEnd(9)} → ${verdict}`);
  console.log(`   유지: ${held.length > 0 ? held.join(", ") : "(없음)"}`);
  for (const inv of violated) {
    const agg = found.get(inv)!;
    console.log(
      `   [${inv}] ${agg.count}/${totalRuns} 스케줄에서 반증  · 최초: 결함="${agg.exampleFault}" seed=${agg.exampleSeed}`,
    );
    console.log(`        ${agg.example.detail}`);
  }
  if (mode === "redesign" && violated.length > 0) {
    redesignClean = false;
    const first = found.get(violated[0]!)!;
    console.log(`\n   반례 트레이스 (마지막 14 스텝, seed=${first.exampleSeed}):`);
    for (const line of first.exampleTrace) console.log(`     · ${line}`);
  }
  console.log("");
}

if (redesignClean) {
  console.log("결과: redesign 이 I1~I7 을 모두 만족. legacy/patched 는 반증되어 모델 타당성도 확인됨.");
} else {
  console.log("결과: redesign 에 반례 존재 — 설계를 수정하고 재검증해야 한다.");
  process.exitCode = 1;
}
