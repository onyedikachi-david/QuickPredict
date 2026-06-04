import Database from "bun:sqlite";

async function main() {
  const db = new Database("/Users/onyedikachi/Documents/codes/QuickPredict/quick-predict.db");
  const positions = db.query("SELECT internal_id, tx_hash, asset_symbol, strike FROM positions").all();
  console.log("Positions:", positions);
}

main().catch(console.error);
