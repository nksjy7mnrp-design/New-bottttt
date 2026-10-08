/**
 * Position monitor — automated take-profit / stop-loss execution.
 *
 * Every open position is created at buy time (see trade.ts's executeBuy)
 * from that token's tokenScore.ts exitPlan, snapshotted as percentages
 * from entry (tp1Pct/tp2Pct/slPct). This runs on an interval, checks the
 * current price for each OPEN position with autoExitEnabled, and sells
 * automatically when a target is crossed:
 *
 *   - price <= entry*(1+slPct/100), before TP1  → sell 100%, close "SL"
 *   - price >= entry*(1+tp1Pct/100), TP1 not hit → sell 50%, mark tp1Hit,
 *     let the rest run toward TP2 (or a trailing stop)
 *   - price >= entry*(1+tp2Pct/100), after TP1   → sell remaining 100%,
 *     close "TP2"
 *   - after TP1, if the plan's trailing stop is on: track the highest
 *     price seen since TP1, and sell the remainder if price pulls back
 *     TRAILING_STOP_PCT from that peak
 *
 * Only SOL positions are monitored — sellPositionCore (trade.ts) only
 * knows how to sell SOL tokens; EVM auto-sell isn't wired up (manual EVM
 * sell still points to a DEX frontend, same as the rest of the bot).
 */

import { db } from "@workspace/db";
import { positionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getPairsByToken } from "./dexscreener";
import { sellPositionCore } from "../bot/handlers/trade";
import { queueMessage } from "../workers/messageQueue";
import { logger } from "../lib/logger";

const CHECK_INTERVAL_MS = 30_000; // 30s
const TRAILING_STOP_PCT = 15; // sell remainder if price pulls back 15% from its post-TP1 peak

type PositionRow = typeof positionsTable.$inferSelect;

function fmtPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return "0";
  return p >= 1 ? p.toFixed(4) : p.toFixed(8);
}

async function partialCloseTp1(position: PositionRow, currentPrice: number): Promise<void> {
  const result = await sellPositionCore(position.walletId, position.tokenAddress, 50);
  if (!result.ok) {
    logger.warn({ positionId: position.id, err: result.error }, "Auto TP1 sell failed");
    return;
  }

  await db.update(positionsTable).set({
    tp1Hit: true,
    trailingPeakPriceUsd: String(currentPrice),
    updatedAt: new Date(),
  }).where(eq(positionsTable.id, position.id));

  await queueMessage(
    position.telegramId,
    [
      `🎯 <b>TP1 Hit — Auto-Sold 50%</b>`,
      `🪙 ${position.tokenSymbol}`,
      `💲 Price: $${fmtPrice(currentPrice)} (entry $${fmtPrice(parseFloat(position.entryPriceUsd))})`,
      `🔗 TX: <code>${result.txHash}</code>`,
      `—`,
      `Remaining 50% still running toward TP2${position.trailingStopEnabled ? " (trailing stop armed)." : "."}`,
    ].join("\n"),
    "HTML",
    [[{ text: "🔕 Disable Auto-Exit", callback_data: `autoexit_off:${position.id}` }]]
  );
}

async function closePosition(
  position: PositionRow,
  reason: "SL" | "TP2" | "TRAILING_STOP",
  pctFromEntry: number
): Promise<void> {
  const result = await sellPositionCore(position.walletId, position.tokenAddress, 100);
  if (!result.ok) {
    logger.warn({ positionId: position.id, err: result.error }, `Auto ${reason} sell failed`);
    return;
  }

  await db.update(positionsTable).set({
    status: "CLOSED",
    closeReason: reason,
    updatedAt: new Date(),
  }).where(eq(positionsTable.id, position.id));

  const label =
    reason === "SL"
      ? "🛑 <b>Stop-Loss Hit — Position Closed</b>"
      : reason === "TP2"
        ? "🎯 <b>TP2 Hit — Position Closed</b>"
        : "📉 <b>Trailing Stop Hit — Position Closed</b>";

  await queueMessage(
    position.telegramId,
    [
      label,
      `🪙 ${position.tokenSymbol}`,
      `${pctFromEntry >= 0 ? "🟢" : "🔴"} ${pctFromEntry >= 0 ? "+" : ""}${pctFromEntry.toFixed(1)}% from entry`,
      `🔗 TX: <code>${result.txHash}</code>`,
    ].join("\n"),
    "HTML"
  );
}

async function checkOne(position: PositionRow): Promise<void> {
  try {
    const pairs = await getPairsByToken(position.tokenAddress);
    const current = parseFloat(pairs[0]?.priceUsd ?? "0");
    if (current <= 0) return; // no live price this tick — try again next time

    const entry = parseFloat(position.entryPriceUsd);
    if (entry <= 0) return;

    const pctFromEntry = ((current - entry) / entry) * 100;
    const tp1Price = entry * (1 + position.tp1Pct / 100);
    const tp2Price = entry * (1 + position.tp2Pct / 100);
    const slPrice = entry * (1 + position.slPct / 100);

    if (!position.tp1Hit) {
      if (current <= slPrice) {
        await closePosition(position, "SL", pctFromEntry);
        return;
      }
      if (current >= tp1Price) {
        await partialCloseTp1(position, current);
        return;
      }
      return;
    }

    // TP1 already hit — now watching for TP2 or a trailing-stop pullback.
    if (current >= tp2Price) {
      await closePosition(position, "TP2", pctFromEntry);
      return;
    }

    if (position.trailingStopEnabled) {
      const priorPeak = parseFloat(position.trailingPeakPriceUsd ?? "0");
      const peak = Math.max(priorPeak, current);
      if (peak > priorPeak) {
        await db.update(positionsTable)
          .set({ trailingPeakPriceUsd: String(peak), updatedAt: new Date() })
          .where(eq(positionsTable.id, position.id));
      }
      const pullbackPct = ((peak - current) / peak) * 100;
      if (pullbackPct >= TRAILING_STOP_PCT) {
        await closePosition(position, "TRAILING_STOP", pctFromEntry);
      }
    }
  } catch (err) {
    logger.warn({ err, positionId: position.id }, "Position monitor check failed");
  }
}

export function startPositionMonitor(): void {
  setInterval(async () => {
    try {
      const open = await db.query.positionsTable.findMany({
        where: and(
          eq(positionsTable.status, "OPEN"),
          eq(positionsTable.autoExitEnabled, true),
          eq(positionsTable.chain, "SOL")
        ),
      });
      for (const position of open) {
        await checkOne(position);
      }
    } catch (err) {
      logger.warn({ err }, "Position monitor tick failed");
    }
  }, CHECK_INTERVAL_MS);

  logger.info("Position monitor started (auto TP/SL, 30s interval)");
}
