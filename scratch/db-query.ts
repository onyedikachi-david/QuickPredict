import Database from "bun:sqlite";

async function main() {
  const db = new Database("/Users/onyedikachi/Documents/codes/QuickPredict/quick-predict.db");
  const positions = db.query("SELECT * FROM positions LIMIT 10").all();
  console.log("Positions in database:", positions);
  
  const users = db.query("SELECT * FROM users LIMIT 10").all();
  console.log("Users in database:", users);
}

main().catch(console.error);
