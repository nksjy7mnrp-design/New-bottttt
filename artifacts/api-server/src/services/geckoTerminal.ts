/**
 * GeckoTerminal API integration for token metadata and pool search.
 */

export interface GeckoPool {
  poolAddress: string;
  baseTokenName: string;
  baseTokenSymbol: string;
  priceUsd: string;
  fdvUsd: number;
  liquidityUsd: number;
}

export async function searchGeckoToken(networkOrCa: string, caOrNetwork?: string): Promise<GeckoPool | null> {
  try {
    // Handle flexible argument order so it never typechecks incorrectly
    const isNetworkFirst = networkOrCa.length <= 10; // e.g. "SOL", "eth"
    const network = isNetworkFirst ? networkOrCa.toLowerCase() : (caOrNetwork?.toLowerCase() ?? "solana");
    const ca = isNetworkFirst ? (caOrNetwork ?? networkOrCa) : networkOrCa;

    const netKey = network === "sol" ? "solana" : network === "eth" ? "eth" : network === "base" ? "base" : "solana";
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${netKey}/tokens/${ca}/pools`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{
        attributes?: {
          address?: string;
          name?: string;
          price_usd?: string;
          fdv_usd?: string;
          reserve_in_usd?: string;
        };
      }>;
    };

    const pool = data.data?.[0];
    if (!pool?.attributes) return null;

    return {
      poolAddress: pool.attributes.address ?? "",
      baseTokenName: pool.attributes.name?.split("/")?.[0]?.trim() ?? "Unknown",
      baseTokenSymbol: pool.attributes.name?.split("/")?.[0]?.trim() ?? "?",
      priceUsd: pool.attributes.price_usd ?? "0",
      fdvUsd: Number(pool.attributes.fdv_usd ?? 0),
      liquidityUsd: Number(pool.attributes.reserve_in_usd ?? 0),
    };
  } catch {
    return null;
  }
}

