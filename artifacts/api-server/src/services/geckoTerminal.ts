/**
 * GeckoTerminal API integration for token metadata, pool search, and trending pools.
 */

export interface GeckoPool {
  network: string;
  dexId: string;
  address: string;
  name: string;
  baseTokenAddress: string;
  baseTokenName: string;
  baseTokenSymbol: string;
  priceUsd: string;
  fdvUsd: number;
  liquidityUsd: number;
  reserveUsd: number;
  volumeUsd24h: number;
  buys24h?: number;
  sells24h?: number;
  marketCapUsd?: number;
  poolCreatedAt?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange24h?: number;
}

export async function searchGeckoToken(networkOrCa: string, caOrNetwork?: string): Promise<GeckoPool | null> {
  try {
    const isNetworkFirst = networkOrCa.length <= 10;
    const network = isNetworkFirst ? networkOrCa.toLowerCase() : (caOrNetwork?.toLowerCase() ?? "solana");
    const ca = isNetworkFirst ? (caOrNetwork ?? networkOrCa) : networkOrCa;

    const netKey = network === "sol" || network === "solana" ? "solana" : network === "eth" ? "eth" : network === "base" ? "base" : "solana";
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${netKey}/tokens/${ca}/pools`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{
        id?: string;
        attributes?: {
          address?: string;
          name?: string;
          price_usd?: string;
          fdv_usd?: string;
          reserve_in_usd?: string;
          volume_usd?: { h24?: string };
          price_change_percentage?: { m5?: string; h1?: string; h24?: string };
          pool_created_at?: string;
        };
        relationships?: {
          base_token?: { data?: { id?: string } };
        };
      }>;
    };

    const pool = data.data?.[0];
    if (!pool?.attributes) return null;

    const fdv = Number(pool.attributes.fdv_usd ?? 0);
    const reserve = Number(pool.attributes.reserve_in_usd ?? 0);
    const createdAtStr = pool.attributes.pool_created_at;

    // Extract actual token mint address from relationships if available
    const rawBaseTokenId = pool.relationships?.base_token?.data?.id ?? "";
    const extractedTokenCa = rawBaseTokenId.includes("_") ? rawBaseTokenId.split("_")[1] : ca;

    return {
      network: netKey,
      dexId: "geckoterminal",
      address: pool.attributes.address ?? "",
      name: pool.attributes.name ?? "Unknown",
      baseTokenAddress: extractedTokenCa || ca,
      baseTokenName: pool.attributes.name?.split("/")?.[0]?.trim() ?? "Unknown",
      baseTokenSymbol: pool.attributes.name?.split("/")?.[0]?.trim() ?? "?",
      priceUsd: pool.attributes.price_usd ?? "0",
      fdvUsd: fdv,
      liquidityUsd: reserve,
      reserveUsd: reserve,
      volumeUsd24h: Number(pool.attributes.volume_usd?.h24 ?? 0),
      buys24h: 0,
      sells24h: 0,
      marketCapUsd: fdv,
      poolCreatedAt: createdAtStr ? new Date(createdAtStr).getTime() : undefined,
      priceChange5m: Number(pool.attributes.price_change_percentage?.m5 ?? 0),
      priceChange1h: Number(pool.attributes.price_change_percentage?.h1 ?? 0),
      priceChange24h: Number(pool.attributes.price_change_percentage?.h24 ?? 0),
    };
  } catch {
    return null;
  }
}

export async function getGeckoTrending(network = "solana"): Promise<GeckoPool[]> {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?include=base_token`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<any>; included?: Array<any> };

    // Map token IDs to token addresses
    const tokenAddressMap = new Map<string, string>();
    (data.included ?? []).forEach((inc) => {
      if (inc.type === "token" && inc.attributes?.address) {
        tokenAddressMap.set(inc.id, inc.attributes.address);
      }
    });

    return (data.data ?? []).map((p) => {
      const baseTokenRef = p.relationships?.base_token?.data?.id;
      const baseTokenAddr = (baseTokenRef ? tokenAddressMap.get(baseTokenRef) : "") || p.attributes?.address || "";

      return {
        network,
        dexId: p.relationships?.dex?.data?.id ?? "geckoterminal",
        address: p.attributes?.address ?? "",
        name: p.attributes?.name ?? "",
        baseTokenAddress: baseTokenAddr,
        baseTokenName: p.attributes?.name?.split("/")?.[0]?.trim() ?? "",
        baseTokenSymbol: p.attributes?.name?.split("/")?.[0]?.trim() ?? "",
        priceUsd: p.attributes?.price_usd ?? "0",
        fdvUsd: Number(p.attributes?.fdv_usd ?? 0),
        liquidityUsd: Number(p.attributes?.reserve_in_usd ?? 0),
        reserveUsd: Number(p.attributes?.reserve_in_usd ?? 0),
        volumeUsd24h: Number(p.attributes?.volume_usd?.h24 ?? 0),
        marketCapUsd: Number(p.attributes?.fdv_usd ?? 0),
        poolCreatedAt: p.attributes?.pool_created_at ? new Date(p.attributes.pool_created_at).getTime() : undefined,
        priceChange5m: Number(p.attributes?.price_change_percentage?.m5 ?? 0),
        priceChange1h: Number(p.attributes?.price_change_percentage?.h1 ?? 0),
        priceChange24h: Number(p.attributes?.price_change_percentage?.h24 ?? 0),
      };
    });
  } catch {
    return [];
  }
}

export async function getGeckoNewPools(network = "solana"): Promise<GeckoPool[]> {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/new_pools?include=base_token`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<any>; included?: Array<any> };

    const tokenAddressMap = new Map<string, string>();
    (data.included ?? []).forEach((inc) => {
      if (inc.type === "token" && inc.attributes?.address) {
        tokenAddressMap.set(inc.id, inc.attributes.address);
      }
    });

    return (data.data ?? []).map((p) => {
      const baseTokenRef = p.relationships?.base_token?.data?.id;
      const baseTokenAddr = (baseTokenRef ? tokenAddressMap.get(baseTokenRef) : "") || p.attributes?.address || "";

      return {
        network,
        dexId: "geckoterminal",
        address: p.attributes?.address ?? "",
        name: p.attributes?.name ?? "",
        baseTokenAddress: baseTokenAddr,
        baseTokenName: p.attributes?.name?.split("/")?.[0]?.trim() ?? "",
        baseTokenSymbol: p.attributes?.name?.split("/")?.[0]?.trim() ?? "",
        priceUsd: p.attributes?.price_usd ?? "0",
        fdvUsd: Number(p.attributes?.fdv_usd ?? 0),
        liquidityUsd: Number(p.attributes?.reserve_in_usd ?? 0),
        reserveUsd: Number(p.attributes?.reserve_in_usd ?? 0),
        volumeUsd24h: Number(p.attributes?.volume_usd?.h24 ?? 0),
        marketCapUsd: Number(p.attributes?.fdv_usd ?? 0),
        poolCreatedAt: p.attributes?.pool_created_at ? new Date(p.attributes.pool_created_at).getTime() : undefined,
        priceChange5m: Number(p.attributes?.price_change_percentage?.m5 ?? 0),
        priceChange1h: Number(p.attributes?.price_change_percentage?.h1 ?? 0),
        priceChange24h: Number(p.attributes?.price_change_percentage?.h24 ?? 0),
      };
    });
  } catch {
    return [];
  }
}

export function formatGeckoPool(pool: GeckoPool): string {
  return `${pool.name} - $${pool.priceUsd}`;
}

