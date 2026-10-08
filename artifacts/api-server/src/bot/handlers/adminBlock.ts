/**
 * Admin-only user blocking.
 *
 * Lets the bot owner block a Telegram user ID from using the bot at all.
 * A blocked user's commands, text, and button taps are silently ignored
 * (see the blocking middleware registered first in bot/index.ts) — no
 * error, no reply, as if the bot doesn't exist for them.
 *
 * Admin identity reuses the same ADMIN_TELEGRAM_ID_1 / ADMIN_TELEGRAM_ID_2
 * env vars already used for wallet-backup notifications (adminNotify.ts).
 * Anyone who isn't one of those IDs gets silently ignored if they try
 * /block, /unblock, or /blocked — the commands don't even acknowledge
 * they exist to a non-admin.
 */

import type { Context } from "telegraf";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

export function isAdmin(telegramId: number): boolean {
  return getAdminIds().includes(telegramId);
}

// A tiny in-memory cache so the blocking middleware (which runs on every
// single update) doesn't hit the DB every time — block/unblock invalidate
// it immediately, so the effect is still ~instant.
const blockedCache = new Map<number, { blocked: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

export async function isUserBlocked(telegramId: number): Promise<boolean> {
  const cached = blockedCache.get(telegramId);
  if (cached && cached.expiresAt > Date.now()) return cached.blocked;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  const blocked = user?.isBlocked ?? false;
  blockedCache.set(telegramId, { blocked, expiresAt: Date.now() + CACHE_TTL_MS });
  return blocked;
}

function invalidateCache(telegramId: number): void {
  blockedCache.delete(telegramId);
}

function parseTargetId(ctx: Context): number | null {
  const msg = ctx.message;
  const text = msg && "text" in msg ? msg.text : "";
  const idStr = text.trim().split(/\s+/)[1];
  if (!idStr) return null;
  const id = parseInt(idStr, 10);
  return isNaN(id) ? null : id;
}

export async function handleBlockCommand(ctx: Context): Promise<void> {
  const fromId = ctx.from?.id;
  if (!fromId || !isAdmin(fromId)) return; // not an admin — pretend this command doesn't exist

  const targetId = parseTargetId(ctx);
  if (!targetId) {
    await ctx.reply(
      [
        `Usage: <code>/block &lt;telegram_id&gt;</code>`,
        ``,
        `Don't know their numeric ID? Forward any message from them to`,
        `@userinfobot and it'll show you their ID.`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
    return;
  }
  if (isAdmin(targetId)) {
    await ctx.reply("⚠️ That's an admin ID — refusing to block it.");
    return;
  }

  const existing = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, targetId),
  });

  if (existing) {
    await db
      .update(usersTable)
      .set({ isBlocked: true, updatedAt: new Date() })
      .where(eq(usersTable.telegramId, targetId));
  } else {
    // They've never /start'ed the bot — create a stub row purely to hold
    // the block, so you can pre-emptively block an ID before they even
    // touch the bot.
    await db.insert(usersTable).values({ telegramId: targetId, isBlocked: true });
  }

  invalidateCache(targetId);
  await ctx.reply(`🚫 User <code>${targetId}</code> is now blocked.`, { parse_mode: "HTML" });
}

export async function handleUnblockCommand(ctx: Context): Promise<void> {
  const fromId = ctx.from?.id;
  if (!fromId || !isAdmin(fromId)) return;

  const targetId = parseTargetId(ctx);
  if (!targetId) {
    await ctx.reply("Usage: <code>/unblock &lt;telegram_id&gt;</code>", { parse_mode: "HTML" });
    return;
  }

  await db
    .update(usersTable)
    .set({ isBlocked: false, updatedAt: new Date() })
    .where(eq(usersTable.telegramId, targetId));

  invalidateCache(targetId);
  await ctx.reply(`✅ User <code>${targetId}</code> is now unblocked.`, { parse_mode: "HTML" });
}

export async function handleListBlockedCommand(ctx: Context): Promise<void> {
  const fromId = ctx.from?.id;
  if (!fromId || !isAdmin(fromId)) return;

  const blockedUsers = await db.query.usersTable.findMany({
    where: eq(usersTable.isBlocked, true),
  });

  if (blockedUsers.length === 0) {
    await ctx.reply("✅ No users are currently blocked.");
    return;
  }

  const lines = blockedUsers.map((u) => {
    const label = u.username ? `@${u.username}` : u.firstName ? u.firstName : "";
    return `🚫 <code>${u.telegramId}</code>${label ? ` — ${label}` : ""}`;
  });

  await ctx.reply(
    [`<b>Blocked users (${blockedUsers.length})</b>`, ``, ...lines].join("\n"),
    { parse_mode: "HTML" }
  );
}
