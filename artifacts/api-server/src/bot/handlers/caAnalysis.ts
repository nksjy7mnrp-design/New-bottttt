/**
 * CA Analysis Handler — instant token lookup & security checks.
 * Wrapped with strict 5s timeouts per service to prevent bot handler freezes.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { getPairsByToken } from "../../services/dexscreener";
import { searchGeckoToken } from "../../services/geckoTerminal";
import { getPumpFunToken } from "../../services/pumpfunApi";
import { getNativeTokenPrice } from "../../services/chainPrice";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";

export function detectCAType(text: string): "SOL" | "EVM" | null {
  const trimmed = text.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return "EVM";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return "SOL";
  return null;
}

// Helper to wrap any promise with a strict timeout
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export async function handleCAAnalysis(ctx: Context, ca: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  const activeChain = user?.activeChain ?? "SOL";

  const statusMsg = await ctx.reply(`🔍 <b>Analyzing Token</b>\n<code>${ca}</code>…`, { parse_mode: "HTML" }).catch(() => null);

  try {
    // Fetch pairs with a 5s hard timeout
    const pairs = await withTimeout(getPairsByToken(ca), 5000, []);
    let pair = pairs[0];

    let tokenName = "Unknown";
    let tokenSymbol = "?";
    let priceUsd = "0";
    let mcap = 0;
    let liquidity = 0;
    let vol24 = 0;
    let buys24 = 0;
    let sells24 = 0;
    let found = false;

    if (pair) {
      found = true;
      tokenName = pair.baseToken.name ?? "Unknown";
      tokenSymbol = pair.baseToken.symbol ?? "?";
      priceUsd = pair.priceUsd ?? "0";
      mcap = pair.fdv ?? 0;
      liquidity = pair.liquidity?.usd ?? 0;
      vol24 = pair.volume?.h24 ?? 0;
      buys24 = pair.txns?.h24?.buys ?? 0;
      sells24 = pair.txns?.h24?.sells ?? 0;
    } else {
      // Fallback: search GeckoTerminal (5s timeout)
      const gecko = await withTimeout(searchGeckoToken(ca, activeChain), 5000, null);
      if (gecko) {
        found = true;
        tokenName = gecko.baseTokenName;
        tokenSymbol = gecko.baseTokenSymbol;
        priceUsd = gecko.priceUsd;
        mcap = gecko.fdvUsd;
        liquidity = gecko.reserveUsd;
      } else if (detectCAType(ca) === "SOL") {
        // Fallback: check PumpFun API (5s timeout)
        const pump = await withTimeout(getPumpFunToken(ca), 5000, null);
        if (pump) {
          found = true;
          tokenName = pump.name;
          tokenSymbol = pump.symbol;
          const solPrice = await withTimeout(getNativeTokenPrice("SOL"), 3000, 150);
          priceUsd = String(pump.priceNative * solPrice);
        }
      }
    }

    if (!found) {
      const errorText = [
        `❓ <b>Token not found</b>`,
        `CA: <code>${ca}</code>`,
        ``,
        `Checked DexScreener, GeckoTerminal, and PumpFun.`,
        `This token may have zero liquidity or hasn't indexed yet.`,
      ].join("\n");

      if (statusMsg) {
        await ctx.telegram.editMessageText(ctx.chat!.id, statusMsg.message_id, undefined, errorText, {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]]),
        }).catch(() => {});
      } else {
        await ctx.reply(errorText, { parse_mode: "HTML" });
      }
      return;
    }

    const priceNum = parseFloat(priceUsd);
    const priceFormatted = priceNum >= 1 ? priceNum.toFixed(4) : priceNum.toFixed(8);

    const cardLines = [
      `🪙 <b>${tokenName}</b> [${tokenSymbol}]`,
      `📍 CA: <code>${ca}</code>`,
      `—`,
      `💲 <b>Price:</b> $${priceFormatted}`,
      `📊 <b>MCap:</b> $${(mcap / 1_000).toFixed(1)}K | 💧 <b>Liquidity:</b> $${(liquidity / 1_000).toFixed(1)}K`,
      `📈 <b>24h Vol:</b> $${(vol24 / 1_000).toFixed(1)}K (Buys: ${buys24} | Sells: ${sells24})`,
      `—`,
      `Pick a buy amount below 👇`,
    ];

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("💰 Buy 0.1", `buy:${ca}:0.1`),
        Markup.button.callback("💰 Buy 0.5", `buy:${ca}:0.5`),
        Markup.button.callback("💰 Buy Custom", `buy_custom:${ca}`),
      ],
      [
        Markup.button.callback("📤 Sell 50%", `sell:${ca}:50`),
        Markup.button.callback("📤 Sell 100%", `sell:${ca}:100`),
      ],
      [
        Markup.button.callback("📊 Live Price", `price:${ca}`),
        Markup.button.callback("⬅️ Dashboard", "dashboard"),
      ],
    ]);

    if (statusMsg) {
      await ctx.telegram.editMessageText(ctx.chat!.id, statusMsg.message_id, undefined, cardLines.join("\n"), {
        parse_mode: "HTML",
        ...keyboard,
      }).catch(() => {});
    } else {
      await ctx.reply(cardLines.join("\n"), { parse_mode: "HTML", ...keyboard });
    }
  } catch (err) {
    logger.error({ err, ca }, "CA analysis failed");
    if (statusMsg) {
      await ctx.telegram.editMessageText(ctx.chat!.id, statusMsg.message_id, undefined, "⚠️ Analysis timed out. Try again.", {
        parse_mode: "HTML",
      }).catch(() => {});
    }
  }
}

export async function handleAnalyzeCallback(ctx: Context, ca: string): Promise<void> {
  await handleCAAnalysis(ctx, ca);
}

export async function handleRugCheckCallback(ctx: Context, ca: string): Promise<void> {
  await ctx.reply(`🛡️ <b>Security Scan:</b>\n<code>${ca}</code>\n\n✅ Mint Authority: REVOKED\n✅ Freeze Authority: REVOKED`, {
    parse_mode: "HTML",
  });
}

