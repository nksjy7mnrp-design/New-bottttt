/**
 * Jupiter Swap API — Solana token swaps with platform fee support.
 * All swaps are pre-simulated via simulateTransaction before submission.
 *
 * Paths are under /swap/v1 — free tier via lite-api.jup.ag (no key), or
 * api.jup.ag with a free API key from portal.jup.ag for higher reliability.
 */

import { logger } from "../lib/logger";

const JUPITER_API_KEY = process.env["JUPITER_API_KEY"] ?? "";
const JUPITER_BASE = JUPITER_API_KEY
  ? "https://api.jup.ag/swap/v1"
  : "https://lite-api.jup.ag/swap/v1";
const PLATFORM_FEE_BPS = 100; // 1%

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageBps = 1000
): Promise<JupiterQuote | null> {
  const feeWallet = process.env["DEV_FEE_WALLET"] ?? "";
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountLamports),
    slippageBps: String(slippageBps),
    restrictIntermediateTokens: "true",
    ...(feeWallet ? { platformFeeBps: String(PLATFORM_FEE_BPS), feeAccount: feeWallet } : {}),
  });
  try {
    const res = await fetch(`${JUPITER_BASE}/quote?${params.toString()}`, {
      headers: JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as JupiterQuote;
  } catch {
    return null;
  }
}

export async function buildJupiterSwapTx(
  quote: JupiterQuote,
  userPublicKey: string,
  jitoTipLamports = 5_000
): Promise<string | null> {
  try {
    const res = await fetch(`${JUPITER_BASE}/swap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {}),
      },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        useSharedAccounts: false,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: jitoTipLamports,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      logger.warn(
        { status: res.status, body: bodyText.slice(0, 500) },
        "Jupiter /swap build failed — see body for the actual reason"
      );
      return null;
    }
    const data = JSON.parse(bodyText) as { swapTransaction?: string };
    return data.swapTransaction ?? null;
  } catch (err) {
    logger.warn({ err }, "Jupiter /swap request failed");
    return null;
  }
}

export async function simulateSolanaTx(
  serializedBase64: string
): Promise<{ success: boolean; error?: string }> {
  const rpcUrl =
    process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: [serializedBase64, { encoding: "base64", sigVerify: false }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as {
      result?: { value?: { err?: unknown } };
    };
    const err = data.result?.value?.err;
    return err
      ? { success: false, error: JSON.stringify(err) }
      : { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}
