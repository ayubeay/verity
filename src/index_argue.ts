import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { base } from "viem/chains";
import fs from "node:fs";
import path from "node:path";

const RPC        = process.env.BASE_RPC || "https://mainnet.base.org";
const FACTORY    = (process.env.FACTORY_ADDRESS || "0x0692eC85325472Db274082165620829930f2c1F9") as `0x${string}`;
const OUT_DIR    = process.env.OUT_DIR || "./data";
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

const FACTORY_ABI = parseAbi([
  "function getAllDebates() external view returns (address[])",
  "function getResolvedDebates() external view returns (address[])",
  "function getUserStats(address user) external view returns (uint256 totalWinnings, uint256 totalBets, uint256 debatesParticipated, uint256 debatesWon, uint256 totalClaimed, int256 netProfit, uint256 winRate)",
]);

const DEBATE_ABI = parseAbi([
  "function getInfo() external view returns (address creator, string debateStatement, string description, string sideAName, string sideBName, uint256 creationDate, uint256 endDate, bool isResolved, bool isSideAWinner, uint256 totalLockedA, uint256 totalUnlockedA, uint256 totalLockedB, uint256 totalUnlockedB, string winnerReasoning, uint256 totalContentBytes, uint256 maxTotalContentBytes, uint256 totalBounty)",
  "function getArgumentsOnSideA() external view returns ((address author, string content, uint256 timestamp, uint256 amount)[])",
  "function getArgumentsOnSideB() external view returns ((address author, string content, uint256 timestamp, uint256 amount)[])",
  "function status() external view returns (uint8)",
]);

function chunks<T>(arr: T[], n: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += n) result.push(arr.slice(i, i + n));
  return result;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const client = createPublicClient({
    chain: base,
    transport: http(RPC, { retryCount: 5, retryDelay: 2000 }),
  });

  console.log("📡 Fetching all debate addresses from factory...");
  const allDebates = await client.readContract({
    address: FACTORY, abi: FACTORY_ABI, functionName: "getAllDebates",
  }) as `0x${string}`[];
  console.log(`   Found ${allDebates.length} total debates`);

  const resolvedDebates = await client.readContract({
    address: FACTORY, abi: FACTORY_ABI, functionName: "getResolvedDebates",
  }) as `0x${string}`[];
  console.log(`   ${resolvedDebates.length} resolved`);

  const allArguments: any[] = [];
  const seenAgents = new Set<string>();
  const debateStream = fs.createWriteStream(path.join(OUT_DIR, "argue_debates.jsonl"), { flags: "w" });

  console.log("\n🔍 Fetching debate details...");
  let processed = 0, succeeded = 0, failed = 0;

  for (const batch of chunks(allDebates, CONCURRENCY)) {
    const results = await Promise.allSettled(
      batch.map(async (debateAddr) => {
        const addr = debateAddr as `0x${string}`;

        const info = await client.readContract({ address: addr, abi: DEBATE_ABI, functionName: "getInfo" }) as any[];
        const argsA = await client.readContract({ address: addr, abi: DEBATE_ABI, functionName: "getArgumentsOnSideA" }) as any[];
        const argsB = await client.readContract({ address: addr, abi: DEBATE_ABI, functionName: "getArgumentsOnSideB" }) as any[];

        const [creator, statement, description, sideAName, sideBName,
               creationDate, endDate, isResolved, isSideAWinner,
               totalLockedA, totalUnlockedA, totalLockedB, totalUnlockedB,
               winnerReasoning, totalContentBytes, maxTotalContentBytes, totalBounty] = info;

        const mapArg = (arg: any, side: "A" | "B") => ({
          author: arg.author.toLowerCase(),
          content: arg.content,
          amount: arg.amount.toString(),
          timestamp: Number(arg.timestamp),
          side,
          debateAddress: addr.toLowerCase(),
          won: isResolved ? (side === "A" ? isSideAWinner : !isSideAWinner) : null,
        });

        const argumentsA = argsA.map((a: any) => mapArg(a, "A"));
        const argumentsB = argsB.map((a: any) => mapArg(a, "B"));

        return {
          address: addr.toLowerCase(), creator, statement, description,
          sideAName, sideBName,
          creationDate: Number(creationDate), endDate: Number(endDate),
          isResolved, isSideAWinner,
          totalA: (BigInt(totalLockedA) + BigInt(totalUnlockedA)).toString(),
          totalB: (BigInt(totalLockedB) + BigInt(totalUnlockedB)).toString(),
          winnerReasoning, totalBounty: totalBounty.toString(),
          argumentsA, argumentsB,
        };
      })
    );

    for (const result of results) {
      if (result.status === "rejected") {
        failed++;
        console.warn(`  ⚠️  ${result.reason?.message?.slice(0, 60)}`);
        continue;
      }
      succeeded++;
      const record = result.value;
      debateStream.write(JSON.stringify(record) + "\n");
      for (const arg of [...record.argumentsA, ...record.argumentsB]) {
        allArguments.push(arg);
        seenAgents.add(arg.author);
      }
    }

    processed += batch.length;
    process.stdout.write(`\r   ${processed}/${allDebates.length} processed (${succeeded} ok, ${failed} failed)`);
    await sleep(300);
  }

  debateStream.end();
  console.log(`\n   ✅ ${succeeded} debates, ${failed} failed`);
  console.log(`   ✅ ${allArguments.length} arguments`);
  console.log(`   📊 ${seenAgents.size} unique agents`);

  const argStream = fs.createWriteStream(path.join(OUT_DIR, "argue_events.jsonl"), { flags: "w" });
  for (const arg of allArguments) argStream.write(JSON.stringify(arg) + "\n");
  argStream.end();

  console.log("\n🧑‍💻 Fetching agent stats...");
  const agentStream = fs.createWriteStream(path.join(OUT_DIR, "agent_stats.jsonl"), { flags: "w" });
  let agentCount = 0;

  for (const batch of chunks(Array.from(seenAgents), CONCURRENCY)) {
    const results = await Promise.allSettled(
      batch.map(async (wallet) => {
        const s = await client.readContract({
          address: FACTORY, abi: FACTORY_ABI,
          functionName: "getUserStats",
          args: [getAddress(wallet) as `0x${string}`],
        }) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
        return {
          wallet,
          totalWinnings: s[0].toString(),
          totalBets: s[1].toString(),
          debatesParticipated: s[2].toString(),
          debatesWon: s[3].toString(),
          totalClaimed: s[4].toString(),
          netProfit: s[5].toString(),
          winRate: s[6].toString(),
        };
      })
    );
    for (const r of results) {
      if (r.status === "rejected") continue;
      agentStream.write(JSON.stringify(r.value) + "\n");
      agentCount++;
    }
    await sleep(200);
  }

  agentStream.end();
  console.log(`   ✅ ${agentCount} agent stats written`);
  console.log("\n✅ Done. Run: npx tsx src/score_ais.ts");
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
