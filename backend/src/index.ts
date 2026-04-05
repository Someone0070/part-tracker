import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { getDb } from "./db/index.js";
import { seedSettings } from "./db/seed.js";
import { proxySecret } from "./middleware/proxy-secret.js";
import { authMiddleware } from "./middleware/auth.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { generalLimiter } from "./middleware/rate-limit.js";
import healthRouter from "./routes/health.js";
import authRouter from "./routes/auth.js";
import partsRouter from "./routes/parts.js";
import settingsRouter from "./routes/settings.js";
import appliancesRouter from "./routes/appliances.js";

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);

// Trust proxy for Express internals
app.set("trust proxy", 1);

// Body parsing
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

// Security middleware
if (process.env.NODE_ENV === "production") {
  app.use(proxySecret);
}
app.use(securityHeaders);

// Health check — before auth
app.use("/api/health", healthRouter);

// Auth routes — before auth middleware (some routes exempt)
app.use("/api/auth", authRouter);

// Auth middleware — applies to everything below
app.use(authMiddleware);

// Rate limit all authenticated routes
app.use(generalLimiter);

// Application routes
app.use("/api/parts", partsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/appliances", appliancesRouter);

// Start server
async function start() {
  try {
    // Run migrations
    const db = getDb();
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations complete");

    // Seed default settings
    await seedSettings(process.env.DEFAULT_PASSWORD || "changeme");

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
