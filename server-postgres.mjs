// ============================================
// STUDY VIBE - SERVER
// SECTION 1 OF 3
// ============================================

import express from "express";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import session from "express-session";
import bcrypt from "bcryptjs";
import { pool, initPostgresDatabase } from "./database-postgres.mjs";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// GEMINI AI CONFIGURATION
// ============================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const GEMINI_FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS ||
  "gemini-3.7-flash,gemini-3.6-flash"
).split(",").map(model => model.trim()).filter(Boolean);


const genAI = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

async function generateWithFallback(prompt) {
  if (!genAI) {
    throw new Error("Gemini API key is missing.");
  }

  const models = [
    GEMINI_MODEL,
    ...GEMINI_FALLBACK_MODELS
  ].filter((model, index, array) => {
    return array.indexOf(model) === index;
  });

  let lastError = null;

  for (const model of models) {
    try {
      console.log("Trying Gemini model:", model);

      const response = await genAI.models.generateContent({
        model,
        contents: prompt
      });

      const answer = response.text;

      if (!answer) {
        throw new Error("Gemini returned an empty response.");
      }

      return answer;
    } catch (error) {
      lastError = error;

      console.error(
        `Gemini model ${model} failed:`,
        error.message
      );

      const status = Number(
        error.status ||
        error.statusCode ||
        error.code
      );

      const retryable =
        [404, 429, 500, 502, 503, 504].includes(status) ||
        /not found|high demand|overloaded|unavailable|quota|rate limit/i.test(
          error.message || ""
        );

      if (!retryable) {
        throw error;
      }
    }
  }

  throw lastError || new Error("All Gemini models failed.");
}

async function generateStudyWithRetry(prompt) {
  return generateWithFallback(prompt);
}

async function generateWritingWithFallback(prompt) {
  return generateWithFallback(prompt);
}

class PostgresSessionStore extends session.Store {

  get(sid, callback) {
    pool.query(
      "SELECT sess, expires FROM sessions WHERE sid = $1",
      [sid]
    ).then(async (result) => {
      if (result.rows.length === 0) {
        return callback(null, null);
      }

      const row = result.rows[0];

      if (Number(row.expires) <= Date.now()) {
        await pool.query(
          "DELETE FROM sessions WHERE sid = $1",
          [sid]
        );
        return callback(null, null);
      }

      const sess = typeof row.sess === "string"
        ? JSON.parse(row.sess)
        : row.sess;

      callback(null, sess);

    }).catch(callback);
  }

  set(sid, sess, callback) {
    const expires = sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 7 * 24 * 60 * 60 * 1000;

    pool.query(`
      INSERT INTO sessions (sid, sess, expires)
      VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (sid)
      DO UPDATE SET
        sess = EXCLUDED.sess,
        expires = EXCLUDED.expires
    `, [sid, JSON.stringify(sess), expires])
      .then(() => callback?.(null))
      .catch(error => callback?.(error));
  }

  destroy(sid, callback) {
    pool.query(
      "DELETE FROM sessions WHERE sid = $1",
      [sid]
    )
      .then(() => callback?.(null))
      .catch(error => callback?.(error));
  }

  touch(sid, sess, callback) {
    const expires = sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 7 * 24 * 60 * 60 * 1000;

    pool.query(
      "UPDATE sessions SET expires = $1 WHERE sid = $2",
      [expires, sid]
    )
      .then(() => callback?.(null))
      .catch(error => callback?.(error));
  }
}

// ============================================
// EXPRESS MIDDLEWARE
// ============================================

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(express.json({
  limit: "15mb"
}));

app.use(express.urlencoded({
  extended: true,
  limit: "15mb"
}));

const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET is missing. Add it to your .env file."
  );
}

app.use(session({
  name: "studyvibe.sid",
  secret: SESSION_SECRET,
  store: new PostgresSessionStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// Block access to private server files.

app.use((req, res, next) => {
  const requestedFile = path.basename(
    decodeURIComponent(req.path)
  ).toLowerCase();

  const blockedFiles = [
  ".env",
  "server.mjs",
  "server-postgres.mjs",
  "server-sqlite-backup.mjs",
  "database.mjs",
  "database-postgres.mjs",
  "study-vibe.sqlite",
  "study-vibe.sqlite-wal",
  "study-vibe.sqlite-shm",
  "package.json",
  "package-lock.json"
];

  if (
    blockedFiles.includes(requestedFile) ||
    requestedFile.startsWith(".env.")
  ) {
    return res.status(403).send("Access denied.");
  }

  if (
    req.path.startsWith("/node_modules/") ||
    req.path.startsWith("/.git/")
  ) {
    return res.status(403).send("Access denied.");
  }

  next();
});

// ============================================
// HEALTH CHECK
// ============================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Study Vibe server is running.",
    aiConfigured: Boolean(genAI)
  });
});

// ============================================
// AUTHENTICATION HELPERS
// ============================================

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }

  next();
}

async function getUserById(userId) {
  const result = await pool.query(`
    SELECT
      id,
      email,
      plan,
      premium_started_at,
      premium_expires_at,
      created_at
    FROM users
    WHERE id = $1
  `, [userId]);

  if (result.rows.length === 0) {
    return null;
  }

  const user = result.rows[0];

  return {
    ...user,
    id: Number(user.id)
  };
}

// ============================================
// LOGIN ATTEMPT LIMITER
// ============================================

const loginAttempts = new Map();

function checkLoginAttempts(req, res, next) {
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();

  const key = `${req.ip}:${email}`;
  const now = Date.now();

  const existing = loginAttempts.get(key);

  if (existing && existing.blockedUntil > now) {
    const seconds = Math.ceil(
      (existing.blockedUntil - now) / 1000
    );

    return res.status(429).json({
      error: `Too many login attempts. Try again in ${seconds} seconds.`
    });
  }

  if (existing && existing.blockedUntil <= now) {
    loginAttempts.delete(key);
  }

  req.loginAttemptKey = key;

  next();
}

function recordFailedLogin(key) {
  const now = Date.now();
  const existing = loginAttempts.get(key);

  const attempts = existing
    ? existing.attempts + 1
    : 1;

  loginAttempts.set(key, {
    attempts,
    blockedUntil: attempts >= 5
      ? now + 15 * 60 * 1000
      : 0
  });
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

// ============================================
// AUTHENTICATION ROUTES
// ============================================

// Get current logged-in user.

app.get("/api/auth/me", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.json({
        loggedIn: false,
        user: null,
        plan: "free"
      });
    }

    const user = await getUserById(req.session.userId);

    if (!user) {
      return req.session.destroy(() => {
        res.json({
          loggedIn: false,
          user: null,
          plan: "free"
        });
      });
    }

    const plan = await getEffectivePlan(user.id);
    const updatedUser = await getUserById(user.id);

    return res.json({
      loggedIn: true,
      user: updatedUser,
      plan
    });
  } catch (error) {
    console.error("Auth check error:", error);

    return res.status(500).json({
      error: "Could not check login status."
    });
  }
});
// Register a new account.

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "Please enter a valid email address."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must contain at least 8 characters."
      });
    }

    const existingUser = await pool.query(`
      SELECT id
      FROM users
      WHERE LOWER(email) = $1
    `, [email]);

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        error: "An account with this email already exists."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(`
      INSERT INTO users (email, password_hash, plan)
      VALUES ($1, $2, 'free')
      RETURNING id
    `, [email, passwordHash]);

    const userId = Number(result.rows[0].id);

    await new Promise((resolve, reject) => {
      req.session.regenerate(error => {
        if (error) reject(error);
        else resolve();
      });
    });

    req.session.userId = userId;

    await new Promise((resolve, reject) => {
      req.session.save(error => {
        if (error) reject(error);
        else resolve();
      });
    });

    const createdUser = await getUserById(userId);

    return res.status(201).json({
      success: true,
      message: "Account created successfully.",
      user: createdUser,
      plan: "free"
    });

  } catch (error) {
    console.error("Registration error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "An account with this email already exists."
      });
    }

    return res.status(500).json({
      error: "Registration failed. Please try again."
    });
  }
});
// Log in.

app.post(
  "/api/auth/login",
  checkLoginAttempts,
  async (req, res) => {
    try {
      const email = String(req.body.email || "")
        .trim()
        .toLowerCase();

      const password = String(req.body.password || "");

      if (!email || !password) {
        return res.status(400).json({
          error: "Email and password are required."
        });
      }

      const result = await pool.query(`
        SELECT *
        FROM users
        WHERE LOWER(email) = $1
      `, [email]);

      const user = result.rows[0];

      if (!user) {
        recordFailedLogin(req.loginAttemptKey);

        return res.status(401).json({
          error: "Incorrect email or password."
        });
      }

      const passwordMatches = await bcrypt.compare(
        password,
        user.password_hash
      );

      if (!passwordMatches) {
        recordFailedLogin(req.loginAttemptKey);

        return res.status(401).json({
          error: "Incorrect email or password."
        });
      }

      clearLoginAttempts(req.loginAttemptKey);

      await new Promise((resolve, reject) => {
        req.session.regenerate(error => {
          if (error) reject(error);
          else resolve();
        });
      });

      req.session.userId = Number(user.id);

      await new Promise((resolve, reject) => {
        req.session.save(error => {
          if (error) reject(error);
          else resolve();
        });
      });

      const plan = await getEffectivePlan(user.id);
      const updatedUser = await getUserById(user.id);

      return res.json({
        success: true,
        message: "Login successful.",
        user: updatedUser,
        plan
      });

    } catch (error) {
      console.error("Login error:", error);

      return res.status(500).json({
        error: "Login failed. Please try again."
      });
    }
  }
);
// Log out.

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout error:", error);

      return res.status(500).json({
        error: "Could not log out."
      });
    }

    res.clearCookie("studyvibe.sid");

    return res.json({
      success: true,
      message: "Logged out successfully."
    });
  });
});

// ============================================
// MEMBERSHIP SYSTEM
// ============================================

// Automatically downgrade expired Premium accounts.

async function getEffectivePlan(userId) {
  const result = await pool.query(`
    SELECT plan, premium_expires_at
    FROM users
    WHERE id = $1
  `, [userId]);

  if (result.rows.length === 0) {
    return null;
  }

  const user = result.rows[0];

  if (user.plan === "premium") {
    if (
      !user.premium_expires_at ||
      new Date(user.premium_expires_at).getTime() <= Date.now()
    ) {
      await pool.query(`
        UPDATE users
        SET
          plan = 'free',
          premium_started_at = NULL,
          premium_expires_at = NULL
        WHERE id = $1
      `, [userId]);

      return "free";
    }
  }

  return user.plan;
}
// Calculate the user's usage period.

function getUsagePeriod(plan) {
  const now = new Date();

  if (plan === "premium") {
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1)
      .padStart(2, "0");

    return {
      periodType: "monthly",
      periodStart: `${year}-${month}-01`,
      limit: 200
    };
  }

  const monday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));

  const day = monday.getUTCDay();

  const daysSinceMonday = (day + 6) % 7;

  monday.setUTCDate(
    monday.getUTCDate() - daysSinceMonday
  );

  return {
    periodType: "weekly",
    periodStart: monday.toISOString().slice(0, 10),
    limit: 10
  };
}

// Reserve one AI request.

async function reserveAiRequestTransaction(userId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(`
      SELECT id, plan, premium_expires_at
      FROM users
      WHERE id = $1
      FOR UPDATE
    `, [userId]);

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return {
        allowed: false,
        reason: "user_not_found"
      };
    }

    let user = userResult.rows[0];
    let plan = user.plan;

    if (plan === "premium") {
      if (
        !user.premium_expires_at ||
        new Date(user.premium_expires_at).getTime() <= Date.now()
      ) {
        await client.query(`
          UPDATE users
          SET
            plan = 'free',
            premium_started_at = NULL,
            premium_expires_at = NULL
          WHERE id = $1
        `, [userId]);

        plan = "free";
      }
    }

    const period = getUsagePeriod(plan);

    const usageResult = await client.query(`
      INSERT INTO ai_usage (
        user_id,
        period_type,
        period_start,
        requests_used
      )
      VALUES ($1, $2, $3, 0)
      ON CONFLICT (user_id, period_type, period_start)
      DO NOTHING
    `, [
      userId,
      period.periodType,
      period.periodStart
    ]);

    const existingResult = await client.query(`
      SELECT requests_used
      FROM ai_usage
      WHERE
        user_id = $1
        AND period_type = $2
        AND period_start = $3
      FOR UPDATE
    `, [
      userId,
      period.periodType,
      period.periodStart
    ]);

    const used = Number(existingResult.rows[0].requests_used);

    if (used >= period.limit) {
      await client.query("COMMIT");

      return {
        allowed: false,
        reason: "limit_reached",
        userId: Number(userId),
        plan,
        used,
        limit: period.limit,
        periodType: period.periodType,
        periodStart: period.periodStart
      };
    }

    await client.query(`
      UPDATE ai_usage
      SET requests_used = requests_used + 1
      WHERE
        user_id = $1
        AND period_type = $2
        AND period_start = $3
    `, [
      userId,
      period.periodType,
      period.periodStart
    ]);

    await client.query("COMMIT");

    return {
      allowed: true,
      userId: Number(userId),
      plan,
      used: used + 1,
      limit: period.limit,
      periodType: period.periodType,
      periodStart: period.periodStart
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }
}
async function reserveAiRequest(userId) {
  return await reserveAiRequestTransaction(userId);
}

// Return a request if AI generation fails.

async function releaseAiRequest(reservation) {
  if (!reservation || !reservation.allowed) return;

  await pool.query(`
    UPDATE ai_usage
    SET requests_used = GREATEST(requests_used - 1, 0)
    WHERE user_id = $1
      AND period_type = $2
      AND period_start = $3
  `, [
    reservation.userId,
    reservation.periodType,
    reservation.periodStart
  ]);
}

// Get current usage information.

async function getUserUsage(userId) {
  const plan = await getEffectivePlan(userId);

  if (!plan) {
    return null;
  }

  const period = getUsagePeriod(plan);

  const result = await pool.query(`
    SELECT requests_used
    FROM ai_usage
    WHERE
      user_id = $1
      AND period_type = $2
      AND period_start = $3
  `, [
    userId,
    period.periodType,
    period.periodStart
  ]);

  const used = result.rows.length > 0
    ? Number(result.rows[0].requests_used)
    : 0;

  return {
    plan,
    used,
    limit: period.limit,
    remaining: Math.max(0, period.limit - used),
    period: period.periodType
  };
}

// ============================================
// ADMIN AUTHENTICATION
// ============================================

async function requirePaymentAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }

  try {
    const user = await getUserById(req.session.userId);

    const adminEmail = String(
      process.env.ADMIN_EMAIL || ""
    ).trim().toLowerCase();

    if (
      !user ||
      !adminEmail ||
      user.email.toLowerCase() !== adminEmail
    ) {
      return res.status(403).json({
        error: "Admin access denied."
      });
    }

    return next();

  } catch (error) {
    console.error("Admin authentication error:", error);

    return res.status(500).json({
      error: "Could not verify admin access."
    });
  }
}

// ============================================
// END OF SECTION 1
// SECTION 2 WILL CONTINUE BELOW THIS LINE
// ============================================
// ============================================
// STUDY VIBE - SERVER
// SECTION 2 OF 3
// PAYMENT SYSTEM + STUDY API
// ============================================

// ============================================
// PAYMENT DATABASE MIGRATIONS
// ============================================


// ============================================
// PAYMENT SUBMISSION
// ============================================

app.post(
  "/api/payments/submit",
  requireLogin,
  async (req, res) => {
    try {
      const userId = req.session.userId;

      const amount = Number(req.body.amount);
      const provider = String(
        req.body.provider || ""
      ).trim().toLowerCase();

      const transactionId = String(
        req.body.transactionId || ""
      ).trim();

      const senderNumber = String(
        req.body.senderNumber || ""
      ).trim();

      if (amount !== 299) {
        return res.status(400).json({
          error: "The Premium subscription costs ৳299."
        });
      }

      const allowedProviders = [
        "bkash",
        "nagad",
        "sonali_bank"
      ];

      if (!allowedProviders.includes(provider)) {
        return res.status(400).json({
          error: "Invalid payment method."
        });
      }

      if (!transactionId || transactionId.length < 4) {
        return res.status(400).json({
          error: "Please enter a valid transaction ID."
        });
      }

      if (!senderNumber) {
        return res.status(400).json({
          error: "Please enter the sender account number."
        });
      }

      const result = await pool.query(`
        INSERT INTO payments (
          user_id,
          amount,
          currency,
          provider,
          transaction_id,
          sender_number,
          status
        )
        VALUES ($1, $2, 'BDT', $3, $4, $5, 'pending')
        RETURNING id
      `, [
        userId,
        amount,
        provider,
        transactionId,
        senderNumber
      ]);

      return res.status(201).json({
        success: true,
        message: "Payment submitted. Please wait for admin verification.",
        paymentId: Number(result.rows[0].id)
      });

    } catch (error) {
      console.error("Payment submission error:", error);

      if (error.code === "23505") {
        return res.status(409).json({
          error: "This transaction ID has already been submitted."
        });
      }

      return res.status(500).json({
        error: "Could not submit payment. Please try again."
      });
    }
  }
);

// ============================================
// USER PAYMENT HISTORY
// ============================================

app.get(
  "/api/payments/my",
  requireLogin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          id,
          amount,
          currency,
          provider,
          transaction_id,
          status,
          created_at,
          reviewed_at
        FROM payments
        WHERE user_id = $1
        ORDER BY id DESC
      `, [req.session.userId]);

      return res.json({
        success: true,
        payments: result.rows
      });

    } catch (error) {
      console.error("Payment history error:", error);

      return res.status(500).json({
        error: "Could not load payment history."
      });
    }
  }
);

// ============================================
// ADMIN - VIEW ALL PAYMENTS
// ============================================

app.get(
  "/api/admin/payments",
  requirePaymentAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          payments.id,
          payments.user_id,
          users.email,
          payments.amount,
          payments.currency,
          payments.provider,
          payments.transaction_id,
          payments.sender_number,
          payments.status,
          payments.created_at,
          payments.reviewed_at
        FROM payments
        JOIN users
          ON users.id = payments.user_id
        ORDER BY payments.id DESC
      `);

      return res.json({
        success: true,
        payments: result.rows.map(payment => ({
          ...payment,
          id: Number(payment.id),
          user_id: Number(payment.user_id)
        }))
      });

    } catch (error) {
      console.error("Admin payment list error:", error);

      return res.status(500).json({
        error: "Could not load payments."
      });
    }
  }
);

// ============================================
// PREMIUM EXPIRY DATE HELPER
// ============================================

function addOneCalendarMonth(date) {
  const result = new Date(date);

  const originalDay = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);

  const lastDay = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0
  )).getUTCDate();

  result.setUTCDate(
    Math.min(originalDay, lastDay)
  );

  return result;
}

// ============================================
// ADMIN - APPROVE PAYMENT
// ============================================

async function approvePaymentTransaction(paymentId, adminId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const paymentResult = await client.query(`
      SELECT *
      FROM payments
      WHERE id = $1
      FOR UPDATE
    `, [paymentId]);

    if (paymentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { success: false, reason: "not_found" };
    }

    const payment = paymentResult.rows[0];

    if (payment.status !== "pending") {
      await client.query("ROLLBACK");
      return { success: false, reason: "already_reviewed" };
    }

    if (Number(payment.amount) !== 299) {
      await client.query("ROLLBACK");
      return { success: false, reason: "invalid_amount" };
    }

    const userResult = await client.query(`
      SELECT *
      FROM users
      WHERE id = $1
      FOR UPDATE
    `, [payment.user_id]);

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { success: false, reason: "user_not_found" };
    }

    const user = userResult.rows[0];
    const now = new Date();

    let startDate = now;

    if (
      user.plan === "premium" &&
      user.premium_expires_at &&
      new Date(user.premium_expires_at).getTime() > now.getTime()
    ) {
      startDate = new Date(user.premium_expires_at);
    }

    const expiryDate = addOneCalendarMonth(startDate);

    await client.query(`
      UPDATE payments
      SET
        status = 'verified',
        reviewed_at = CURRENT_TIMESTAMP,
        reviewed_by = $1
      WHERE id = $2
        AND status = 'pending'
    `, [adminId, paymentId]);

    await client.query(`
      UPDATE users
      SET
        plan = 'premium',
        premium_started_at = $1,
        premium_expires_at = $2
      WHERE id = $3
    `, [
      now.toISOString(),
      expiryDate.toISOString(),
      payment.user_id
    ]);

    await client.query("COMMIT");

    return {
      success: true,
      userId: Number(payment.user_id),
      expiresAt: expiryDate.toISOString()
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }
}
app.post(
  "/api/admin/payments/:id/approve",
  requirePaymentAdmin,
  async (req, res) => {
    try {
      const paymentId = Number(req.params.id);

      if (
        !Number.isSafeInteger(paymentId) ||
        paymentId < 1
      ) {
        return res.status(400).json({
          error: "Invalid payment ID."
        });
      }

      const result = await approvePaymentTransaction(
        paymentId,
        req.session.userId
      );

      if (!result.success) {
        const messages = {
          not_found: "Payment not found.",
          already_reviewed: "This payment has already been reviewed.",
          invalid_amount: "Payment amount is invalid.",
          user_not_found: "The payment's user account was not found."
        };

        return res.status(
          result.reason === "not_found" ||
          result.reason === "user_not_found" ? 404 : 400
        ).json({
          error: messages[result.reason] || "Could not approve payment."
        });
      }

      return res.json({
        success: true,
        message: "Payment approved. Premium membership activated.",
        expiresAt: result.expiresAt
      });

    } catch (error) {
      console.error("Payment approval error:", error);

      return res.status(500).json({
        error: "Could not approve payment."
      });
    }
  }
);

// ============================================
// ADMIN - REJECT PAYMENT
// ============================================

app.post(
  "/api/admin/payments/:id/reject",
  requirePaymentAdmin,
  async (req, res) => {
    try {
      const paymentId = Number(req.params.id);

      if (
        !Number.isSafeInteger(paymentId) ||
        paymentId < 1
      ) {
        return res.status(400).json({
          error: "Invalid payment ID."
        });
      }

      const result = await pool.query(`
        UPDATE payments
        SET
          status = 'failed',
          reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by = $1
        WHERE
          id = $2
          AND status = 'pending'
        RETURNING id
      `, [
        req.session.userId,
        paymentId
      ]);

      if (result.rowCount !== 1) {
        return res.status(404).json({
          error: "Pending payment not found or already reviewed."
        });
      }

      return res.json({
        success: true,
        message: "Payment rejected."
      });

    } catch (error) {
      console.error("Payment rejection error:", error);

      return res.status(500).json({
        error: "Could not reject payment."
      });
    }
  }
);

// ============================================
// STUDY ASSISTANT PROMPT BUILDER
// ============================================

function buildStudyPrompt(body, plan) {
  const task = String(
    body.task || body.type || "answer"
  ).trim().toLowerCase();

  const subject = String(body.subject || "General")
    .slice(0, 150);

  const topic = String(body.topic || "")
    .slice(0, 500);

  const textbook = String(body.textbook || "")
    .slice(0, 12000);

  const question = String(
    body.question || body.text || ""
  ).slice(0, 12000);

  const language = String(body.language || "English")
    .slice(0, 50);

  const difficulty = String(
    body.difficulty || "Easy"
  ).slice(0, 50);

  const context = `
Subject: ${subject}
Topic: ${topic}
Difficulty: ${difficulty}
Preferred language: ${language}

Textbook or supplied study material:
${textbook || "No textbook material supplied."}

Student's question or instructions:
${question || "Use the supplied image or material."}
`;

  if (task === "math") {
    return `
You are Study Vibe, a friendly and accurate mathematics tutor.

Solve the problem step by step.
Explain each calculation clearly.
Show the relevant formula.
Check the final answer when possible.
Use readable mathematical notation.

${context}
`;
  }

  if (task === "mcq") {
    const explanations = plan === "premium";

    return `
You are Study Vibe, an expert educational question creator.

Create exactly 30 multiple-choice questions.

Rules:
- Use the supplied subject and study material.
- Each question must have exactly four options: A, B, C, D.
- Only one option may be correct.
- Do not repeat questions.
- Keep the questions appropriate to the difficulty.
- Number every question from 1 to 30.
- Clearly identify the correct answer.

${explanations
  ? "Provide a short explanation for every correct answer."
  : "Do not provide explanations. Only show the correct answer."}

${context}
`;
  }

  if (task === "short") {
    return `
You are Study Vibe, an educational question creator.

Create exactly 10 useful short-answer questions.
Provide clear, concise answers.
Avoid duplicate questions.

${context}
`;
  }

  if (task === "notes") {
    return `
You are Study Vibe, an expert note-making assistant.

Create well-organized study notes.
Use clear headings and subheadings.
Include definitions, important points, examples,
formulas where relevant, and key facts.
Keep the notes easy for a student to revise.

${context}
`;
  }

  if (task === "summary") {
    return `
You are Study Vibe, an expert study assistant.

Create a clear and accurate summary.
Include the most important concepts,
definitions, facts, and conclusions.
Use headings and bullet points where helpful.
Do not omit essential information.

${context}
`;
  }

  return `
You are Study Vibe, a friendly and accurate AI study assistant.

Answer the student's question clearly.
Explain difficult concepts in simple language.
Use examples when helpful.
Organize long answers with headings.
Do not invent facts.
If the supplied material does not contain the answer,
say so honestly.

${context}
`;
}

// ============================================
// STUDY ASSISTANT API
// ============================================

app.post(
  "/api/study",
  requireLogin,
  async (req, res) => {
    let reservation = null;

    try {
      const userId = req.session.userId;

      const user = await getUserById(userId);

      if (!user) {
        return res.status(401).json({
          error: "Your account could not be found. Please log in again."
        });
      }

      const imageData = req.body.imageData || null;

      if (imageData) {
        if (typeof imageData !== "string") {
          return res.status(400).json({
            error: "Invalid image data."
          });
        }

        if (imageData.length > 12000000) {
          return res.status(413).json({
            error: "Image is too large. Please use a smaller image."
          });
        }

        const validImage = /^data:image\/(png|jpeg|jpg|webp);base64,/i
          .test(imageData);

        if (!validImage) {
          return res.status(400).json({
            error: "Only PNG, JPG, JPEG, and WEBP images are supported."
          });
        }
      }

      const question = String(
        req.body.question ||
        req.body.text ||
        ""
      ).trim();

      if (!question && !imageData) {
        return res.status(400).json({
          error: "Please enter a question or upload an image."
        });
      }

      const plan = await getEffectivePlan(userId);

      reservation = await reserveAiRequest(userId);

      if (!reservation.allowed) {
        if (reservation.reason === "limit_reached") {
          return res.status(429).json({
            error: plan === "premium"
              ? "You have reached your monthly Premium AI request limit."
              : "You have used all 10 free AI requests this week.",
            usage: {
              plan: reservation.plan,
              used: reservation.used,
              limit: reservation.limit,
              remaining: 0,
              period: reservation.periodType
            }
          });
        }

        return res.status(401).json({
          error: "Could not verify your account."
        });
      }

      const prompt = buildStudyPrompt(
        req.body,
        reservation.plan
      );

      let answer;

      if (imageData) {
        if (!genAI) {
          throw new Error("Gemini API key is missing.");
        }

        const matches = imageData.match(
          /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i
        );

        if (!matches) {
          throw new Error("Invalid image data.");
        }

        const mimeType = matches[1].toLowerCase() === "jpg"
          ? "image/jpeg"
          : `image/${matches[1].toLowerCase()}`;

        const base64Data = matches[2];

        const imagePrompt = `
${prompt}

Please carefully inspect the uploaded image.
Read any visible text, diagrams, or mathematical expressions.
Use the image as part of the student's question.
`;

        answer = await generateWithFallback([
          {
            inlineData: {
              mimeType,
              data: base64Data
            }
          },
          {
            text: imagePrompt
          }
        ]);
      } else {
        answer = await generateStudyWithRetry(prompt);
      }

      const usage = await getUserUsage(userId);

      reservation = null;

      return res.json({
        success: true,
        answer,
        usage
      });
    } catch (error) {
      console.error("Study API error:", error);

      if (reservation?.allowed) {
        try {
          await releaseAiRequest(reservation);
        } catch (releaseError) {
          console.error(
            "Could not restore AI request:",
            releaseError
          );
        }
      }

      return res.status(500).json({
        error: "Study Vibe could not generate an answer. Please try again."
      });
    }
  }
);

// ============================================
// END OF SECTION 2
// SECTION 3 WILL CONTINUE BELOW THIS LINE
// ============================================
// ============================================
// STUDY VIBE - SERVER
// SECTION 3 OF 3
// WRITING STUDIO + SERVER STARTUP
// ============================================

// ============================================
// WRITING STUDIO API
// ============================================

app.post(
  "/api/writing",
  requireLogin,
  async (req, res) => {
    let reservation = null;

    try {
      const userId = req.session.userId;

      const user = await getUserById(userId);

      if (!user) {
        return res.status(401).json({
          error: "Your account could not be found. Please log in again."
        });
      }

      const plan = await getEffectivePlan(userId);

      // Writing Studio is a Premium feature.

      if (plan !== "premium") {
        return res.status(403).json({
          error: "Writing Studio is available to Premium members only.",
          premiumRequired: true
        });
      }

      const prompt = String(
        req.body.prompt ||
        req.body.text ||
        req.body.instructions ||
        ""
      ).trim();

      if (!prompt) {
        return res.status(400).json({
          error: "Please enter your writing instructions."
        });
      }

      if (prompt.length > 12000) {
        return res.status(413).json({
          error: "Your writing instructions are too long."
        });
      }

      reservation = await reserveAiRequest(userId);

      if (!reservation.allowed) {
        return res.status(429).json({
          error: "You have reached your monthly Premium AI request limit.",
          usage: {
            plan: reservation.plan,
            used: reservation.used,
            limit: reservation.limit,
            remaining: 0,
            period: reservation.periodType
          }
        });
      }

      const writingType = String(
        req.body.writingType ||
        req.body.type ||
        "General writing"
      ).slice(0, 100);

      const tone = String(
        req.body.tone || "Professional"
      ).slice(0, 100);

      const language = String(
        req.body.language || "English"
      ).slice(0, 50);

      const writingPrompt = `
You are Study Vibe Writing Studio.

You are an expert academic and professional writing assistant.

Writing type: ${writingType}
Preferred tone: ${tone}
Preferred language: ${language}

User's instructions:
${prompt}

Instructions:
- Follow the user's instructions carefully.
- Produce original, clear, well-organized writing.
- Use appropriate headings and formatting.
- Maintain correct grammar and spelling.
- Do not invent references, quotations, research findings, or statistics.
- If sources or citations are requested, never fabricate them.
- Make the writing useful and ready for the user's review and editing.
`;

      const answer = await generateWritingWithFallback(
        writingPrompt
      );

      const usage = await getUserUsage(userId);

      reservation = null;

      return res.json({
        success: true,
        answer,
        plan: "premium",
        usage
      });
    } catch (error) {
      console.error("Writing Studio API error:", error);

      if (reservation?.allowed) {
        try {
          await releaseAiRequest(reservation);
        } catch (releaseError) {
          console.error(
            "Could not restore Writing Studio request:",
            releaseError
          );
        }
      }

      return res.status(500).json({
        error: "Writing Studio could not generate your content. Please try again."
      });
    }
  }
);

// ============================================
// STATIC WEBSITE FILES
// ============================================

app.use(express.static(__dirname, {
  dotfiles: "ignore",
  index: "index.html"
}));

// ============================================
// UNKNOWN API ROUTES
// ============================================

app.use("/api", (req, res) => {
  return res.status(404).json({
    error: "API endpoint not found."
  });
});

// ============================================
// GENERAL 404 PAGE
// ============================================

app.use((req, res) => {
  return res.status(404).send("Page not found.");
});

// ============================================
// SERVER STARTUP
// ============================================

async function startServer() {
  try {
    await initPostgresDatabase();

    app.listen(PORT, () => {
      console.log("------------------------------------");
      console.log("Study Vibe PostgreSQL server is running.");
      console.log(`Local address: http://localhost:${PORT}`);
      console.log(`AI configured: ${Boolean(genAI)}`);
      console.log("------------------------------------");
    });

  } catch (error) {
    console.error("Could not start Study Vibe:", error);
    process.exit(1);
  }
}

startServer();

// ============================================
// END OF STUDY VIBE SERVER
// ============================================