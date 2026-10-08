import app from "./app";
import { logger } from "./lib/logger";
import { createBot, launchBot } from "./bot/index";
import { setBotInstance } from "./routes/index";

// ── Global exception boundaries ──────────────────────────────────────────
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
  process.exit(1);
});

// ── Port validation ───────────────────────────────────────────────────────
const rawPort = process.env["PORT"] || "8080";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT: "${rawPort}"`);

// ── Redis (optional) ──────────────────────────────────────────────────────
let redis: import("ioredis").default | null = null;

function extractRedisUrl(raw: string): string | null {
  // If the value is just a URL already, return it
  if (/^rediss?:\/\//i.test(raw.trim())) return raw.trim();
  // If user pasted a redis-cli command like "redis-cli --tls -u redis://...", extract the URL
  const match = raw.match(/rediss?:\/\/\S+/i);
  return match ? match[0] : null;
}

const rawRedisUrl = process.env["REDIS_URL"];
const redisUrl = rawRedisUrl ? extractRedisUrl(rawRedisUrl) : null;

if (redisUrl) {
  try {
    const { default: IORedis } = await import("ioredis");
    redis = new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    redis.on("error", (err) => logger.warn({ err }, "Redis error"));
    await redis.connect().catch((err) => {
      logger.warn({ err }, "Redis connect failed — queue disabled");
      redis = null;
    });
    if (redis) logger.info("Redis connected — BullMQ message queue active");
  } catch (err) {
    logger.warn({ err }, "Redis init failed — queue disabled");
    redis = null;
  }
} else {
  if (rawRedisUrl) {
    logger.warn("REDIS_URL value does not contain a valid redis:// URL — queue disabled");
  } else {
    logger.warn("REDIS_URL not set — BullMQ message queue disabled");
  }
}

// ── Bot initialization ────────────────────────────────────────────────────
let bot: ReturnType<typeof createBot> | null = null;
const botToken = process.env["TELEGRAM_BOT_TOKEN"];

if (botToken) {
  bot = createBot(redis);
  setBotInstance(bot);
  await launchBot(bot);
  const { startSnipeMonitor } = await import("./services/snipeMonitor");
  startSnipeMonitor();
  const { startPendingSnipeQueue } = await import("./services/pendingSnipeQueue");
  startPendingSnipeQueue();
  const { startPositionMonitor } = await import("./services/positionMonitor");
  startPositionMonitor();

  // The PumpFun/Auto-Snipe listener only lives in memory — every deploy or
  // restart wipes it out. Without this, users would need to manually
  // re-toggle Auto-Snipe or re-open PumpFun after every single redeploy.
  const { startPumpfunListener } = await import("./bot/handlers/pumpfun");
  const { db: dbClient, usersTable } = await import("@workspace/db");
  const { eq: eqOp } = await import("drizzle-orm");
  const autoSnipeUsers = await dbClient
    .select()
    .from(usersTable)
    .where(eqOp(usersTable.autoSnipe, true));
  for (const u of autoSnipeUsers) {
    startPumpfunListener(u.id, u.telegramId, u.telegramId);
  }
  logger.info({ count: autoSnipeUsers.length }, "Resumed PumpFun listeners for Auto-Snipe users");
} else {

  logger.warn("TELEGRAM_BOT_TOKEN not set — bot not started. Set it in Secrets.");
}

// ── Start HTTP server ─────────────────────────────────────────────────────
const server = app.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error starting server");
    process.exit(1);
  }
    logger.info({ port }, "MAESTRO_BOT server listening");
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
  logger.info({ signal }, "Shutting down gracefully");
  
  // Stop accepting new connections
  server.close(async () => {
    logger.info("HTTP server closed");
    
    // Stop the bot
    if (bot) {
      try {
        bot.stop(signal);
        logger.info("Bot stopped");
      } catch (err) {
        logger.warn({ err }, "Error stopping bot");
      }
    }
    
    // Close Redis connection
    if (redis) {
      try {
        await redis.quit();
        logger.info("Redis disconnected");
      } catch (err) {
        logger.warn({ err }, "Error closing Redis");
      }
    }
    
    logger.info("Shutdown complete");
    process.exit(0);
  });
  
  // Force exit after 30 seconds if graceful shutdown takes too long
  setTimeout(() => {
    logger.error("Graceful shutdown timeout — forcing exit");
    process.exit(1);
  }, 30_000);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
