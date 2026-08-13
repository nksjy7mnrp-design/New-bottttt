/**
 * Jito Block Engine — sends Solana transactions as bundles to avoid front-running.
 * Transactions are routed through the Jito block engine with dynamic tips.
 */

import { logger } from "../lib/logger";

/** Default tip (in lamports) used when a user hasn't configured their own
 *  jitoTipLamports in Snipe Filters. 10,000 lamports = 0.00001 SOL. */
export function getJitoTipLamports(): number {
  const envDefault = process.env["JITO_DEFAULT_TIP_LAMPORTS"];
  const parsed = envDefault ? parseInt(envDefault, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

export async function sendJitoBundle(
  serializedBase64Txs: string[]
): Promise<string | null> {
  const jitoUrl =
    process.env["JITO_BLOCK_ENGINE_URL"] ??
    "https://mainnet.block-engine.jito.wtf";
  try {
    const res = await fetch(`${jitoUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serializedBase64Txs],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => null)) as
      | { result?: string; error?: { message?: string; code?: number } }
      | null;
    if (!res.ok || !data?.result) {
      logger.warn(
        { status: res.status, body: data },
        "Jito bundle rejected — see body for the actual reason"
      );
      return null;
    }
    return data.result;
  } catch (err) {
    logger.warn({ err }, "Jito bundle request failed");
    return null;
  }
}
