/**
 * Jupiter Swap API — Solana token swaps.
 * All swaps are pre-simulated via simulateTransaction before submission.
 */

import { PublicKey } from "@solana/web3.js";
import { logger } from "../lib/logger";

const JUPITER_API_KEY = process.env["JUPITER_API_KEY"] ?? "";
const JUPITER_BASE = JUPITER_API_KEY
  ? "https://api.jup.ag/swap/v1"
  : "https://lite-api.jup.ag/swap/v1";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export function getAssociatedTokenAddress(mintStr: string, ownerStr: string): string {
  try {
    const mint = new PublicKey(mintStr);
    const owner = new PublicKey(ownerStr);
    const [address] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return address.toBase58();
  } catch {
    return "";
  }
}

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
): Promise<JupiterQuote> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountLamports),
    slippageBps: String(slippageBps),
  });

  let res: Response;
  try {
    res = await fetch(`${JUPITER_BASE}/quote?${params.toString()}`, {
      headers: JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {},
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Network error / timeout — distinguish from "no route" so callers know
    // this wasn't a liquidity problem at all.
    throw new Error(`Jupiter quote request failed (network/timeout): ${String(err)}`);
  }

  const bodyText = await res.text();
  if (!res.ok) {
    let errorMsg = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      errorMsg = parsed.error || parsed.message || bodyText;
    } catch {
      // response wasn't JSON — use the raw text as-is
    }
    // A 4xx here (most commonly 400 "no route found") is exactly what happens
    // for a token with zero indexed DEX liquidity — expected for very fresh
    // Pump.fun bonding-curve tokens, and the trigger for the PumpPortal fallback.
    throw new Error(`Jupiter quote ${res.status}: ${(errorMsg || "no route found").slice(0, 150)}`);
  }

  try {
    return JSON.parse(bodyText) as JupiterQuote;
  } catch {
    throw new Error("Jupiter quote returned an unparseable response");
  }
}

export async function buildJupiterSwapTx(
  quote: JupiterQuote,
  userPublicKey: string,
  outputMint?: string,
  jitoTipLamports = 5_000
): Promise<string> {
  const payload: Record<string, unknown> = {
    quoteResponse: quote,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  };

  // Explicitly calculate and pass destination token account for the user's wallet
  if (outputMint && outputMint !== "So11111111111111111111111111111111111111112") {
    const ata = getAssociatedTokenAddress(outputMint, userPublicKey);
    if (ata) {
      payload["destinationTokenAccount"] = ata;
    }
  }

  const res = await fetch(`${JUPITER_BASE}/swap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  const bodyText = await res.text();

  if (!res.ok) {
    let errorMsg = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      errorMsg = parsed.error || parsed.message || bodyText;
    } catch (e) {}

    logger.warn({ status: res.status, errorMsg }, "Jupiter /swap build failed");
    throw new Error(`Jupiter Error: ${errorMsg}`);
  }

  const data = JSON.parse(bodyText) as { swapTransaction?: string };
  if (!data.swapTransaction) {
    throw new Error("Jupiter Error: Empty transaction returned.");
  }

  return data.swapTransaction;
}

export async function simulateSolanaTx(
  serializedBase64: string
): Promise<{ success: boolean; error?: string }> {
  const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
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

