import { NextResponse } from 'next/server';
import { PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { createRpc, LightSystemProgram } from '@lightprotocol/stateless.js';
import bs58 from 'bs58';

function validateMystTransaction(instructions: any[], notePublicKey?: string) {
  const ALLOWED_PROGRAMS = [
    'CmtHVz7C4mRhk3UKNs2BjPZVKPMbB6x86wwghHKzeKZy', // Light Protocol
    'SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7', // System Program
    '11111111111111111111111111111111', // System Program variant
    'compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq', // Compression program
    'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', // No-op program
    'ComputeBudget111111111111111111111111111111', // Compute Budget Program
  ];

  console.log('=== TRANSACTION VALIDATION ===');
  console.log('Validating', instructions.length, 'instructions');

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    console.log(`Instruction ${i}:`, {
      programId: inst.programId,
      keysCount: inst.keys?.length || 0
    });

    if (!ALLOWED_PROGRAMS.includes(inst.programId)) {
      console.error(`❌ BLOCKED: Unauthorized program: ${inst.programId}`);
      throw new Error(`Unauthorized program: ${inst.programId}`);
    }
  }

  console.log('✅ Transaction validation passed');
}

function validateGaslessTransaction(noteKeypair: Keypair, recipientAddress: string, totalLamports: bigint) {
  console.log('=== GASLESS TRANSACTION VALIDATION ===');
  
  try {
    new PublicKey(recipientAddress);
  } catch (error) {
    console.error('❌ BLOCKED: Invalid recipient address format:', recipientAddress);
    throw new Error('Invalid recipient address format');
  }

  const MAX_WITHDRAWAL_LAMPORTS = BigInt(100 * 1e9); // 100 SOL max
  if (totalLamports > MAX_WITHDRAWAL_LAMPORTS) {
    console.error(`❌ BLOCKED: Withdrawal amount too large: ${totalLamports} lamports`);
    throw new Error(`Withdrawal amount exceeds maximum: ${Number(totalLamports) / 1e9} SOL`);
  }

  const MIN_WITHDRAWAL_LAMPORTS = BigInt(0.001 * 1e9); // 0.001 SOL min
  if (totalLamports < MIN_WITHDRAWAL_LAMPORTS) {
    console.error(`❌ BLOCKED: Withdrawal amount too small: ${totalLamports} lamports`);
    throw new Error(`Withdrawal amount below minimum: ${Number(totalLamports) / 1e9} SOL`);
  }

  console.log('✅ Gasless transaction validation passed');
  console.log('Note keypair:', noteKeypair.publicKey.toString());
  console.log('Recipient:', recipientAddress);
  console.log('Amount:', Number(totalLamports) / 1e9, 'SOL');
}

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.mainnet-beta.solana.com";

export async function POST(request: Request) {
  try {
    const { notePrivateKey, recipientAddress } = await request.json();
    
    const proxyPrivateKeyString = process.env.PROXY_WALLET_PRIVATE_KEY;
    if (!proxyPrivateKeyString) {
      throw new Error('Proxy wallet configuration missing');
    }
    
    console.log('=== PROXY WALLET SETUP ===');
    
    let proxyWallet;
    try {
      const proxyPrivateKeyBytes = bs58.decode(proxyPrivateKeyString);
      proxyWallet = Keypair.fromSecretKey(proxyPrivateKeyBytes);
      console.log('Successfully decoded proxy wallet with bs58');
    } catch (error) {
      console.log('bs58 decode failed, trying JSON.parse fallback');
      try {
        const proxyPrivateKeyBytes = Uint8Array.from(JSON.parse(proxyPrivateKeyString));
        proxyWallet = Keypair.fromSecretKey(proxyPrivateKeyBytes);
        console.log('Successfully decoded proxy wallet with JSON.parse');
      } catch (fallbackError) {
        console.error('Both bs58 and JSON.parse failed:', error, fallbackError);
        throw new Error('Invalid proxy wallet private key format');
      }
    }

    console.log('=== NOTE KEYPAIR SETUP ===');
    console.log('Note private key exists:', !!notePrivateKey);
    console.log('Note private key length:', notePrivateKey.length);
    
    const notePrivateKeyBytes = Buffer.from(notePrivateKey, 'base64');
    console.log('Decoded note private key bytes length:', notePrivateKeyBytes.length);
    
    const noteKeypair = Keypair.fromSecretKey(notePrivateKeyBytes);
    console.log('Note keypair public key:', noteKeypair.publicKey.toString());

    console.log('=== RPC CONNECTION ===');
    console.log('RPC URL:', RPC_URL);
    
    const connection = await createRpc(RPC_URL);
    console.log('RPC connection created successfully');
    
    console.log('=== QUERYING COMPRESSED ACCOUNTS ===');
    console.log('Querying for public key:', noteKeypair.publicKey.toString());
    
    const accounts = await connection.getCompressedAccountsByOwner(noteKeypair.publicKey);
    console.log('Compressed accounts response:', accounts);
    
    if (!accounts || !accounts.items || accounts.items.length === 0) {
      throw new Error('No compressed accounts found for this note');
    }

    const totalLamports = accounts.items.reduce((sum: bigint, account: any) => 
      BigInt(sum) + BigInt(account.lamports || 0), BigInt(0));

    if (totalLamports === BigInt(0)) {
      throw new Error('No balance available to withdraw');
    }

    console.log('=== VALIDITY PROOF ===');
    const accountHashes = accounts.items.map((acc: any) => acc.hash);
    console.log('Account hashes for proof:', accountHashes);
    
    const proof = await connection.getValidityProof(accountHashes);
    console.log('Validity proof obtained:', !!proof);

    console.log('=== DECOMPRESS INSTRUCTION ===');
    console.log('Recipient address:', recipientAddress);
    console.log('Total lamports to withdraw:', Number(totalLamports));
    console.log('Number of compressed accounts:', accounts.items.length);
    
    const decompressInstruction = await LightSystemProgram.decompress({
      payer: proxyWallet.publicKey,
      toAddress: new PublicKey(recipientAddress),
      lamports: Number(totalLamports),
      inputCompressedAccounts: accounts.items,
      recentValidityProof: proof.compressedProof,
      recentInputStateRootIndices: proof.rootIndices,
    });
    console.log('Decompress instruction created successfully');

    validateGaslessTransaction(noteKeypair, recipientAddress, totalLamports);

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      decompressInstruction,
    ];

    const instructionData = instructions.map(inst => ({
      programId: inst.programId.toString(),
      keys: inst.keys || []
    }));
    validateMystTransaction(instructionData);

    console.log('=== BLOCKHASH ===');
    const { context: { slot: minContextSlot }, value: blockhashCtx } =
      await connection.getLatestBlockhashAndContext();
    console.log('Latest blockhash:', blockhashCtx.blockhash);
    console.log('Min context slot:', minContextSlot);

    const messageV0 = new TransactionMessage({
      payerKey: proxyWallet.publicKey,
      recentBlockhash: blockhashCtx.blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    
    console.log('=== TRANSACTION SIGNING ===');
    
    transaction.sign([proxyWallet, noteKeypair]);
    console.log('Transaction signed successfully');

    console.log('=== SENDING TRANSACTION ===');
    const signature = await connection.sendTransaction(transaction, {
      minContextSlot,
    });
    console.log('Transaction sent with signature:', signature);

    console.log('=== CONFIRMING TRANSACTION ===');
    await connection.confirmTransaction({
      signature,
      blockhash: blockhashCtx.blockhash,
      lastValidBlockHeight: blockhashCtx.lastValidBlockHeight,
    });
    console.log('Transaction confirmed successfully');

    return NextResponse.json({
      success: true,
      signature,
      withdrawnAmount: (Number(totalLamports) / 1e9).toFixed(4),
    });
    
  } catch (error: any) {
    console.error('=== GASLESS TORNADO WITHDRAW ERROR ===');
    console.error('Error type:', typeof error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Full error:', error);
    
    return NextResponse.json(
      { error: error.message || 'Failed to process gasless tornado withdrawal' },
      { status: 500 }
    );
  }
}
