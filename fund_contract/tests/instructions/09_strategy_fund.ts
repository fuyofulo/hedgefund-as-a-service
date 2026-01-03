import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  airdropIfNeeded,
  ensureGlobalConfig,
  ensureFund,
  expectError,
  getContext,
} from "../helpers";
import {
  createMint,
  createSyncNativeInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

const FUND_TYPE_STRATEGY = 1;
const WSOL_MINT = new anchor.web3.PublicKey(
  "So11111111111111111111111111111111111111112",
);
const JUPITER_PROGRAM_ID = new anchor.web3.PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);

const deriveFundPdas = (
  ctx: Awaited<ReturnType<typeof getContext>>,
  fundId: anchor.BN,
) => {
  const fundIdSeed = fundId.toArrayLike(Buffer, "le", 8);
  const [fundPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("fund"),
      ctx.configPda.toBuffer(),
      ctx.provider.wallet.publicKey.toBuffer(),
      fundIdSeed,
    ],
    ctx.program.programId,
  );
  const [shareMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), fundPda.toBuffer()],
    ctx.program.programId,
  );
  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), fundPda.toBuffer()],
    ctx.program.programId,
  );
  const [strategyPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("strategy"), fundPda.toBuffer()],
    ctx.program.programId,
  );
  return { fundPda, shareMintPda, vaultPda, strategyPda };
};

const createStrategyFund = async (
  ctx: Awaited<ReturnType<typeof getContext>>,
  fundId: anchor.BN,
) => {
  const { fundPda, shareMintPda, vaultPda, strategyPda } = deriveFundPdas(
    ctx,
    fundId,
  );
  const managerShareAccount = await anchor.utils.token.associatedAddress({
    mint: shareMintPda,
    owner: ctx.provider.wallet.publicKey,
  });

  await ctx.program.methods
    .initializeStrategyFund(
      fundId,
      new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 20),
      new anchor.BN(0),
    )
    .accounts({
      manager: ctx.provider.wallet.publicKey,
      config: ctx.configPda,
      fundState: fundPda,
      shareMint: shareMintPda,
      managerShareAccount,
      fundVault: vaultPda,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  return { fundPda, shareMintPda, vaultPda, strategyPda };
};

const addTokenForFund = async (
  ctx: Awaited<ReturnType<typeof getContext>>,
  fundPda: anchor.web3.PublicKey,
  fundId: anchor.BN,
) => {
  const decimals = 6;
  const mint = await createMint(
    ctx.provider.connection,
    ctx.provider.wallet.payer,
    ctx.provider.wallet.publicKey,
    null,
    decimals,
  );
  const tokenPythFeed = anchor.web3.Keypair.generate().publicKey;
  const globalWhitelistPda = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("global_whitelist"), ctx.configPda.toBuffer(), mint.toBuffer()],
    ctx.program.programId,
  )[0];
  const fundWhitelistPda = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), fundPda.toBuffer(), mint.toBuffer()],
    ctx.program.programId,
  )[0];
  const fundTokenVault = await anchor.utils.token.associatedAddress({
    mint,
    owner: fundPda,
  });

  await ctx.program.methods
    .addToken(0, new anchor.BN(0), tokenPythFeed)
    .accounts({
      authority: ctx.provider.wallet.publicKey,
      config: ctx.configPda,
      mint,
      globalWhitelist: globalWhitelistPda,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    })
    .rpc();

  await ctx.program.methods
    .addToken(1, fundId, tokenPythFeed)
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
      { pubkey: fundPda, isWritable: true, isSigner: false },
      { pubkey: fundWhitelistPda, isWritable: true, isSigner: false },
      { pubkey: fundTokenVault, isWritable: true, isSigner: false },
    ])
    .rpc();

  return { mint, tokenPythFeed, globalWhitelistPda, fundWhitelistPda, fundTokenVault };
};

describe("strategy-fund", () => {
  it("Initializes a strategy fund", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(10);
    const { fundPda } = await createStrategyFund(ctx, fundId);

    const fund = await ctx.program.account.fundState.fetch(fundPda);
    expect(fund.fundType).to.equal(FUND_TYPE_STRATEGY);
  });

  it("Rejects initialize strategy fund with negative timelock", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(11);
    const { fundPda, shareMintPda, vaultPda } = deriveFundPdas(ctx, fundId);
    const managerShareAccount = await anchor.utils.token.associatedAddress({
      mint: shareMintPda,
      owner: ctx.provider.wallet.publicKey,
    });

    await expectError(
      ctx.program.methods
        .initializeStrategyFund(
          fundId,
          new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 20),
          new anchor.BN(-1),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: fundPda,
          shareMint: shareMintPda,
          managerShareAccount,
          fundVault: vaultPda,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc(),
      "InvalidTimelock",
    );
  });

  it("Sets strategy allocations (success)", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(12);
    const { fundPda, strategyPda } = await createStrategyFund(ctx, fundId);
    const tokenA = await addTokenForFund(ctx, fundPda, fundId);
    const tokenB = await addTokenForFund(ctx, fundPda, fundId);

    await ctx.program.methods
      .setStrategy(
        [
          { mint: tokenA.mint, weightBps: 6000 },
          { mint: tokenB.mint, weightBps: 4000 },
        ],
        200,
        new anchor.BN(60),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        fundState: fundPda,
        strategyConfig: strategyPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: tokenA.fundWhitelistPda, isWritable: false, isSigner: false },
        { pubkey: tokenB.fundWhitelistPda, isWritable: false, isSigner: false },
      ])
      .rpc();

    const strategy = await ctx.program.account.strategyConfig.fetch(strategyPda);
    expect(strategy.allocationCount).to.equal(2);
  });

  it("Rejects set_strategy on trading fund", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);

    const strategyPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("strategy"), ctx.fundPda.toBuffer()],
      ctx.program.programId,
    )[0];

    await expectError(
      ctx.program.methods
        .setStrategy(
          [{ mint: ctx.provider.wallet.publicKey, weightBps: 10_000 }],
          200,
          new anchor.BN(60),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          fundState: ctx.fundPda,
          strategyConfig: strategyPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InvalidFundType",
    );
  });

  it("Rejects set_strategy by non-manager", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(13);
    const { fundPda, strategyPda } = await createStrategyFund(ctx, fundId);
    const token = await addTokenForFund(ctx, fundPda, fundId);
    const rogue = anchor.web3.Keypair.generate();
    await airdropIfNeeded(
      ctx.provider,
      rogue.publicKey,
      anchor.web3.LAMPORTS_PER_SOL / 2,
    );

    await expectError(
      ctx.program.methods
        .setStrategy(
          [{ mint: token.mint, weightBps: 10_000 }],
          200,
          new anchor.BN(60),
        )
        .accounts({
          manager: rogue.publicKey,
          fundState: fundPda,
          strategyConfig: strategyPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([rogue])
        .remainingAccounts([
          { pubkey: token.fundWhitelistPda, isWritable: false, isSigner: false },
        ])
        .rpc(),
      "Unauthorized",
    );
  });

  it("Rejects set_strategy with allocation count mismatch", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(14);
    const { fundPda, strategyPda } = await createStrategyFund(ctx, fundId);

    await expectError(
      ctx.program.methods
        .setStrategy(
          [
            { mint: anchor.web3.Keypair.generate().publicKey, weightBps: 5000 },
            { mint: anchor.web3.Keypair.generate().publicKey, weightBps: 5000 },
          ],
          200,
          new anchor.BN(60),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          fundState: fundPda,
          strategyConfig: strategyPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InvalidStrategyConfig",
    );
  });

  it("Rejects set_strategy with weight sum mismatch", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(15);
    const { fundPda, strategyPda } = await createStrategyFund(ctx, fundId);
    const tokenA = await addTokenForFund(ctx, fundPda, fundId);
    const tokenB = await addTokenForFund(ctx, fundPda, fundId);

    await expectError(
      ctx.program.methods
        .setStrategy(
          [
            { mint: tokenA.mint, weightBps: 4000 },
            { mint: tokenB.mint, weightBps: 5000 },
          ],
          200,
          new anchor.BN(60),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          fundState: fundPda,
          strategyConfig: strategyPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InvalidStrategyConfig",
    );
  });

  it("Rejects set_strategy with duplicate mint", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(16);
    const { fundPda, strategyPda } = await createStrategyFund(ctx, fundId);
    const tokenA = await addTokenForFund(ctx, fundPda, fundId);
    await addTokenForFund(ctx, fundPda, fundId);

    await expectError(
      ctx.program.methods
        .setStrategy(
          [
            { mint: tokenA.mint, weightBps: 5000 },
            { mint: tokenA.mint, weightBps: 5000 },
          ],
          200,
          new anchor.BN(60),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          fundState: fundPda,
          strategyConfig: strategyPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InvalidStrategyConfig",
    );
  });

  it("Rejects set_strategy with more than 8 allocations", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(17);
    const { fundPda, strategyPda } = await createStrategyFund(ctx, fundId);

    const allocations = Array.from({ length: 9 }, () => ({
      mint: anchor.web3.Keypair.generate().publicKey,
      weightBps: 1,
    }));

    await expectError(
      ctx.program.methods
        .setStrategy(allocations, 200, new anchor.BN(60))
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          fundState: fundPda,
          strategyConfig: strategyPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "InvalidStrategyConfig",
    );
  });

  it("Rejects rebalance by non-keeper", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(18);
    const { fundPda, strategyPda, vaultPda } = await createStrategyFund(ctx, fundId);
    const token = await addTokenForFund(ctx, fundPda, fundId);

    await ctx.program.methods
      .setStrategy(
        [{ mint: token.mint, weightBps: 10_000 }],
        200,
        new anchor.BN(60),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        fundState: fundPda,
        strategyConfig: strategyPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: token.fundWhitelistPda, isWritable: false, isSigner: false },
      ])
      .rpc();

    const fundWsolVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: fundPda,
    });

    const rogue = anchor.web3.Keypair.generate();
    await airdropIfNeeded(
      ctx.provider,
      rogue.publicKey,
      anchor.web3.LAMPORTS_PER_SOL / 2,
    );

    await expectError(
      ctx.program.methods
        .rebalanceStrategy(token.mint, new anchor.BN(1), Buffer.from([1]))
        .accounts({
          executor: rogue.publicKey,
          config: ctx.configPda,
          fundState: fundPda,
          fundVault: vaultPda,
          strategyConfig: strategyPda,
          fundTokenVault: token.fundTokenVault,
          fundWsolVault,
          wsolMint: WSOL_MINT,
          solPriceFeed: ctx.solPythFeed,
          swapProgram: JUPITER_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([rogue])
        .rpc(),
      "Unauthorized",
    );
  });

  it("Rejects rebalance when cooldown not met", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(19);
    const { fundPda, strategyPda, vaultPda } = await createStrategyFund(ctx, fundId);
    const token = await addTokenForFund(ctx, fundPda, fundId);

    await ctx.program.methods
      .setStrategy(
        [{ mint: token.mint, weightBps: 10_000 }],
        200,
        new anchor.BN(600),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        fundState: fundPda,
        strategyConfig: strategyPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: token.fundWhitelistPda, isWritable: false, isSigner: false },
      ])
      .rpc();

    const fundWsolVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: fundPda,
    });

    await expectError(
      ctx.program.methods
        .rebalanceStrategy(token.mint, new anchor.BN(1), Buffer.from([1]))
        .accounts({
          executor: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: fundPda,
          fundVault: vaultPda,
          strategyConfig: strategyPda,
          fundTokenVault: token.fundTokenVault,
          fundWsolVault,
          wsolMint: WSOL_MINT,
          solPriceFeed: ctx.solPythFeed,
          swapProgram: JUPITER_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "RebalanceNotNeeded",
    );
  });

  it("Rejects rebalance when WSOL is not swept", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(24);
    const { fundPda, strategyPda, vaultPda } = await createStrategyFund(ctx, fundId);
    const token = await addTokenForFund(ctx, fundPda, fundId);

    await ctx.program.methods
      .setStrategy(
        [{ mint: token.mint, weightBps: 10_000 }],
        200,
        new anchor.BN(60),
      )
      .accounts({
        manager: ctx.provider.wallet.publicKey,
        fundState: fundPda,
        strategyConfig: strategyPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: token.fundWhitelistPda, isWritable: false, isSigner: false },
      ])
      .rpc();

    const fundWsolVault = await getOrCreateAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.provider.wallet.payer,
      WSOL_MINT,
      fundPda,
      true,
    );

    const wrapTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: ctx.provider.wallet.publicKey,
        toPubkey: fundWsolVault.address,
        lamports: 10_000,
      }),
      createSyncNativeInstruction(fundWsolVault.address),
    );
    await ctx.provider.sendAndConfirm(wrapTx);

    await expectError(
      ctx.program.methods
        .rebalanceStrategy(token.mint, new anchor.BN(1), Buffer.from([1]))
        .accounts({
          executor: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: fundPda,
          fundVault: vaultPda,
          strategyConfig: strategyPda,
          fundTokenVault: token.fundTokenVault,
          fundWsolVault: fundWsolVault.address,
          wsolMint: WSOL_MINT,
          solPriceFeed: ctx.solPythFeed,
          swapProgram: JUPITER_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(),
      "WsolNotCleared",
    );
  });

  it("Rejects limit order creation on strategy fund", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(20);
    const { fundPda, vaultPda } = await createStrategyFund(ctx, fundId);
    const token = await addTokenForFund(ctx, fundPda, fundId);

    const fundState = await ctx.program.account.fundState.fetch(fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("limit_order"), fundPda.toBuffer(), orderId.toArrayLike(Buffer, "le", 8)],
      ctx.program.programId,
    )[0];
    const orderVaultAuth = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("limit_order_vault_auth"), orderPda.toBuffer()],
      ctx.program.programId,
    )[0];
    const orderSolVault = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("limit_order_sol_vault"), orderPda.toBuffer()],
      ctx.program.programId,
    )[0];
    const orderTokenVault = await anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: orderVaultAuth,
    });

    await expectError(
      ctx.program.methods
        .createLimitOrder(
          0,
          new anchor.BN(10_000),
          new anchor.BN(1),
          new anchor.BN(1),
          0,
          new anchor.BN(0),
        )
        .accounts({
          manager: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: fundPda,
          fundVault: vaultPda,
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
      "InvalidFundType",
    );
  });

  it("Sweeps WSOL vault into fund vault (success)", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(23);
    const { fundPda, vaultPda } = await createStrategyFund(ctx, fundId);

    await airdropIfNeeded(
      ctx.provider,
      ctx.provider.wallet.publicKey,
      anchor.web3.LAMPORTS_PER_SOL,
    );

    const fundWsolVault = await getOrCreateAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.provider.wallet.payer,
      WSOL_MINT,
      fundPda,
      true,
    );

    const fundVaultBefore = await ctx.provider.connection.getBalance(vaultPda);
    const wrapAmount = 250_000;

    const wrapTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: ctx.provider.wallet.publicKey,
        toPubkey: fundWsolVault.address,
        lamports: wrapAmount,
      }),
      createSyncNativeInstruction(fundWsolVault.address),
    );
    await ctx.provider.sendAndConfirm(wrapTx);

    await ctx.program.methods
      .sweepWsol()
      .accounts({
        executor: ctx.provider.wallet.publicKey,
        config: ctx.configPda,
        fundState: fundPda,
        fundVault: vaultPda,
        fundWsolVault: fundWsolVault.address,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();

    const fundVaultAfter = await ctx.provider.connection.getBalance(vaultPda);
    expect(fundVaultAfter).to.be.greaterThan(fundVaultBefore);

    const wsolInfo = await ctx.provider.connection.getAccountInfo(
      fundWsolVault.address,
    );
    expect(wsolInfo).to.equal(null);
  });

  it("Rejects sweep_wsol by non-keeper", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(21);
    const { fundPda, vaultPda } = await createStrategyFund(ctx, fundId);

    const fundWsolVault = await getOrCreateAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.provider.wallet.payer,
      WSOL_MINT,
      fundPda,
      true,
    );

    const rogue = anchor.web3.Keypair.generate();
    await airdropIfNeeded(
      ctx.provider,
      rogue.publicKey,
      anchor.web3.LAMPORTS_PER_SOL / 2,
    );

    await expectError(
      ctx.program.methods
        .sweepWsol()
        .accounts({
          executor: rogue.publicKey,
          config: ctx.configPda,
          fundState: fundPda,
          fundVault: vaultPda,
          fundWsolVault: fundWsolVault.address,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([rogue])
        .rpc(),
      "Unauthorized",
    );
  });

  it("Rejects sweep_wsol with wrong vault", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);

    const fundId = new anchor.BN(22);
    const { fundPda, vaultPda } = await createStrategyFund(ctx, fundId);

    const wrongMint = await createMint(
      ctx.provider.connection,
      ctx.provider.wallet.payer,
      ctx.provider.wallet.publicKey,
      null,
      6,
    );
    const wrongVault = await getOrCreateAssociatedTokenAccount(
      ctx.provider.connection,
      ctx.provider.wallet.payer,
      wrongMint,
      fundPda,
      true,
    );

    await expectError(
      ctx.program.methods
        .sweepWsol()
        .accounts({
          executor: ctx.provider.wallet.publicKey,
          config: ctx.configPda,
          fundState: fundPda,
          fundVault: vaultPda,
          fundWsolVault: wrongVault.address,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .rpc(),
      "InvalidOrderVault",
    );
  });
});
