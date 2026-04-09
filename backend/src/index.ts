import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { getDb } from "./db/index.js";
import { seedSettings, seedPresetVendors } from "./db/seed.js";
import { proxySecret } from "./middleware/proxy-secret.js";
import { authMiddleware } from "./middleware/auth.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { generalLimiter, cronLimiter } from "./middleware/rate-limit.js";
import { timingMiddleware } from "./middleware/timing.js";
import { getClientIp } from "./lib/client-ip.js";
import healthRouter from "./routes/health.js";
import authRouter from "./routes/auth.js";
import partsRouter from "./routes/parts.js";
import settingsRouter from "./routes/settings.js";
import appliancesRouter from "./routes/appliances.js";
import ebayRouter from "./routes/ebay.js";
import vendorCookiesRouter from "./routes/vendor-cookies.js";
import importRouter from "./routes/import.js";
import vendorTemplatesRouter from "./routes/vendor-templates.js";
import { pollEbayOrders } from "./services/ebay.js";

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);

// Trust proxy for Express internals
app.set("trust proxy", 1);

// Body parsing — larger limit for image upload routes, then global default
app.use("/api/appliances/ocr", express.json({ limit: "12mb" }));
app.use("/api/appliances/upload", express.json({ limit: "12mb" }));
app.use("/api/parts/ocr", express.json({ limit: "12mb" }));
app.use("/api/parts/import", express.json({ limit: "12mb" }));
app.use("/api/vendor-cookies", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

// Timing middleware — logs slow requests, sets Server-Timing header
app.use(timingMiddleware);

// Security middleware
if (process.env.NODE_ENV === "production") {
  app.use(proxySecret);
}
app.use(securityHeaders);

// Health check — before auth
app.use("/api/health", healthRouter);

// Auth routes — before auth middleware (some routes exempt)
app.use("/api/auth", authRouter);

// Internal cron endpoint — before auth middleware, protected by INTERNAL_CRON_SECRET
app.post("/api/internal/ebay-poll", cronLimiter, async (req, res) => {
  const clientIp = getClientIp(req);
  console.log(`eBay poll invoked from IP: ${clientIp}`);

  const cronSecret = process.env.INTERNAL_CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  const provided = req.headers.authorization;
  if (provided !== `Bearer ${cronSecret}`) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  try {
    const result = await pollEbayOrders();
    res.json(result);
  } catch (err) {
    console.error("eBay poll error:", err);
    res.status(500).json({ error: "Poll failed" });
  }
});

// Auth middleware — applies to everything below
app.use(authMiddleware);

// Rate limit all authenticated routes
app.use(generalLimiter);

// Application routes
app.use("/api/parts", partsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/ebay", ebayRouter);
app.use("/api/appliances", appliancesRouter);
app.use("/api/vendor-cookies", vendorCookiesRouter);
app.use("/api/import", importRouter);
app.use("/api/vendor-templates", vendorTemplatesRouter);

// Start server
async function start() {
  try {
    // Run migrations
    const db = getDb();
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations complete");

    // Seed default settings
    await seedSettings(process.env.DEFAULT_PASSWORD || "changeme");
    await seedPresetVendors();

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
