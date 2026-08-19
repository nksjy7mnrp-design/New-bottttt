/**
 * GeckoTerminal public API (no key required)
 * Used as fallback when DexScreener has no data for a token.
 */

const GT_BASE = "https://api.geckoterminal.com/api/v2";

const CHAIN_MAP: Record<string, string> = {
  SOL: "solana",
  ETH: "eth",
  BASE: "base",
  BSC: "bsc",
};

export interface GeckoPool {
  name: string;
  address: string;
  baseTokenAddress: string;
  baseTokenName: string;
  baseTokenSymbol: string;
  priceUsd: string;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  volumeUsd24h: number;
  liquidityUsd: number;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  network: string;
  dexId: string;
  buys24h?: number;
  sells24h?: number;
  poolCreatedAt?: number; // unix ms
}

interface GTPoolAttr {
  name?: string;
  base_token_price_usd?: string;
  price_change_percentage?: { m5?: string; h1?: string; h24?: string };
  volume_usd?: { h24?: string };
  reserve_in_usd?: string;
  fdv_usd?: string;
  market_cap_usd?: string;
  address?: string;
  pool_created_at?: string;
  transactions?: { h24?: { buys?: number; sells?: number } };
}

interface GTRelationships {
  base_token?: { data?: { id?: string } };
  dex?: { data?: { id?: string } };
}

function parsePool(
  attr: GTPoolAttr,
  rel: GTRelationships,
  network: string
): GeckoPool | null {
  const baseParts = rel.base_token?.data?.id?.split("_") ?? [];
  const baseTokenAddress = baseParts.slice(1).join("_") || "";
  if (!attr.base_token_price_usd) return null;
  return {
    name: attr.name ?? "Unknown",
    address: attr.address ?? "",
    baseTokenAddress,
    baseTokenName: (attr.name ?? "").split(" / ")[0] ?? "Unknown",
    baseTokenSymbol: (attr.name ?? "").split(" / ")[0] ?? "?",
    priceUsd: attr.base_token_price_usd,
    priceChange5m: parseFloat(attr.price_change_percentage?.m5 ?? "0"),
    priceChange1h: parseFloat(attr.price_change_percentage?.h1 ?? "0"),
    priceChange24h: parseFloat(attr.price_change_percentage?.h24 ?? "0"),
    volumeUsd24h: parseFloat(attr.volume_usd?.h24 ?? "0"),
    liquidityUsd: parseFloat(attr.reserve_in_usd ?? "0"),
    fdvUsd: attr.fdv_usd ? parseFloat(attr.fdv_usd) : null,
    marketCapUsd: attr.market_cap_usd ? parseFloat(attr.market_cap_usd) : null,
    network,
    dexId: rel.dex?.data?.id ?? "unknown",
    buys24h: attr.transactions?.h24?.buys,
    sells24h: attr.transactions?.h24?.sells,
    poolCreatedAt: attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : undefined,
  };
}

/** Search GeckoTerminal for pools matching a token address */
export async function searchGeckoToken(
  ca: string,
  chain: string
): Promise<GeckoPool | null> {
  const network = CHAIN_MAP[chain] ?? "solana";
  try {
    // Try by address first (most precise)
    const res = await fetch(
      `${GT_BASE}/networks/${network}/tokens/${ca}/pools?page=1`,
      {
        headers: { Accept: "application/json;version=20230302" },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (res.ok) {
      const json = (await res.json()) as {
        data?: Array<{ attributes?: GTPoolAttr; relationships?: GTRelationships }>;
      };
      const pools = json.data ?? [];
      for (const p of pools) {
        const pool = parsePool(p.attributes ?? {}, p.relationships ?? {}, network);
        if (pool) return pool;
      }
    }

    // Fallback: search endpoint
    const res2 = await fetch(
      `${GT_BASE}/search/pools?query=${encodeURIComponent(ca)}&network=${network}&page=1`,
      {
        headers: { Accept: "application/json;version=20230302" },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res2.ok) return null;
    const json2 = (await res2.json()) as {
      data?: Array<{ attributes?: GTPoolAttr; relationships?: GTRelationships }>;
    };
    const pools2 = json2.data ?? [];
    for (const p of pools2) {
      const pool = parsePool(p.attributes ?? {}, p.relationships ?? {}, network);
      if (pool) return pool;
    }
    return null;
  } catch {
    return null;
  }
}

/** Get top trending pools from GeckoTerminal (Solana) */
export async function getGeckoTrending(network = "solana"): Promise<GeckoPool[]> {
  try {
    const res = await fetch(
      `${GT_BASE}/networks/${network}/trending_pools?page=1`,
      {
        headers: { Accept: "application/json;version=20230302" },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: Array<{ attributes?: GTPoolAttr; relationships?: GTRelationships }>;
    };
    const results: GeckoPool[] = [];
    for (const p of (json.data ?? []).slice(0, 5)) {
      const pool = parsePool(p.attributes ?? {}, p.relationships ?? {}, network);
      if (pool) results.push(pool);
    }
    return results;
  } catch {
    return [];
  }
}

/** Get newest pools from GeckoTerminal (Solana) */
export async function getGeckoNewPools(network = "solana"): Promise<GeckoPool[]> {
  try {
    const res = await fetch(
      `${GT_BASE}/networks/${network}/new_pools?page=1`,
      {
        headers: { Accept: "application/json;version=20230302" },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: Array<{ attributes?: GTPoolAttr; relationships?: GTRelationships }>;
    };
    const results: GeckoPool[] = [];
    for (const p of (json.data ?? []).slice(0, 5)) {
      const pool = parsePool(p.attributes ?? {}, p.relationships ?? {}, network);
      if (pool) results.push(pool);
    }
    return results;
  } catch {
    return [];
  }
}

export function formatGeckoPool(p: GeckoPool): string {
  const sign = (n: number) => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2));
  const liq =
    p.liquidityUsd > 0
      ? `$${(p.liquidityUsd / 1_000).toFixed(1)}K`
      : "N/A";
  const mc =
    p.marketCapUsd != null
      ? `$${(p.marketCapUsd / 1_000_000).toFixed(2)}M`
      : p.fdvUsd != null
        ? `$${(p.fdvUsd / 1_000_000).toFixed(2)}M (FDV)`
        : "N/A";
  return [
    `🦎 <b>${p.baseTokenName}</b>`,
    `📍 CA: <code>${p.baseTokenAddress || p.address}</code>`,
    `💲 Price: <b>$${Number(p.priceUsd).toFixed(8)}</b>`,
    `📊 5m: ${sign(p.priceChange5m)}% | 1h: ${sign(p.priceChange1h)}% | 24h: ${sign(p.priceChange24h)}%`,
    `🏦 MCap: ${mc} | 💧 Liq: ${liq}`,
    `🔗 DEX: ${p.dexId} on ${p.network}`,
  ].join("\n");
}
