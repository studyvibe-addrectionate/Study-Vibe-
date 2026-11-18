import Database from "better-sqlite3";
import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing.");
}

const sqlite = new Database("study-vibe.sqlite", {
  readonly: true
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2
});

const tables = ["users", "payments", "ai_usage"];

async function migrate() {
  const client = await pool.connect();

  try {
    console.log("Checking PostgreSQL destination...");

    await client.query("BEGIN");

    // Prevent accidental duplicate imports.
    for (const table of tables) {
      const result = await client.query(
        `SELECT COUNT(*) FROM ${table}`
      );

      if (Number(result.rows[0].count) !== 0) {
        throw new Error(
          `PostgreSQL table ${table} is not empty. Migration stopped.`
        );
      }
    }

    const users = sqlite.prepare(
      "SELECT * FROM users ORDER BY id"
    ).all();

    const payments = sqlite.prepare(
      "SELECT * FROM payments ORDER BY id"
    ).all();

    const usage = sqlite.prepare(
      "SELECT * FROM ai_usage ORDER BY id"
    ).all();

    console.log("Copying records...");

    for (const user of users) {
      await client.query(`
        INSERT INTO users (
          id, email, password_hash, plan,
          premium_started_at, premium_expires_at, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [
        user.id,
        user.email,
        user.password_hash,
        user.plan,
        user.premium_started_at,
        user.premium_expires_at,
        user.created_at
      ]);
    }

    for (const payment of payments) {
      await client.query(`
        INSERT INTO payments (
          id, user_id, amount, currency, provider,
          transaction_id, status, created_at,
          sender_number, reviewed_at, reviewed_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [
        payment.id,
        payment.user_id,
        payment.amount,
        payment.currency,
        payment.provider,
        payment.transaction_id,
        payment.status,
        payment.created_at,
        payment.sender_number,
        payment.reviewed_at,
        payment.reviewed_by
      ]);
    }

    for (const record of usage) {
      await client.query(`
        INSERT INTO ai_usage (
          id, user_id, period_type,
          period_start, requests_used
        )
        VALUES ($1,$2,$3,$4,$5)
      `, [
        record.id,
        record.user_id,
        record.period_type,
        record.period_start,
        record.requests_used
      ]);
    }

    // Synchronize identity sequences after preserving original IDs.
    for (const table of tables) {
      await client.query(`
        SELECT setval(
          pg_get_serial_sequence('${table}', 'id'),
          COALESCE((SELECT MAX(id) FROM ${table}), 1),
          EXISTS (SELECT 1 FROM ${table})
        )
      `);
    }

    await client.query("COMMIT");

    console.log("--------------------------------");
    console.log("MIGRATION SUCCESSFUL");
    console.log("Users copied:", users.length);
    console.log("Payments copied:", payments.length);
    console.log("AI usage records copied:", usage.length);
    console.log("Old sessions were not copied.");
    console.log("--------------------------------");

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", error.message);
    process.exitCode = 1;

  } finally {
    client.release();
    sqlite.close();
    await pool.end();
  }
}

migrate().catch(async error => {
  console.error("Migration error:", error.message);
  sqlite.close();
  await pool.end();
  process.exitCode = 1;
});