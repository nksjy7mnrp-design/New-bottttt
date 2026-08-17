/**
 * MAESTRO_BOT — Telegraf bot initialization.
 * Registers all command, callback_query, and text handlers.
 * Uses webhook in production, polling in development.
 */

import { Telegraf, Markup, type Context } from "telegraf";
import type IORedis from "ioredis";
import { logger } from "../lib/logger";
import { renderDashboard } from "./dashboard";
import { handleNewRunners } from "./handlers/newRunners";
import { handleTrending } from "./handlers/trending";
import { handlePumpfun, handlePumpfunStop } from "./handlers/pumpfun";
import { handlePreviousSignals } from "./handlers/previousSignals";
import {
  handleWalletManager,
  handleDeposit,
  handleGenerateWallet,
  handleImportWallet,
  handleImportMethodChoice,
  processImportedKey,
  getPendingImport,
  handleWalletDetail,
  handleRenameWallet,
  processRenameInput,
  getPendingRename,
  handleActivateWallet,
  handleToggleTradeable,
  handleExportKey,
  handleDeleteWallet,
  handleDeleteWalletConfirm,
} from "./handlers/walletManager";
import {
  handleCopyTrade,
  handleAddCopyTarget,
  handleRemoveCopyTarget,
  processCopyTradeInput,
  isPendingCopyTradeAdd,
} from "./handlers/copyTrade";
import { handleGroupScanner, scanGroupMessage } from "./handlers/groupScanner";
import { handlePnlCenter } from "./handlers/pnlCenter";
import { handleMyTrades } from "./handlers/myTrades";
import { handleAutoSnipe, handleAutoSnipeToggle } from "./handlers/autoSnipe";
import { handleSettings, handleSetChain } from "./handlers/settings";
import {
  handleFilters,
  handleSetFilter,
  handleToggleHoneypot,
  handleToggleBuyMode,
  processFilterInput,
  getPendingFilter,
} from "./handlers/filters";
import {
  handleManualSnipePrompt,
  processManualSnipeCA,
  isPendingManualSnipe,
  handleStartManualSnipe,
  handleStopSnipe,
  handleSnipeConfirmPreview,
} from "./handlers/manualSnipe";
import { handleBotStats } from "./handlers/botStats";

import { handleHelpGuide } from "./handlers/helpGuide";
import {
  handleCAAnalysis,
  handleAnalyzeCallback,
  handleRugCheckCallback,
  detectCAType,
} from "./handlers/caAnalysis";
import {
  handleBuy,
  handleBuyCustom,
  handleSell,
  handleLivePrice,
  processCustomBuyAmount,
  getPendingCustomBuy,
} from "./handlers/trade";
import { initMessageQueue } from "../workers/messageQueue";
import { setBotRef } from "../lib/botRef";
import { clearAllPendingFlows } from "../lib/pendingFlows";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// All commands shown in the Telegram menu
const BOT_COMMANDS = [
  { command: "start",     description: "🏠 Open main dashboard" },
  { command: "menu",      description: "🏠 Open main dashboard" },
  { command: "wallet",    description: "💼 Wallet manager" },
  { command: "trending",  description: "🔥 Trending tokens" },
  { command: "runners",   description: "🔍 New runners / boosted tokens" },
  { command: "pumpfun",   description: "🌱 PumpFun & Moonshot sniper" },
  { command: "signals",   description: "📋 Previous signals" },
  { command: "trades",    description: "📉 My trades" },
  { command: "pnl",       description: "📊 PnL center" },
  { command: "snipe",     description: "🤖 Toggle auto-snipe" },
  { command: "copytrade", description: "🔄 Copy-trade manager" },
  { command: "scanner",   description: "📡 Group scanner" },
  { command: "settings",  description: "⚙️ Settings & chain selection" },
  { command: "filters",   description: "⚗️ Snipe filters" },
  { command: "deposit",   description: "💳 Deposit funds to active wallet" },
  { command: "help",      description: "❓ Help & guide" },
];

export function createBot(redis: IORedis | null): Telegraf<Context> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const bot = new Telegraf<Context>(token);

  // Register bot singleton so any module can send messages
  setBotRef(bot);

  // Initialize BullMQ message queue
  initMessageQueue(bot, redis);

  // ── Global error handler ────────────────────────────────────────────────
  bot.catch((err, ctx) => {
    logger.error({ err, update: ctx.update }, "Bot handler error");
    ctx.reply("⚠️ An internal error occurred. Please try again.").catch(() => {});
  });

  // ── Global middleware: instantly dismiss the loading spinner on every
  //    inline-button tap so users never see the clock animation.
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (ctx.callbackQuery) {
      ctx.answerCbQuery().catch(() => {});
      if (fromId) clearAllPendingFlows(fromId);
    } else if (
      fromId &&
      ctx.message &&
      "text" in ctx.message &&
      ctx.message.text.startsWith("/")
    ) {
      clearAllPendingFlows(fromId);
    }
    return next();
  });

  // ── Commands ────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    await renderDashboard(ctx, false);
  });

  bot.command("menu",      async (ctx) => renderDashboard(ctx, false));
  bot.command("wallet",    async (ctx) => handleWalletManager(ctx));
  bot.command("trending",  async (ctx) => handleTrending(ctx));
  bot.command("runners",   async (ctx) => handleNewRunners(ctx));
  bot.command("pumpfun",   async (ctx) => handlePumpfun(ctx));
  bot.command("signals",   async (ctx) => handlePreviousSignals(ctx));
  bot.command("trades",    async (ctx) => handleMyTrades(ctx));
  bot.command("pnl",       async (ctx) => handlePnlCenter(ctx));
  bot.command("snipe",     async (ctx) => handleAutoSnipe(ctx));
  bot.command("copytrade", async (ctx) => handleCopyTrade(ctx));
  bot.command("scanner",   async (ctx) => handleGroupScanner(ctx));
  bot.command("settings",  async (ctx) => handleSettings(ctx));
  bot.command("filters",   async (ctx) => handleFilters(ctx));
  bot.command("help",      async (ctx) => handleHelpGuide(ctx));

  // ── Callback Queries ────────────────────────────────────────────────────
  bot.action("dashboard",      (ctx) => renderDashboard(ctx, true));
  bot.action("new_runners",    handleNewRunners);
  bot.action("trending",       handleTrending);
  bot.action("pumpfun",        handlePumpfun);
  bot.action("pumpfun_stop",   handlePumpfunStop);
  bot.action("prev_signals",   handlePreviousSignals);
  bot.action("wallet_manager", handleWalletManager);
  bot.action("copy_trade",     handleCopyTrade);
  bot.action("add_copy_target",handleAddCopyTarget);
  bot.action("group_scanner",  handleGroupScanner);
  bot.action("pnl_center",     handlePnlCenter);
  bot.action("my_trades",      handleMyTrades);
  bot.action("auto_snipe",     handleAutoSnipe);
  bot.action("auto_snipe_toggle", handleAutoSnipeToggle);
  bot.action("settings",       handleSettings);
  bot.action("filters",        handleFilters);
  bot.action("toggle_honeypot",handleToggleHoneypot);
  bot.action("toggle_buy_mode", handleToggleBuyMode);

  bot.action("manual_snipe",   handleManualSnipePrompt);

  bot.action(/^manual_snipe_start:(.+)$/, async (ctx) => {
    const ca = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleStartManualSnipe(ctx, ca);
  });

  bot.action(/^stop_snipe:(\d+)$/, async (ctx) => {
    const id = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleStopSnipe(ctx, id);
  });

  bot.action(/^snipe_confirm:(.+)$/, async (ctx) => {
    const target = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleSnipeConfirmPreview(ctx, target);
  });
  bot.action("bot_stats",      handleBotStats);
  bot.action("help_guide",     handleHelpGuide);

  bot.action("del_msg", async (ctx) => {
    await ctx.deleteMessage().catch(() => {});
  });

  bot.action(/^deposit:(.+)$/, async (ctx) => {
    const chain = (ctx.match as RegExpMatchArray)[1] ?? "SOL";
    await handleDeposit(ctx, chain);
  });

  bot.command("deposit", async (ctx) => {
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.telegramId, ctx.from.id),
    });
    await handleDeposit(ctx, user?.activeChain ?? "SOL");
  });

  bot.action("prompt_buy", async (ctx) => {
    await ctx.reply(
      [
        `💰 <b>Buy a Token</b>`,
        ``,
        `Paste a token contract address below and I'll analyze it`,
        `and show you buy options instantly.`,
        ``,
        `<b>Solana:</b> base58 address (e.g. <code>EPjFWdd5...</code>)`,
        `<b>EVM:</b> 0x address (e.g. <code>0x6B175...</code>)`,
        ``,
        `Or pick a token from the lists below:`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("🔍 New Runners", "new_runners"),
            Markup.button.callback("🔥 Trending", "trending"),
          ],
          [
            Markup.button.callback("🌱 PumpFun Snipe", "pumpfun"),
            Markup.button.callback("⬅️ Dashboard", "dashboard"),
          ],
        ]),
      }
    );
  });

  bot.action(/^analyze:(.+)$/, async (ctx) => {
    const ca = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleAnalyzeCallback(ctx, ca);
  });

  bot.action(/^rugcheck:(.+)$/, async (ctx) => {
    const target = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleRugCheckCallback(ctx, target);
  });

  bot.action("prompt_sell", async (ctx) => {
    await ctx.reply(
      [
        `📤 <b>Sell a Token</b>`,
        ``,
        `Paste the contract address of a token you're holding and I'll`,
        `pull it up with sell options.`,
        ``,
        `<b>Solana:</b> base58 address (e.g. <code>EPjFWdd5...</code>)`,
        `<b>EVM:</b> 0x address (e.g. <code>0x6B175...</code>)`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📉 My Trades", "my_trades")],
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
  });

  bot.action(/^gen_wallet:(.+)$/, async (ctx) => {
    const chain = (ctx.match as RegExpMatchArray)[1] ?? "SOL";
    await handleGenerateWallet(ctx, chain);
  });

  bot.action(/^import_method:(.+):(key|phrase)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const chain = match[1] ?? "SOL";
    const method = (match[2] ?? "key") as "key" | "phrase";
    await handleImportMethodChoice(ctx, chain, method);
  });

  bot.action(/^import_wallet:(.+)$/, async (ctx) => {
    const chain = (ctx.match as RegExpMatchArray)[1] ?? "SOL";
    await handleImportWallet(ctx, chain);
  });

  // ── Wallet management (detail / rename / activate / export / delete) ────
  bot.action(/^wallet:(\d+)$/, async (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1] ?? "0", 10);
    await handleWalletDetail(ctx, id);
  });

  bot.action(/^wallet_rename:(\d+)$/, async (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1] ?? "0", 10);
    await handleRenameWallet(ctx, id);
  });

  bot.action(/^wallet_activate:(\d+)$/, async (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1] ?? "0", 10);
    await handleActivateWallet(ctx, id);
  });

  bot.action(/^wallet_toggle_tradeable:(\d+)$/, async (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1] ?? "0", 10);
    await handleToggleTradeable(ctx, id);
  });

  bot.action(/^wallet_export:(\d+)$/, async (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1] ?? "0", 10);
    await handleExportKey(ctx, id);
  });

  bot.action(/^wallet_del:(\d+)$/, async (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1] ?? "0", 10);
    await handleDeleteWallet(ctx, id);
  });

  bot.action(/^wallet_del_yes:(\d+)$/, async (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1] ?? "0", 10);
    await handleDeleteWalletConfirm(ctx, id);
  });

  bot.action(/^rm_ct:(\d+)$/, async (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1] ?? "0", 10);
    await handleRemoveCopyTarget(ctx, id);
  });

  bot.action(/^set_chain:(.+)$/, async (ctx) => {
    const chain = (ctx.match as RegExpMatchArray)[1] ?? "SOL";
    await handleSetChain(ctx, chain);
  });

  bot.action(/^set_filter:(.+)$/, async (ctx) => {
    const field = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleSetFilter(ctx, field);
  });

  bot.action(/^buy:([^:]+):([0-9.]+)$/, async (ctx) => {
    const [, ca, amount] = ctx.match as RegExpMatchArray;
    await handleBuy(ctx, ca ?? "", amount ?? "0");
  });

  bot.action(/^buy_custom:(.+)$/, async (ctx) => {
    const ca = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleBuyCustom(ctx, ca);
  });

  bot.action(/^sell:([^:]+):(\d+)$/, async (ctx) => {
    const [, ca, pct] = ctx.match as RegExpMatchArray;
    await handleSell(ctx, ca ?? "", pct ?? "100");
  });

  bot.action(/^price:(.+)$/, async (ctx) => {
    const ca = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleLivePrice(ctx, ca);
  });

  // ── Text handler — CA detection + multi-step flows ──────────────────────
  bot.on("text", async (ctx) => {
    const text = ctx.message.text.trim();
    const telegramId = ctx.from.id;

    const importState = getPendingImport(telegramId);
    if (importState) {
      await processImportedKey(ctx, text);
      return;
    }

    if (getPendingRename(telegramId)) {
      await processRenameInput(ctx, text);
      return;
    }

    if (isPendingCopyTradeAdd(telegramId)) {
      await processCopyTradeInput(ctx, text);
      return;
    }

    const filterState = getPendingFilter(telegramId);
    if (filterState) {
      await processFilterInput(ctx, text);
      return;
    }

    if (isPendingManualSnipe(telegramId)) {
      await processManualSnipeCA(ctx, text);
      return;
    }

    const customBuy = getPendingCustomBuy(telegramId);
    if (customBuy) {
      await processCustomBuyAmount(ctx, text);
      return;
    }

    const caType = detectCAType(text);
    if (caType) {
      await handleCAAnalysis(ctx, text);
      return;
    }

    if (ctx.chat.type !== "private") {
      const user = await db.query.usersTable.findFirst({
        where: eq(usersTable.telegramId, telegramId),
      });
      if (user?.scannerActive) {
        await scanGroupMessage(text, user.id, telegramId, user.activeChain);
      }
      return;
    }

    await renderDashboard(ctx, false);
  });

  return bot;
}

export async function launchBot(bot: Telegraf<Context>): Promise<void> {
  const webhookDomain = process.env["WEBHOOK_DOMAIN"];
  const port = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : undefined;

  if (webhookDomain && port) {
    const webhookPath = "/api/webhook";
    logger.info({ webhookDomain, webhookPath }, "Launching bot with webhook");
    await bot.telegram.setWebhook(`${webhookDomain}${webhookPath}`);
    logger.info("Webhook set — Express will handle updates");
  } else {
    logger.info("Launching bot with long-polling (no WEBHOOK_DOMAIN set)");
    await bot.telegram.deleteWebhook();
    void bot.launch({ dropPendingUpdates: true });
  }

  try {
    await bot.telegram.setMyCommands(BOT_COMMANDS);
  } catch (err) {
    logger.error({ err }, "Failed to set bot commands menu");
  }
}
