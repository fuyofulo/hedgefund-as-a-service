import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { FundContract } from "../target/types/fund_contract";
import { createMint } from "@solana/spl-token";

export type TestContext = {
  program: Program<FundContract>;
  provider: anchor.AnchorProvider;
  configId: anchor.BN;
  configPda: anchor.web3.PublicKey;
  keeper: anchor.web3.PublicKey;
  fundId: anchor.BN;
  fundPda: anchor.web3.PublicKey;
  shareMintPda: anchor.web3.PublicKey;
  vaultPda: anchor.web3.PublicKey;
  investor: anchor.web3.Keypair;
  feeTreasury: anchor.web3.Keypair;
  solPythFeed: anchor.web3.PublicKey;
  pythProgramId: anchor.web3.PublicKey;
};

let cachedContext: TestContext | null = null;
let initPromise: Promise<TestContext> | null = null;

export const getContext = async (): Promise<TestContext> => {
  if (cachedContext) {
    return cachedContext;
  }
  if (!initPromise) {
    initPromise = (async () => {
      anchor.setProvider(anchor.AnchorProvider.env());
      const program = anchor.workspace.fundContract as Program<FundContract>;
      const provider = anchor.getProvider() as anchor.AnchorProvider;

      const configId = new anchor.BN(Date.now());
      const configIdSeed = configId.toArrayLike(Buffer, "le", 8);
      const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config"), configIdSeed],
        program.programId,
      );

      const investor = anchor.web3.Keypair.generate();
      const feeTreasury = anchor.web3.Keypair.generate();
      const solPythFeed = anchor.web3.Keypair.generate().publicKey;
      const pythProgramId = anchor.web3.Keypair.generate().publicKey;

      const fundId = new anchor.BN(1);
      const fundIdSeed = fundId.toArrayLike(Buffer, "le", 8);
      const [fundPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("fund"),
          configPda.toBuffer(),
          provider.wallet.publicKey.toBuffer(),
          fundIdSeed,
        ],
        program.programId,
      );
      const [shareMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("shares"), fundPda.toBuffer()],
        program.programId,
      );
      const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), fundPda.toBuffer()],
        program.programId,
      );

      cachedContext = {
        program,
        provider,
        configId,
        configPda,
        keeper: provider.wallet.publicKey,
        fundId,
        fundPda,
        shareMintPda,
        vaultPda,
        investor,
        feeTreasury,
        solPythFeed,
        pythProgramId,
      };
      return cachedContext;
    })();
  }
  return initPromise;
};

export const airdropIfNeeded = async (
  provider: anchor.AnchorProvider,
  pubkey: anchor.web3.PublicKey,
  lamports: number,
) => {
  const balance = await provider.connection.getBalance(pubkey);
  if (balance >= lamports) {
    return;
  }
  const sig = await provider.connection.requestAirdrop(pubkey, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
};

export const decodeFundWhitelist = (data: Buffer) => {
  const fund = new anchor.web3.PublicKey(data.slice(8, 40));
  const mint = new anchor.web3.PublicKey(data.slice(40, 72));
  const decimals = data[72];
  const pythFeed = new anchor.web3.PublicKey(data.slice(73, 105));
  const enabled = data[105] !== 0;
  const bump = data[106];
  return { fund, mint, decimals, pythFeed, enabled, bump };
};

export const expectError = async (promise: Promise<string>, code: string) => {
  try {
    await promise;
    throw new Error("Expected error but transaction succeeded");
  } catch (err: any) {
    const msg =
      err?.error?.errorCode?.code ??
      err?.error?.errorMessage ??
      err?.message ??
      JSON.stringify(err);
    if (!msg.includes(code)) {
      throw err;
    }
  }
};

export const getClockUnixTimestamp = async (
  connection: anchor.web3.Connection,
) => {
  const info = await connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY);
  if (!info?.data || info.data.length < 40) {
    return Math.floor(Date.now() / 1000);
  }
  return Number(info.data.readBigInt64LE(32));
};

export const ensureGlobalConfig = async (ctx: TestContext) => {
  const info = await ctx.provider.connection.getAccountInfo(ctx.configPda);
  if (info) {
    return false;
  }
  await airdropIfNeeded(
    ctx.provider,
    ctx.provider.wallet.publicKey,
    2 * anchor.web3.LAMPORTS_PER_SOL,
  );
  await airdropIfNeeded(
    ctx.provider,
    ctx.feeTreasury.publicKey,
    anchor.web3.LAMPORTS_PER_SOL,
  );

  await ctx.program.methods
    .initializeGlobalConfig(
      ctx.configId,
      ctx.keeper,
      ctx.solPythFeed,
      ctx.pythProgramId,
      50,
      25,
      10,
      100,
      new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 10),
    )
    .accounts({
      config: ctx.configPda,
      admin: ctx.provider.wallet.publicKey,
      feeTreasury: ctx.feeTreasury.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  return true;
};

export const ensureFund = async (ctx: TestContext) => {
  const info = await ctx.provider.connection.getAccountInfo(ctx.fundPda);
  if (info) {
    return false;
  }
  const managerShareAccount = await anchor.utils.token.associatedAddress({
    mint: ctx.shareMintPda,
    owner: ctx.provider.wallet.publicKey,
  });

  await ctx.program.methods
    .initializeFund(
      ctx.fundId,
      new anchor.BN(anchor.web3.LAMPORTS_PER_SOL / 20),
      new anchor.BN(0),
    )
    .accounts({
      manager: ctx.provider.wallet.publicKey,
      config: ctx.configPda,
      fundState: ctx.fundPda,
      shareMint: ctx.shareMintPda,
      managerShareAccount,
      fundVault: ctx.vaultPda,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  return true;
};

export const addFundToken = async (ctx: TestContext) => {
  const decimals = 6;
  const mint = await createMint(
    ctx.provider.connection,
    ctx.provider.wallet.payer,
    ctx.provider.wallet.publicKey,
    null,
    decimals,
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
    .rpc();

  return {
    mint,
    tokenPythFeed,
    globalWhitelistPda,
    fundWhitelistPda,
    fundTokenVault,
  };
};

export const removeFundToken = async (
  ctx: TestContext,
  token: {
    mint: anchor.web3.PublicKey;
    globalWhitelistPda: anchor.web3.PublicKey;
    fundWhitelistPda: anchor.web3.PublicKey;
    fundTokenVault: anchor.web3.PublicKey;
  },
) => {
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
};
