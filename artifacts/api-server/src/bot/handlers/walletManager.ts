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
  
  // 1. Create the new BIG button for Seed Phrase Import (Defaults to active chain)
  const importPhraseRow = [
    Markup.button.callback(`🌱 Import Seed Phrase (${chain})`, `import_method:${chain}:phrase`)
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
    importPhraseRow, // <--- This adds the big Seed Phrase button at the very top
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
