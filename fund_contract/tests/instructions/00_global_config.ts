import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { getContext, ensureGlobalConfig } from "../helpers";
import { expectError } from "../helpers";

describe("global-config", () => {
  it("Initializes global config", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const configAccount = await ctx.program.account.globalConfig.fetch(
      ctx.configPda,
    );
    expect(configAccount.admin.toBase58()).to.equal(
      ctx.provider.wallet.publicKey.toBase58(),
    );
    expect(configAccount.configId.toNumber()).to.equal(ctx.configId.toNumber());
    expect(configAccount.feeTreasury.toBase58()).to.equal(
      ctx.feeTreasury.publicKey.toBase58(),
    );
    expect(configAccount.solUsdPythFeed.toBase58()).to.equal(
      ctx.solPythFeed.toBase58(),
    );
    expect(configAccount.pythProgramId.toBase58()).to.equal(
      ctx.pythProgramId.toBase58(),
    );
    expect(configAccount.depositFeeBps).to.equal(50);
    expect(configAccount.withdrawFeeBps).to.equal(25);
    expect(configAccount.tradeFeeBps).to.equal(10);
    expect(configAccount.minManagerDepositLamports.toNumber()).to.equal(
      Math.floor(anchor.web3.LAMPORTS_PER_SOL / 10),
    );
  });

  it("Updates global config", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const newDepositFeeBps = 75;
    const newWithdrawFeeBps = 35;
    const newTradeFeeBps = 20;
    const newMinManagerDepositLamports = new anchor.BN(
      anchor.web3.LAMPORTS_PER_SOL / 5,
    );

    await ctx.program.methods
      .updateGlobalConfig(
        ctx.configId,
        ctx.solPythFeed,
        ctx.pythProgramId,
        newDepositFeeBps,
        newWithdrawFeeBps,
        newTradeFeeBps,
        newMinManagerDepositLamports,
      )
      .accounts({
        config: ctx.configPda,
        admin: ctx.provider.wallet.publicKey,
        feeTreasury: ctx.feeTreasury.publicKey,
      })
      .rpc();

    const configAccount = await ctx.program.account.globalConfig.fetch(
      ctx.configPda,
    );
    expect(configAccount.depositFeeBps).to.equal(newDepositFeeBps);
    expect(configAccount.withdrawFeeBps).to.equal(newWithdrawFeeBps);
    expect(configAccount.tradeFeeBps).to.equal(newTradeFeeBps);
    expect(configAccount.minManagerDepositLamports.toNumber()).to.equal(
      newMinManagerDepositLamports.toNumber(),
    );
  });

  it("Rejects initialize with invalid fee bps", async () => {
    const ctx = await getContext();
    const badConfigId = new anchor.BN(Date.now() + 1);
    const badSeed = badConfigId.toArrayLike(Buffer, "le", 8);
    const [badConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config"), badSeed],
      ctx.program.programId,
    );

    await expectError(
      ctx.program.methods
        .initializeGlobalConfig(
          badConfigId,
          ctx.solPythFeed,
          ctx.pythProgramId,
          20_000,
          0,
          0,
          new anchor.BN(1),
        )
        .accounts({
          config: badConfigPda,
          admin: ctx.provider.wallet.publicKey,
          feeTreasury: ctx.feeTreasury.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InvalidFeeBps",
    );
  });

  it("Rejects update from non-admin", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    const rogue = anchor.web3.Keypair.generate();

    await expectError(
      ctx.program.methods
        .updateGlobalConfig(
          ctx.configId,
          ctx.solPythFeed,
          ctx.pythProgramId,
          10,
          10,
          10,
          new anchor.BN(1),
        )
        .accounts({
          config: ctx.configPda,
          admin: rogue.publicKey,
          feeTreasury: ctx.feeTreasury.publicKey,
        })
        .signers([rogue])
        .rpc(),
      "ConstraintHasOne",
    );
  });
});
