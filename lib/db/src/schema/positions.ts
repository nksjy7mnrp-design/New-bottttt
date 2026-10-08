import { pgTable, serial, integer, bigint, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { walletsTable } from "./wallets";

/**
 * One row per open buy that's eligible for automated TP/SL exit. Created
 * at buy time from that token's tokenScore.ts exitPlan (tp1Pct/tp2Pct/
 * slPct are percentages from entry, e.g. tp1Pct=50 means "+50% from
 * entry"), then watched by services/positionMonitor.ts.
 *
 * Only SOL positions are currently monitored/auto-exited — see
 * positionMonitor.ts for why.
 */
export const positionsTable = pgTable("bot_positions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
  walletId: integer("wallet_id")
    .notNull()
    .references(() => walletsTable.id),
  chain: text("chain").notNull(),
  tokenAddress: text("token_address").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  entryPriceUsd: text("entry_price_usd").notNull(),
  tp1Pct: integer("tp1_pct").notNull(),
  tp2Pct: integer("tp2_pct").notNull(),
  slPct: integer("sl_pct").notNull(), // negative, e.g. -20
  trailingStopEnabled: boolean("trailing_stop_enabled").notNull().default(false),
  trailingPeakPriceUsd: text("trailing_peak_price_usd"),
  tp1Hit: boolean("tp1_hit").notNull().default(false),
  autoExitEnabled: boolean("auto_exit_enabled").notNull().default(true),
  status: text("status").notNull().default("OPEN"), // OPEN | CLOSED
  closeReason: text("close_reason"), // TP1 | TP2 | SL | TRAILING_STOP | MANUAL
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Position = typeof positionsTable.$inferSelect;
