/** 특정 시드의 위반 발생 순간을 정확히 짚기 위한 디버그 러너. */
import {
  World,
  faultInjector,
  ipChange,
  reconcileTimer,
  rehabTimer,
  workerLoop,
  type DesignMode,
  type Faults,
  type Proc,
} from "./lifecycle-model";

const mode = (process.argv[2] ?? "redesign") as DesignMode;
const seed = Number(process.argv[3] ?? 9);

const faults: Faults = {
  stopFails: false,
  updateTimesOut: false,
  brokerDown: false,
  profileVanishes: false,
};

function makeRng(s: number): () => number {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const world = new World(mode, 4, 8, 2, { ...faults });
const procs: { name: string; gen: Proc; done: boolean }[] = [];
for (const b of world.browsers) {
  procs.push({ name: `worker:${b.profileId}`, gen: workerLoop(world, b), done: false });
}
procs.push({ name: "ipchange", gen: ipChange(world), done: false });
if (mode === "redesign") {
  procs.push({ name: "reconcile", gen: reconcileTimer(world), done: false });
  procs.push({ name: "rehab", gen: rehabTimer(world), done: false });
}
procs.push({ name: "faults", gen: faultInjector(world, [0, 2]), done: false });

const rng = makeRng(seed);
const snap = (): string =>
  world.browsers
    .map(
      (b) =>
        `${b.profileId}[${b.state}${b.running ? ",run" : ""} lease=${b.lease ? `${b.lease.proxyId}${b.lease.applied ? "*" : "?"}` : "-"} eg=${b.egress ?? "-"}]`,
    )
    .join(" ");
const ledgerSnap = (): string =>
  world.ledger.rows
    .filter((r) => r.leased)
    .map((r) => `${r.id}(g${r.group},own=${r.owner ?? "-"})`)
    .join(" ") || "(none)";

for (let step = 0; step < 500; step++) {
  const runnable = procs.filter((p) => !p.done);
  if (runnable.length === 0) break;
  const slot = runnable[Math.floor(rng() * runnable.length)]!;
  const next = slot.gen.next();
  if (next.done) slot.done = true;
  world.clock++;
  const before = world.violations.length;
  world.checkSafety();
  if (world.violations.length > before) {
    const v = world.violations[world.violations.length - 1]!;
    console.log(`\n*** 위반 ${v.invariant} @clock=${v.clock} step=${step}`);
    console.log(`    ${v.detail}`);
    console.log(`    직전 스텝: ${slot.name} :: ${next.done ? "(done)" : next.value}`);
    console.log(`    브라우저: ${snap()}`);
    console.log(`    원장(leased): ${ledgerSnap()}`);
    break;
  }
}
console.log("\n최종 브라우저:", snap());
console.log("최종 원장(leased):", ledgerSnap());
console.log("위반:", world.violations.map((v) => `${v.invariant}@${v.clock}`).join(", ") || "(없음)");
