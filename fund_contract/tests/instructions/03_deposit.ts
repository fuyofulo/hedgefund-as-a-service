import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  addFundToken,
  airdropIfNeeded,
  ensureFund,
  ensureGlobalConfig,
  expectError,
  getContext,
  removeFundToken,
} from "../helpers";

describe("deposit", () => {
  it("Rejects deposit with missing token accounts", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);
    await airdropIfNeeded(
      ctx.provider,
      ctx.investor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );

    const token = await addFundToken(ctx);
    const investorShareAccount =
      await anchor.utils.token.associatedAddress({
        mint: ctx.shareMintPda,
        owner: ctx.investor.publicKey,
      });
    const amountLamports = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 4);

    await expectError(
      ctx.program.methods
        .deposit(amountLamports)
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
        .rpc(),
      "InvalidRemainingAccounts",
    );

    await removeFundToken(ctx, token);
  });

  it("Rejects deposit with unordered token triplets", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);
    await airdropIfNeeded(
      ctx.provider,
      ctx.investor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await airdropIfNeeded(ctx.provider, ctx.solPythFeed, 1);

    const tokenA = await addFundToken(ctx);
    const tokenB = await addFundToken(ctx);
    await airdropIfNeeded(ctx.provider, tokenA.tokenPythFeed, 1);
    await airdropIfNeeded(ctx.provider, tokenB.tokenPythFeed, 1);

    const investorShareAccount =
      await anchor.utils.token.associatedAddress({
        mint: ctx.shareMintPda,
        owner: ctx.investor.publicKey,
      });
    const amountLamports = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 4);

    const ordered =
      tokenA.mint.toBuffer().compare(tokenB.mint.toBuffer()) < 0
        ? [tokenA, tokenB]
        : [tokenB, tokenA];
    const reversed = [ordered[1], ordered[0]];

    await expectError(
      ctx.program.methods
        .deposit(amountLamports)
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
        .remainingAccounts([
          { pubkey: ctx.solPythFeed, isWritable: false, isSigner: false },
          {
            pubkey: reversed[0].fundWhitelistPda,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey: reversed[0].fundTokenVault,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey: reversed[0].tokenPythFeed,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey: reversed[1].fundWhitelistPda,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey: reversed[1].fundTokenVault,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey: reversed[1].tokenPythFeed,
            isWritable: false,
            isSigner: false,
          },
        ])
        .signers([ctx.investor])
        .rpc(),
      "InvalidWhitelistOrder",
    );

    await removeFundToken(ctx, tokenA);
    await removeFundToken(ctx, tokenB);
  });

  it("Rejects deposit with oracle owner mismatch", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);
    await airdropIfNeeded(
      ctx.provider,
      ctx.investor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await airdropIfNeeded(ctx.provider, ctx.solPythFeed, 1);

    const token = await addFundToken(ctx);
    await airdropIfNeeded(ctx.provider, token.tokenPythFeed, 1);

    const investorShareAccount =
      await anchor.utils.token.associatedAddress({
        mint: ctx.shareMintPda,
        owner: ctx.investor.publicKey,
      });
    const amountLamports = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 4);

    await expectError(
      ctx.program.methods
        .deposit(amountLamports)
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
        .remainingAccounts([
          { pubkey: ctx.solPythFeed, isWritable: false, isSigner: false },
          { pubkey: token.fundWhitelistPda, isWritable: false, isSigner: false },
          { pubkey: token.fundTokenVault, isWritable: false, isSigner: false },
          { pubkey: token.tokenPythFeed, isWritable: false, isSigner: false },
        ])
        .signers([ctx.investor])
        .rpc(),
      "InvalidOracle",
    );

    await removeFundToken(ctx, token);
  });

  it("Rejects deposit with skipped token via duplicate triplet", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);
    await airdropIfNeeded(
      ctx.provider,
      ctx.investor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await airdropIfNeeded(ctx.provider, ctx.solPythFeed, 1);

    const tokenA = await addFundToken(ctx);
    const tokenB = await addFundToken(ctx);
    await airdropIfNeeded(ctx.provider, tokenA.tokenPythFeed, 1);
    await airdropIfNeeded(ctx.provider, tokenB.tokenPythFeed, 1);

    const investorShareAccount =
      await anchor.utils.token.associatedAddress({
        mint: ctx.shareMintPda,
        owner: ctx.investor.publicKey,
      });
    const amountLamports = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 4);

    await expectError(
      ctx.program.methods
        .deposit(amountLamports)
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
        .remainingAccounts([
          { pubkey: ctx.solPythFeed, isWritable: false, isSigner: false },
          { pubkey: tokenA.fundWhitelistPda, isWritable: false, isSigner: false },
          { pubkey: tokenA.fundTokenVault, isWritable: false, isSigner: false },
          { pubkey: tokenA.tokenPythFeed, isWritable: false, isSigner: false },
          { pubkey: tokenA.fundWhitelistPda, isWritable: false, isSigner: false },
          { pubkey: tokenA.fundTokenVault, isWritable: false, isSigner: false },
          { pubkey: tokenA.tokenPythFeed, isWritable: false, isSigner: false },
        ])
        .signers([ctx.investor])
        .rpc(),
      "InvalidWhitelistOrder",
    );

    await removeFundToken(ctx, tokenA);
    await removeFundToken(ctx, tokenB);
  });

  it("Rejects deposit when open limit orders are not provided", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);
    await airdropIfNeeded(
      ctx.provider,
      ctx.investor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await airdropIfNeeded(ctx.provider, ctx.solPythFeed, 1);

    const token = await addFundToken(ctx);
    await airdropIfNeeded(ctx.provider, token.tokenPythFeed, 1);

    const fundState = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const orderId = new anchor.BN(fundState.nextOrderId.toString());
    const orderPda = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("limit_order"),
        ctx.fundPda.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
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
      mint: new anchor.web3.PublicKey(
        "So11111111111111111111111111111111111111112",
      ),
      owner: orderVaultAuth,
    });

    await ctx.program.methods
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
        fundState: ctx.fundPda,
        fundVault: ctx.vaultPda,
        mint: token.mint,
        whitelist: token.fundWhitelistPda,
        order: orderPda,
        orderSolVault,
        orderVaultAuth,
        orderTokenVault,
        fundTokenVault: token.fundTokenVault,
        wsolMint: new anchor.web3.PublicKey(
          "So11111111111111111111111111111111111111112",
        ),
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const investorShareAccount =
      await anchor.utils.token.associatedAddress({
        mint: ctx.shareMintPda,
        owner: ctx.investor.publicKey,
      });
    const amountLamports = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 4);

    await expectError(
      ctx.program.methods
        .deposit(amountLamports)
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
        .remainingAccounts([
          { pubkey: ctx.solPythFeed, isWritable: false, isSigner: false },
          { pubkey: token.fundWhitelistPda, isWritable: false, isSigner: false },
          { pubkey: token.fundTokenVault, isWritable: false, isSigner: false },
          { pubkey: token.tokenPythFeed, isWritable: false, isSigner: false },
        ])
        .signers([ctx.investor])
        .rpc(),
      "InvalidRemainingAccounts",
    );

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

    await removeFundToken(ctx, token);
  });

  it("Deposits SOL and mints shares", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);
    await airdropIfNeeded(
      ctx.provider,
      ctx.investor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );

    const investorShareAccount =
      await anchor.utils.token.associatedAddress({
        mint: ctx.shareMintPda,
        owner: ctx.investor.publicKey,
      });

    const amountLamports = new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 2);

    const fundVaultBefore = await ctx.provider.connection.getBalance(ctx.vaultPda);
    const feeTreasuryBefore = await ctx.provider.connection.getBalance(
      ctx.feeTreasury.publicKey,
    );
    const fundStateBefore = await ctx.program.account.fundState.fetch(ctx.fundPda);
    const configAccount = await ctx.program.account.globalConfig.fetch(ctx.configPda);

    const fee = Math.floor(
      (amountLamports.toNumber() * configAccount.depositFeeBps) / 10000,
    );
    const net = amountLamports.toNumber() - fee;
    const navBefore = fundVaultBefore;
    const sharesToMint = Math.floor(
      (net * fundStateBefore.totalShares.toNumber()) / navBefore,
    );

    await ctx.program.methods
      .deposit(amountLamports)
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

    const fundVaultAfter = await ctx.provider.connection.getBalance(ctx.vaultPda);
    const feeTreasuryAfter = await ctx.provider.connection.getBalance(
      ctx.feeTreasury.publicKey,
    );
    const investorShareBalance =
      await ctx.provider.connection.getTokenAccountBalance(investorShareAccount);
    const fundStateAfter = await ctx.program.account.fundState.fetch(ctx.fundPda);

    expect(fundVaultAfter - fundVaultBefore).to.equal(net);
    expect(feeTreasuryAfter - feeTreasuryBefore).to.equal(fee);
    expect(investorShareBalance.value.amount).to.equal(
      sharesToMint.toString(),
    );
    expect(fundStateAfter.totalShares.toNumber()).to.equal(
      fundStateBefore.totalShares.toNumber() + sharesToMint,
    );
  });

  it("Rejects deposit below minimum", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);
    await airdropIfNeeded(
      ctx.provider,
      ctx.investor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );

    const investorShareAccount =
      await anchor.utils.token.associatedAddress({
        mint: ctx.shareMintPda,
        owner: ctx.investor.publicKey,
      });

    await expectError(
      ctx.program.methods
        .deposit(new anchor.BN(1))
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
        .rpc(),
      "DepositTooSmall",
    );
  });

  it("Rejects deposit that mints zero shares", async () => {
    const ctx = await getContext();
    await ensureGlobalConfig(ctx);
    await ensureFund(ctx);
    await airdropIfNeeded(
      ctx.provider,
      ctx.investor.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );

    const configBefore = await ctx.program.account.globalConfig.fetch(
      ctx.configPda,
    );

    await ctx.program.methods
      .updateGlobalConfig(
        ctx.configId,
        configBefore.keeper,
        configBefore.solUsdPythFeed,
        configBefore.pythProgramId,
        10_000,
        configBefore.withdrawFeeBps,
        configBefore.tradeFeeBps,
        configBefore.maxSlippageBps,
        configBefore.minManagerDepositLamports,
      )
      .accounts({
        config: ctx.configPda,
        admin: ctx.provider.wallet.publicKey,
        feeTreasury: ctx.feeTreasury.publicKey,
      })
      .rpc();

    const investorShareAccount =
      await anchor.utils.token.associatedAddress({
        mint: ctx.shareMintPda,
        owner: ctx.investor.publicKey,
      });

    await expectError(
      ctx.program.methods
        .deposit(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 10))
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
        .rpc(),
      "ZeroShares",
    );

    await ctx.program.methods
      .updateGlobalConfig(
        ctx.configId,
        configBefore.keeper,
        configBefore.solUsdPythFeed,
        configBefore.pythProgramId,
        configBefore.depositFeeBps,
        configBefore.withdrawFeeBps,
        configBefore.tradeFeeBps,
        configBefore.maxSlippageBps,
        configBefore.minManagerDepositLamports,
      )
      .accounts({
        config: ctx.configPda,
        admin: ctx.provider.wallet.publicKey,
        feeTreasury: ctx.feeTreasury.publicKey,
      })
      .rpc();
  });
});
