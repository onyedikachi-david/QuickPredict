import { getRpcClient } from "../src/sui/client";

async function main() {
  const client = getRpcClient();
  const digest = "96UNBKk14NpcnmKdtShYTxsYKn2wrj8CfdXUCL7EahZL";
  console.log("Querying transaction details for:", digest);
  
  const tx = await client.getTransactionBlock({
    digest,
    options: {
      showInput: true,
      showEffects: true,
      showEvents: true,
      showBalanceChanges: true,
    }
  });
  
  console.log("Transaction details:");
  console.log(JSON.stringify(tx, null, 2));
}

main().catch(console.error);
