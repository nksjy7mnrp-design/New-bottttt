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

/**
 * Broadcasts a signed transaction straight to your configured Solana RPC.
 * No block-engine URL, no bundle JSON-RPC shape, no region to pick — just
 * the same SOLANA_RPC_URL the bot already uses for balance checks and
 * simulation. This is now the default landing path; sendJitoBundle above is
 * kept for anyone who wants to opt back into Jito later, but nothing calls
 * it automatically anymore.
 *
 * Trade-off vs. Jito: no bundle-level MEV/front-run protection. For a
 * personal bot placing individual buys, that's a reasonable trade for
 * something with far fewer ways to misconfigure.
 */
export async function sendSolanaTxDirect(signedBase64Tx: string): Promise<string | null> {
  const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [
          signedBase64Tx,
          { encoding: "base64", skipPreflight: true, maxRetries: 3 },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => null)) as
      | { result?: string; error?: { message?: string; code?: number } }
      | null;

    if (!res.ok || !data?.result) {
      logger.warn(
        { status: res.status, body: data },
        "Direct RPC broadcast rejected — see body for the actual reason"
      );
      return null;
    }
    // Unlike Jito's bundle ID, this result IS the real transaction
    // signature — viewable directly on any Solana explorer.
    return data.result;
  } catch (err) {
    logger.warn({ err }, "Direct RPC broadcast failed");
    return null;
  }
}
  serializedBase64Txs: string[]
): Promise<string | null> {
  // Jito does not run a bundle-accepting endpoint at the bare
  // "mainnet.block-engine.jito.wtf" host — only the regional subdomains
  // below are documented as operational for sendBundle. The bare host was
  // returning a 404 on every single request, which is why every buy was
  // failing at this step regardless of the token. Set JITO_BLOCK_ENGINE_URL
  // to whichever region is physically closest to your Railway deployment
  // for the best landing odds; any of the four will work correctly.
  //   https://amsterdam.mainnet.block-engine.jito.wtf
  //   https://frankfurt.mainnet.block-engine.jito.wtf
  //   https://ny.mainnet.block-engine.jito.wtf
  //   https://tokyo.mainnet.block-engine.jito.wtf
  const jitoUrl =
    process.env["JITO_BLOCK_ENGINE_URL"] ??
    "https://ny.mainnet.block-engine.jito.wtf";
  try {
    const res = await fetch(`${jitoUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serializedBase64Txs, { encoding: "base64" }],
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
