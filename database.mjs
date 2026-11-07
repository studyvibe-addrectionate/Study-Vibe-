import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create or open the Study Vibe database.
const db = new Database(
  path.join(__dirname, "study-vibe.sqlite")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// USER ACCOUNTS
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free'
      CHECK (plan IN ('free', 'premium')),
    premium_started_at TEXT,
    premium_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// AI REQUEST USAGE
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    period_type TEXT NOT NULL
      CHECK (period_type IN ('weekly', 'monthly')),
    period_start TEXT NOT NULL,
    requests_used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
      ON DELETE CASCADE,
    UNIQUE (user_id, period_type, period_start)
  );
`);

// PAYMENT RECORDS
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'BDT',
    provider TEXT NOT NULL,
    transaction_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'verified', 'failed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
      ON DELETE CASCADE
  );
`);

console.log("Study Vibe database initialized successfully.");

export default db;