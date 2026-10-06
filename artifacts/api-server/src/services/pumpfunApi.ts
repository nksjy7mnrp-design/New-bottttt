/**
 * PumpFun token info — read directly from Solana on-chain accounts.
 *
 * pump.fun's old REST API (frontend-api.pump.fun) is retired, and their
 * current API (frontend-api-v3.pump.fun) requires a logged-in wallet
 * session (JWT) for single-coin lookups — not usable from a server-side
 * bot. Every pre-graduation pump.fun token has its price/reserve state
 * stored on-chain in a "bonding curve" account (PDA of the pump.fun
 * program), and its name/symbol/socials in a standard Metaplex metadata
 * account — both freely readable via any Solana RPC, no key required.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const BONDING_CURVE_SEED = Buffer.from("bonding-curve");
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const METADATA_SEED = Buffer.from("metadata");

export interface PumpFunToken {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  createdTimestamp: number;
  usdMarketCap: number;
  bondingCurveProgress: number; // 0–100 (100 = graduated)
  complete: boolean;
  totalSupply: number;
  priceNative: number; // price in SOL
  priceUsd: number;
  virtualSolReserves: number;
  virtualTokenReserves: number;
}

function getConnection(): Connection {
  const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

/** Parse a Metaplex Token Metadata account: name/symbol/uri are borsh
 *  length-prefixed strings (4-byte LE length + UTF8 bytes), back to back,
 *  starting right after [key(1) + updateAuthority(32) + mint(32)]. */
async function fetchMetaplexMetadata(
  connection: Connection,
  mint: PublicKey
): Promise<{ name: string; symbol: string; uri: string } | null> {
  try {
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [METADATA_SEED, METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METADATA_PROGRAM_ID
    );
    const info = await connection.getAccountInfo(metadataPda);
    if (!info) return null;
    const data = info.data;
    let offset = 1 + 32 + 32; // key + updateAuthority + mint

    const nameLen = data.readUInt32LE(offset); offset += 4;
    const name = data.slice(offset, offset + nameLen).toString("utf8").replace(/\0/g, "").trim();
    offset += nameLen;

    const symbolLen = data.readUInt32LE(offset); offset += 4;
    const symbol = data.slice(offset, offset + symbolLen).toString("utf8").replace(/\0/g, "").trim();
    offset += symbolLen;

    const uriLen = data.readUInt32LE(offset); offset += 4;
    const uri = data.slice(offset, offset + uriLen).toString("utf8").replace(/\0/g, "").trim();

    return { name, symbol, uri };
  } catch {
    return null;
  }
}

/** Reads name/symbol/uri from a Token-2022 mint's on-chain "TokenMetadata"
 *  extension (the Metadata Pointer standard). A growing number of newer
 *  launchpads (Believe, Boop, some Bonk/LaunchLab tokens, Heaven, etc.)
 *  mint with Token-2022 and store metadata directly in the mint account
 *  this way instead of a separate legacy Metaplex PDA — the old
 *  `fetchMetaplexMetadata` above never finds those. Returns null for any
 *  mint that isn't Token-2022, or that is but has no metadata extension. */
async function fetchToken2022Metadata(
  connection: Connection,
  mint: PublicKey
): Promise<{ name: string; symbol: string; uri: string } | null> {
  try {
    const meta = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (!meta) return null;
    return {
      name: (meta.name || "").replace(/\0/g, "").trim(),
      symbol: (meta.symbol || "").replace(/\0/g, "").trim(),
      uri: (meta.uri || "").replace(/\0/g, "").trim(),
    };
  } catch {
    return null;
  }
}

/** Best-effort fetch of the off-chain JSON (description/socials/image)
 *  that the on-chain metadata's `uri` points to. Never blocks the core
 *  price/reserve data if it fails or times out. */
async function fetchOffchainJson(uri: string): Promise<{
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  createdOn?: number;
} | null> {
  if (!uri) return null;
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown> as {
      description?: string;
      image?: string;
      twitter?: string;
      telegram?: string;
      website?: string;
    };
  } catch {
    return null;
  }
}

export interface OnchainSolToken {
  mint: string;
  name: string;
  symbol: string;
  description?: string;
  imageUri?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

/**
 * Generic Solana metadata-only lookup — works for ANY SPL token with
 * on-chain metadata, not just pump.fun ones. Used as the final fallback
 * when a token isn't on DexScreener, GeckoTerminal, or a pump.fun bonding
 * curve (e.g. a token that migrated off pump.fun's curve already, was
 * never a pump.fun launch, or comes from a launchpad DexScreener/Gecko
 * haven't indexed yet). No price/liquidity data — just confirms the token
 * exists on-chain and shows its name/symbol/socials.
 *
 * Tries two metadata standards, since different launchpads use different
 * ones:
 *   1. Legacy Metaplex Token Metadata (separate PDA) — covers Pump.fun
 *      and most "classic" SPL tokens.
 *   2. Token-2022's on-chain Metadata Pointer extension (stored inside the
 *      mint account itself) — covers newer Token-2022 launchpads (Believe,
 *      Boop, some Bonk/LaunchLab tokens, Heaven, etc.) that the legacy
 *      lookup can never find because there's no separate PDA at all.
 */
export async function getSolTokenOnchainMetadata(mint: string): Promise<OnchainSolToken | null> {
  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(mint);

    const meta =
      (await fetchMetaplexMetadata(connection, mintPubkey)) ??
      (await fetchToken2022Metadata(connection, mintPubkey));
    if (!meta) return null;

    const offchain = meta.uri ? await fetchOffchainJson(meta.uri) : null;

    return {
      mint,
      name: meta.name || "Unknown",
      symbol: meta.symbol || "?",
      description: offchain?.description,
      imageUri: offchain?.image,
      twitter: offchain?.twitter,
      telegram: offchain?.telegram,
      website: offchain?.website,
    };
  } catch {
    return null;
  }
}

export async function getPumpFunToken(mint: string): Promise<PumpFunToken | null> {
  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(mint);

    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [BONDING_CURVE_SEED, mintPubkey.toBuffer()],
      PUMP_PROGRAM_ID
    );

    const curveInfo = await connection.getAccountInfo(bondingCurve);
    if (!curveInfo || curveInfo.data.length < 49) return null; // never launched via pump.fun

    const data = curveInfo.data;
    // Layout after 8-byte Anchor discriminator: 5x u64 LE + 1 bool
    const virtualTokenReserves = data.readBigUInt64LE(8);
    const virtualSolReserves = data.readBigUInt64LE(16);
    const tokenTotalSupply = data.readBigUInt64LE(40);
    const complete = data[48] === 1;

    const solRes = Number(virtualSolReserves) / 1e9;
    const tokRes = Number(virtualTokenReserves) / 1e6;
    const priceNative = tokRes > 0 ? solRes / tokRes : 0;

    // Migration to PumpSwap has historically occurred around ~85 SOL of
    // real reserves — used only as a rough progress indicator, not exact.
    const progress = complete ? 100 : Math.min((solRes / 85) * 100, 99);

    const meta = await fetchMetaplexMetadata(connection, mintPubkey);
    const offchain = meta?.uri ? await fetchOffchainJson(meta.uri) : null;

    return {
      mint,
      name: meta?.name || "Unknown",
      symbol: meta?.symbol || "?",
      description: offchain?.description ?? "",
      imageUri: offchain?.image ?? "",
      twitter: offchain?.twitter,
      telegram: offchain?.telegram,
      website: offchain?.website,
      createdTimestamp: 0,
      usdMarketCap: 0, // enriched by caller via priceUsd × totalSupply
      bondingCurveProgress: progress,
      complete,
      totalSupply: Number(tokenTotalSupply) / 1e6,
      priceNative,
      priceUsd: 0, // enriched by caller using chainPrice service
      virtualSolReserves: Number(virtualSolReserves),
      virtualTokenReserves: Number(virtualTokenReserves),
    };
  } catch {
    return null;
  }
}

export function formatPumpFunMessage(
  token: PumpFunToken,
  solPriceUsd: number
): string {
  const priceUsd = token.priceNative * solPriceUsd;
  const mcUsd =
    token.usdMarketCap > 0
      ? `$${(token.usdMarketCap / 1_000).toFixed(1)}K`
      : priceUsd > 0 && token.totalSupply > 0
        ? `$${((priceUsd * token.totalSupply) / 1_000_000).toFixed(2)}M`
        : "N/A";

  const progress = Math.min(token.bondingCurveProgress, 100).toFixed(1);
  const progressBar =
    "█".repeat(Math.round(token.bondingCurveProgress / 10)) +
    "░".repeat(10 - Math.round(token.bondingCurveProgress / 10));

  const links: string[] = [];
  if (token.twitter) links.push(`<a href="${token.twitter}">🐦 Twitter</a>`);
  if (token.telegram) links.push(`<a href="${token.telegram}">💬 Telegram</a>`);
  if (token.website) links.push(`<a href="${token.website}">🌐 Website</a>`);

  return [
    `🚀 <b>${token.name}</b> (<code>${token.symbol}</code>) — PumpFun`,
    `📍 CA: <code>${token.mint}</code>`,
    `💲 Price: <b>~$${priceUsd.toFixed(8)}</b> (${token.priceNative.toFixed(6)} SOL)`,
    `🏦 MCap: ${mcUsd}`,
    `📈 Bonding: [${progressBar}] ${progress}%${token.complete ? " ✅ Graduated" : ""}`,
    ...(links.length ? [`🔗 ${links.join(" | ")}`] : []),
    ...(token.description
      ? [`📝 ${token.description.slice(0, 120)}${token.description.length > 120 ? "…" : ""}`]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
}
