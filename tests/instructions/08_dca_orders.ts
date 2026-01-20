import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  airdropIfNeeded,
  addFundToken,
  ensureFund,
  ensureGlobalConfig,
  expectError,
  getClockUnixTimestamp,
  getContext,
} from "../helpers";
import { createMintToInstruction } from "@solana/spl-token";

const DCA_SIDE_BUY = 0;
const DCA_SIDE_SELL = 1;
const WSOL_MINT = new anchor.web3.PublicKey(
  "So11111111111111111111111111111111111111112",
);
const JUPITER_PROGRAM_ID = new anchor.web3.PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);
const MIN_PROVIDER_BALANCE = 10 * anchor.web3.LAMPORTS_PER_SOL;

const deriveDcaOrderPda = (
  fundPda: anchor.web3.PublicKey,
  orderId: anchor.BN,
  programId: anchor.web3.PublicKey,
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("dca_order"),
      fundPda.toBuffer(),
      orderId.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  )[0];

const deriveDcaSolVault = (
  orderPda: anchor.web3.PublicKey,
  programId: anchor.web3.PublicKey,
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("dca_order_sol_vault"), orderPda.toBuffer()],
    programId,
  )[0];

const deriveDcaVaultAuth = (
  orderPda: anchor.web3.PublicKey,
  programId: anchor.web3.PublicKey,
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("dca_order_vault_auth"), orderPda.toBuffer()],
    programId,
  )[0];

const deriveDcaAccounts = async (
  ctx: Awaited<ReturnType<typeof getContext>>,
  orderId: anchor.BN,
  mint: anchor.web3.PublicKey,
  side: number,
) => {
  const orderPda = deriveDcaOrderPda(ctx.fundPda, orderId, ctx.program.programId);
  const orderSolVault = deriveDcaSolVault(orderPda, ctx.program.programId);
  const orderVaultAuth = deriveDcaVaultAuth(orderPda, ctx.program.programId);
  const orderTokenVault = await anchor.utils.token.associatedAddress({
    mint: side === DCA_SIDE_BUY ? WSOL_MINT : mint,
    owner: orderVaultAuth,
  });
  return { orderPda, orderSolVault, orderVaultAuth, orderTokenVault };
};

describe("dca-orders", () => {
  beforeEach(async () => {
    const ctx = await getContext();
    await airdropIfNeeded(ctx.provider, ctx.provider.wallet.publicKey, MIN_PROVIDER_BALANCE);
  });
  it("Creates and cancels a buy DCA order", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    const fundVaultBefore = await ctx.provider.connection.getBalance(ctx.vaultPda);

    await ctx.program.methods
      .createDcaOrder(
        DCA_SIDE_BUY,
        new anchor.BN(100_000),
        new anchor.BN(50_000),
        new anchor.BN(1),
        new anchor.BN(1),
        new anchor.BN(0),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        mint: token.mint,
        whitelist: token.fundWhitelistPda,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        fundTokenVault: token.fundTokenVault,
        wsolMint: WSOL_MINT,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const orderAccount = await ctx.program.account.dcaOrder.fetch(orderPda);
    expect(orderAccount.status).to.equal(0);
    expect(orderAccount.remainingAmount.toString()).to.equal("100000");

    const fundVaultAfter = await ctx.provider.connection.getBalance(ctx.vaultPda);
    expect(fundVaultBefore - fundVaultAfter).to.equal(100_000);

    await ctx.program.methods
      .cancelDcaOrder(orderId)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        whitelist: token.fundWhitelistPda,
        fundTokenVault: token.fundTokenVault,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const cancelled = await ctx.program.account.dcaOrder.fetch(orderPda);
    expect(cancelled.status).to.equal(2);
  });

  it("Creates and cancels a sell DCA order", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const mintIx = createMintToInstruction(
      token.mint,
      token.fundTokenVault,
      ctx.provider.wallet.publicKey,
      1_000,
    );
    await ctx.provider.sendAndConfirm(new anchor.web3.Transaction().add(mintIx), []);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_SELL);

    const fundTokenBefore = await ctx.provider.connection.getTokenAccountBalance(
      token.fundTokenVault,
    );

    await ctx.program.methods
      .createDcaOrder(
        DCA_SIDE_SELL,
        new anchor.BN(500),
        new anchor.BN(100),
        new anchor.BN(1),
        new anchor.BN(1),
        new anchor.BN(0),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        mint: token.mint,
        whitelist: token.fundWhitelistPda,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        fundTokenVault: token.fundTokenVault,
        wsolMint: WSOL_MINT,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const fundTokenAfter = await ctx.provider.connection.getTokenAccountBalance(
      token.fundTokenVault,
    );
    expect(Number(fundTokenBefore.value.amount) - Number(fundTokenAfter.value.amount)).to.equal(500);

    await ctx.program.methods
      .cancelDcaOrder(orderId)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        whitelist: token.fundWhitelistPda,
        fundTokenVault: token.fundTokenVault,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const cancelled = await ctx.program.account.dcaOrder.fetch(orderPda);
    expect(cancelled.status).to.equal(2);
  });

  it("Rejects create DCA by non-manager", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const rogue = anchor.web3.Keypair.generate();
    await airdropIfNeeded(
      ctx.provider,
      rogue.publicKey,
      anchor.web3.LAMPORTS_PER_SOL / 2,
    );

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    await expectError(
      ctx.program.methods
        .createDcaOrder(
          DCA_SIDE_BUY,
          new anchor.BN(10_000),
          new anchor.BN(5_000),
          new anchor.BN(10),
          new anchor.BN(1),
          new anchor.BN(0),
        )
        .accounts({
          manager: rogue.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          mint: token.mint,
          whitelist: token.fundWhitelistPda,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          fundTokenVault: token.fundTokenVault,
          wsolMint: WSOL_MINT,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([rogue])
        .rpc(),
      "Unauthorized",
    );
  });

  it("Rejects create DCA with invalid interval", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    await expectError(
      ctx.program.methods
        .createDcaOrder(
          DCA_SIDE_BUY,
          new anchor.BN(10_000),
          new anchor.BN(5_000),
          new anchor.BN(0),
          new anchor.BN(1),
          new anchor.BN(0),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          mint: token.mint,
          whitelist: token.fundWhitelistPda,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          fundTokenVault: token.fundTokenVault,
          wsolMint: WSOL_MINT,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "InvalidDcaInterval",
    );
  });

  it("Rejects create DCA with invalid slice", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    await expectError(
      ctx.program.methods
        .createDcaOrder(
          DCA_SIDE_BUY,
          new anchor.BN(10_000),
          new anchor.BN(0),
          new anchor.BN(10),
          new anchor.BN(1),
          new anchor.BN(0),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          mint: token.mint,
          whitelist: token.fundWhitelistPda,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          fundTokenVault: token.fundTokenVault,
          wsolMint: WSOL_MINT,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "InvalidDcaSlice",
    );
  });

  it("Rejects create DCA when slice exceeds total", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    await expectError(
      ctx.program.methods
        .createDcaOrder(
          DCA_SIDE_BUY,
          new anchor.BN(10_000),
          new anchor.BN(20_000),
          new anchor.BN(10),
          new anchor.BN(1),
          new anchor.BN(0),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          mint: token.mint,
          whitelist: token.fundWhitelistPda,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          fundTokenVault: token.fundTokenVault,
          wsolMint: WSOL_MINT,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "InvalidDcaSlice",
    );
  });

  it("Rejects create DCA with zero min_out", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    await expectError(
      ctx.program.methods
        .createDcaOrder(
          DCA_SIDE_BUY,
          new anchor.BN(10_000),
          new anchor.BN(5_000),
          new anchor.BN(10),
          new anchor.BN(0),
          new anchor.BN(0),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          mint: token.mint,
          whitelist: token.fundWhitelistPda,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          fundTokenVault: token.fundTokenVault,
          wsolMint: WSOL_MINT,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "InvalidMinOut",
    );
  });

  it("Rejects create DCA with invalid side", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    await expectError(
      ctx.program.methods
        .createDcaOrder(
          3,
          new anchor.BN(10_000),
          new anchor.BN(5_000),
          new anchor.BN(10),
          new anchor.BN(1),
          new anchor.BN(0),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          mint: token.mint,
          whitelist: token.fundWhitelistPda,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          fundTokenVault: token.fundTokenVault,
          wsolMint: WSOL_MINT,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "InvalidOrderSide",
    );
  });

  it("Rejects create DCA buy with insufficient liquidity", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    const fundBalance = await ctx.provider.connection.getBalance(ctx.vaultPda);
    await expectError(
      ctx.program.methods
        .createDcaOrder(
          DCA_SIDE_BUY,
          new anchor.BN(fundBalance + 1),
          new anchor.BN(1),
          new anchor.BN(10),
          new anchor.BN(1),
          new anchor.BN(0),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          mint: token.mint,
          whitelist: token.fundWhitelistPda,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          fundTokenVault: token.fundTokenVault,
          wsolMint: WSOL_MINT,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "InsufficientLiquidity",
    );
  });

  it("Rejects execute DCA by non-keeper", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    await ctx.program.methods
      .createDcaOrder(
        DCA_SIDE_BUY,
        new anchor.BN(10_000),
        new anchor.BN(5_000),
        new anchor.BN(10),
        new anchor.BN(1),
        new anchor.BN(0),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        mint: token.mint,
        whitelist: token.fundWhitelistPda,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        fundTokenVault: token.fundTokenVault,
        wsolMint: WSOL_MINT,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const rogue = anchor.web3.Keypair.generate();
    await expectError(
      ctx.program.methods
        .executeDcaOrder(orderId, Buffer.from([1]))
        .accounts({
          executor: rogue.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          whitelist: token.fundWhitelistPda,
          fundTokenVault: token.fundTokenVault,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          priceFeed: token.tokenPythFeed,
          solPriceFeed: ctx.solPythFeed,
          swapProgram: JUPITER_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([rogue])
        .rpc(),
      "Unauthorized",
    );

    await ctx.program.methods
      .cancelDcaOrder(orderId)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        whitelist: token.fundWhitelistPda,
        fundTokenVault: token.fundTokenVault,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  });

  it("Rejects execute DCA when not ready", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    await ctx.program.methods
      .createDcaOrder(
        DCA_SIDE_BUY,
        new anchor.BN(10_000),
        new anchor.BN(5_000),
        new anchor.BN(60),
        new anchor.BN(1),
        new anchor.BN(0),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        mint: token.mint,
        whitelist: token.fundWhitelistPda,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        fundTokenVault: token.fundTokenVault,
        wsolMint: WSOL_MINT,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await expectError(
      ctx.program.methods
        .executeDcaOrder(orderId, Buffer.from([1]))
        .accounts({
          executor: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          whitelist: token.fundWhitelistPda,
          fundTokenVault: token.fundTokenVault,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          priceFeed: token.tokenPythFeed,
          solPriceFeed: ctx.solPythFeed,
          swapProgram: JUPITER_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "DcaNotReady",
    );

    await ctx.program.methods
      .cancelDcaOrder(orderId)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        whitelist: token.fundWhitelistPda,
        fundTokenVault: token.fundTokenVault,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  });

  it("Rejects execute DCA when expired", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    const expiredTs = (await getClockUnixTimestamp(ctx.provider.connection)) - 1;

    await ctx.program.methods
      .createDcaOrder(
        DCA_SIDE_BUY,
        new anchor.BN(10_000),
        new anchor.BN(5_000),
        new anchor.BN(1),
        new anchor.BN(1),
        new anchor.BN(expiredTs),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        mint: token.mint,
        whitelist: token.fundWhitelistPda,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        fundTokenVault: token.fundTokenVault,
        wsolMint: WSOL_MINT,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await expectError(
      ctx.program.methods
        .executeDcaOrder(orderId, Buffer.from([1]))
        .accounts({
          executor: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          whitelist: token.fundWhitelistPda,
          fundTokenVault: token.fundTokenVault,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          priceFeed: token.tokenPythFeed,
          solPriceFeed: ctx.solPythFeed,
          swapProgram: JUPITER_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "OrderExpired",
    );

    await ctx.program.methods
      .cancelDcaOrder(orderId)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        whitelist: token.fundWhitelistPda,
        fundTokenVault: token.fundTokenVault,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  });

  it("Rejects execute DCA with invalid oracle", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    await ctx.program.methods
      .createDcaOrder(
        DCA_SIDE_BUY,
        new anchor.BN(10_000),
        new anchor.BN(5_000),
        new anchor.BN(1),
        new anchor.BN(1),
        new anchor.BN(0),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        mint: token.mint,
        whitelist: token.fundWhitelistPda,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        fundTokenVault: token.fundTokenVault,
        wsolMint: WSOL_MINT,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await new Promise((resolve) => setTimeout(resolve, 1200));

    await expectError(
      ctx.program.methods
        .executeDcaOrder(orderId, Buffer.from([1]))
        .accounts({
          executor: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          whitelist: token.fundWhitelistPda,
          fundTokenVault: token.fundTokenVault,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          priceFeed: token.tokenPythFeed,
          solPriceFeed: ctx.solPythFeed,
          swapProgram: JUPITER_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InvalidOracle",
    );

    await ctx.program.methods
      .cancelDcaOrder(orderId)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        whitelist: token.fundWhitelistPda,
        fundTokenVault: token.fundTokenVault,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  });

  it("Rejects cancel DCA by non-manager", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const { orderPda, orderSolVault, orderVaultAuth, orderTokenVault } =
      await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_BUY);

    await ctx.program.methods
      .createDcaOrder(
        DCA_SIDE_BUY,
        new anchor.BN(10_000),
        new anchor.BN(5_000),
        new anchor.BN(10),
        new anchor.BN(1),
        new anchor.BN(0),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        mint: token.mint,
        whitelist: token.fundWhitelistPda,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        fundTokenVault: token.fundTokenVault,
        wsolMint: WSOL_MINT,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const rogue = anchor.web3.Keypair.generate();
    await expectError(
      ctx.program.methods
        .cancelDcaOrder(orderId)
        .accounts({
          manager: rogue.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          whitelist: token.fundWhitelistPda,
          fundTokenVault: token.fundTokenVault,
          order: orderPda,
          orderSolVault,
          orderVaultAuth,
          orderTokenVault,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([rogue])
        .rpc(),
      "Unauthorized",
    );

    await ctx.program.methods
      .cancelDcaOrder(orderId)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        whitelist: token.fundWhitelistPda,
        fundTokenVault: token.fundTokenVault,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  });

  it("Rejects create DCA when max active reached", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    await airdropIfNeeded(
      ctx.provider,
      ctx.provider.wallet.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );

    const token = await addFundToken(ctx);
    const mintIx = createMintToInstruction(
      token.mint,
      token.fundTokenVault,
      ctx.provider.wallet.publicKey,
      100,
    );
    await ctx.provider.sendAndConfirm(new anchor.web3.Transaction().add(mintIx), []);

    const fundStateStart = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const maxActive = 20;
    const currentActive = fundStateStart.activeDcaCount;
    const toCreate = Math.max(0, maxActive - currentActive);

    if (toCreate === 0) {
      const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
      const orderId = new anchor.BN(fundState.nextOrderId.toString());
      const overflowAccounts = await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_SELL);
      await expectError(
        ctx.program.methods
          .createDcaOrder(
            DCA_SIDE_SELL,
            new anchor.BN(1),
            new anchor.BN(1),
            new anchor.BN(10),
            new anchor.BN(1),
            new anchor.BN(0),
          )
          .accounts({
            manager: ctx.provider.wallet.publicKey,
            config: ctx.configPda,
            fundState: ctx.fundPda,
            fundVault: ctx.vaultPda,
            mint: token.mint,
            whitelist: token.fundWhitelistPda,
            order: overflowAccounts.orderPda,
            orderSolVault: overflowAccounts.orderSolVault,
            orderVaultAuth: overflowAccounts.orderVaultAuth,
            orderTokenVault: overflowAccounts.orderTokenVault,
            fundTokenVault: token.fundTokenVault,
            wsolMint: WSOL_MINT,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .rpc(),
        "MaxActiveDca",
      );
      return;
    }

    const orders: Array<{
      orderId: anchor.BN;
      orderPda: anchor.web3.PublicKey;
      orderSolVault: anchor.web3.PublicKey;
      orderVaultAuth: anchor.web3.PublicKey;
      orderTokenVault: anchor.web3.PublicKey;
    }> = [];

    for (let i = 0; i < toCreate; i += 1) {
      const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
      const orderId = new anchor.BN(fundState.nextOrderId.toString());
      const accounts = await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_SELL);
      orders.push({ orderId, ...accounts });

      await ctx.program.methods
        .createDcaOrder(
          DCA_SIDE_SELL,
          new anchor.BN(1),
          new anchor.BN(1),
          new anchor.BN(10),
          new anchor.BN(1),
          new anchor.BN(0),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          mint: token.mint,
          whitelist: token.fundWhitelistPda,
          order: accounts.orderPda,
          orderSolVault: accounts.orderSolVault,
          orderVaultAuth: accounts.orderVaultAuth,
          orderTokenVault: accounts.orderTokenVault,
          fundTokenVault: token.fundTokenVault,
          wsolMint: WSOL_MINT,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    }

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const overflowAccounts = await deriveDcaAccounts(ctx, orderId, token.mint, DCA_SIDE_SELL);

    await expectError(
      ctx.program.methods
        .createDcaOrder(
          DCA_SIDE_SELL,
          new anchor.BN(1),
          new anchor.BN(1),
          new anchor.BN(10),
          new anchor.BN(1),
          new anchor.BN(0),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          mint: token.mint,
          whitelist: token.fundWhitelistPda,
          order: overflowAccounts.orderPda,
          orderSolVault: overflowAccounts.orderSolVault,
          orderVaultAuth: overflowAccounts.orderVaultAuth,
          orderTokenVault: overflowAccounts.orderTokenVault,
          fundTokenVault: token.fundTokenVault,
          wsolMint: WSOL_MINT,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "MaxActiveDca",
    );

    for (const order of orders) {
      await ctx.program.methods
        .cancelDcaOrder(order.orderId)
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          whitelist: token.fundWhitelistPda,
          fundTokenVault: token.fundTokenVault,
          order: order.orderPda,
          orderSolVault: order.orderSolVault,
          orderVaultAuth: order.orderVaultAuth,
          orderTokenVault: order.orderTokenVault,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    }
  });
});
