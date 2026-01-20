import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  airdropIfNeeded,
  ensureFund,
  ensureGlobalConfig,
  expectError,
  getContext,
} from "../helpers";

describe("withdraw", () => {
  const ensureInvestorShares = async (ctx: Awaited<ReturnType<typeof getContext>>) => {
    const investorShareAccount =
      await anchor.utils.token.associatedAddress({
        mint: ctx.shareMintPda,
        owner: ctx.investor.publicKey,
      });
    const balance = await ctx.provider.connection.getTokenAccountBalance(
      investorShareAccount,
    );
    if (Number(balance.value.amount) > 0) {
      return investorShareAccount;
    }

    await airdropIfNeeded(
      ctx.provider,
      ctx.investor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await ctx.program.methods
      .deposit(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 4))
      .accounts({
        investor: ctx.investor.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        shareMint: ctx.shareMintPda,
        investorShareAccount,
        feeTreasury: ctx.feeTreasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([ctx.investor])
      .rpc();

    return investorShareAccount;
  };

  it("Requests and executes withdraw", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const investorShareAccount = await ensureInvestorShares(ctx);
    const withdrawRequestPda =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("withdraw"),
          ctx.fundPda.toBuffer(),
          ctx.investor.publicKey.toBuffer(),
        ],
        ctx.program.programId,
      )[0];

    const shareBalanceBefore =
      await ctx.provider.connection.getTokenAccountBalance(investorShareAccount);
    const sharesToWithdraw = Math.floor(
      Number(shareBalanceBefore.value.amount) / 2,
    );

    await ctx.program.methods
      .requestWithdraw(new anchor.BN(sharesToWithdraw))
      .accounts({
        investor: ctx.investor.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        shareMint: ctx.shareMintPda,
        investorShareAccount,
        withdrawRequest: withdrawRequestPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([ctx.investor])
      .rpc();

    const fundVaultBefore = await ctx.provider.connection.getBalance(ctx.vaultPda);
    const feeTreasuryBefore = await ctx.provider.connection.getBalance(
      ctx.feeTreasury.publicKey,
    );
    const fundStateBefore = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const configAccount = await ctx.program.account.globalConfig.fetch(ctx.configPda);

    const gross = Math.floor(
      (sharesToWithdraw * fundVaultBefore) /
        fundStateBefore.totalShares.toNumber(),
    );
    const fee = Math.floor((gross * configAccount.withdrawFeeBps) / 10000);

    await ctx.program.methods
      .executeWithdraw()
      .accounts({
        investor: ctx.investor.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        shareMint: ctx.shareMintPda,
        investorShareAccount,
        withdrawRequest: withdrawRequestPda,
        feeTreasury: ctx.feeTreasury.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([ctx.investor])
      .rpc();

    const fundVaultAfter = await ctx.provider.connection.getBalance(ctx.vaultPda);
    const feeTreasuryAfter = await ctx.provider.connection.getBalance(
      ctx.feeTreasury.publicKey,
    );
    const shareBalanceAfter =
      await ctx.provider.connection.getTokenAccountBalance(investorShareAccount);
    const fundStateAfter = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const requestInfo = await ctx.provider.connection.getAccountInfo(
      withdrawRequestPda,
    );

    expect(fundVaultBefore - fundVaultAfter).to.equal(gross);
    expect(feeTreasuryAfter - feeTreasuryBefore).to.equal(fee);
    expect(Number(shareBalanceAfter.value.amount)).to.equal(
      Number(shareBalanceBefore.value.amount) - sharesToWithdraw,
    );
    expect(fundStateAfter.totalShares.toNumber()).to.equal(
      fundStateBefore.totalShares.toNumber() - sharesToWithdraw,
    );
    expect(requestInfo).to.equal(null);
  });

  it("Cancels withdraw request", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const investorShareAccount = await ensureInvestorShares(ctx);
    const withdrawRequestPda =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("withdraw"),
          ctx.fundPda.toBuffer(),
          ctx.investor.publicKey.toBuffer(),
        ],
        ctx.program.programId,
      )[0];

    const shareBalanceBefore =
      await ctx.provider.connection.getTokenAccountBalance(investorShareAccount);
    const sharesToWithdraw = Math.max(
      1,
      Math.floor(Number(shareBalanceBefore.value.amount) / 4),
    );

    await ctx.program.methods
      .requestWithdraw(new anchor.BN(sharesToWithdraw))
      .accounts({
        investor: ctx.investor.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        shareMint: ctx.shareMintPda,
        investorShareAccount,
        withdrawRequest: withdrawRequestPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([ctx.investor])
      .rpc();

    await ctx.program.methods
      .cancelWithdraw()
      .accounts({
        investor: ctx.investor.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        withdrawRequest: withdrawRequestPda,
      })
      .signers([ctx.investor])
      .rpc();

    const shareBalanceAfter =
      await ctx.provider.connection.getTokenAccountBalance(investorShareAccount);
    const requestInfo = await ctx.provider.connection.getAccountInfo(
      withdrawRequestPda,
    );
    expect(Number(shareBalanceAfter.value.amount)).to.equal(
      Number(shareBalanceBefore.value.amount),
    );
    expect(requestInfo).to.equal(null);
  });

  it("Rejects execute withdraw without request", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const investorShareAccount = await ensureInvestorShares(ctx);
    const withdrawRequestPda =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("withdraw"),
          ctx.fundPda.toBuffer(),
          ctx.investor.publicKey.toBuffer(),
        ],
        ctx.program.programId,
      )[0];

    const computeIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
      units: 200_000 + Math.floor(Math.random() * 1_000),
    });

    await expectError(
      ctx.program.methods
        .executeWithdraw()
        .accounts({
          investor: ctx.investor.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          fundVault: ctx.vaultPda,
          shareMint: ctx.shareMintPda,
          investorShareAccount,
          withdrawRequest: withdrawRequestPda,
          feeTreasury: ctx.feeTreasury.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .preInstructions([computeIx])
        .signers([ctx.investor])
        .rpc(),
      "AccountNotInitialized",
    );
  });

  it("Rejects cancel withdraw by non-owner", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const investorShareAccount = await ensureInvestorShares(ctx);
    const withdrawRequestPda =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("withdraw"),
          ctx.fundPda.toBuffer(),
          ctx.investor.publicKey.toBuffer(),
        ],
        ctx.program.programId,
      )[0];

    await ctx.program.methods
      .requestWithdraw(new anchor.BN(1))
      .accounts({
        investor: ctx.investor.publicKey,
        config: ctx.configPda,
        fundState: ctx.fundPda,
        shareMint: ctx.shareMintPda,
        investorShareAccount,
        withdrawRequest: withdrawRequestPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([ctx.investor])
      .rpc();

    const rogue = anchor.web3.Keypair.generate();
    await expectError(
      ctx.program.methods
        .cancelWithdraw()
        .accounts({
          investor: rogue.publicKey,
          config: ctx.configPda,
          fundState: ctx.fundPda,
          withdrawRequest: withdrawRequestPda,
        })
        .signers([rogue])
        .rpc(),
      "ConstraintSeeds",
    );
  });
});
