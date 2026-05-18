import { defineConfig } from "drizzle-kit";

const dbFileName = process.env.DB_FILE_NAME || "./quick-predict.db";
const dbUrl =
  dbFileName === ":memory:" ||
  dbFileName.startsWith("file:") ||
  dbFileName.startsWith("libsql:") ||
  dbFileName.startsWith("http:")
    ? dbFileName
    : `file:${dbFileName}`;

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/drizzle.schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: dbUrl,
  },
});
