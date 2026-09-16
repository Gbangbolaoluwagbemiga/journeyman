import "dotenv/config";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import { requireApiSecret } from "./middleware/auth.js";
import { aiRouter } from "./routes/ai.js";
import { notificationsRouter } from "./routes/notifications.js";
import { uploadRouter } from "./routes/upload.js";
import { messagesRouter } from "./routes/messages.js";
import { gaslessRouter } from "./routes/gasless.js";
import { evidenceRouter } from "./routes/evidence.js";
import { analyticsRouter } from "./routes/analytics.js";
import { applicationsRouter } from "./routes/applications.js";
import { disputesRouter } from "./routes/disputes.js";

const app = express();
const port = Number(process.env.PORT) || 8787;
const apiSecret = process.env.API_SECRET;

// Build a CORS origin matcher that supports:
//  - FRONTEND_URL: comma-separated list of exact origins, e.g.
//      https://atelier-arc.vercel.app,https://my-preview.vercel.app
//  - FRONTEND_URL_PATTERN: a regex string to allow preview deployments, e.g.
//      https://atelier.*\.vercel\.app
//  - If neither is set, allow all origins (open for local dev).
const rawOrigins = (process.env.FRONTEND_URL ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const rawPattern = process.env.FRONTEND_URL_PATTERN?.trim();

function buildOriginMatcher(): cors.CorsOptions["origin"] {
  const exactSet = new Set(rawOrigins);
  const pattern = rawPattern ? new RegExp(rawPattern) : null;

  if (exactSet.size === 0 && !pattern) {
    // No restriction configured — allow all (dev / unconfigured)
    return true;
  }

  return (origin, callback) => {
    // Non-browser requests (curl, server-to-server) have no origin
    if (!origin) return callback(null, true);
    if (exactSet.has(origin)) return callback(null, true);
    if (pattern && pattern.test(origin)) return callback(null, true);
    /*
     * Refuse by saying no, not by throwing.
     *
     * Handing cors an Error makes Express answer the preflight with a 500,
     * which reads as "the API is broken" — and that is how a missing
     * FRONTEND_URL entry presented in production: the deployed web app could
     * not reach the API at all, and the only clue was a 500 on an OPTIONS
     * request. A rejected origin is a configuration answer, not a server
     * fault, and the difference decides whether the next person looks at the
     * env vars or at the server logs.
     */
    callback(null, false);
  };
}

app.use(
  cors({
    origin: buildOriginMatcher(),
    credentials: true,
  }),
);

/*
 * Say WHICH origin was refused, and where to fix it.
 *
 * Without this a blocked browser sees only the absence of a header, which is
 * indistinguishable from the API being down. cors() has already decided by the
 * time this runs; all this does is make the refusal legible to whoever is
 * looking at the network tab.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || res.getHeader("Access-Control-Allow-Origin")) return next();
  res.status(403).json({
    error: "Origin not allowed",
    origin,
    hint: "Add this origin to FRONTEND_URL (comma-separated) or match it with FRONTEND_URL_PATTERN.",
  });
});
app.use(express.json({ limit: "10mb" }));

// General rate limiter — 60 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

// Strict limiter for expensive AI endpoints — 20 requests per 15 min per IP
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "AI rate limit reached. Please try again in 15 minutes." },
});

app.use(generalLimiter);

/*
 * Something at the root.
 *
 * This is a JSON API with no page, so `/` was a 404 — and the README links it,
 * which means anyone following that link met an error and had to guess whether
 * the service was down. It is not documentation; it is a signpost saying what
 * this is and where the useful endpoints are.
 */
app.get("/", (_req, res) => {
  res.json({
    service: "Atelier API",
    what: "Notifications, messaging, cover letters and file uploads for atelier-job.vercel.app. The escrow itself lives on Arc, not here.",
    endpoints: {
      health: "/health",
      notifications: "/v1/notifications?wallet=0x… (Bearer API_SECRET)",
      messages: "/v1/messages/inbox?wallet=0x…",
      applications: "/v1/applications/:escrowId",
      analytics: "/v1/analytics/platform",
    },
    source: "https://github.com/Gbangbolaoluwagbemiga/Atelier",
  });
});

app.get("/health", async (_req, res) => {
  /*
   * Reachability, not configuration.
   *
   * This used to report supabase:true whenever the two env vars were set,
   * which it kept doing after the project itself stopped resolving — a health
   * check that answers "is it configured" while every route that touches it
   * returns 500. A health endpoint that is green during an outage is worse
   * than no health endpoint, because it is where you look first.
   */
  let supabase = false;
  const url = process.env.SUPABASE_URL?.trim();
  if (url && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const probe = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY },
        signal: AbortSignal.timeout(3000),
      });
      supabase = probe.status < 500;
    } catch {
      supabase = false;
    }
  }

  res.json({
    ok: true,
    groq: !!process.env.GROQ_API_KEY,
    supabase,
  });
});

const auth = requireApiSecret(apiSecret);

// AI routes get the strict per-IP limiter applied before auth
app.use("/v1/ai", aiLimiter, auth, aiRouter);
app.use("/v1/notifications", auth, notificationsRouter);
app.use("/v1/upload", auth, uploadRouter);
app.use("/v1/messages", auth, messagesRouter);
app.use("/v1/gasless", auth, gaslessRouter);
app.use("/v1/evidence", auth, evidenceRouter);
app.use("/v1/analytics", auth, analyticsRouter);
app.use("/v1/applications", auth, applicationsRouter);
app.use("/v1/disputes", auth, disputesRouter);

/*
 * Bind a port only when we own the process.
 *
 * On a serverless host the platform owns the listener and imports the app as a
 * handler; calling listen() there either throws or quietly holds a port nothing
 * routes to, which looks exactly like a deployed service that answers nothing.
 * Locally there is no platform, so we still bind.
 */
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`atelier-api listening on :${port}`);
    if (!apiSecret) {
      console.warn(
        "[atelier-api] API_SECRET is unset; /v1 routes are open (set API_SECRET for production)",
      );
    }
  });
}

/** The handler a serverless host mounts. Harmless when running standalone. */
export default app;











