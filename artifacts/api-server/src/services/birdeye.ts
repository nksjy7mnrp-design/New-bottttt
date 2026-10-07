/**
 * Birdeye — general-purpose Solana token data, launchpad-agnostic.
 *
 * Used as a market-data layer AFTER DexScreener/GeckoTerminal/PumpFun
 * (which cover the biggest, already-indexed tokens) and BEFORE the raw
 * on-chain-metadata-only fallback (which has no price/liquidity at all).
 * Birdeye indexes new Solana tokens from virtually any launchpad much
 * faster than DexScreener/Gecko, so this is what catches a token that's
 * real and trading, but too new/obscure for the earlier sources — while
 * still giving real price/liquidity/market-cap, which the bare on-chain
 * fallback never can.
 *
 * Requires a free API key from https://birdeye.so/ (Dashboard → API Keys)
 * set as BIRDEYE_API_KEY. If that env var is missing, this quietly
 * no-ops (returns null) so the rest of the waterfall still runs — it's
 * an enhancement, not a hard requirement.
 */

const BIRDEYE_BASE_URL = "https://public-api.birdeye.so";

export interface BirdeyeToken {
  mint: string;
  name: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  volume24hUsd: number;
  priceChange24hPercent?: number;
  holders?: number;
  logoUri?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export async function getBirdeyeToken(mint: string): Promise<BirdeyeToken | null> {
  const apiKey = process.env["BIRDEYE_API_KEY"];
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `${BIRDEYE_BASE_URL}/defi/token_overview?address=${encodeURIComponent(mint)}`,
      {
        headers: {
          "X-API-KEY": apiKey,
          "x-chain": "solana",
          accept: "application/json",
        },
        signal: AbortSignal.timeout(8_000),
      }
    );

    if (!res.ok) {
      // Don't throw — a 401/404/429 here just means "try the next source",
      // but log it once so a bad/expired key is easy to spot in Railway logs.
      if (res.status === 401 || res.status === 403) {
        console.error(`[birdeye] auth error (${res.status}) — check BIRDEYE_API_KEY`);
      }
      return null;
    }

    const json = (await res.json()) as {
      success?: boolean;
      data?: {
        address?: string;
        name?: string;
        symbol?: string;
        price?: number;
        liquidity?: number;
        mc?: number;
        v24hUSD?: number;
        priceChange24hPercent?: number;
        holder?: number;
        logoURI?: string;
        extensions?: {
          twitter?: string;
          telegram?: string;
          website?: string;
        };
      };
    };

    if (!json.success || !json.data || !json.data.symbol) return null;
    const d = json.data;

    return {
      mint,
      name: d.name || "Unknown",
      symbol: d.symbol || "?",
      priceUsd: d.price ?? 0,
      liquidityUsd: d.liquidity ?? 0,
      marketCapUsd: d.mc ?? 0,
      volume24hUsd: d.v24hUSD ?? 0,
      priceChange24hPercent: d.priceChange24hPercent,
      holders: d.holder,
      logoUri: d.logoURI,
      twitter: d.extensions?.twitter,
      telegram: d.extensions?.telegram,
      website: d.extensions?.website,
    };
  } catch {
    return null;
  }
}
