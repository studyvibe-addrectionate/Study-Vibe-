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
import db from "./database.mjs";

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
  "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-2.5-flash"
)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

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

// ============================================
// SQLITE SESSION STORE
// ============================================

// Create or update the sessions table safely.

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL DEFAULT 0
);
`);

const sessionColumns = db.prepare(`
  PRAGMA table_info(sessions)
`).all();

const hasExpireColumn = sessionColumns.some(
  (column) => column.name === "expire"
);

if (!hasExpireColumn) {
  db.exec(`
    ALTER TABLE sessions
    ADD COLUMN expire INTEGER NOT NULL DEFAULT 0
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_expire
ON sessions(expires);;
`);

console.log("Study Vibe session database ready.");

class SQLiteSessionStore extends session.Store {

  get(sid, callback) {
    try {
      const row = db.prepare(`
        SELECT sess, expires
        FROM sessions
        WHERE sid = ?
      `).get(sid);

      if (!row) {
        return callback(null, null);
      }

      if (Number(row.expires) <= Date.now()) {
        db.prepare(`
          DELETE FROM sessions
          WHERE sid = ?
        `).run(sid);

        return callback(null, null);
      }

      return callback(null, JSON.parse(row.sess));

    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sess, callback) {
    try {
      const expires = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;

      db.prepare(`
        INSERT INTO sessions (sid, sess, expires)
        VALUES (?, ?, ?)
        ON CONFLICT(sid)
        DO UPDATE SET
          sess = excluded.sess,
          expires = excluded.expires
      `).run(
        sid,
        JSON.stringify(sess),
        expires
      );

      if (callback) callback(null);

    } catch (error) {
      if (callback) callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      db.prepare(`
        DELETE FROM sessions
        WHERE sid = ?
      `).run(sid);

      if (callback) callback(null);

    } catch (error) {
      if (callback) callback(error);
    }
  }

  touch(sid, sess, callback) {
    try {
      const expires = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;

      db.prepare(`
        UPDATE sessions
        SET expires = ?
        WHERE sid = ?
      `).run(expires, sid);

      if (callback) callback(null);

    } catch (error) {
      if (callback) callback(error);
    }
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
  store: new SQLiteSessionStore(),
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
    "database.mjs",
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

function getUserById(userId) {
  return db.prepare(`
    SELECT
      id,
      email,
      plan,
      premium_started_at,
      premium_expires_at,
      created_at
    FROM users
    WHERE id = ?
  `).get(userId);
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

app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId) {
    return res.json({
      loggedIn: false,
      user: null,
      plan: "free"
    });
  }

  const user = getUserById(req.session.userId);

  if (!user) {
    return req.session.destroy(() => {
      res.json({
        loggedIn: false,
        user: null,
        plan: "free"
      });
    });
  }

  const plan = getEffectivePlan(user.id);

  const updatedUser = getUserById(user.id);

  return res.json({
    loggedIn: true,
    user: updatedUser,
    plan
  });
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

    const existingUser = db.prepare(`
      SELECT id
      FROM users
      WHERE email = ?
    `).get(email);

    if (existingUser) {
      return res.status(409).json({
        error: "An account with this email already exists."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = db.prepare(`
      INSERT INTO users (email, password_hash, plan)
      VALUES (?, ?, 'free')
    `).run(email, passwordHash);

    const userId = Number(result.lastInsertRowid);

    req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error("Session error:", sessionError);

        return res.status(500).json({
          error: "Account created, but login failed. Please log in."
        });
      }

      req.session.userId = userId;

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Session save error:", saveError);

          return res.status(500).json({
            error: "Account created, but login failed. Please log in."
          });
        }

        return res.status(201).json({
          success: true,
          message: "Account created successfully.",
          user: getUserById(userId),
          plan: "free"
        });
      });
    });
  } catch (error) {
    console.error("Registration error:", error);

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

      const user = db.prepare(`
        SELECT *
        FROM users
        WHERE email = ?
      `).get(email);

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

      req.session.regenerate((sessionError) => {
        if (sessionError) {
          console.error("Session regeneration error:", sessionError);

          return res.status(500).json({
            error: "Login failed. Please try again."
          });
        }

        req.session.userId = user.id;

        req.session.save((saveError) => {
          if (saveError) {
            console.error("Session save error:", saveError);

            return res.status(500).json({
              error: "Login failed. Please try again."
            });
          }

          const plan = getEffectivePlan(user.id);

          return res.json({
            success: true,
            message: "Login successful.",
            user: getUserById(user.id),
            plan
          });
        });
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

function getEffectivePlan(userId) {
  const user = db.prepare(`
    SELECT plan, premium_expires_at
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!user) {
    return null;
  }

  if (user.plan === "premium") {
    if (
      !user.premium_expires_at ||
      new Date(user.premium_expires_at).getTime() <= Date.now()
    ) {
      db.prepare(`
        UPDATE users
        SET
          plan = 'free',
          premium_started_at = NULL,
          premium_expires_at = NULL
        WHERE id = ?
      `).run(userId);

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

const reserveAiRequestTransaction = db.transaction((userId) => {
  const plan = getEffectivePlan(userId);

  if (!plan) {
    return {
      allowed: false,
      reason: "user_not_found"
    };
  }

  const period = getUsagePeriod(plan);

  const existing = db.prepare(`
    SELECT requests_used
    FROM ai_usage
    WHERE
      user_id = ?
      AND period_type = ?
      AND period_start = ?
  `).get(
    userId,
    period.periodType,
    period.periodStart
  );

  const used = existing
    ? existing.requests_used
    : 0;

  if (used >= period.limit) {
    return {
      allowed: false,
      reason: "limit_reached",
      userId,
      plan,
      used,
      limit: period.limit,
      periodType: period.periodType,
      periodStart: period.periodStart
    };
  }

  if (existing) {
    db.prepare(`
      UPDATE ai_usage
      SET requests_used = requests_used + 1
      WHERE
        user_id = ?
        AND period_type = ?
        AND period_start = ?
    `).run(
      userId,
      period.periodType,
      period.periodStart
    );
  } else {
    db.prepare(`
      INSERT INTO ai_usage (
        user_id,
        period_type,
        period_start,
        requests_used
      )
      VALUES (?, ?, ?, 1)
    `).run(
      userId,
      period.periodType,
      period.periodStart
    );
  }

  return {
    allowed: true,
    userId,
    plan,
    used: used + 1,
    limit: period.limit,
    periodType: period.periodType,
    periodStart: period.periodStart
  };
});

function reserveAiRequest(userId) {
  return reserveAiRequestTransaction(userId);
}

// Return a request if AI generation fails.

function releaseAiRequest(reservation) {
  if (!reservation || !reservation.allowed) {
    return;
  }

  db.prepare(`
    UPDATE ai_usage
    SET requests_used =
      CASE
        WHEN requests_used > 0 THEN requests_used - 1
        ELSE 0
      END
    WHERE
      user_id = ?
      AND period_type = ?
      AND period_start = ?
  `).run(
    reservation.userId,
    reservation.periodType,
    reservation.periodStart
  );
}

// Get current usage information.

function getUserUsage(userId) {
  const plan = getEffectivePlan(userId);

  if (!plan) {
    return null;
  }

  const period = getUsagePeriod(plan);

  const row = db.prepare(`
    SELECT requests_used
    FROM ai_usage
    WHERE
      user_id = ?
      AND period_type = ?
      AND period_start = ?
  `).get(
    userId,
    period.periodType,
    period.periodStart
  );

  const used = row ? row.requests_used : 0;

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

function requirePaymentAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }

  const user = getUserById(req.session.userId);

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

  next();
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

const paymentColumns = db.prepare(`
  PRAGMA table_info(payments)
`).all();

const existingPaymentColumns = paymentColumns.map(
  (column) => column.name
);

if (!existingPaymentColumns.includes("sender_number")) {
  db.exec(`
    ALTER TABLE payments
    ADD COLUMN sender_number TEXT
  `);
}

if (!existingPaymentColumns.includes("reviewed_at")) {
  db.exec(`
    ALTER TABLE payments
    ADD COLUMN reviewed_at TEXT
  `);
}

if (!existingPaymentColumns.includes("reviewed_by")) {
  db.exec(`
    ALTER TABLE payments
    ADD COLUMN reviewed_by INTEGER
  `);
}

// ============================================
// PAYMENT SUBMISSION
// ============================================

app.post(
  "/api/payments/submit",
  requireLogin,
  (req, res) => {
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

      const duplicate = db.prepare(`
        SELECT id
        FROM payments
        WHERE transaction_id = ?
      `).get(transactionId);

      if (duplicate) {
        return res.status(409).json({
          error: "This transaction ID has already been submitted."
        });
      }

      const result = db.prepare(`
        INSERT INTO payments (
          user_id,
          amount,
          currency,
          provider,
          transaction_id,
          sender_number,
          status
        )
        VALUES (?, ?, 'BDT', ?, ?, ?, 'pending')
      `).run(
        userId,
        amount,
        provider,
        transactionId,
        senderNumber
      );

      return res.status(201).json({
        success: true,
        message: "Payment submitted. Please wait for admin verification.",
        paymentId: Number(result.lastInsertRowid)
      });
    } catch (error) {
      console.error("Payment submission error:", error);

      if (
        String(error.message || "").includes("UNIQUE constraint")
      ) {
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
  (req, res) => {
    try {
      const payments = db.prepare(`
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
        WHERE user_id = ?
        ORDER BY id DESC
      `).all(req.session.userId);

      return res.json({
        success: true,
        payments
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
  (req, res) => {
    try {
      const payments = db.prepare(`
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
      `).all();

      return res.json({
        success: true,
        payments
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

const approvePaymentTransaction = db.transaction(
  (paymentId, adminId) => {
    const payment = db.prepare(`
      SELECT *
      FROM payments
      WHERE id = ?
    `).get(paymentId);

    if (!payment) {
      return {
        success: false,
        reason: "not_found"
      };
    }

    if (payment.status !== "pending") {
      return {
        success: false,
        reason: "already_reviewed"
      };
    }

    if (payment.amount !== 299) {
      return {
        success: false,
        reason: "invalid_amount"
      };
    }

    const user = db.prepare(`
      SELECT *
      FROM users
      WHERE id = ?
    `).get(payment.user_id);

    if (!user) {
      return {
        success: false,
        reason: "user_not_found"
      };
    }

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

    const updatePayment = db.prepare(`
      UPDATE payments
      SET
        status = 'verified',
        reviewed_at = CURRENT_TIMESTAMP,
        reviewed_by = ?
      WHERE id = ?
        AND status = 'pending'
    `).run(adminId, paymentId);

    if (updatePayment.changes !== 1) {
      return {
        success: false,
        reason: "already_reviewed"
      };
    }

    db.prepare(`
      UPDATE users
      SET
        plan = 'premium',
        premium_started_at = ?,
        premium_expires_at = ?
      WHERE id = ?
    `).run(
      now.toISOString(),
      expiryDate.toISOString(),
      payment.user_id
    );

    return {
      success: true,
      userId: payment.user_id,
      expiresAt: expiryDate.toISOString()
    };
  }
);

app.post(
  "/api/admin/payments/:id/approve",
  requirePaymentAdmin,
  (req, res) => {
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

      const result = approvePaymentTransaction(
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
          result.reason === "user_not_found"
            ? 404
            : 400
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
  (req, res) => {
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

      const result = db.prepare(`
        UPDATE payments
        SET
          status = 'failed',
          reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by = ?
        WHERE
          id = ?
          AND status = 'pending'
      `).run(
        req.session.userId,
        paymentId
      );

      if (result.changes !== 1) {
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

      const user = getUserById(userId);

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

      const plan = getEffectivePlan(userId);

      reservation = reserveAiRequest(userId);

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

      const usage = getUserUsage(userId);

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
          releaseAiRequest(reservation);
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

      const user = getUserById(userId);

      if (!user) {
        return res.status(401).json({
          error: "Your account could not be found. Please log in again."
        });
      }

      const plan = getEffectivePlan(userId);

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

      reservation = reserveAiRequest(userId);

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

      const usage = getUserUsage(userId);

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
          releaseAiRequest(reservation);
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

app.listen(PORT, () => {
  console.log("------------------------------------");
  console.log("Study Vibe server is running.");
  console.log(`Local address: http://localhost:${PORT}`);
  console.log(`AI configured: ${Boolean(genAI)}`);
  console.log("------------------------------------");
});

// ============================================
// END OF STUDY VIBE SERVER
// ============================================