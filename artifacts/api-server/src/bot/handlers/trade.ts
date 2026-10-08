/**
 * Trade execution handler.
 * SOL: Jupiter (DEX/AMM aggregator) with PumpPortal fallback, pool="auto"
 *      (Pump.fun bonding curve, PumpSwap post-graduation, or Raydium)
 * EVM: 1inch swap → eth_call simulate → direct/Flashbots
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import {
  usersTable,
  walletsTable,
  tradesTable,
  sniperConfigsTable,
  activeSnipesTable,
  positionsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { decrypt } from "../../lib/encryption";
import { getBotRef } from "../../lib/botRef";
import { getJupiterQuote, buildJupiterSwapTx, simulateSolanaTx } from "../../services/jupiter";
import { sendSolanaTxDirect, getJitoTipLamports } from "../../services/jito";
import { get1inchSwap } from "../../services/evmSwap";
import { simulateEvmTx } from "../../services/flashbots";
import { getPairsByToken } from "../../services/dexscreener";
import { pickTradingWallet, markWalletUsed } from "../../services/walletRotation";
import { searchGeckoToken } from "../../services/geckoTerminal";
import { getPumpFunToken } from "../../services/pumpfunApi";
import { getNativeTokenPrice } from "../../services/chainPrice";
import { scoreToken, type ScoreInput } from "../../services/tokenScore";
import { detectCAType } from "./caAnalysis";
import { logger } from "../../lib/logger";
import { registerPendingClearer } from "../../lib/pendingFlows";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const EVM_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const PLATFORM_FEE_BPS = 0;

// ── Pending custom buy state ──────────────────────────────────────────────
const pendingCustomBuy = new Map<number, { ca: string }>();
registerPendingClearer((id) => pendingCustomBuy.delete(id));

export function getPendingCustomBuy(telegramId: number): { ca: string } | null {
  return pendingCustomBuy.get(telegramId) ?? null;
}

export async function processCustomBuyAmount(ctx: Context, amount: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const state = pendingCustomBuy.get(telegramId);
  if (!state) return;
  pendingCustomBuy.delete(telegramId);

  const parsed = parseFloat(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    await ctx.reply("❌ Invalid amount — send a positive number like <b>0.25</b>.", {
      parse_mode: "HTML",
    });
    return;
  }
  await executeBuy(ctx, state.ca, parsed);
}

export async function handleBuy(ctx: Context, ca: string, amountStr: string): Promise<void> {
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) { await ctx.reply("❌ Invalid amount."); return; }
  await executeBuy(ctx, ca, amount);
}

export async function handleBuyCustom(ctx: Context, ca: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  pendingCustomBuy.set(telegramId, { ca });
  await ctx.reply("💬 Send the amount to buy in native token (e.g. <b>0.25</b>):", { parse_mode: "HTML" });
}

export async function handleSell(ctx: Context, ca: string, percentStr: string): Promise<void> {
  const percent = parseInt(percentStr, 10);
  if (isNaN(percent) || percent <= 0 || percent > 100) { await ctx.reply("❌ Invalid percent."); return; }
  await executeSell(ctx, ca, percent);
}

// ── PumpPortal fallback for Pump.fun tokens (bonding curve OR PumpSwap) ──

async function buildPumpPortalTx(
  publicKey: string,
  action: "buy" | "sell",
  mint: string,
  amount: number | string,
  denominatedInSol: boolean,
  slippagePct = 10
): Promise<string> {
  let res: Response;
  try {
    res = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey,
        action,
        mint,
        denominatedInSol: denominatedInSol ? "true" : "false",
        amount,
        slippage: slippagePct,
        priorityFee: 0.0005,
        // "auto" lets PumpPortal detect where the liquidity actually lives:
        // the original bonding curve ("pump"), PumpSwap after the token
        // graduates ("pump-amm", the default destination since PumpSwap
        // launched in March 2025), or Raydium. Hardcoding "pump" here was
        // the root cause of most buy/sell failures: any token that had
        // already graduated has no bonding curve left to trade against, so
        // PumpPortal had nothing to build and this always came back empty —
        // right as Jupiter's route can *also* still be missing if the
        // migration is too fresh to be indexed yet, tripping both fallbacks
        // at once.
        pool: "auto",
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    throw new Error(`PumpPortal request failed (network/timeout): ${String(err)}`);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    let errorMsg = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      errorMsg = parsed.error || parsed.message || bodyText;
    } catch {
      // response wasn't JSON — use the raw text as-is
    }
    logger.warn({ status: res.status, errorMsg, mint }, "PumpPortal transaction build failed");
    throw new Error(`PumpPortal ${res.status}: ${(errorMsg || "request failed").slice(0, 150)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  if (!base64) throw new Error("PumpPortal returned an empty transaction");
  return base64;
}

// ── Core SOL buy execution ──────────────────────────────────────────────

interface SolBuyParams {
  walletAddress: string;
  encryptedPrivateKey: string;
  ca: string;
  lamports: number;
  slippageBps: number;
  jitoTipLamports: number;
}

interface SolBuyResult {
  txHash: string;
  outAmount: string;
}

async function executeSolBuy(params: SolBuyParams): Promise<SolBuyResult> {
  const { encryptedPrivateKey, ca, lamports, slippageBps, jitoTipLamports } = params;

  const privateKey = decrypt(encryptedPrivateKey);
  const { Keypair, VersionedTransaction } = await import("@solana/web3.js");
  const bs58 = await import("bs58");
  const kp = Keypair.fromSecretKey(bs58.default.decode(privateKey));
  const signerPubKey = kp.publicKey.toBase58();

  let swapTxBase64: string | null = null;
  let isPumpPortal = false;
  let jupiterFailReason = "";
  let pumpPortalFailReason = "";

  // 1. Try Jupiter first (covers anything with real DEX/AMM liquidity,
  //    including graduated Pump.fun tokens now trading on PumpSwap/Raydium)
  try {
    const quote = await getJupiterQuote(SOL_MINT, ca, lamports, slippageBps);
    swapTxBase64 = await buildJupiterSwapTx(quote, signerPubKey, ca, jitoTipLamports);
  } catch (jupErr) {
    jupiterFailReason = jupErr instanceof Error ? jupErr.message : String(jupErr);
    logger.info({ jupErr: jupiterFailReason, ca }, "Jupiter build failed — checking PumpPortal fallback");
  }

  // 2. Fallback to PumpPortal — pool "auto" covers the bonding curve,
  //    PumpSwap, and Raydium, so this now also catches tokens Jupiter
  //    hasn't indexed yet.
  if (!swapTxBase64) {
    const amountSol = lamports / 1e9;
    const slippagePct = Math.max(5, Math.min(50, slippageBps / 100));
    try {
      swapTxBase64 = await buildPumpPortalTx(signerPubKey, "buy", ca, amountSol, true, slippagePct);
      isPumpPortal = true;
    } catch (ppErr) {
      pumpPortalFailReason = ppErr instanceof Error ? ppErr.message : String(ppErr);
      logger.warn({ ppErr: pumpPortalFailReason, ca }, "PumpPortal fallback failed");
    }
  }

  if (!swapTxBase64) {
    throw new Error(
      `No route found on Jupiter or Pump.fun.\nJupiter: ${jupiterFailReason || "no route"}\nPumpPortal: ${pumpPortalFailReason || "no route"}`
    );
  }

  // Simulate if Jupiter transaction
  if (!isPumpPortal) {
    const sim = await simulateSolanaTx(swapTxBase64);
    if (!sim.success) throw new Error(`Simulation failed: ${sim.error}`);
  }

  const txBytes = Buffer.from(swapTxBase64, "base64");
  const vTx = VersionedTransaction.deserialize(txBytes);
  vTx.sign([kp]);
  const signedBase64 = Buffer.from(vTx.serialize()).toString("base64");

  const txHash = await sendSolanaTxDirect(signedBase64);
  if (!txHash) throw new Error("Transaction broadcast failed.");

  return { txHash, outAmount: String(lamports) };
}

// ── Core SOL sell execution ──────────────────────────────────────────────
// Extracted from executeSell so both the manual /sell flow and the
// automated TP/SL position monitor (positionMonitor.ts) share one path
// instead of two copies of the same quote/build/sign/send logic.

interface SolSellParams {
  walletAddress: string;
  encryptedPrivateKey: string;
  ca: string;
  percent: number;
  slippageBps: number;
  jitoTipLamports: number;
}

interface SolSellResult {
  txHash: string;
}

async function executeSolSell(params: SolSellParams): Promise<SolSellResult> {
  const { walletAddress, encryptedPrivateKey, ca, percent, slippageBps, jitoTipLamports } = params;

  const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
  const balRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "getTokenAccountsByOwner",
      params: [walletAddress, { mint: ca }, { encoding: "jsonParsed" }],
    }),
  });
  const balData = (await balRes.json()) as {
    result?: { value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[] };
  };
  const rawAmount = balData.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0";
  const sellAmount = Math.floor((parseInt(rawAmount, 10) * percent) / 100);
  if (sellAmount === 0) throw new Error("No token balance to sell");

  const privateKey = decrypt(encryptedPrivateKey);
  const { Keypair, VersionedTransaction } = await import("@solana/web3.js");
  const bs58 = await import("bs58");
  const kp = Keypair.fromSecretKey(bs58.default.decode(privateKey));
  const actualSignerPubKey = kp.publicKey.toBase58();

  let swapTxBase64: string | null = null;
  let jupiterFailReason = "";
  let pumpPortalFailReason = "";

  try {
    const quote = await getJupiterQuote(ca, SOL_MINT, sellAmount, slippageBps);
    swapTxBase64 = await buildJupiterSwapTx(quote, actualSignerPubKey, SOL_MINT, jitoTipLamports);
  } catch (jupErr) {
    jupiterFailReason = jupErr instanceof Error ? jupErr.message : String(jupErr);
    logger.info({ jupErr: jupiterFailReason, ca }, "Jupiter sell build failed — checking PumpPortal fallback");
  }

  if (!swapTxBase64) {
    try {
      // Sell by percentage of current holdings: PumpPortal accepts "N%" as
      // amount with denominatedInSol=false, and pool "auto" finds the token
      // wherever it now trades.
      swapTxBase64 = await buildPumpPortalTx(actualSignerPubKey, "sell", ca, `${percent}%`, false, 15);
    } catch (ppErr) {
      pumpPortalFailReason = ppErr instanceof Error ? ppErr.message : String(ppErr);
      logger.warn({ ppErr: pumpPortalFailReason, ca }, "PumpPortal sell fallback failed");
    }
  }

  if (!swapTxBase64) {
    throw new Error(
      `No route found on Jupiter or Pump.fun.\nJupiter: ${jupiterFailReason || "no route"}\nPumpPortal: ${pumpPortalFailReason || "no route"}`
    );
  }

  const txBytes = Buffer.from(swapTxBase64, "base64");
  const vTx = VersionedTransaction.deserialize(txBytes);
  vTx.sign([kp]);
  const signedBase64 = Buffer.from(vTx.serialize()).toString("base64");

  const txHash = await sendSolanaTxDirect(signedBase64);
  if (!txHash) throw new Error("Transaction broadcast failed.");

  return { txHash };
}

/**
 * Ctx-free sell entry point used by the automated position monitor (no
 * Telegram update to reply to — notifications go through queueMessage
 * instead). Looks up the wallet by id, sells `percent` of the token via
 * the same SOL sell path as the manual flow, and records a trade row.
 */
export async function sellPositionCore(
  walletId: number,
  ca: string,
  percent: number
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  try {
    const wallet = await db.query.walletsTable.findFirst({ where: eq(walletsTable.id, walletId) });
    if (!wallet) return { ok: false, error: "Wallet not found" };

    const config = await db.query.sniperConfigsTable.findFirst({
      where: eq(sniperConfigsTable.userId, wallet.userId),
    });
    const slippageBps = config?.slippageBps ?? 1000;
    const jitoTip = config?.jitoTipLamports ?? getJitoTipLamports();

    const result = await executeSolSell({
      walletAddress: wallet.address,
      encryptedPrivateKey: wallet.encryptedPrivateKey,
      ca,
      percent,
      slippageBps,
      jitoTipLamports: jitoTip,
    });

    await db.insert(tradesTable).values({
      userId: wallet.userId,
      chain: "SOL",
      tokenAddress: ca,
      tokenSymbol: "AUTO",
      tokenName: "AUTO",
      side: "SELL",
      amountIn: `${percent}%`,
      feeBps: PLATFORM_FEE_BPS,
      priceUsd: "0",
      status: "CONFIRMED",
      txHash: result.txHash,
    });

    if (percent === 100) {
      await db
        .update(activeSnipesTable)
        .set({ active: false })
        .where(and(eq(activeSnipesTable.userId, wallet.userId), eq(activeSnipesTable.tokenAddress, ca)));
    }

    return { ok: true, txHash: result.txHash };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function getSolBalanceLamports(address: string): Promise<number> {
  const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { result?: { value?: number } };
    return data.result?.value ?? 0;
  } catch {
    return 0;
  }
}

// ── Manual buy (ctx-based) ────────────────────────────────────────────────

async function executeBuy(ctx: Context, ca: string, amount: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Type /start first."); return; }

  const wallet = await pickTradingWallet(user.id, user.activeChain);
  if (!wallet) {
    await ctx.reply(
      "❌ No active wallet for this chain. Add one in 💼 Wallet Manager.",
      Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]])
    );
    return;
  }

  const detectedType = ca.startsWith("0x") ? "EVM" : "SOL";
  if (detectedType === "SOL" && user.activeChain !== "SOL") {
    await ctx.reply(
      `⚠️ This is a <b>Solana</b> token, but your active wallet is <b>${user.activeChain}</b>.\nSwitch to your SOL wallet in 💼 Wallet Manager, then try again.`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]]) }
    );
    return;
  }
  if (detectedType === "EVM" && user.activeChain === "SOL") {
    await ctx.reply(
      `⚠️ This is an <b>EVM</b> token, but your active wallet is <b>SOL</b>.\nSwitch to an ETH/BASE/BSC wallet in 💼 Wallet Manager, then try again.`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]]) }
    );
    return;
  }

  if (detectedType === "SOL") {
    const lamportsNeeded = Math.round(amount * 1e9) + 10_000_000;
    const balanceLamports = await getSolBalanceLamports(wallet.address);
    if (balanceLamports < lamportsNeeded) {
      const haveSol = (balanceLamports / 1e9).toFixed(4);
      const needSol = (lamportsNeeded / 1e9).toFixed(4);
      await ctx.reply(
        `⚠️ <b>Insufficient balance.</b>\nYour wallet has <b>${haveSol} SOL</b>, but this buy needs ~<b>${needSol} SOL</b> (including network fees).\n\n📥 Fund your wallet first:\n<code>${wallet.address}</code>`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]]) }
      );
      return;
    }
  }

  const config = await db.query.sniperConfigsTable.findFirst({
    where: eq(sniperConfigsTable.userId, user.id),
  });
  const slippageBps = config?.slippageBps ?? 1000;

  const pairs = await getPairsByToken(ca);
  const pair = pairs[0];
  const priceUsd = pair?.priceUsd ?? "0";
  const tokenSymbol = pair?.baseToken.symbol ?? "UNKNOWN";
  const tokenName = pair?.baseToken.name ?? "UNKNOWN";

  const [trade] = await db.insert(tradesTable).values({
    userId: user.id,
    chain: user.activeChain,
    tokenAddress: ca,
    tokenSymbol,
    tokenName,
    side: "BUY",
    amountIn: String(amount),
    feeBps: PLATFORM_FEE_BPS,
    priceUsd,
    status: "PENDING",
  }).returning();

  await ctx.reply(
    `⏳ <b>Buy Order Submitted</b>\n💰 Buying ${amount} ${user.activeChain} of <b>${tokenSymbol}</b>\n🔐 Submitting to the blockchain…`,
    { parse_mode: "HTML" }
  );

  try {
    let txHash: string | null = null;

    if (user.activeChain === "SOL") {
      const lamports = Math.round(amount * 1e9);
      const jitoTip = config?.jitoTipLamports ?? getJitoTipLamports();
      const result = await executeSolBuy({
        walletAddress: wallet.address,
        encryptedPrivateKey: wallet.encryptedPrivateKey,
        ca,
        lamports,
        slippageBps,
        jitoTipLamports: jitoTip,
      });
      txHash = result.txHash;
    } else {
      if (!process.env["ZEROX_API_KEY"]) {
        const dexUrl = `https://app.uniswap.org/#/swap?outputCurrency=${ca}`;
        await ctx.reply(
          `⚠️ <b>In-bot EVM swaps require a 0x API key.</b>\n\nTrade directly:\n<a href="${dexUrl}">🔗 Uniswap — ${ca.slice(0, 8)}…</a>`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        await db.update(tradesTable).set({ status: "FAILED" }).where(eq(tradesTable.id, trade!.id));
        return;
      }
      const amountWei = BigInt(Math.round(amount * 1e18)).toString();
      const { Wallet, JsonRpcProvider } = await import("ethers");
      const rpcMap: Record<string, string> = { ETH: "ETH_RPC_URL", BASE: "BASE_RPC_URL", BSC: "BSC_RPC_URL" };
      const rpcUrl = process.env[rpcMap[user.activeChain] ?? ""] ?? "";
      const provider = new JsonRpcProvider(rpcUrl);

      const balanceWei = await provider.getBalance(wallet.address);
      const neededWei = BigInt(amountWei) + BigInt(3_000_000_000_000_000);
      if (balanceWei < neededWei) {
        const haveNative = (Number(balanceWei) / 1e18).toFixed(5);
        const needNative = (Number(neededWei) / 1e18).toFixed(5);
        await ctx.reply(
          `⚠️ <b>Insufficient balance.</b>\nYour wallet has <b>${haveNative} ${user.activeChain}</b>, but this buy needs ~<b>${needNative} ${user.activeChain}</b> (including gas).\n\n📥 Fund your wallet first:\n<code>${wallet.address}</code>`,
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]]) }
        );
        await db.update(tradesTable).set({ status: "FAILED" }).where(eq(tradesTable.id, trade!.id));
        return;
      }

      const swap = await get1inchSwap(user.activeChain, EVM_NATIVE, ca, amountWei, wallet.address, slippageBps / 100);
      if (!swap) throw new Error("1inch quote failed");
      const simResult = await simulateEvmTx(wallet.address, swap.to, swap.data, user.activeChain);
      if (!simResult.success) throw new Error(`EVM simulation failed: ${simResult.error}`);
      const pk = decrypt(wallet.encryptedPrivateKey);
      const evmWallet = new Wallet(pk, provider);
      const tx = await evmWallet.sendTransaction({
        to: swap.to, data: swap.data, value: BigInt(swap.value),
        gasLimit: BigInt(Math.round(swap.gas * 1.2)),
      });
      txHash = tx.hash;
    }

    await db.update(tradesTable)
      .set({ status: "CONFIRMED", txHash: txHash ?? undefined })
      .where(eq(tradesTable.id, trade!.id));
    void markWalletUsed(wallet.id);

    // Auto TP/SL: only for SOL (the only chain the position monitor can
    // currently sell for), and only when we actually have a real entry
    // price to measure targets against.
    let exitLine = "";
    let autoExitButton: ReturnType<typeof Markup.button.callback> | null = null;
    const entryPriceNum = parseFloat(priceUsd);
    if (user.activeChain === "SOL" && entryPriceNum > 0) {
      const ageMinutes = pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60_000 : undefined;
      const input: ScoreInput = {
        liquidityUsd: pair?.liquidity?.usd ?? 0,
        volume24hUsd: pair?.volume?.h24 ?? 0,
        marketCapUsd: pair?.marketCap ?? pair?.fdv ?? 0,
        buys24h: pair?.txns?.h24?.buys,
        sells24h: pair?.txns?.h24?.sells,
        priceChange5m: pair?.priceChange?.m5,
        priceChange1h: pair?.priceChange?.h1,
        priceChange24h: pair?.priceChange?.h24,
        ageMinutes,
        securityRisks: 0, // not re-checked here; this only shapes the exit %, not the buy decision
      };
      const { exitPlan } = scoreToken(input);

      const [position] = await db.insert(positionsTable).values({
        userId: user.id,
        telegramId,
        walletId: wallet.id,
        chain: "SOL",
        tokenAddress: ca,
        tokenSymbol,
        entryPriceUsd: priceUsd,
        tp1Pct: exitPlan.tp1,
        tp2Pct: exitPlan.tp2,
        slPct: exitPlan.sl,
        trailingStopEnabled: exitPlan.trailingStop,
      }).returning();

      exitLine = `🎯 Auto-Exit armed: TP1 +${exitPlan.tp1}% | TP2 +${exitPlan.tp2}% | SL ${exitPlan.sl}%${exitPlan.trailingStop ? " | Trailing stop ON" : ""}\n`;
      if (position) {
        autoExitButton = Markup.button.callback("🔕 Disable Auto-Exit", `autoexit_off:${position.id}`);
      }
    }

    await ctx.reply(
      [
        `✅ <b>Buy Confirmed!</b>`,
        `🪙 <b>${tokenName}</b> [${tokenSymbol}] — ${user.activeChain}`,
        `💰 Spent: <b>${amount} ${user.activeChain}</b>`,
        `💲 Price at entry: <b>${entryPriceNum.toFixed(8)}</b>`,
        `🔗 TX: <code>${txHash}</code>`,
        `—`,
        exitLine,
        `Use the buttons below to sell your position.`,
      ].filter(Boolean).join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("📤 Sell 25%", `sell:${ca}:25`),
            Markup.button.callback("📤 Sell 50%", `sell:${ca}:50`),
          ],
          [
            Markup.button.callback("📤 Sell 75%", `sell:${ca}:75`),
            Markup.button.callback("📤 Sell 100%", `sell:${ca}:100`),
          ],
          [
            Markup.button.callback("📊 Live Price", `price:${ca}`),
            Markup.button.callback("🔍 Analyze Token", `analyze:${ca}`),
          ],
          ...(autoExitButton ? [[autoExitButton]] : []),
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Buy execution failed");
    await db.update(tradesTable).set({ status: "FAILED" }).where(eq(tradesTable.id, trade!.id));
    await ctx.reply(
      `❌ <b>Buy Failed</b>\n${String(err).slice(0, 200)}`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]]) }
    );
  }
}

/** Disable auto-exit for one position — called from the "🔕 Disable
 *  Auto-Exit" button on the buy-confirmed message. Verifies the position
 *  belongs to whoever tapped the button before touching it. */
export async function handleDisableAutoExit(ctx: Context, positionIdStr: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const positionId = parseInt(positionIdStr, 10);
  if (isNaN(positionId)) return;

  const position = await db.query.positionsTable.findFirst({ where: eq(positionsTable.id, positionId) });
  if (!position || position.telegramId !== telegramId) {
    await ctx.reply("❌ Position not found.");
    return;
  }

  await db.update(positionsTable).set({ autoExitEnabled: false, updatedAt: new Date() }).where(eq(positionsTable.id, positionId));
  await ctx.reply(`🔕 Auto-exit disabled for ${position.tokenSymbol}. You're back to manual sells only for this position.`);
}

// ── Auto-snipe buy ───────────────────────────────────────────────────────

export interface AutoSnipeParams {
  dbUserId: number;
  telegramId: number;
  ca: string;
  tokenSymbol: string;
  tokenName: string;
  priceUsd: string;
  liquidityUsd: number;
}

function escapeSnipeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function triggerAutoSnipeBuy(params: AutoSnipeParams): Promise<void> {
  const { dbUserId, telegramId, ca, tokenSymbol, tokenName, priceUsd, liquidityUsd } = params;
  const bot = getBotRef();
  if (!bot) return;

  const symbolSafe = escapeSnipeHtml(tokenSymbol);
  const nameSafe = escapeSnipeHtml(tokenName);
  const entryPrice = Number(priceUsd) > 0 ? `${Number(priceUsd).toFixed(8)}` : "— (fresh mint)";
  const liqLabel = liquidityUsd > 0 ? `${(liquidityUsd / 1_000).toFixed(1)}K` : "— (fresh mint)";

  const send = (msg: string, keyboard?: { text: string; callback_data: string }[][]) =>
    bot.telegram
      .sendMessage(telegramId, msg, {
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      })
      .catch(() => undefined);

  try {
    const wallet = await pickTradingWallet(dbUserId, "SOL");
    if (!wallet) {
      await send(`⚡ <b>Auto-Snipe skipped</b> — no active SOL wallet.\n🪙 Token: <b>${symbolSafe}</b> <code>${ca}</code>`);
      return;
    }

    const config = await db.query.sniperConfigsTable.findFirst({
      where: eq(sniperConfigsTable.userId, dbUserId),
    });

    const buyAmount = parseFloat(config?.autoBuyAmountNative ?? "0.1");
    const slippageBps = config?.slippageBps ?? 1500;
    const jitoTip = config?.jitoTipLamports ?? getJitoTipLamports();

    const minLiq = parseFloat(config?.minLiquidityUsd ?? "0");
    if (minLiq > 0 && liquidityUsd < minLiq) {
      logger.info({ ca, liquidityUsd, minLiq }, "Auto-snipe skipped: liquidity below filter");
      return;
    }

    const lamportsNeeded = Math.round(buyAmount * 1e9) + 10_000_000;
    const balanceLamports = await getSolBalanceLamports(wallet.address);
    if (balanceLamports < lamportsNeeded) {
      const haveSol = (balanceLamports / 1e9).toFixed(4);
      const needSol = (lamportsNeeded / 1e9).toFixed(4);
      await send(
        [
          `⚡ <b>Auto-Snipe Skipped — Insufficient Balance</b>`,
          `🪙 <b>${nameSafe}</b> (${symbolSafe})`,
          `📍 CA: <code>${ca}</code>`,
          `💰 Wallet has: <b>${haveSol} SOL</b>`,
          `📉 Needed: <b>~${needSol} SOL</b> (your configured buy: ${buyAmount} SOL + fees)`,
          ``,
          `Fund your SOL wallet so auto-snipe can execute:`,
          `<code>${wallet.address}</code>`,
        ].join("\n")
      );
      return;
    }

    await send(
      [
        `⚡ <b>Auto-Snipe Triggered!</b>`,
        `━━━━━━━━━━━━━━━━━`,
        `🪙 <b>${nameSafe}</b> (${symbolSafe})`,
        `📍 CA: <code>${ca}</code>`,
        `💲 Price: ${entryPrice}`,
        `💧 Liquidity: ${liqLabel}`,
        `━━━━━━━━━━━━━━━━━`,
        `💰 Buying: <b>${buyAmount} SOL</b> | 📉 Slippage: ${(slippageBps / 100).toFixed(1)}%`,
        `🚀 Sending via Jito bundle…`,
      ].join("\n")
    );

    const [trade] = await db.insert(tradesTable).values({
      userId: dbUserId,
      chain: "SOL",
      tokenAddress: ca,
      tokenSymbol,
      tokenName,
      side: "BUY",
      amountIn: String(buyAmount),
      feeBps: PLATFORM_FEE_BPS,
      priceUsd,
      status: "PENDING",
    }).returning();

    const lamports = Math.round(buyAmount * 1e9);
    const result = await executeSolBuy({
      walletAddress: wallet.address,
      encryptedPrivateKey: wallet.encryptedPrivateKey,
      ca,
      lamports,
      slippageBps,
      jitoTipLamports: jitoTip,
    });

    await db.update(tradesTable)
      .set({ status: "CONFIRMED", txHash: result.txHash })
      .where(eq(tradesTable.id, trade!.id));
    void markWalletUsed(wallet.id);

    await send(
      [
        `✅ <b>Auto-Snipe Confirmed!</b>`,
        `━━━━━━━━━━━━━━━━━`,
        `🪙 <b>${nameSafe}</b> (${symbolSafe})`,
        `📍 CA: <code>${ca}</code>`,
        `💰 Spent: <b>${buyAmount} SOL</b>`,
        `💲 Entry: ${entryPrice}`,
        `🔗 TX: <code>${result.txHash}</code>`,
        ``,
        `Manage your new position below 👇`,
      ].join("\n"),
      [
        [
          { text: "📊 Live Price", callback_data: `price:${ca}` },
          { text: "🔍 Analyze", callback_data: `analyze:${ca}` },
        ],
        [
          { text: "📤 Sell 25%", callback_data: `sell:${ca}:25` },
          { text: "📤 Sell 50%", callback_data: `sell:${ca}:50` },
        ],
        [
          { text: "📤 Sell 75%", callback_data: `sell:${ca}:75` },
          { text: "📤 Sell 100%", callback_data: `sell:${ca}:100` },
        ],
      ]
    );

    logger.info({ ca, txHash: result.txHash, telegramId }, "Auto-snipe executed");
  } catch (err) {
    logger.error({ err, ca, telegramId }, "Auto-snipe buy failed");
    await send(
      [
        `❌ <b>Auto-Snipe Failed</b>`,
        `🪙 <b>${nameSafe}</b> (${symbolSafe})`,
        `📍 CA: <code>${ca}</code>`,
        `⚠️ ${escapeSnipeHtml(String(err).slice(0, 200))}`,
      ].join("\n"),
      [[{ text: "🔍 Analyze Token", callback_data: `analyze:${ca}` }]]
    );
  }
}

// ── Sell (ctx-based) ──────────────────────────────────────────────────────

async function executeSell(ctx: Context, ca: string, percent: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found."); return; }

  const wallet = await db.query.walletsTable.findFirst({
    where: and(
      eq(walletsTable.userId, user.id),
      eq(walletsTable.chain, user.activeChain),
      eq(walletsTable.isActive, true)
    ),
  });
  if (!wallet) { await ctx.reply("❌ No active wallet. Add one in 💼 Wallet Manager."); return; }

  const pairs = await getPairsByToken(ca);
  const pair = pairs[0];
  const priceUsd = pair?.priceUsd ?? "0";
  const tokenSymbol = pair?.baseToken.symbol ?? "UNKNOWN";
  const tokenName = pair?.baseToken.name ?? "UNKNOWN";

  await ctx.reply(`⏳ <b>Sell Order: ${percent}% of ${tokenSymbol}</b>\n🔐 Preparing transaction…`, { parse_mode: "HTML" });

  const [trade] = await db.insert(tradesTable).values({
    userId: user.id,
    chain: user.activeChain,
    tokenAddress: ca,
    tokenSymbol,
    tokenName,
    side: "SELL",
    amountIn: `${percent}%`,
    feeBps: PLATFORM_FEE_BPS,
    priceUsd,
    status: "PENDING",
  }).returning();

  try {
    let txHash: string | null = null;

    if (user.activeChain === "SOL") {
      const config = await db.query.sniperConfigsTable.findFirst({
        where: eq(sniperConfigsTable.userId, user.id),
      });
      const slippageBps = config?.slippageBps ?? 1000;
      const jitoTip = config?.jitoTipLamports ?? getJitoTipLamports();

      const result = await executeSolSell({
        walletAddress: wallet.address,
        encryptedPrivateKey: wallet.encryptedPrivateKey,
        ca,
        percent,
        slippageBps,
        jitoTipLamports: jitoTip,
      });
      txHash = result.txHash;

      await db.update(tradesTable)
        .set({ status: "CONFIRMED", txHash, amountOut: `${percent}%` })
        .where(eq(tradesTable.id, trade!.id));

      if (percent === 100) {
        await db
          .update(activeSnipesTable)
          .set({ active: false })
          .where(and(eq(activeSnipesTable.userId, user.id), eq(activeSnipesTable.tokenAddress, ca)));
      }
    } else {
      await ctx.reply("⚠️ EVM sell: use a DEX frontend (Uniswap/PancakeSwap) until native EVM sell is available.");
      await db.update(tradesTable).set({ status: "FAILED" }).where(eq(tradesTable.id, trade!.id));
      return;
    }

    await ctx.reply(
      [`✅ <b>Sell Confirmed!</b>`, `🪙 ${tokenSymbol} [${user.activeChain}]`,
       `📤 Sold: ${percent}% position`, `🔗 TX: <code>${txHash}</code>`].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📊 PnL Center", "pnl_center")],
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Sell execution failed");
    await db.update(tradesTable).set({ status: "FAILED" }).where(eq(tradesTable.id, trade!.id));
    await ctx.reply(
      `❌ <b>Sell Failed</b>\n${String(err).slice(0, 200)}`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]]) }
    );
  }
}

// ── Live Price Tracker ────────────────────────────────────────────────────

function fmtPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return "0";
  return p >= 1 ? p.toFixed(4) : p.toFixed(8);
}

async function editOrReply(
  ctx: Context,
  text: string,
  extra: Parameters<Context["reply"]>[1]
): Promise<void> {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, extra as Parameters<Context["editMessageText"]>[1]);
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
    }
  }
  await ctx.reply(text, extra);
}

export async function handleLivePrice(ctx: Context, ca: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Type /start first."); return; }

  let current = 0;
  let tokenSymbol = "?";
  let tokenName = "Unknown";
  let found = false;

  const pairs = await getPairsByToken(ca);
  const pair = pairs[0];
  if (pair) {
    current = parseFloat(pair.priceUsd ?? "0");
    tokenSymbol = pair.baseToken.symbol ?? "?";
    tokenName = pair.baseToken.name ?? "Unknown";
    found = true;
  } else {
    const caType = detectCAType(ca);
    const geckoChain = caType === "SOL" ? "SOL" : user.activeChain;
    const geckoPool = await searchGeckoToken(ca, geckoChain);
    if (geckoPool) {
      current = Number(geckoPool.priceUsd ?? 0);
      tokenSymbol = geckoPool.baseTokenSymbol;
      tokenName = geckoPool.baseTokenName;
      found = true;
    } else if (caType === "SOL") {
      const pumpToken = await getPumpFunToken(ca);
      if (pumpToken) {
        const solPrice = Number(await getNativeTokenPrice("SOL").catch(() => 0));
        current = pumpToken.priceNative * solPrice;
        tokenSymbol = pumpToken.symbol;
        tokenName = pumpToken.name;
        found = true;
      }
    }
  }

  if (!found) {
    await editOrReply(ctx, `❌ No live market data found for:\n<code>${ca}</code>`, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("🔄 Retry", `price:${ca}`),
          Markup.button.callback("🔍 Analyze", `analyze:${ca}`),
        ],
        [Markup.button.callback("⬅️ My Trades", "my_trades")],
      ]),
    });
    return;
  }

  const lastBuy = await db.query.tradesTable.findFirst({
    where: and(
      eq(tradesTable.userId, user.id),
      eq(tradesTable.tokenAddress, ca),
      eq(tradesTable.side, "BUY"),
      eq(tradesTable.status, "CONFIRMED")
    ),
    orderBy: [desc(tradesTable.createdAt)],
  });

  const lines = [
    `📊 <b>Live Price — ${tokenSymbol}</b>`,
    `—`,
    `🪙 <b>${tokenName}</b> [${tokenSymbol}]`,
    `📬 <code>${ca}</code>`,
    `—`,
    `💲 <b>Current Price:</b> $${fmtPrice(current)}`,
  ];

  if (lastBuy) {
    const entry = parseFloat(lastBuy.priceUsd);
    lines.push(`🎯 <b>Your Entry:</b> $${fmtPrice(entry)}`);
    if (entry > 0 && current > 0) {
      const pct = ((current - entry) / entry) * 100;
      lines.push(
        `${pct >= 0 ? "🟢" : "🔴"} <b>P&L:</b> ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% from entry`
      );
    }
    lines.push(`💰 <b>Position:</b> ${lastBuy.amountIn} ${lastBuy.chain} spent`);
  } else {
    lines.push(`ℹ️ No confirmed buys of this token yet.`);
  }

  lines.push(`—`, `🕐 Updated: ${new Date().toISOString().slice(11, 19)} UTC`);

  const sellRows = lastBuy
    ? [[
        Markup.button.callback("📤 25%", `sell:${ca}:25`),
        Markup.button.callback("📤 50%", `sell:${ca}:50`),
        Markup.button.callback("📤 75%", `sell:${ca}:75`),
        Markup.button.callback("📤 100%", `sell:${ca}:100`),
      ]]
    : [];

  await editOrReply(ctx, lines.join("\n"), {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("🔄 Refresh", `price:${ca}`),
        Markup.button.callback("🔍 Analyze", `analyze:${ca}`),
      ],
      ...sellRows,
      [Markup.button.callback("⬅️ My Trades", "my_trades")],
    ]),
  });
}

