import { NextResponse } from 'next/server';
import { PublicKey, Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';
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

  const feePayerPrivateKeyString = process.env.PROXY_WALLET_PRIVATE_KEY;
  if (!feePayerPrivateKeyString) {
    throw new Error('Fee payer wallet configuration missing for validation');
  }

  let feePayerPublicKey: string;
  try {
    const feePayerPrivateKeyBytes = bs58.decode(feePayerPrivateKeyString);
    const feePayerWallet = Keypair.fromSecretKey(feePayerPrivateKeyBytes);
    feePayerPublicKey = feePayerWallet.publicKey.toString();
  } catch (error) {
    try {
      const feePayerPrivateKeyBytes = Uint8Array.from(JSON.parse(feePayerPrivateKeyString));
      const feePayerWallet = Keypair.fromSecretKey(feePayerPrivateKeyBytes);
      feePayerPublicKey = feePayerWallet.publicKey.toString();
    } catch (fallbackError) {
      throw new Error('Failed to load fee payer wallet for validation');
    }
  }

  console.log('=== ENHANCED TRANSACTION VALIDATION ===');
  console.log('Validating', instructions.length, 'instructions');
  console.log('Note public key:', notePublicKey);
  console.log('Fee payer public key:', feePayerPublicKey);

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

    if (inst.programId === '11111111111111111111111111111111') {
      const fromPubkey = inst.keys[0]?.pubkey;
      const toPubkey = inst.keys[1]?.pubkey;
      
      console.log('System transfer details:', {
        from: fromPubkey,
        to: toPubkey,
        isFeePayerSource: fromPubkey === feePayerPublicKey
      });
      
      if (fromPubkey === feePayerPublicKey) {
        console.error(`🚨 SECURITY VIOLATION: Fee payer attempted as transfer source`);
        console.error(`Fee Payer: ${feePayerPublicKey}`);
        console.error(`Attempted From: ${fromPubkey}`);
        console.error(`To: ${toPubkey}`);
        console.error(`Note Public Key: ${notePublicKey}`);
        throw new Error('SECURITY VIOLATION: Fee payer wallet can only pay transaction fees, never transfer funds');
      }
      
      if (notePublicKey && fromPubkey !== notePublicKey) {
        console.error(`❌ BLOCKED: Transfer from unauthorized address: ${fromPubkey}`);
        throw new Error('Transfers must originate from note keypair');
      }
    }

    if (inst.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
      const signerKeys = inst.keys.filter(key => key.isSigner);
      if (signerKeys.some(key => key.pubkey === feePayerPublicKey)) {
        console.error(`🚨 SECURITY VIOLATION: Fee payer attempted as token transfer signer`);
        throw new Error('SECURITY VIOLATION: Fee payer cannot transfer tokens');
      }
    }
  }

  console.log('✅ Enhanced transaction validation passed');
}

export async function POST(request: Request) {
  try {
    console.log('=== TORNADO WITHDRAWAL API START ===');
    
    const { instructions: serializedInstructions, blockhash, notePublicKey, getProxyWalletOnly } = await request.json();
    console.log('Request data received:', { 
      instructionsCount: serializedInstructions?.length || 0,
      hasBlockhash: !!blockhash,
      notePublicKey,
      getProxyWalletOnly
    });
    
    const proxyPrivateKeyString = process.env.PROXY_WALLET_PRIVATE_KEY;
    if (!proxyPrivateKeyString) {
      console.error('PROXY_WALLET_PRIVATE_KEY environment variable not found');
      throw new Error('Proxy wallet configuration missing');
    }
    
    console.log('=== PROXY WALLET SETUP ===');
    
    let proxyWallet;
    try {
      const proxyPrivateKeyBytes = bs58.decode(proxyPrivateKeyString);
      proxyWallet = Keypair.fromSecretKey(proxyPrivateKeyBytes);
      console.log('✅ Successfully decoded proxy wallet with bs58');
    } catch (error) {
      console.log('❌ bs58 decode failed, trying JSON.parse fallback');
      try {
        const proxyPrivateKeyBytes = Uint8Array.from(JSON.parse(proxyPrivateKeyString));
        proxyWallet = Keypair.fromSecretKey(proxyPrivateKeyBytes);
        console.log('✅ Successfully decoded proxy wallet with JSON.parse');
      } catch (fallbackError) {
        console.error('❌ Both bs58 and JSON.parse failed:', { 
          bs58Error: error instanceof Error ? error.message : String(error), 
          jsonError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) 
        });
        throw new Error('Invalid proxy wallet private key format');
      }
    }

    if (getProxyWalletOnly) {
      console.log('=== RETURNING PROXY WALLET PUBLIC KEY ONLY ===');
      return NextResponse.json({
        success: true,
        proxyWalletPublicKey: proxyWallet.publicKey.toString(),
      });
    }

    console.log('=== DESERIALIZING INSTRUCTIONS ===');
    const instructions = serializedInstructions.map((inst: any) => {
      return new TransactionInstruction({
        programId: new PublicKey(inst.programId),
        keys: inst.keys.map((key: any) => ({
          pubkey: new PublicKey(key.pubkey),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: Buffer.from(inst.data)
      });
    });
    console.log('✅ Instructions deserialized successfully:', instructions.length);

    validateMystTransaction(serializedInstructions, notePublicKey);

    console.log('=== TRANSACTION CREATION ===');
    const messageV0 = new TransactionMessage({
      payerKey: proxyWallet.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    console.log('✅ Transaction created successfully');
    
    console.log('=== PROXY WALLET SIGNING ===');
    transaction.sign([proxyWallet]);
    console.log('✅ Proxy wallet signature added');

    return NextResponse.json({
      success: true,
      transaction: bs58.encode(transaction.serialize()),
    });
    
  } catch (error: any) {
    console.error('=== TORNADO WITHDRAWAL ERROR ===');
    console.error('Error type:', typeof error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Full error object:', error);
    
    return NextResponse.json(
      { 
        error: error.message || 'Failed to process tornado withdrawal',
        details: error.stack || 'No stack trace available'
      },
      { status: 500 }
    );
  }
}
