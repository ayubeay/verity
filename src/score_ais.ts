import fs from "node:fs";
import readline from "node:readline";

const IN_EVENTS  = process.env.IN_EVENTS  || "./data/argue_events.jsonl";
const IN_STATS   = process.env.IN_STATS   || "./data/agent_stats.jsonl";
const OUT_SCORES = process.env.OUT_SCORES || "./data/ais_scores.jsonl";
const OUT_LB     = process.env.OUT_LB     || "./data/leaderboard.json";

const FLAG_HIGH_RISK          = 1 << 0;
const FLAG_STAKE_VOLATILITY   = 1 << 1;
const FLAG_CONCENTRATION_RISK = 1 << 2;
const FLAG_NARROW_WIN_FARMING = 1 << 3;
const FLAG_LOW_SAMPLE         = 1 << 4;
const FLAG_FIRST_LOSS         = 1 << 5;

const clamp  = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const mean   = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
const stddev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x=>(x-m)**2)));
};
const normalizeBigints = (xs: bigint[]) => {
  if (!xs.length) return [];
  const max = xs.reduce((a,b)=>b>a?b:a, 0n);
  if (max===0n) return xs.map(()=>0);
  return xs.map(x=>Number((x*10000n)/max)/10000);
};

async function readJsonl<T>(filepath: string): Promise<T[]> {
  if (!fs.existsSync(filepath)) return [];
  const rl = readline.createInterface({ input: fs.createReadStream(filepath), crlfDelay: Infinity });
  const rows: T[] = [];
  for await (const line of rl) { if (line.trim()) rows.push(JSON.parse(line) as T); }
  return rows;
}

function formatStake(wei: bigint): string {
  const e18 = BigInt("1000000000000000000");
  const whole = wei / e18;
  const frac  = (wei % e18) * 100n / e18;
  return `${whole}.${frac.toString().padStart(2,"0")} ARGUE`;
}

async function main() {
  console.log("🧮 VERITY AIS Scorer\n");

  const events   = await readJsonl<any>(IN_EVENTS);
  const statsRaw = await readJsonl<any>(IN_STATS);
  const resolvedEvents = events.filter((e:any) => e.won !== null);
  console.log(`   ${events.length} argument events`);
  console.log(`   ${statsRaw.length} agent stat records`);
  console.log(`   ${resolvedEvents.length} resolved outcomes (won != null)`);

  const statsMap = new Map<string,any>(statsRaw.map((s:any)=>[s.wallet.toLowerCase(), s]));
  const profiles = new Map<string,any>();

  for (const ev of events) {
    const w = ev.author.toLowerCase();
    if (!profiles.has(w)) {
      profiles.set(w, {
        wallet: w, wins: 0, losses: 0, unresolved: 0,
        argumentsCount: 0,
        totalAmountStaked: 0n,
        amountsPerDebate: new Map(),
        winAmounts: [], lossAmounts: [], allAmounts: [],
        debatesParticipated: new Set(),
        contractWinRate: 0,
      });
    }
    const p   = profiles.get(w)!;
    const amt = BigInt(ev.amount);
    p.argumentsCount++;
    p.totalAmountStaked += amt;
    p.allAmounts.push(amt);
    p.debatesParticipated.add(ev.debateAddress);
    p.amountsPerDebate.set(ev.debateAddress, (p.amountsPerDebate.get(ev.debateAddress) ?? 0n) + amt);
    if      (ev.won === null)  p.unresolved++;
    else if (ev.won)           { p.wins++;   p.winAmounts.push(amt); }
    else                       { p.losses++; p.lossAmounts.push(amt); }
  }

  for (const [wallet, p] of profiles.entries()) {
    const cs = statsMap.get(wallet);
    if (cs) {
      const raw = Number(cs.winRate);
      p.contractWinRate = raw > 1 ? raw / 10000 : raw;
    }
  }

  const scores: any[] = [];
  const TIER_LABEL = ["TRUSTED","STANDARD","FLAGGED","RESTRICTED"];

  for (const p of profiles.values()) {
    const resolved            = p.wins + p.losses;
    const participatedDebates = p.debatesParticipated.size;
    const avgStake = p.allAmounts.length
      ? p.totalAmountStaked / BigInt(p.allAmounts.length)
      : 0n;

    if (resolved === 0) {
      scores.push({
        wallet: p.wallet, ais: 50, tier: 1, flags: FLAG_LOW_SAMPLE,
        winRate: 0, resolvedDebates: 0, confidence: 0,
        participatedDebates, argumentsCount: p.argumentsCount,
        totalStaked: p.totalAmountStaked.toString(),
        avgStake: avgStake.toString(),
        stakeVolatility: 0, concentrationRisk: 0,
        contractWinRate: p.contractWinRate,
        flagReasons: ["LOW_SAMPLE: no resolved debates yet"],
      });
      continue;
    }

    const confidence = clamp(resolved / 5, 0.2, 1.0);
    const winRate    = p.wins / resolved;

    // contractConsistency only reliable with 3+ resolved
    const contractConsistency = resolved >= 3
      ? 1 - Math.abs(p.contractWinRate - winRate)
      : 0;

    const normAmounts     = normalizeBigints(p.allAmounts);
    const stakeVolatility = clamp(stddev(normAmounts), 0, 1);
    let concentrationRisk = 0;
    if (p.totalAmountStaked > 0n) {
      const debateTotals = Array.from(p.amountsPerDebate.values()) as bigint[];
      const maxDebate    = debateTotals.reduce((a:bigint,b:bigint)=>b>a?b:a, 0n);
      concentrationRisk  = clamp(Number((maxDebate*10000n)/p.totalAmountStaked)/10000, 0, 1);
    }

    let delta = 30*winRate
              - 15*stakeVolatility
              - 10*concentrationRisk
              + (resolved >= 3 ? 10*contractConsistency : 0);

    // Direction lock: at low confidence, a net loss cannot raise AIS above 50,
    // and a net win cannot lower it below 50.
    if (confidence < 1) {
      const outcomeSign = p.wins - p.losses;
      if (outcomeSign < 0) delta = Math.min(delta, 0);
      if (outcomeSign > 0) delta = Math.max(delta, 0);
    }

    const ais  = Math.round(clamp(50 + confidence * delta, 0, 100));
    const tier = ais>=75 ? 0 : ais>=55 ? 1 : ais>=35 ? 2 : 3;

    let flags = 0; const flagReasons: string[] = [];
    if (resolved === 1 && p.losses === 1) { flags |= FLAG_FIRST_LOSS;         flagReasons.push("FIRST_RESOLVED_LOSS"); }
    if (resolved === 1 && p.wins === 1)   {                                    flagReasons.push("FIRST_RESOLVED_WIN"); }
    if (resolved < 5)                     { flags |= FLAG_LOW_SAMPLE;         flagReasons.push(`LOW_SAMPLE: ${resolved}/5 (conf ${Math.round(confidence*100)}%)`); }
    if (ais < 35)                         { flags |= FLAG_HIGH_RISK;           flagReasons.push("HIGH_RISK"); }
    if (stakeVolatility > 0.65)           { flags |= FLAG_STAKE_VOLATILITY;    flagReasons.push("STAKE_VOLATILITY"); }
    if (concentrationRisk > 0.7)          { flags |= FLAG_CONCENTRATION_RISK;  flagReasons.push("CONCENTRATION_RISK"); }
    if (winRate > 0.75 && p.winAmounts.length > 0 && p.lossAmounts.length > 0) {
      const avgWin  = mean(p.winAmounts.map(Number));
      const avgLoss = mean(p.lossAmounts.map(Number));
      if (avgLoss > avgWin * 2) { flags |= FLAG_NARROW_WIN_FARMING; flagReasons.push("NARROW_WIN_FARMING"); }
    }

    scores.push({
      wallet: p.wallet, ais, tier, flags,
      winRate, resolvedDebates: resolved, confidence,
      participatedDebates, argumentsCount: p.argumentsCount,
      totalStaked: p.totalAmountStaked.toString(),
      avgStake: avgStake.toString(),
      stakeVolatility, concentrationRisk,
      contractWinRate: p.contractWinRate, flagReasons,
    });
  }

  scores.sort((a,b) =>
    b.ais !== a.ais               ? b.ais - a.ais :
    b.confidence !== a.confidence ? b.confidence - a.confidence :
    b.resolvedDebates !== a.resolvedDebates ? b.resolvedDebates - a.resolvedDebates :
    BigInt(b.totalStaked) > BigInt(a.totalStaked) ? 1 : -1
  );

  const scoresStream = fs.createWriteStream(OUT_SCORES, { flags:"w" });
  for (const s of scores) scoresStream.write(JSON.stringify(s)+"\n");
  scoresStream.end();

  const debatesRaw     = await readJsonl<any>("./data/argue_debates.jsonl");
  const resolvedDebates = debatesRaw.filter((d:any) => d.isResolved);

  const leaderboard = {
    generatedAt:          new Date().toISOString(),
    totalAgents:          scores.length,
    totalDebates:         debatesRaw.length,
    totalArguments:       events.length,
    resolvedDebatesCount: resolvedDebates.length,
    resolvedOutcomesCount: resolvedEvents.length,
    lastResolvedDebates:  resolvedDebates.slice(0,3).map((d:any) => ({
      address: d.address, statement: d.statement,
      isSideAWinner: d.isSideAWinner,
      totalA: d.totalA, totalB: d.totalB,
      argsA: d.argumentsA?.length ?? 0,
      argsB: d.argumentsB?.length ?? 0,
    })),
    distribution: {
      trusted:    scores.filter(s=>s.tier===0).length,
      standard:   scores.filter(s=>s.tier===1).length,
      flagged:    scores.filter(s=>s.tier===2).length,
      restricted: scores.filter(s=>s.tier===3).length,
    },
    top20: scores.slice(0,20).map(s=>({
      wallet: s.wallet, ais: s.ais, tier: TIER_LABEL[s.tier],
      confidence: `${Math.round(s.confidence*100)}%`,
      winRate: `${(s.winRate*100).toFixed(1)}%`,
      resolvedDebates: s.resolvedDebates,
      participatedDebates: s.participatedDebates,
      argumentsCount: s.argumentsCount,
      totalStaked: formatStake(BigInt(s.totalStaked)),
      flags: s.flagReasons,
    })),
  };

  fs.writeFileSync(OUT_LB, JSON.stringify(leaderboard, null, 2));

  console.log("\n📊 Distribution:");
  console.log(`   TRUSTED    (75–100): ${leaderboard.distribution.trusted}`);
  console.log(`   STANDARD   (55–74):  ${leaderboard.distribution.standard}`);
  console.log(`   FLAGGED    (35–54):  ${leaderboard.distribution.flagged}`);
  console.log(`   RESTRICTED (0–34):   ${leaderboard.distribution.restricted}`);
  console.log(`\n   Resolved debates: ${resolvedDebates.length}  |  Resolved outcomes: ${resolvedEvents.length}`);

  console.log("\n🏆 Agent leaderboard:");
  scores.slice(0,17).forEach((s,i)=>{
    const conf = s.confidence > 0 ? ` conf=${Math.round(s.confidence*100)}%` : "";
    console.log(`   ${String(i+1).padStart(2)}. ${s.wallet.slice(0,10)}…  AIS=${s.ais}${conf}  debates=${s.participatedDebates}  resolved=${s.resolvedDebates}  args=${s.argumentsCount}  staked=${formatStake(BigInt(s.totalStaked))}  flags=${s.flagReasons[0]||"none"}`);
  });

  console.log(`\n✅ Scores     → ${OUT_SCORES}`);
  console.log(`✅ Leaderboard → ${OUT_LB}`);
}

main().catch((e)=>{ console.error("❌", e); process.exit(1); });
