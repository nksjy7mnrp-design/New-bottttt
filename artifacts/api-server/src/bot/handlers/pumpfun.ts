/**
 * PumpFun / Moonshot live sniper.
 * Listens to PumpPortal WebSocket for new token mints.
 * When autoSnipe=true, applies sniper filters then auto-executes buy.
 *
 * The listener is started/stopped from TWO places that both need to agree:
 *  - the 🌱 PumpFun screen (manual start/stop of live alerts)
 *  - the 🤖 Auto-Snipe toggle (turning auto-buy on/off)
 * Both call the same startPumpfunListener/stopPumpfunListener functions so
 * there's exactly one listener per user and no stale/disconnected state.
 * The auto-snipe check inside the listener always re-reads the DB flag at
 * fire time — never a captured value from when the listener started — so
 * toggling Auto-Snipe on/off takes effect immediately without restarting.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, walletsTable, sniperConfigsTable, signalsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { WsManager } from "../../services/wsManager";
import { getPairsByToken } from "../../services/dexscreener";
import { searchGeckoToken } from "../../services/geckoTerminal";
import { getPumpFunToken } from "../../services/pumpfunApi";
import { getNativeTokenPrice, getChainBalance } from "../../services/chainPrice";
import { checkSolanaToken } from "../../services/goplus";
import { queueMessage } from "../../workers/messageQueue";
import { computeBuyAmount } from "../../services/positionSizing";
import { triggerAutoSnipeBuy } from "./trade";
import { logger } from "../../lib/logger";
import { safeReply } from "../../lib/ctxHelper";

// Active PumpFun WSS listeners keyed by db userId
const activeListeners = new Map<number, WsManager>();

// Token names/symbols come from an external WebSocket feed — escape before
// rendering in HTML parse mode, or a name like "<Best>" silently kills the send.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PUMPFUN_WSS =
  process.env["SOLANA_WSS_URL"] ?? "wss://pumpportal.fun/api/data";

export function isPumpfunListenerActive(dbUserId: number): boolean {
  return activeListeners.has(dbUserId);
}

export function stopPumpfunListener(dbUserId: number): void {
  activeListeners.get(dbUserId)?.destroy();
  activeListeners.delete(dbUserId);
}

/**
 * Starts (or no-ops if already running) the live PumpFun listener for a
 * user. Auto-snipe eligibility is re-checked fresh from the DB on every
 * single new-token event — this function does not "bake in" the current
 * autoSnipe value, so toggling it elsewhere takes effect on the very next
 * detected token without needing to restart anything.
 */
export function startPumpfunListener(dbUserId: number, telegramId: number, chatId: number): void {
  if (activeListeners.has(dbUserId)) return; // already running

  // Pump.fun can create many tokens per minute — processing every single one
  // (DexScreener + GeckoTerminal + CoinGecko + RPC lookups, per token) is what
  // was exhausting those services' rate limits and making balance/price show
  // as 0. This drops events that arrive faster than one every 2.5s, before
  // any lookup happens, so the actual call volume stays bounded no matter
  // how fast new tokens are being minted network-wide.
  let lastProcessedAt = 0;
  const MIN_EVENT_INTERVAL_MS = 2_500;

  const ws = new WsManager(
    PUMPFUN_WSS,
        async (raw) => {
      try {
        const data = JSON.parse(raw) as {
          txType?: string;
          mint?: string;
          name?: string;
          symbol?: string;
          solAmount?: number;
          marketCapSol?: number;
        };

        if (data.txType !== "create" || !data.mint) return;

        const now = Date.now();
        if (now - lastProcessedAt < MIN_EVENT_INTERVAL_MS) return; // dropped, not queued
        lastProcessedAt = now;

        logger.info({ preview: raw.slice(0, 200) }, "PumpFun WS message received");

        const mint = data.mint;
        // Raw values for DB + trade params; escaped values for HTML rendering
        const symbol = data.symbol ?? "?";
        const name = data.name ?? "Unknown";
        const symbolSafe = escapeHtml(symbol);
        const nameSafe = escapeHtml(name);
        const devBuySol = data.solAmount ?? 0;
        const mcapSol = data.marketCapSol ?? 0;

        // ── Resolve token data (waterfall) ────────────────────────────────
        let priceUsd = "0";
        let liquidityUsd = 0;
        let tokenMsg = "";

        const pairs = await getPairsByToken(mint).catch(() => []);
        const pair = pairs[0];

        if (pair) {
          priceUsd = pair.priceUsd ?? "0";
          liquidityUsd = pair.liquidity?.usd ?? 0;
          tokenMsg = [
            `🌱 <b>New Token!</b>`,
            `🪙 <b>${nameSafe}</b> (<code>${symbolSafe}</code>)`,
            `📍 CA: <code>${mint}</code>`,
            `💲 Price: $${Number(priceUsd).toFixed(8)}`,
            `💧 Liquidity: $${(liquidityUsd / 1_000).toFixed(1)}K`,
            `📊 Source: DexScreener`,
          ].join("\n");
        } else {
          const gecko = await searchGeckoToken(mint, "SOL").catch(() => null);
          if (gecko) {
            priceUsd = gecko.priceUsd;
            liquidityUsd = gecko.liquidityUsd;
            tokenMsg = [
              `🌱 <b>New Token!</b>`,
              `🪙 <b>${escapeHtml(gecko.baseTokenName)}</b>`,
              `📍 CA: <code>${mint}</code>`,
              `💲 Price: $${Number(priceUsd).toFixed(8)}`,
              `💧 Liquidity: $${(liquidityUsd / 1_000).toFixed(1)}K`,
              `📊 Source: GeckoTerminal`,
            ].join("\n");
          } else {
            const pumpToken = await getPumpFunToken(mint).catch(() => null);
            const solUsd = Number(await getNativeTokenPrice("SOL").catch(() => 0));
            const pPrice = pumpToken ? pumpToken.priceNative * solUsd : 0;
            priceUsd = pPrice.toFixed(10);
            liquidityUsd = 0;
            tokenMsg = [
              `🌱 <b>New PumpFun Launch!</b>`,
              `🪙 <b>${escapeHtml(pumpToken?.name ?? name)}</b> (<code>${escapeHtml(pumpToken?.symbol ?? symbol)}</code>)`,
              `📍 CA: <code>${mint}</code>`,
              `💲 ~$${pPrice.toFixed(8)}`,
              pumpToken ? `📈 Bonding: ${pumpToken.bondingCurveProgress.toFixed(1)}%` : "",
              `📊 Source: PumpFun`,
            ].filter(Boolean).join("\n");
          }
        }

        // Launch stats straight from the mint event itself
        const launchStats = [
          mcapSol > 0 ? `🏦 Launch MC: ${mcapSol.toFixed(1)} SOL` : "",
          devBuySol > 0 ? `👨‍💻 Dev buy: ${devBuySol.toFixed(2)} SOL` : "",
        ].filter(Boolean).join(" | ");
        if (launchStats) tokenMsg += `\n${launchStats}`;

        // ── Always fetch fresh config for this token's quick-buy amount ───
        const freshConfig0 = await db.query.sniperConfigsTable.findFirst({
          where: eq(sniperConfigsTable.userId, dbUserId),
        });
        const rawAutoBuy = parseFloat(freshConfig0?.autoBuyAmountNative ?? "0.1");
        const quickBuyAmount = Number(
          Math.min(Math.max(Number.isFinite(rawAutoBuy) ? rawAutoBuy : 0.1, 0.000001), 1000).toFixed(6)
        );

        // ── Auto-snipe — ALWAYS re-read the live DB flag, never a value
        //    captured when the listener started, so toggling Auto-Snipe
        //    on/off elsewhere takes effect on the very next token. ───────
        const freshUser = await db.query.usersTable.findFirst({
          where: eq(usersTable.id, dbUserId),
        });

        // Only broadcast the manual "New Token!" browse alert when
        // Auto-Snipe is OFF. With Auto-Snipe on, the bot is already
        // deciding whether to buy — sending this too just doubles every
        // single launch into a second, redundant message and is the main
        // source of the flood/429s.
        if (!freshUser?.autoSnipe) {
          await queueMessage(chatId, tokenMsg, "HTML", [
            [
              { text: "📊 Analyze", callback_data: `analyze:${mint}` },
              { text: "💰 Quick Buy", callback_data: `buy:${mint}:${quickBuyAmount}` },
            ],
          ]);
        }

        // ── Record signal ────────────────────────────────────────────────
        void db.insert(signalsTable).values({
          userId: dbUserId,
          tokenAddress: mint,
          tokenSymbol: symbol,
          chain: "SOL",
          source: "PUMPFUN",
          priceUsd,
        }).catch(() => undefined);

        if (!freshUser?.autoSnipe) return;

        const freshConfig = await db.query.sniperConfigsTable.findFirst({
          where: eq(sniperConfigsTable.userId, dbUserId),
        });

        const minLiq = parseFloat(freshConfig?.minLiquidityUsd ?? "0");
        if (minLiq > 0 && liquidityUsd < minLiq) {
          // Silent skip, no message — every token is at $0 liquidity at the
          // instant it's created, so this condition is true for nearly
          // every single launch. Notifying on it is pure noise, not signal.
          return;
        }

        if (freshConfig?.honeypotCheck !== false) {
          const sec = await checkSolanaToken(mint).catch(() => null);
          if (sec?.isBlacklisted || sec?.hasMintAuthority) {
            // Silent skip, no message — not a real trade, no signal to send.
            return;
          }
        }

        // Check balance right before firing
        const freshWallet = await db.query.walletsTable.findFirst({
          where: and(eq(walletsTable.userId, dbUserId), eq(walletsTable.chain, "SOL"), eq(walletsTable.isActive, true)),
        });
        if (!freshWallet) {
          // Silent skip, no message — same reasoning as above.
          return;
        }
                const currentBal = parseFloat(await getChainBalance("SOL", freshWallet.address).catch(() => "0"));
        const buyAmt = computeBuyAmount(freshConfig, "SOL", currentBal);
        if (buyAmt <= 0 || currentBal < buyAmt) {
          // Silent skip, no message. This was the main source of sustained
          // traffic: with balance at 0, this branch fired on nearly every
          // token that cleared the filters above. The token still gets
          // queued below so it auto-buys the moment the wallet is funded —
          // only the notification is removed, not the underlying behavior.
          void queuePendingSnipe(dbUserId, telegramId, mint, symbol, name, priceUsd, liquidityUsd, buyAmt);
          return;
        }

        void triggerAutoSnipeBuy({
          dbUserId,
          telegramId,
          ca: mint,
          tokenSymbol: symbol,
          tokenName: name,
          priceUsd,
          liquidityUsd,
        });
      } catch (err) {
        logger.error({ err }, "PumpFun message handler error");
      }
    },
    () => {
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    }
  );

  ws.connect();
  activeListeners.set(dbUserId, ws);
}

/**
/**
 * Opens the PumpFun screen. This no longer starts anything on its own —
 * it only reports current status. The listener starts exclusively when the
 * user explicitly presses "▶️ Start Listener" (handlePumpfunStart below),
 * so simply navigating here (or back here) never silently kicks off the
 * live feed.
 */
export async function handlePumpfun(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  // Check SOL wallet + balance before starting
  const wallet = await db.query.walletsTable.findFirst({
    where: and(
      eq(walletsTable.userId, user.id),
      eq(walletsTable.chain, "SOL"),
      eq(walletsTable.isActive, true)
    ),
  });

  const config = await db.query.sniperConfigsTable.findFirst({
    where: eq(sniperConfigsTable.userId, user.id),
  });

  const rawAutoBuy = parseFloat(config?.autoBuyAmountNative ?? "0.1");
  const autoBuyAmount = Number(
    Math.min(Math.max(Number.isFinite(rawAutoBuy) ? rawAutoBuy : 0.1, 0.000001), 1000).toFixed(6)
  );
  const autoSnipe = user.autoSnipe ?? false;

  let balanceWarning = "";
  if (autoSnipe) {
    if (!wallet) {
      balanceWarning = `\n⚠️ <b>No SOL wallet!</b> Auto-snipe is ON but you have no wallet. Go to 💼 Wallet Manager first.`;
    } else {
      const bal = parseFloat(await getChainBalance("SOL", wallet.address).catch(() => "0"));
      if (bal < autoBuyAmount) {
        balanceWarning = `\n⚠️ <b>Low balance!</b> Your wallet has <b>${bal.toFixed(4)} SOL</b> but auto-buy is set to <b>${autoBuyAmount} SOL</b>.\nDeposit more SOL or reduce the buy amount in ⚗️ Filters. New launches will queue and auto-buy once funded.`;
      }
    }
  }

  const isActive = isPumpfunListenerActive(user.id);

  const autoSnipeStatus = autoSnipe
    ? `⚡ <b>Auto-Snipe: ON</b> — will auto-buy matching launches${balanceWarning}`
    : `🔴 Auto-Snipe: OFF — tap 🤖 Auto-Snipe to enable automatic buying`;

  await safeReply(
    ctx,
    [
      `🌱 <b>PumpFun / Moonshot Snipe</b>`,
      ``,
      isActive
        ? `🟢 Listener <b>active</b> — watching new Solana token launches.\nYou'll receive an alert with buy buttons for every new mint.`
        : `🔴 Listener <b>stopped</b>.\nTap ▶️ Start Listener below to begin watching new launches.`,
      ``,
      autoSnipeStatus,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          isActive
            ? Markup.button.callback("⏹ Stop Listener", "pumpfun_stop")
            : Markup.button.callback("▶️ Start Listener", "pumpfun_start"),
        ],
        [
          Markup.button.callback("🤖 Auto-Snipe Settings", "auto_snipe"),
          Markup.button.callback("⚗️ Filters", "filters"),
        ],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}

/**
 * Explicit start — only reachable via the "▶️ Start Listener" button.
 */
export async function handlePumpfunStart(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  const chatId = ctx.chat?.id ?? telegramId;
  startPumpfunListener(user.id, telegramId, chatId); // no-op if already running
  await handlePumpfun(ctx); // re-render with the now-active status
}

/**
 * Explicit stop — only reachable via the "⏹ Stop Listener" button, never
 * by just re-opening the PumpFun menu.
 */
export async function handlePumpfunStop(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  stopPumpfunListener(user.id);
  await safeReply(
    ctx,
    [
      `🌱 <b>PumpFun / Moonshot Snipe</b>`,
      ``,
      `🔴 Listener <b>stopped</b>.`,
      `Tap Start to resume monitoring new launches.`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("▶️ Start Listener", "pumpfun")],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}

/**
 * Queues a token that passed all filters but couldn't be bought due to
 * insufficient balance. pendingSnipeQueue.ts polls these every minute and
 * fires the buy automatically the moment the wallet is funded.
 */
async function queuePendingSnipe(
  dbUserId: number,
  telegramId: number,
  ca: string,
  tokenSymbol: string,
  tokenName: string,
  priceUsd: string,
  liquidityUsd: number,
  buyAmountNative: number
): Promise<void> {
  const { queuePendingAutoSnipe } = await import("../../services/pendingSnipeQueue");
  await queuePendingAutoSnipe({
    dbUserId,
    telegramId,
    chain: "SOL",
    ca,
    tokenSymbol,
    tokenName,
    priceUsd,
    liquidityUsd,
    buyAmountNative: String(buyAmountNative),
  });
}
