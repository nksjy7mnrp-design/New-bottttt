/**
 * BullMQ message queue — enforces ≤30 outbound Telegram messages/second.
 * Falls back to direct send when Redis is unavailable.
 * Supports optional inline keyboard buttons.
 */

import { Queue, Worker } from "bullmq";
import type IORedis from "ioredis";
import type { Telegraf, Context } from "telegraf";
import { logger } from "../lib/logger";

type InlineButton = { text: string; callback_data: string };
type InlineKeyboard = InlineButton[][];

interface SendMessageJob {
  chatId: number | string;
  text: string;
  parseMode?: "HTML" | "MarkdownV2" | "Markdown";
  inlineKeyboard?: InlineKeyboard;
}

let queue: Queue<SendMessageJob> | null = null;
let botRef: Telegraf<Context> | null = null;

// Paces the no-Redis fallback path to under 1 message/second — Telegram's
// own retry_after values (seen escalating from 500ms up to 4000ms in
// production logs) confirmed the previous 350ms pacing still exceeded its
// real per-chat limit under sustained traffic. Without this, a burst of
// calls sends them all essentially at once and trips Telegram's 429.
const DIRECT_SEND_INTERVAL_MS = 1_100;
let lastDirectSendAt = 0;
let directSendChain: Promise<void> = Promise.resolve();

function scheduleDirectSend(fn: () => Promise<void>): Promise<void> {
  directSendChain = directSendChain.then(async () => {
    const wait = Math.max(0, lastDirectSendAt + DIRECT_SEND_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastDirectSendAt = Date.now();
    await fn();
  });
  return directSendChain;
}

export function initMessageQueue(
  bot: Telegraf<Context>,
  redis: IORedis | null
): void {
  botRef = bot;

  if (!redis) {
    logger.warn("Redis unavailable — message queue disabled, direct send active");
    return;
  }

  queue = new Queue<SendMessageJob>("tg-messages", {
    connection: redis as never,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
  });

  const worker = new Worker<SendMessageJob>(
    "tg-messages",
    async (job) => {
      const { chatId, text, parseMode, inlineKeyboard } = job.data;
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: parseMode ?? "HTML",
        reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
      });
    },
    {
      connection: redis as never,
      limiter: { max: 30, duration: 1_000 },
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Message queue job failed");
  });

  logger.info("BullMQ message queue initialized (30 msg/s limit)");
}

export async function queueMessage(
  chatId: number | string,
  text: string,
  parseMode: "HTML" | "MarkdownV2" | "Markdown" = "HTML",
  inlineKeyboard?: InlineKeyboard
): Promise<void> {
  const extra = {
    parse_mode: parseMode as "HTML" | "MarkdownV2" | "Markdown",
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
  };

  if (queue) {
    await queue.add("send", { chatId, text, parseMode, inlineKeyboard });
    return;
  }

  // Fallback: direct send, paced to avoid Telegram rate limits
  await scheduleDirectSend(async () => {
    try {
      await botRef?.telegram.sendMessage(chatId, text, extra);
    } catch (err) {
      logger.error({ chatId, err }, "Direct message send failed");
    }
  });
}
