import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

const RPC     = process.env.BASE_RPC!;
const FACTORY = "0x0692eC85325472Db274082165620829930f2c1F9" as `0x${string}`;

const factoryAbi = parseAbi([
  "function getAllDebates() view returns (address[])",
  "function getResolvedDebates() view returns (address[])",
  "function getUndeterminedDebates() view returns (address[])",
]);

const debateAbi = parseAbi([
  "function getInfo() view returns (address creator, string debateStatement, string description, string sideAName, string sideBName, uint256 creationDate, uint256 endDate, bool isResolved, bool isSideAWinner, uint256 totalLockedA, uint256 totalUnlockedA, uint256 totalLockedB, uint256 totalUnlockedB, string winnerReasoning, uint256 totalContentBytes, uint256 maxTotalContentBytes, uint256 totalBounty)",
  "function status() view returns (uint8)",
]);

async function main() {
  const client = createPublicClient({ chain: base, transport: http(RPC) });

  const all          = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getAllDebates" }) as `0x${string}`[];
  const resolved     = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getResolvedDebates" }) as `0x${string}`[];
  const undetermined = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getUndeterminedDebates" }) as `0x${string}`[];

  console.log(`All: ${all.length}  Resolved: ${resolved.length}  Undetermined: ${undetermined.length}`);

  for (const addr of all.slice(0, 8)) {
    const info   = await client.readContract({ address: addr, abi: debateAbi, functionName: "getInfo" }) as any[];
    const status = await client.readContract({ address: addr, abi: debateAbi, functionName: "status" }) as number;

    const [,statement,,,, , endDate, isResolved, isSideAWinner,,,,, winnerReasoning] = info;
    const statusLabel = ["ACTIVE","RESOLVING","RESOLVED","UNDETERMINED"][status] ?? status;

    console.log(`\n${addr}`);
    console.log(`  status()=${statusLabel}  isResolved=${isResolved}  winner=${isSideAWinner}`);
    console.log(`  endDate=${new Date(Number(endDate)*1000).toISOString()}`);
    console.log(`  reasoning=${String(winnerReasoning).slice(0,80) || "(empty)"}`);
    console.log(`  statement=${String(statement).slice(0,70)}`);
  }
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
