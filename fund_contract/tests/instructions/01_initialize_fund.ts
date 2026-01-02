import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { expectError, getContext, ensureGlobalConfig, ensureFund } from "../helpers";

describe("initialize-fund", () => {
  it("Initializes fund", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const fundAccount = await ctx.program.account.fundState.fetch(ctx.fundPda);
    expect(fundAccount.manager.toBase58()).to.equal(
      ctx.provider.wallet.publicKey.toBase58(),
    );
    expect(fundAccount.config.toBase58()).to.equal(ctx.configPda.toBase58());
    expect(fundAccount.fundId.toNumber()).to.equal(ctx.fundId.toNumber());
    expect(fundAccount.shareMint.toBase58()).to.equal(
      ctx.shareMintPda.toBase58(),
    );
    expect(fundAccount.vault.toBase58()).to.equal(ctx.vaultPda.toBase58());
    expect(fundAccount.minInvestorDepositLamports.toNumber()).to.equal(
      Math.floor(anchor.web3.LAMPORTS_PER_SOL / 20),
    );
    expect(fundAccount.withdrawTimelockSecs.toNumber()).to.equal(0);

    const managerShareAccount = await anchor.utils.token.associatedAddress({
      mint: ctx.shareMintPda,
      owner: ctx.provider.wallet.publicKey,
    });
    const shareBalance = await ctx.provider.connection.getTokenAccountBalance(
      managerShareAccount,
    );
    const configAccount = await ctx.program.account.globalConfig.fetch(
      ctx.configPda,
    );
    expect(shareBalance.value.amount).to.equal(
      configAccount.minManagerDepositLamports.toString(),
    );
  });

  it("Rejects initialize fund with negative timelock", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const badFundId = new anchor.BN(999);
    const badFundSeed = badFundId.toArrayLike(Buffer, "le", 8);
    const [badFundPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("fund"),
        ctx.configPda.toBuffer(),
        ctx.provider.wallet.publicKey.toBuffer(),
        badFundSeed,
      ],
      ctx.program.programId,
    );
    const [badShareMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), badFundPda.toBuffer()],
      ctx.program.programId,
    );
    const [badVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), badFundPda.toBuffer()],
      ctx.program.programId,
    );
    const managerShareAccount = await anchor.utils.token.associatedAddress({
      mint: badShareMint,
      owner: ctx.provider.wallet.publicKey,
    });

    await expectError(
      ctx.program.methods
        .initializeFund(badFundId, new anchor.BN(1), new anchor.BN(-1))
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: badFundPda,
          shareMint: badShareMint,
          managerShareAccount,
          fundVault: badVault,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "InvalidTimelock",
    );
  });
});
