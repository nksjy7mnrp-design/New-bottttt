/**
 * CA Analysis — triggered by text input or inline "analyze:" callback.
 *
 * EVM chain is NEVER guessed from the user's active wallet — a 0x address
 * looks identical on every EVM chain, so we resolve the real chain from
 * whichever data source actually finds the token (DexScreener's chainId,
 * GeckoTerminal's network, or on-chain bytecode presence), trying
 * ETH/BASE/BSC in parallel. This means pasting any CA works regardless of
 * which chain the user currently has selected.
 *
 * Waterfall (SOL):  DexScreener → GeckoTerminal → PumpFun bonding curve
 *                    → generic on-chain metadata (any SPL token) → not found
 * Waterfall (EVM):  DexScreener (all chains) → GeckoTerminal (ETH/BASE/BSC
 *                    in parallel) → on-chain bytecode+ERC20 read (ETH/BASE/BSC
 *                    in parallel) → not found
 *
 * Message format includes an auto-generated Score/Signal/Potential block
 * (see ../../services/tokenScore.ts) — a transparent formula built from
 * real liquidity/volume/momentum/security data, not a third-party opinion.
 *
 * Every result card also gets: 📊 Track PnL (live price + entry P&L),
 * 📈 Chart (external link, when a pair/pool/pump.fun page exists), and
 * 🔍 RugCheck (re-runs just the security scan standalone).
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { getPairsByToken, type TokenPair } from "../../services/dexscreener";
import { searchGeckoToken, type GeckoPool } from "../../services/geckoTerminal";
import {
  getPumpFunToken,
  getSolTokenOnchainMetadata,
  type PumpFunToken,
} from "../../services/pumpfunApi";
import { resolveEvmTokenOnchain, type OnchainEvmToken } from "../../services/evmOnchain";
import { getNativeTokenPrice } from "../../services/chainPrice";
import { checkEvmToken, checkSolanaToken } from "../../services/goplus";
import { scoreToken, formatScoreBlock, type ScoreInput } from "../../services/tokenScore";
import { db } from "@workspace/db";
import { usersTable, signalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
// Base58 Solana: 32-44 chars to catch PumpFun mints too
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Different sources spell chain names differently — normalize to our codes.
const DEXSCREENER_CHAIN_MAP: Record<string, "ETH" | "BASE" | "BSC"> = {
  ethereum: "ETH",
  base: "BASE",
  bsc: "BSC",
};
const GECKO_CHAIN_MAP: Record<string, "ETH" | "BASE" | "BSC"> = {
  eth: "ETH",
  base: "BASE",
  bsc: "BSC",
};

export function detectCAType(text: string): "EVM" | "SOL" | null {
  const trimmed = text.trim();
  if (EVM_RE.test(trimmed)) return "EVM";
  if (SOL_RE.test(trimmed)) return "SOL";
  return null;
}

export type EvmSecurity = Awaited<ReturnType<typeof checkEvmToken>>;
export type SolSecurity = Awaited<ReturnType<typeof checkSolanaToken>>;

export function countSecurityRisks(caType: "EVM" | "SOL", security: EvmSecurity | SolSecurity): number {
  if (caType === "EVM") {
    const s = security as EvmSecurity;
    return (
      (s.isHoneypot ? 1 : 0) +
      (s.isMintable ? 1 : 0) +
      (s.isBlacklisted ? 1 : 0) +
      (s.buyTax > 10 ? 1 : 0) +
      (s.sellTax > 10 ? 1 : 0)
    );
  }
  const s = security as SolSecurity;
  return (s.hasMintAuthority ? 1 : 0) + (s.hasFreezeAuthority ? 1 : 0) + (s.isBlacklisted ? 1 : 0);
}

export function securityLinesFor(caType: "EVM" | "SOL", security: EvmSecurity | SolSecurity): string[] {
  if (caType === "EVM") {
    const s = security as EvmSecurity;
    return [
      `🕵️ <b>Security (GoPlus)</b>`,
      `  🍯 Honeypot: <b>${s.isHoneypot ? "⚠️ YES" : "✅ NO"}</b>`,
      `  💸 Buy Tax: <b>${s.buyTax.toFixed(1)}%</b> | Sell Tax: <b>${s.sellTax.toFixed(1)}%</b>`,
      `  🖨 Mintable: <b>${s.isMintable ? "⚠️ YES" : "✅ NO"}</b>`,
      `  🚫 Blacklist: <b>${s.isBlacklisted ? "⚠️ YES" : "✅ NO"}</b>`,
    ];
  }
  const s = security as SolSecurity;
  return [
    `🕵️ <b>Security (GoPlus)</b>`,
    `  🖨 Mint Authority: <b>${s.hasMintAuthority ? "⚠️ ACTIVE" : "✅ REVOKED"}</b>`,
    `  🧊 Freeze Authority: <b>${s.hasFreezeAuthority ? "⚠️ ACTIVE" : "✅ REVOKED"}</b>`,
    `  🚫 Blacklist: <b>${s.isBlacklisted ? "⚠️ YES" : "✅ NO"}</b>`,
  ];
}

function sign(n?: number): string {
  if (n === undefined || n === null) return "0.00";
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtAge(ageMinutes?: number): string {
  if (ageMinutes === undefined) return "N/A";
  if (ageMinutes < 60) return `${Math.round(ageMinutes)} min`;
  if (ageMinutes < 1440) return `${(ageMinutes / 60).toFixed(1)} hr`;
  return `${(ageMinutes / 1440).toFixed(1)} d`;
}

interface ExtraButtonsOpts {
  chartUrl?: string;
  /** Encoded as "SOL::<ca>" or "EVM:<CHAIN>:<ca>" — used by the rugcheck: callback. */
  rugcheckTarget?: string;
}

const tradeButtonsFor = (ca: string, opts: ExtraButtonsOpts = {}) => {
  const utilityRow: (ReturnType<typeof Markup.button.callback> | ReturnType<typeof Markup.button.url>)[] = [
    Markup.button.callback("📊 Track PnL", `price:${ca}`),
  ];
  if (opts.chartUrl) utilityRow.push(Markup.button.url("📈 Chart", opts.chartUrl));
  if (opts.rugcheckTarget) {
    utilityRow.push(Markup.button.callback("🔍 RugCheck", `rugcheck:${opts.rugcheckTarget}`));
  }

    const rows: (ReturnType<typeof Markup.button.callback> | ReturnType<typeof Markup.button.url>)[][] = [
    [
      Markup.button.callback("💰 Buy 0.1", `buy:${ca}:0.1`),
      Markup.button.callback("💰 Buy 0.5", `buy:${ca}:0.5`),
      Markup.button.callback("💰 Buy Custom", `buy_custom:${ca}`),
    ],
  ];
  if (opts.rugcheckTarget) {
    rows.push([Markup.button.callback("🎯 Snipe", `snipe_confirm:${opts.rugcheckTarget}`)]);
  }
  rows.push(
    [
      Markup.button.callback("📤 Sell 50%", `sell:${ca}:50`),
      Markup.button.callback("📤 Sell 100%", `sell:${ca}:100`),
    ],
    utilityRow,
    [Markup.button.callback("⬅️ Dashboard", "dashboard")]
  );
  return rows;
};

/** Build the full scored card for a DexScreener pair. */
function buildDexScreenerCard(pair: TokenPair, securityLines: string[], securityRisks: number): string {
  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const volume24hUsd = pair.volume?.h24 ?? 0;
  const marketCapUsd = pair.marketCap ?? pair.fdv ?? 0;
  const buys24h = pair.txns?.h24?.buys ?? 0;
  const sells24h = pair.txns?.h24?.sells ?? 0;
  const ageMinutes = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60_000 : undefined;

  const input: ScoreInput = {
    liquidityUsd,
    volume24hUsd,
    marketCapUsd,
    buys24h,
    sells24h,
    priceChange5m: pair.priceChange?.m5,
    priceChange1h: pair.priceChange?.h1,
    priceChange24h: pair.priceChange?.h24,
    ageMinutes,
    securityRisks,
  };
  const result = scoreToken(input);

  return [
    `🚀 <b>${pair.baseToken.name}</b> (<code>${pair.baseToken.symbol}</code>)`,
    `🔗 ${pair.dexId} on ${pair.chainId}`,
    `—`,
    formatScoreBlock(result),
    `—`,
    `💲 Price  <b>$${Number(pair.priceUsd ?? 0).toFixed(8)}</b>`,
    `🏦 Market Cap  ${fmtUsd(marketCapUsd)}`,
    `💧 Liquidity  ${fmtUsd(liquidityUsd)}`,
    `📊 Vol 24h  ${fmtUsd(volume24hUsd)}`,
    `🔄 Buys ${buys24h} | Sells ${sells24h}`,
    `⏱ Age  ${fmtAge(ageMinutes)}`,
    `📈 5m: ${sign(pair.priceChange?.m5)}% | 1h: ${sign(pair.priceChange?.h1)}% | 24h: ${sign(pair.priceChange?.h24)}%`,
    `—`,
    `📍 CA: <code>${pair.baseToken.address}</code>`,
    `—`,
    ...securityLines,
  ].join("\n");
}

/** Build the full scored card for a GeckoTerminal pool (pre-DexScreener listing). */
function buildGeckoCard(pool: GeckoPool, securityLines: string[], securityRisks: number): string {
  const liquidityUsd = pool.liquidityUsd ?? 0;
  const volume24hUsd = pool.volumeUsd24h ?? 0;
  const marketCapUsd = pool.marketCapUsd ?? pool.fdvUsd ?? 0;
  const ageMinutes = pool.poolCreatedAt ? (Date.now() - pool.poolCreatedAt) / 60_000 : undefined;

  const input: ScoreInput = {
    liquidityUsd,
    volume24hUsd,
    marketCapUsd,
    buys24h: pool.buys24h,
    sells24h: pool.sells24h,
    priceChange5m: pool.priceChange5m,
    priceChange1h: pool.priceChange1h,
    priceChange24h: pool.priceChange24h,
    ageMinutes,
    securityRisks,
  };
  const result = scoreToken(input);

  return [
    `🚀 <b>${pool.baseTokenName}</b> (<code>${pool.baseTokenSymbol}</code>)`,
    `🔗 ${pool.dexId} on ${pool.network}`,
    `<i>📡 Source: GeckoTerminal (not on DexScreener yet)</i>`,
    `—`,
    formatScoreBlock(result),
    `—`,
    `💲 Price  <b>$${Number(pool.priceUsd ?? 0).toFixed(8)}</b>`,
    `🏦 Market Cap  ${fmtUsd(marketCapUsd)}`,
    `💧 Liquidity  ${fmtUsd(liquidityUsd)}`,
    `📊 Vol 24h  ${fmtUsd(volume24hUsd)}`,
    `🔄 Buys ${pool.buys24h ?? "N/A"} | Sells ${pool.sells24h ?? "N/A"}`,
    `⏱ Age  ${fmtAge(ageMinutes)}`,
    `📈 5m: ${sign(pool.priceChange5m)}% | 1h: ${sign(pool.priceChange1h)}% | 24h: ${sign(pool.priceChange24h)}%`,
    `—`,
    `📍 CA: <code>${pool.baseTokenAddress}</code>`,
    `—`,
    ...securityLines,
  ].join("\n");
}

/** Build the full scored card for a pre-graduation PumpFun token (on-chain data only). */
function buildPumpFunCard(
  token: PumpFunToken,
  solPriceUsd: number,
  securityLines: string[],
  securityRisks: number
): string {
  const priceUsd = token.priceNative * solPriceUsd;
  const marketCapUsd = priceUsd * token.totalSupply;
  const liquidityUsd = (token.virtualSolReserves / 1e9) * solPriceUsd * 2; // both sides of the curve

  const input: ScoreInput = {
    liquidityUsd,
    volume24hUsd: 0, // not available from on-chain bonding-curve state alone
    marketCapUsd,
    securityRisks,
  };
  const result = scoreToken(input);

  return [
    `🚀 <b>${token.name}</b> (<code>${token.symbol}</code>)`,
    `🌱 PumpFun ${token.complete ? "✅ Graduated" : "PRE-BOND"}`,
    `<i>🚀 Source: PumpFun on-chain (bonding curve)</i>`,
    `—`,
    formatScoreBlock(result),
    `—`,
    `💲 Price  <b>~$${priceUsd.toFixed(8)}</b> (${token.priceNative.toFixed(6)} SOL)`,
    `🏦 Market Cap  ${marketCapUsd > 0 ? fmtUsd(marketCapUsd) : "N/A"}`,
    `💧 Liquidity  ~${fmtUsd(liquidityUsd)}`,
    `📈 Bonding progress: ${Math.min(token.bondingCurveProgress, 100).toFixed(1)}%${token.complete ? " ✅" : ""}`,
    `—`,
    `📍 CA: <code>${token.mint}</code>`,
    `—`,
    ...securityLines,
  ].join("\n");
}

/** Minimal card for tokens found only via raw on-chain lookup (no indexer coverage yet). */
function buildOnchainOnlyCard(
  chainLabel: string,
  name: string,
  symbol: string,
  ca: string,
  securityLines: string[]
): string {
  return [
    `🚀 <b>${name}</b> (<code>${symbol}</code>) — ${chainLabel}`,
    `<i>⛓️ Source: on-chain only — not yet indexed by any market data provider</i>`,
    `—`,
    `⚠️ No price/liquidity data available yet. This token may be too new, or may not have an active trading pool.`,
    `—`,
    `📍 CA: <code>${ca}</code>`,
    `—`,
    ...securityLines,
  ].join("\n");
}
export async function handleCAAnalysis(ctx: Context, ca: string): Promise<void> {
  const caType = detectCAType(ca);
  if (!caType) return;

  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  await ctx.reply(`🔍 Analyzing <code>${ca}</code>…`, { parse_mode: "HTML" });

  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });

  // ═══════════════════════════════════════════════════════════════════════
  // SOLANA
  // ═══════════════════════════════════════════════════════════════════════
  if (caType === "SOL") {
    const [pairs, security] = await Promise.all([getPairsByToken(ca), checkSolanaToken(ca)]);
    const pair = pairs[0];
    const securityRisks = countSecurityRisks("SOL", security);
    const securityLines = securityLinesFor("SOL", security);
    const rugcheckTarget = `SOL::${ca}`;

    if (pair) {
      const fullText = buildDexScreenerCard(pair, securityLines, securityRisks);
      const chartUrl = `https://dexscreener.com/solana/${pair.pairAddress}`;
      if (user) {
        void db.insert(signalsTable).values({
          userId: user.id, tokenAddress: ca, tokenSymbol: pair.baseToken.symbol,
          chain: "SOL", source: "MANUAL", priceUsd: pair.priceUsd ?? "0",
        });
      }
      await ctx.reply(fullText, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(tradeButtonsFor(ca, { chartUrl, rugcheckTarget })),
      });
      return;
    }

    const geckoPool = await searchGeckoToken(ca, "SOL");
    if (geckoPool) {
      const fullText = buildGeckoCard(geckoPool, securityLines, securityRisks);
      const chartUrl = `https://www.geckoterminal.com/solana/pools/${geckoPool.address}`;
      if (user) {
        void db.insert(signalsTable).values({
          userId: user.id, tokenAddress: ca, tokenSymbol: geckoPool.baseTokenSymbol,
          chain: "SOL", source: "MANUAL", priceUsd: geckoPool.priceUsd,
        });
      }
      await ctx.reply(fullText, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(tradeButtonsFor(ca, { chartUrl, rugcheckTarget })),
      });
      return;
    }

    const pumpToken = await getPumpFunToken(ca);
    if (pumpToken) {
      const solPrice = Number(await getNativeTokenPrice("SOL").catch(() => 0));
      const fullText = buildPumpFunCard(pumpToken, solPrice, securityLines, securityRisks);
      const chartUrl = `https://pump.fun/coin/${ca}`;
      if (user) {
        const priceUsd = (pumpToken.priceNative * solPrice).toFixed(10);
        void db.insert(signalsTable).values({
          userId: user.id, tokenAddress: ca, tokenSymbol: pumpToken.symbol,
          chain: "SOL", source: "PUMPFUN", priceUsd,
        });
      }
      await ctx.reply(fullText, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard(tradeButtonsFor(ca, { chartUrl, rugcheckTarget })),
      });
      return;
    }

    const onchain = await getSolTokenOnchainMetadata(ca);
    if (onchain) {
      const fullText = buildOnchainOnlyCard("Solana", onchain.name, onchain.symbol, ca, securityLines);
      await ctx.reply(fullText, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(tradeButtonsFor(ca, { rugcheckTarget })),
      });
      return;
    }

    await ctx.reply(
      [
        `❓ <b>Token not found</b>`,
        `CA: <code>${ca}</code>`,
        ``,
        `Checked: DexScreener, GeckoTerminal, PumpFun, on-chain metadata.`,
        `This mint doesn't appear to exist, or isn't a token account.`,
      ].join("\n"),
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]]) }
    );
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EVM — chain resolved from whichever source finds the token, never
  // guessed from the user's currently-active wallet.
  // ═══════════════════════════════════════════════════════════════════════
  const pairs = await getPairsByToken(ca); // DexScreener is chain-agnostic by address
  const evmPair = pairs.find((p) => DEXSCREENER_CHAIN_MAP[p.chainId]);

  if (evmPair) {
    const resolvedChain = DEXSCREENER_CHAIN_MAP[evmPair.chainId]!;
    const security = await checkEvmToken(resolvedChain, ca);
    const securityRisks = countSecurityRisks("EVM", security);
    const securityLines = securityLinesFor("EVM", security);
    const fullText = buildDexScreenerCard(evmPair, securityLines, securityRisks);
    const chartUrl = `https://dexscreener.com/${evmPair.chainId}/${evmPair.pairAddress}`;
    const rugcheckTarget = `EVM:${resolvedChain}:${ca}`;

    if (user) {
      void db.insert(signalsTable).values({
        userId: user.id, tokenAddress: ca, tokenSymbol: evmPair.baseToken.symbol,
        chain: resolvedChain, source: "MANUAL", priceUsd: evmPair.priceUsd ?? "0",
      });
    }
    await ctx.reply(fullText, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(tradeButtonsFor(ca, { chartUrl, rugcheckTarget })),
    });
    return;
  }

  // Try GeckoTerminal across all 3 EVM chains in parallel
  const geckoResults = await Promise.all(
    (["ETH", "BASE", "BSC"] as const).map((c) => searchGeckoToken(ca, c))
  );
  const geckoHit = geckoResults.find((r) => r !== null);
  if (geckoHit) {
    const resolvedChain = GECKO_CHAIN_MAP[geckoHit.network] ?? "ETH";
    const security = await checkEvmToken(resolvedChain, ca);
    const securityRisks = countSecurityRisks("EVM", security);
    const securityLines = securityLinesFor("EVM", security);
    const fullText = buildGeckoCard(geckoHit, securityLines, securityRisks);
    const chartUrl = `https://www.geckoterminal.com/${geckoHit.network}/pools/${geckoHit.address}`;
    const rugcheckTarget = `EVM:${resolvedChain}:${ca}`;

    if (user) {
      void db.insert(signalsTable).values({
        userId: user.id, tokenAddress: ca, tokenSymbol: geckoHit.baseTokenSymbol,
        chain: resolvedChain, source: "MANUAL", priceUsd: geckoHit.priceUsd,
      });
    }
    await ctx.reply(fullText, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(tradeButtonsFor(ca, { chartUrl, rugcheckTarget })),
    });
    return;
  }

  // Last resort: raw on-chain bytecode + ERC20 metadata across ETH/BASE/BSC
  const onchainEvm: OnchainEvmToken | null = await resolveEvmTokenOnchain(ca);
  if (onchainEvm) {
    const security = await checkEvmToken(onchainEvm.chain, ca);
    const securityLines = securityLinesFor("EVM", security);
    const fullText = buildOnchainOnlyCard(onchainEvm.chain, onchainEvm.name, onchainEvm.symbol, ca, securityLines);
    const rugcheckTarget = `EVM:${onchainEvm.chain}:${ca}`;
    await ctx.reply(fullText, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(tradeButtonsFor(ca, { rugcheckTarget })),
    });
    return;
  }

  await ctx.reply(
    [
      `❓ <b>Token not found</b>`,
      `CA: <code>${ca}</code>`,
      ``,
      `Checked: DexScreener, GeckoTerminal, and on-chain (ETH/BASE/BSC).`,
      `This address doesn't appear to be a deployed contract on any supported chain.`,
    ].join("\n"),
    { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]]) }
  );
}

/**
 * Also handles the inline "analyze:CA" callback button.
 * NOTE: the global middleware in bot/index.ts already answers every
 * callback query — answering again here throws and aborts the analysis.
 */
export async function handleAnalyzeCallback(ctx: Context, ca: string): Promise<void> {
  await handleCAAnalysis(ctx, ca);
}

/**
 * Standalone RugCheck view — re-runs just the GoPlus security scan for a
 * known chain (already resolved by handleCAAnalysis, encoded in the
 * "rugcheck:<TYPE>:<CHAIN>:<ca>" callback) and shows it on its own,
 * without redoing the whole price/liquidity lookup.
 */
export async function handleRugCheckCallback(ctx: Context, target: string): Promise<void> {
  const parts = target.split(":");
  const type = parts[0] as "SOL" | "EVM";
  let chain: string;
  let ca: string;
  if (type === "SOL") {
    chain = "SOL";
    ca = parts.slice(2).join(":");
  } else {
    chain = parts[1] ?? "ETH";
    ca = parts.slice(2).join(":");
  }
  if (!ca) return;

  const security = type === "SOL" ? await checkSolanaToken(ca) : await checkEvmToken(chain, ca);
  const risks = countSecurityRisks(type === "SOL" ? "SOL" : "EVM", security);
  const lines = securityLinesFor(type === "SOL" ? "SOL" : "EVM", security);

  const verdict = risks === 0 ? "✅ No red flags detected" : `⚠️ ${risks} risk flag(s) found`;

  await ctx.reply(
    [`🔍 <b>RugCheck</b> — ${chain}`, `📍 CA: <code>${ca}</code>`, `—`, ...lines, `—`, verdict].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔬 Full Analysis", `analyze:${ca}`)],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}
