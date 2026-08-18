/**
 * Trade execution handler.
 * SOL: Jupiter V6 → simulate → Jito bundle
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
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { decrypt } from "../../lib/encryption";
import { getBotRef } from "../../lib/botRef";
import { getJupiterQuote, buildJupiterSwapTx, simulateSolanaTx } from "../../services/jupiter";
import { sendJitoBundle, getJitoTipLamports } from "../../services/jito";
import { get1inchSwap } from "../../services/evmSwap";
import { simulateEvmTx } from "../../services/flashbots";
import { getPairsByToken } from "../../services/dexscreener";
import { pickTradingWallet, markWalletUsed } from "../../services/walletRotation";
import { searchGeckoToken } from "../../services/geckoTerminal";
import { getPumpFunToken } from "../../services/pumpfunApi";
import { getNativeTokenPrice } from "../../services/chainPrice";
import { detectCAType } from "./caAnalysis";
import { logger } from "../../lib/logger";
import { registerPendingClearer } from "../../lib/pendingFlows";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const EVM_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const PLATFORM_FEE_BPS = 0;

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

  // Keypair derivation first ensures userPublicKey matches the signer keypair
  const privateKey = decrypt(encryptedPrivateKey);
  const { Keypair, VersionedTransaction } = await import("@solana/web3.js");
  const bs58 = await import("bs58");
  const kp = Keypair.fromSecretKey(bs58.default.decode(privateKey));
  const actualSignerPubKey = kp.publicKey.toBase58();

  const quote = await getJupiterQuote(SOL_MINT, ca, lamports, slippageBps);
  if (!quote) throw new Error("Jupiter quote failed — token may have no liquidity");

  const swapTx = await buildJupiterSwapTx(quote, actualSignerPubKey, ca, jitoTipLamports);

  const sim = await simulateSolanaTx(swapTx);
  if (!sim.success) throw new Error(`Simulation failed: ${sim.error}`);

  const txBytes = Buffer.from(swapTx, "base64");
  const vTx = VersionedTransaction.deserialize(txBytes);
  vTx.sign([kp]);
  const signedBase64 = Buffer.from(vTx.serialize()).toString("base64");

  const txHash = await sendJitoBundle([signedBase64]);
  if (!txHash) throw new Error("Jito bundle rejected");

  return { txHash, outAmount: quote.outAmount };
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

    await ctx.reply(
      [
        `✅ <b>Buy Confirmed!</b>`,
        `🪙 <b>${tokenName}</b> [${tokenSymbol}] — ${user.activeChain}`,
        `💰 Spent: <b>${amount} ${user.activeChain}</b>`,
        `💲 Price at entry: <b>${parseFloat(priceUsd).toFixed(8)}</b>`,
        `🔗 TX: <code>${txHash}</code>`,
        `—`,
        `Use the buttons below to sell your position.`,
      ].join("\n"),
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

export async function executeSell(ctx: Context, ca: string, percent: number): Promise<void> {
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
      const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
      const balRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTokenAccountsByOwner",
          params: [wallet.address, { mint: ca }, { encoding: "jsonParsed" }],
        }),
      });
      const balData = await balRes.json() as {
        result?: { value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[] };
      };
      const rawAmount = balData.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0";
      const sellAmount = Math.floor(parseInt(rawAmount, 10) * percent / 100);
      if (sellAmount === 0) throw new Error("No token balance to sell");

      const config = await db.query.sniperConfigsTable.findFirst({
        where: eq(sniperConfigsTable.userId, user.id),
      });
      const slippageBps = config?.slippageBps ?? 1000;
      const jitoTip = config?.jitoTipLamports ?? getJitoTipLamports();

      const quote = await getJupiterQuote(ca, SOL_MINT, sellAmount, slippageBps);
      if (!quote) throw new Error("Jupiter quote failed");

      const privateKey = decrypt(wallet.encryptedPrivateKey);
      const { Keypair, VersionedTransaction } = await import("@solana/web3.js");
      const bs58 = await import("bs58");
      const kp = Keypair.fromSecretKey(bs58.default.decode(privateKey));
      const actualSignerPubKey = kp.publicKey.toBase58();

      const swapTx = await buildJupiterSwapTx(quote, actualSignerPubKey, SOL_MINT, jitoTip);

      const sim = await simulateSolanaTx(swapTx);
      if (!sim.success) throw new Error(`Simulation failed: ${sim.error}`);

      const txBytes = Buffer.from(swapTx, "base64");
      const vTx = VersionedTransaction.deserialize(txBytes);
      vTx.sign([kp]);
      const signedBase64 = Buffer.from(vTx.serialize()).toString("base64");

      txHash = await sendJitoBundle([signedBase64]);
      if (!txHash) throw new Error("Jito bundle rejected");

      const solOut = parseFloat(quote.outAmount) / 1e9;
      await db.update(tradesTable)
        .set({ status: "CONFIRMED", txHash, amountOut: String(solOut) })
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

