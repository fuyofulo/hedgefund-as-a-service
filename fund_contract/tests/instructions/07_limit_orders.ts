import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  addFundToken,
  airdropIfNeeded,
  ensureFund,
  ensureGlobalConfig,
  expectError,
  getClockUnixTimestamp,
  getContext,
  removeFundToken,
} from "../helpers";
import { createMintToInstruction } from "@solana/spl-token";

const JUPITER_PROGRAM_ID = new anchor.web3.PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);

const SIDE_BUY = 0;
const SIDE_SELL = 1;
const WSOL_MINT = new anchor.web3.PublicKey(
  "So11111111111111111111111111111111111111112"
);

const deriveOrderPda = (
  fundPda: anchor.web3.PublicKey,
  orderId: anchor.BN,
  programId: anchor.web3.PublicKey
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("limit_order"),
      fundPda.toBuffer(),
      orderId.toArrayLike(Buffer, "le", 8),
    ],
    programId
  )[0];

const deriveOrderSolVault = (
  orderPda: anchor.web3.PublicKey,
  programId: anchor.web3.PublicKey
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("limit_order_sol_vault"), orderPda.toBuffer()],
    programId
  )[0];

const deriveOrderVaultAuth = (
  orderPda: anchor.web3.PublicKey,
  programId: anchor.web3.PublicKey
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("limit_order_vault_auth"), orderPda.toBuffer()],
    programId
  )[0];

describe("limit-orders", () => {
  it("Creates and cancels a buy limit order", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });

    const fundVaultBefore = await ctx.provider.connection.getBalance(
      ctx.vaultPda
    );

    await ctx.program.methods
      .createLimitOrder(
        SIDE_BUY,
        new anchor.BN(100_000),
        new anchor.BN(1),
        new anchor.BN(1),
        0,
        new anchor.BN(0)
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

    const orderAccount = await ctx.program.account.limitOrder.fetch(orderPda);
    expect(orderAccount.status).to.equal(0);
    expect(orderAccount.side).to.equal(SIDE_BUY);

    const orderSolBalance = await ctx.provider.connection.getBalance(
      orderSolVault
    );
    const fundVaultAfter = await ctx.provider.connection.getBalance(
      ctx.vaultPda
    );
    expect(orderSolBalance).to.be.greaterThan(0);
    expect(fundVaultBefore - fundVaultAfter).to.equal(100_000);

    await ctx.program.methods
      .cancelLimitOrder(orderId)
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

    const orderInfo = await ctx.provider.connection.getAccountInfo(orderPda);
    const solVaultInfo = await ctx.provider.connection.getAccountInfo(
      orderSolVault
    );
    expect(orderInfo).to.equal(null);
    expect(solVaultInfo).to.equal(null);
  });

  it("Rejects buy order with non-WSOL vault", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId); // <-- add this

    await expectError(
      ctx.program.methods
        .createLimitOrder(
          SIDE_BUY,
          new anchor.BN(10_000),
          new anchor.BN(1),
          new anchor.BN(1),
          0,
          new anchor.BN(0)
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
          orderTokenVault: token.fundTokenVault,
          fundTokenVault: token.fundTokenVault,
          wsolMint: WSOL_MINT,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "InvalidOrderVault"
    );
  });

  it("Creates and cancels a sell limit order", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const mintIx = createMintToInstruction(
      token.mint,
      token.fundTokenVault,
      ctx.provider.wallet.publicKey,
      1_000
    );
    await ctx.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(mintIx),
      []
    );

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: token.mint,
      owner: orderVaultAuth,
    });

    const fundTokenBefore =
      await ctx.provider.connection.getTokenAccountBalance(
        token.fundTokenVault
      );

    await ctx.program.methods
      .createLimitOrder(
        SIDE_SELL,
        new anchor.BN(500),
        new anchor.BN(1),
        new anchor.BN(1),
        0,
        new anchor.BN(0)
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
      token.fundTokenVault
    );
    expect(
      Number(fundTokenBefore.value.amount) - Number(fundTokenAfter.value.amount)
    ).to.equal(500);

    await ctx.program.methods
      .cancelLimitOrder(orderId)
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

    const orderInfo = await ctx.provider.connection.getAccountInfo(orderPda);
    expect(orderInfo).to.equal(null);
  });

  it("Rejects execute when oracle account is invalid", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    await airdropIfNeeded(ctx.provider, token.tokenPythFeed, 1);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);

    await ctx.program.methods
      .createLimitOrder(
        SIDE_BUY,
        new anchor.BN(50_000),
        new anchor.BN(1),
        new anchor.BN(1),
        0,
        new anchor.BN(0)
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
        .executeLimitOrder(orderId, Buffer.from([1]))
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
      "InvalidOracle"
    );

    await removeFundToken(ctx, token);
  });

  it("Rejects create limit order by non-manager", async () => {
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
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });

    await expectError(
      ctx.program.methods
        .createLimitOrder(
          SIDE_BUY,
          new anchor.BN(10_000),
          new anchor.BN(1),
          new anchor.BN(1),
          0,
          new anchor.BN(0)
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
      "Unauthorized"
    );
  });

  it("Rejects create limit order with zero amount", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });

    await expectError(
      ctx.program.methods
        .createLimitOrder(
          SIDE_BUY,
          new anchor.BN(0),
          new anchor.BN(1),
          new anchor.BN(1),
          0,
          new anchor.BN(0)
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
      "MathOverflow"
    );
  });

  it("Rejects create limit order with zero min_out", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });

    await expectError(
      ctx.program.methods
        .createLimitOrder(
          SIDE_BUY,
          new anchor.BN(10_000),
          new anchor.BN(0),
          new anchor.BN(1),
          0,
          new anchor.BN(0)
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
      "InvalidMinOut"
    );
  });

  it("Rejects create limit order with invalid side", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });

    await expectError(
      ctx.program.methods
        .createLimitOrder(
          3,
          new anchor.BN(10_000),
          new anchor.BN(1),
          new anchor.BN(1),
          0,
          new anchor.BN(0)
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
      "InvalidOrderSide"
    );
  });

  it("Rejects create limit order with insufficient liquidity", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });

    const tooLarge = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL);

    await expectError(
      ctx.program.methods
        .createLimitOrder(
          SIDE_BUY,
          tooLarge,
          new anchor.BN(1),
          new anchor.BN(1),
          0,
          new anchor.BN(0)
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
      "InsufficientLiquidity"
    );
  });

  it("Rejects execute limit order by non-keeper", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);

    await ctx.program.methods
      .createLimitOrder(
        SIDE_BUY,
        new anchor.BN(10_000),
        new anchor.BN(1),
        new anchor.BN(1),
        0,
        new anchor.BN(0)
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
        .executeLimitOrder(orderId, Buffer.from([1]))
        .accounts({
          executor: ctx.investor.publicKey,
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
        .signers([ctx.investor])
        .rpc(),
      "Unauthorized"
    );
  });

  it("Rejects execute limit order when expired", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);

    const expiry = new anchor.BN(
      (await getClockUnixTimestamp(ctx.provider.connection)) - 5
    );

    await ctx.program.methods
      .createLimitOrder(
        SIDE_BUY,
        new anchor.BN(10_000),
        new anchor.BN(1),
        new anchor.BN(1),
        0,
        expiry
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
        .executeLimitOrder(orderId, Buffer.from([1]))
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
      "OrderExpired"
    );
  });

  it("Rejects cancel limit order by non-manager", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const rogue = anchor.web3.Keypair.generate();

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = deriveOrderPda(
      ctx.fundPda,
      orderId,
      ctx.program.programId
    );
    const orderVaultAuth = deriveOrderVaultAuth(
      orderPda,
      ctx.program.programId
    );
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });
    const orderSolVault = deriveOrderSolVault(orderPda, ctx.program.programId);

    await ctx.program.methods
      .createLimitOrder(
        SIDE_BUY,
        new anchor.BN(10_000),
        new anchor.BN(1),
        new anchor.BN(1),
        0,
        new anchor.BN(0)
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
        .cancelLimitOrder(orderId)
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
      "Unauthorized"
    );
  });
});
