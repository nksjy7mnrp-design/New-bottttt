const COINGECKO_IDS: Record<string, string> = {
  SOL: "solana",
  ETH: "ethereum",
  BASE: "ethereum",
  BSC: "binancecoin",
};

const EVM_RPC_ENV: Record<string, string> = {
  ETH: "ETH_RPC_URL",
  BASE: "BASE_RPC_URL",
  BSC: "BSC_RPC_URL",
};

const priceCache = new Map<string, { value: string; expiresAt: number }>();
const PRICE_CACHE_MS = 30_000;

export async function getNativeTokenPrice(chain: string): Promise<string> {
  const coinId = COINGECKO_IDS[chain] ?? "solana";

  const cached = priceCache.get(coinId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return cached?.value ?? "0.00"; // serve stale cache over a hard "0.00" if we have one
    const data = (await res.json()) as Record<string, { usd?: number }>;
    const value = (data[coinId]?.usd ?? 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    priceCache.set(coinId, { value, expiresAt: Date.now() + PRICE_CACHE_MS });
    return value;
  } catch {
    return cached?.value ?? "0.00";
  }
}

export async function getChainBalance(
  chain: string,
  address: string
): Promise<string> {
  try {
    if (chain === "SOL") {
      const rpcUrl =
        process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBalance",
          params: [address],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const data = (await res.json()) as { result?: { value?: number } };
      const lamports = data.result?.value ?? 0;
      return (lamports / 1e9).toFixed(4);
    }

    const envKey = EVM_RPC_ENV[chain];
    const rpcUrl = envKey ? (process.env[envKey] ?? "") : "";
    if (!rpcUrl) return "0.0000";

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const data = (await res.json()) as { result?: string };
    const wei = BigInt(data.result ?? "0x0");
    return (Number(wei) / 1e18).toFixed(4);
  } catch {
    return "0.0000";
  }
}

export const CHAIN_SYMBOLS: Record<string, string> = {
  SOL: "SOL",
  ETH: "ETH",
  BASE: "ETH",
  BSC: "BNB",
};
