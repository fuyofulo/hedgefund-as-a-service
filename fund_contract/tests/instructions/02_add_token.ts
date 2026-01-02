import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { createMint } from "@solana/spl-token";
import {
  decodeFundWhitelist,
  ensureFund,
  ensureGlobalConfig,
  getContext,
  addFundToken,
  expectError,
  removeFundToken,
} from "../helpers";

describe("add-token", () => {
  it("Adds token via unified add_token", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);

    const whitelistInfo = await ctx.provider.connection.getAccountInfo(
      token.fundWhitelistPda,
    );
    expect(whitelistInfo).to.not.equal(null);
    const whitelistAccount = decodeFundWhitelist(whitelistInfo!.data);
    expect(whitelistAccount.mint.toBase58()).to.equal(token.mint.toBase58());
    expect(whitelistAccount.fund.toBase58()).to.equal(ctx.fundPda.toBase58());
    expect(whitelistAccount.decimals).to.equal(6);
    expect(whitelistAccount.pythFeed.toBase58()).to.equal(
      token.tokenPythFeed.toBase58(),
    );
    expect(whitelistAccount.enabled).to.equal(true);

    await removeFundToken(ctx, token);
  });

  it("Rejects add token to fund without global whitelist", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const mint = await createMint(
      ctx.provider.connection,
      ctx.provider.wallet.payer,
      ctx.provider.wallet.publicKey,
      null,
      6,
    );
    const tokenPythFeed = anchor.web3.Keypair.generate().publicKey;
    const globalWhitelistPda =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global_whitelist"), ctx.configPda.toBuffer(), mint.toBuffer()],
        ctx.program.programId,
      )[0];
    const fundWhitelistPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), ctx.fundPda.toBuffer(), mint.toBuffer()],
      ctx.program.programId,
    )[0];
    const fundTokenVault = await anchor.utils.token.associatedAddress({
      mint,
      owner: ctx.fundPda,
    });

    await expectError(
      ctx.program.methods
        .addToken(1, ctx.fundId, tokenPythFeed)
        .accounts({
          authority: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          mint,
          globalWhitelist: globalWhitelistPda,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: ctx.fundPda, isWritable: true, isSigner: false },
          { pubkey: fundWhitelistPda, isWritable: true, isSigner: false },
          { pubkey: fundTokenVault, isWritable: true, isSigner: false },
        ])
        .rpc(),
      "InvalidTokenVault",
    );
  });

  it("Rejects add token by non-manager", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const token = await addFundToken(ctx);
    const rogue = anchor.web3.Keypair.generate();

    await expectError(
      ctx.program.methods
        .addToken(1, ctx.fundId, token.tokenPythFeed)
        .accounts({
          authority: rogue.publicKey,
          config: ctx.configPda,
          mint: token.mint,
          globalWhitelist: token.globalWhitelistPda,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: ctx.fundPda, isWritable: true, isSigner: false },
          { pubkey: token.fundWhitelistPda, isWritable: true, isSigner: false },
          { pubkey: token.fundTokenVault, isWritable: true, isSigner: false },
        ])
        .signers([rogue])
        .rpc(),
      "Unauthorized",
    );

    await removeFundToken(ctx, token);
  });
});
