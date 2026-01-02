import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { createMintToInstruction } from "@solana/spl-token";
import {
  addFundToken,
  ensureFund,
  ensureGlobalConfig,
  getContext,
  expectError,
} from "../helpers";

describe("remove-token", () => {
  it("Removes token via unified remove_token", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    await ctx.program.methods
      .removeToken(1, ctx.fundId)
      .accounts({
        authority: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        mint: token.mint,
        globalWhitelist: token.globalWhitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: ctx.fundPda, isWritable: true, isSigner: false },
        { pubkey: token.fundWhitelistPda, isWritable: true, isSigner: false },
        { pubkey: token.fundTokenVault, isWritable: true, isSigner: false },
      ])
      .rpc();

    const fundWhitelistInfo = await ctx.provider.connection.getAccountInfo(
      token.fundWhitelistPda,
    );
    const fundVaultInfo = await ctx.provider.connection.getAccountInfo(
      token.fundTokenVault,
    );
    expect(fundWhitelistInfo).to.equal(null);
    expect(fundVaultInfo).to.not.equal(null);

    await ctx.program.methods
      .removeToken(0, new anchor.BN(0))
      .accounts({
        authority: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        mint: token.mint,
        globalWhitelist: token.globalWhitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const globalWhitelistInfo = await ctx.provider.connection.getAccountInfo(
      token.globalWhitelistPda,
    );
    expect(globalWhitelistInfo).to.equal(null);
  });

  it("Rejects remove token when vault has balance", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const mintToIx = createMintToInstruction(
      token.mint,
      token.fundTokenVault,
      ctx.provider.wallet.publicKey,
      1,
    );
    await ctx.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(mintToIx),
      [],
    );

    await expectError(
      ctx.program.methods
        .removeToken(1, ctx.fundId)
        .accounts({
          authority: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          mint: token.mint,
          globalWhitelist: token.globalWhitelistPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: ctx.fundPda, isWritable: true, isSigner: false },
          { pubkey: token.fundWhitelistPda, isWritable: true, isSigner: false },
          { pubkey: token.fundTokenVault, isWritable: true, isSigner: false },
        ])
        .rpc(),
      "TokenVaultNotEmpty",
    );
  });
});
