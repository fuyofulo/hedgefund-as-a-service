import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  addFundToken,
  ensureFund,
  ensureGlobalConfig,
  expectError,
  getContext,
  removeFundToken,
} from "../helpers";
import { createMintToInstruction } from "@solana/spl-token";

describe("borrow-settle", () => {
  it("Borrows and settles swap", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const amountIn = new anchor.BN(100_000_000);
    const minOut = new anchor.BN(1_000);

    const fundVaultBefore = await ctx.provider.connection.getBalance(ctx.vaultPda);
    const tokenBefore = await ctx.provider.connection.getTokenAccountBalance(
      token.fundTokenVault,
    );

    const borrowIx = await ctx.program.methods
      .borrowForSwap(amountIn, minOut)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        trading: ctx.tradingPda,
        fundVault: ctx.vaultPda,
        managerReceive: ctx.provider.wallet.publicKey,
        outputWhitelist: token.fundWhitelistPda,
        outputTokenVault: token.fundTokenVault,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    const mintToIx = createMintToInstruction(
      token.mint,
      token.fundTokenVault,
      ctx.provider.wallet.publicKey,
      minOut.toNumber() + 1000,
    );

    const settleIx = await ctx.program.methods
      .settleSwap()
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        trading: ctx.tradingPda,
        fundVault: ctx.vaultPda,
        outputWhitelist: token.fundWhitelistPda,
        outputTokenVault: token.fundTokenVault,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(
      borrowIx,
      mintToIx,
      settleIx,
    );
    await ctx.provider.sendAndConfirm(tx, []);

    const fundVaultAfter = await ctx.provider.connection.getBalance(ctx.vaultPda);
    const tokenAfter = await ctx.provider.connection.getTokenAccountBalance(
      token.fundTokenVault,
    );
    const trading = await ctx.program.account.trading.fetch(
      ctx.tradingPda,
    );

    expect(fundVaultBefore - fundVaultAfter).to.equal(amountIn.toNumber());
    expect(Number(tokenAfter.value.amount)).to.equal(
      Number(tokenBefore.value.amount) + minOut.toNumber() + 1000,
    );
    expect(trading.isLocked).to.equal(false);
    expect(trading.borrowAmount.toNumber()).to.equal(0);
    expect(trading.expectedMinOut.toNumber()).to.equal(0);
  });

  it("Rejects borrow without settle in same transaction", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const amountIn = new anchor.BN(1_000_000);
    const minOut = new anchor.BN(1);

    await expectError(
      ctx.program.methods
        .borrowForSwap(amountIn, minOut)
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
        trading: ctx.tradingPda,
          fundVault: ctx.vaultPda,
          managerReceive: ctx.provider.wallet.publicKey,
          outputWhitelist: token.fundWhitelistPda,
          outputTokenVault: token.fundTokenVault,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "MissingSettleInstruction",
    );

    await removeFundToken(ctx, token);
  });

  it("Rejects settle when fund is not locked", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    await expectError(
      ctx.program.methods
        .settleSwap()
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
        trading: ctx.tradingPda,
          fundVault: ctx.vaultPda,
          outputWhitelist: token.fundWhitelistPda,
          outputTokenVault: token.fundTokenVault,
        })
        .rpc(),
      "FundNotLocked",
    );

    await removeFundToken(ctx, token);
  });

  it("Rejects settle when min_out not met", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const amountIn = new anchor.BN(1_000_000);
    const minOut = new anchor.BN(10_000);

    const borrowIx = await ctx.program.methods
      .borrowForSwap(amountIn, minOut)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        trading: ctx.tradingPda,
        fundVault: ctx.vaultPda,
        managerReceive: ctx.provider.wallet.publicKey,
        outputWhitelist: token.fundWhitelistPda,
        outputTokenVault: token.fundTokenVault,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    const settleIx = await ctx.program.methods
      .settleSwap()
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        trading: ctx.tradingPda,
        fundVault: ctx.vaultPda,
        outputWhitelist: token.fundWhitelistPda,
        outputTokenVault: token.fundTokenVault,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(borrowIx, settleIx);

    await expectError(ctx.provider.sendAndConfirm(tx, []), "InvalidTokenVault");

    const trading = await ctx.program.account.trading.fetch(
      ctx.tradingPda,
    );
    if (trading.isLocked) {
      const unlockIx = await ctx.program.methods
        .settleSwap()
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          trading: ctx.tradingPda,
          fundVault: ctx.vaultPda,
          outputWhitelist: token.fundWhitelistPda,
          outputTokenVault: token.fundTokenVault,
        })
        .instruction();
      await ctx.provider.sendAndConfirm(new anchor.web3.Transaction().add(unlockIx), []);
    }

    await removeFundToken(ctx, token);
  });

  it("Rejects borrow with amount 0", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const amountIn = new anchor.BN(0);
    const minOut = new anchor.BN(1);

    await expectError(
      ctx.program.methods
        .borrowForSwap(amountIn, minOut)
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
        trading: ctx.tradingPda,
          fundVault: ctx.vaultPda,
          managerReceive: ctx.provider.wallet.publicKey,
          outputWhitelist: token.fundWhitelistPda,
          outputTokenVault: token.fundTokenVault,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "MathOverflow",
    );

    await removeFundToken(ctx, token);
  });

  it("Rejects borrow with min_out 0", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const amountIn = new anchor.BN(1_000_000);
    const minOut = new anchor.BN(0);

    await expectError(
      ctx.program.methods
        .borrowForSwap(amountIn, minOut)
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
        trading: ctx.tradingPda,
          fundVault: ctx.vaultPda,
          managerReceive: ctx.provider.wallet.publicKey,
          outputWhitelist: token.fundWhitelistPda,
          outputTokenVault: token.fundTokenVault,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InvalidMinOut",
    );

    await removeFundToken(ctx, token);
  });

  it("Rejects borrow with insufficient liquidity", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const vaultBalance = await ctx.provider.connection.getBalance(ctx.vaultPda);
    const amountIn = new anchor.BN(vaultBalance + 1);
    const minOut = new anchor.BN(1);

    await expectError(
      ctx.program.methods
        .borrowForSwap(amountIn, minOut)
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
        trading: ctx.tradingPda,
          fundVault: ctx.vaultPda,
          managerReceive: ctx.provider.wallet.publicKey,
          outputWhitelist: token.fundWhitelistPda,
          outputTokenVault: token.fundTokenVault,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InsufficientLiquidity",
    );

    await removeFundToken(ctx, token);
  });

  it("Rejects borrow with wrong instruction sysvar", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const amountIn = new anchor.BN(1_000_000);
    const minOut = new anchor.BN(1);

    await expectError(
      ctx.program.methods
        .borrowForSwap(amountIn, minOut)
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
        trading: ctx.tradingPda,
          fundVault: ctx.vaultPda,
          managerReceive: ctx.provider.wallet.publicKey,
          outputWhitelist: token.fundWhitelistPda,
          outputTokenVault: token.fundTokenVault,
          instructionsSysvar: anchor.web3.SystemProgram.programId,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InvalidSettleInstruction",
    );

    await removeFundToken(ctx, token);
  });

  it("Rejects borrow with non-manager receiver", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const amountIn = new anchor.BN(1_000_000);
    const minOut = new anchor.BN(1);
    const receiver = anchor.web3.Keypair.generate();

    await expectError(
      ctx.program.methods
        .borrowForSwap(amountIn, minOut)
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
        trading: ctx.tradingPda,
          fundVault: ctx.vaultPda,
          managerReceive: receiver.publicKey,
          outputWhitelist: token.fundWhitelistPda,
          outputTokenVault: token.fundTokenVault,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InvalidReceiver",
    );

    await removeFundToken(ctx, token);
  });

  it("Rejects settle when vault balance is unexpected", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const amountIn = new anchor.BN(1_000_000);
    const minOut = new anchor.BN(1);

    const borrowIx = await ctx.program.methods
      .borrowForSwap(amountIn, minOut)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        trading: ctx.tradingPda,
        fundVault: ctx.vaultPda,
        managerReceive: ctx.provider.wallet.publicKey,
        outputWhitelist: token.fundWhitelistPda,
        outputTokenVault: token.fundTokenVault,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    const bumpVaultIx = anchor.web3.SystemProgram.transfer({
      fromPubkey: ctx.provider.wallet.publicKey,
      toPubkey: ctx.vaultPda,
      lamports: 1,
    });

    const settleIx = await ctx.program.methods
      .settleSwap()
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        trading: ctx.tradingPda,
        fundVault: ctx.vaultPda,
        outputWhitelist: token.fundWhitelistPda,
        outputTokenVault: token.fundTokenVault,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(
      borrowIx,
      bumpVaultIx,
      settleIx,
    );

    await expectError(ctx.provider.sendAndConfirm(tx, []), "InvalidTokenVault");

    await removeFundToken(ctx, token);
  });

  it("Rejects settle with wrong output whitelist/vault", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const tokenA = await addFundToken(ctx);
    const tokenB = await addFundToken(ctx);
    const amountIn = new anchor.BN(1_000_000);
    const minOut = new anchor.BN(1);

    const borrowIx = await ctx.program.methods
      .borrowForSwap(amountIn, minOut)
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        trading: ctx.tradingPda,
        fundVault: ctx.vaultPda,
        managerReceive: ctx.provider.wallet.publicKey,
        outputWhitelist: tokenA.fundWhitelistPda,
        outputTokenVault: tokenA.fundTokenVault,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    const settleIx = await ctx.program.methods
      .settleSwap()
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        trading: ctx.tradingPda,
        fundVault: ctx.vaultPda,
        outputWhitelist: tokenB.fundWhitelistPda,
        outputTokenVault: tokenB.fundTokenVault,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(borrowIx, settleIx);
    await expectError(
      ctx.provider.sendAndConfirm(tx, []),
      "InvalidSettleInstruction",
    );

    await removeFundToken(ctx, tokenA);
    await removeFundToken(ctx, tokenB);
  });
});
