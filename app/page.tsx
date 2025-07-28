"use client";

import { useState, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { LockIcon, EyeOffIcon, ArrowDownIcon, ArrowUpIcon, Copy, Download, X } from "lucide-react";
import Image from "next/image";
import { useWallet } from "@solana/wallet-adapter-react";
import { PhantomWalletName } from "@solana/wallet-adapter-phantom";
import { 
  PublicKey, 
  Keypair, 
  SystemProgram, 
  TransactionMessage, 
  VersionedTransaction,
  ComputeBudgetProgram 
} from "@solana/web3.js";
import bs58 from 'bs58';
import { 
  LightSystemProgram, 
  defaultTestStateTreeAccounts,
  createRpc,
  selectMinCompressedSolAccountsForTransfer
} from "@lightprotocol/stateless.js";
import { toast } from "sonner";

export default function MixerPage() {
  const { publicKey, connected, sendTransaction, connect, disconnect, connecting, select } = useWallet();
  const fixedAmounts = [0.1, 1, 10, 100];
  const [selectedAmountIndex, setSelectedAmountIndex] = useState([1]);
  const [note, setNote] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [isShielding, setIsShielding] = useState(false);
  const [showNotePopup, setShowNotePopup] = useState(false);
  const [generatedNote, setGeneratedNote] = useState("");
  const [noteBalance, setNoteBalance] = useState("0.0000");
  const [isComplianceMode, setIsComplianceMode] = useState(false);
  const [complianceNote, setComplianceNote] = useState("");

  const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.mainnet-beta.solana.com";
  const FEE_RECIPIENT = new PublicKey("Fszf1EKYXnCboSGqMbKdabUq6ayGSpe9uHhx3BoCkAPZ");
  const MIN_FEE_LAMPORTS = 10000;

  const encryptPrivateKey = (privateKey: Uint8Array): string => {
    return Buffer.from(privateKey).toString('base64');
  };

  const deserializeNote = (noteString: string): { publicKey: PublicKey, privateKey: Uint8Array } | null => {
    try {
      if (!noteString.startsWith('mystify-0.2.0-')) {
        throw new Error('Invalid note format');
      }
      
      const noteContent = noteString.replace('mystify-0.2.0-', '');
      const parts = noteContent.split('-');
      if (parts.length !== 2) {
        throw new Error('Invalid note format - missing transaction hash');
      }
      
      const encryptedKey = parts[0];
      const privateKeyBytes = Buffer.from(encryptedKey, 'base64');
      const keypair = Keypair.fromSecretKey(privateKeyBytes);
      
      return {
        publicKey: keypair.publicKey,
        privateKey: privateKeyBytes
      };
    } catch (error) {
      console.error('Failed to deserialize note:', error);
      return null;
    }
  };

  const queryNoteBalance = async (noteString: string): Promise<string> => {
    try {
      const deserializedNote = deserializeNote(noteString);
      if (!deserializedNote) {
        return "0.0000";
      }

      const connection = await createRpc(RPC_URL);
      const compressedAccounts = await connection.getCompressedAccountsByOwner(deserializedNote.publicKey);
      
      if (!compressedAccounts || !compressedAccounts.items || compressedAccounts.items.length === 0) {
        return "0.0000";
      }

      const totalLamports = compressedAccounts.items.reduce((sum: bigint, account: any) => 
        BigInt(sum) + BigInt(account.lamports || 0), BigInt(0));
      
      return (Number(totalLamports) / 1e9).toFixed(4);
    } catch (error) {
      console.error('Error querying note balance:', error);
      return "0.0000";
    }
  };

  const handleDeposit = async () => {
    if (!connected || !publicKey || !sendTransaction) {
      toast.error('Please connect your wallet');
      return;
    }

    const amount = fixedAmounts[selectedAmountIndex[0]].toString();
    if (!amount || parseFloat(amount) <= 0) {
      toast.error('Please select a valid amount');
      return;
    }

    setIsShielding(true);

    try {
      const depositKeypair = Keypair.generate();

      console.log('Generated keypair:', {
        publicKey: depositKeypair.publicKey.toString(),
        privateKey: Array.from(depositKeypair.secretKey)
      });

      const connection = await createRpc(RPC_URL);
      const lamportsAmount = parseFloat(amount) * 1e9;

      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        await LightSystemProgram.compress({
          payer: publicKey,
          toAddress: depositKeypair.publicKey,
          lamports: lamportsAmount,
          outputStateTree: defaultTestStateTreeAccounts().merkleTree,
        })
      ];

      const { context: { slot: minContextSlot }, value: blockhashCtx } =
        await connection.getLatestBlockhashAndContext();

      const messageV0 = new TransactionMessage({
        payerKey: publicKey,
        recentBlockhash: blockhashCtx.blockhash,
        instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);

      const signature = await sendTransaction(transaction, connection, {
        minContextSlot,
      });

      await connection.confirmTransaction({
        signature,
        blockhash: blockhashCtx.blockhash,
        lastValidBlockHeight: blockhashCtx.lastValidBlockHeight,
      });

      const encryptedPrivateKey = encryptPrivateKey(depositKeypair.secretKey);
      const encodedTxHash = Buffer.from(signature, 'utf8').toString('base64');
      const noteString = `mystify-0.2.0-${encryptedPrivateKey}-${encodedTxHash}`;
      setGeneratedNote(noteString);
      setShowNotePopup(true);

      toast.success(`Successfully deposited ${amount} SOL!`);

    } catch (error) {
      console.error('Shield error:', error);
      toast.error('Failed to create deposit. Please try again.');
    } finally {
      setIsShielding(false);
    }
  };

  const handleWithdraw = async () => {
    if (!note || !recipientAddress) {
      toast.error('Please enter both note and recipient address');
      return;
    }

    setIsShielding(true);

    try {
      console.log('=== TORNADO WITHDRAWAL FRONTEND START ===');
      console.log('Note input:', note.substring(0, 50) + '...');
      console.log('Recipient address:', recipientAddress);

      const balance = await queryNoteBalance(note);
      console.log(`Note balance: ${balance} SOL`);
      
      if (parseFloat(balance) === 0) {
        console.error('❌ No balance available to withdraw');
        toast.error('No balance available to withdraw');
        return;
      }

      console.log('✅ Balance found, proceeding with withdrawal');

      const deserializedNote = deserializeNote(note);
      if (!deserializedNote) {
        console.error('❌ Invalid note format');
        toast.error('Invalid note format');
        return;
      }

      console.log('✅ Note deserialized successfully');
      console.log('Regenerated private key length:', deserializedNote.privateKey.length);
      console.log('Regenerated public key:', deserializedNote.publicKey.toString());

      console.log('=== QUERYING COMPRESSED ACCOUNTS (FRONTEND) ===');
      console.log('Querying accounts with public key:', deserializedNote.publicKey.toString());

      const connection = await createRpc(RPC_URL);
      const accounts = await connection.getCompressedAccountsByOwner(deserializedNote.publicKey);
      
      console.log('✅ Compressed accounts query successful');
      console.log('Accounts found:', accounts?.items?.length || 0);

      if (!accounts || !accounts.items || accounts.items.length === 0) {
        console.error('❌ No compressed accounts found for this note');
        toast.error('No compressed accounts found for this note');
        return;
      }

      console.log('✅ Accounts found, selecting for withdrawal');

      const totalLamports = accounts.items.reduce((sum: bigint, account: any) => 
        BigInt(sum) + BigInt(account.lamports || 0), BigInt(0));

      if (totalLamports === BigInt(0)) {
        console.error('❌ No balance available to withdraw');
        toast.error('No balance available to withdraw');
        return;
      }

      const [selectedAccounts] = selectMinCompressedSolAccountsForTransfer(
        accounts.items,
        Number(totalLamports)
      );

      console.log('Selected compressed accounts for withdrawal:', selectedAccounts.length);

      console.log('=== CREATING VALIDITY PROOF (FRONTEND) ===');
      const accountHashes = selectedAccounts.map((acc: any) => acc.hash);
      console.log('Getting validity proof for account hashes:', accountHashes.length);
      
      const proof = await connection.getValidityProof(accountHashes);
      console.log('✅ Validity proof obtained successfully');

      console.log('=== GETTING PROXY WALLET FOR FEES ===');
      const response = await fetch('/api-tornado/withdraw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          getProxyWalletOnly: true,
        }),
      });

      const proxyResult = await response.json();
      if (!proxyResult.success) {
        throw new Error('Failed to get proxy wallet public key');
      }

      const proxyWalletPublicKey = new PublicKey(proxyResult.proxyWalletPublicKey);
      console.log('✅ Got proxy wallet public key:', proxyWalletPublicKey.toString());

      console.log('=== CREATING TWO-STEP ATOMIC TRANSACTION ===');
      const noteKeypair = Keypair.fromSecretKey(deserializedNote.privateKey);
      
      const decompressInstruction = await LightSystemProgram.decompress({
        payer: noteKeypair.publicKey,
        toAddress: noteKeypair.publicKey,
        lamports: Number(totalLamports),
        inputCompressedAccounts: selectedAccounts,
        recentValidityProof: proof.compressedProof,
        recentInputStateRootIndices: proof.rootIndices,
        outputStateTree: defaultTestStateTreeAccounts().merkleTree,
      });
      
      console.log('✅ Step 1: Decompress instruction created - unshielding to note keypair');
      
      const feeAmount = Math.floor(Number(totalLamports) * 0.005);
      const feeTransferInstruction = SystemProgram.transfer({
        fromPubkey: noteKeypair.publicKey,
        toPubkey: proxyWalletPublicKey,
        lamports: feeAmount,
      });
      
      console.log('✅ Step 2: Fee transfer instruction created - 0.5% fee to fee payer');
      
      const transferInstruction = SystemProgram.transfer({
        fromPubkey: noteKeypair.publicKey,
        toPubkey: new PublicKey(recipientAddress),
        lamports: Number(totalLamports) - 5000 - feeAmount,
      });
      
      console.log('✅ Step 3: Transfer instruction created - sending remaining to destination');

      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        decompressInstruction,
        feeTransferInstruction,
        transferInstruction,
      ];

      console.log('=== GETTING BLOCKHASH (FRONTEND) ===');
      const { context: { slot: minContextSlot }, value: blockhashCtx } =
        await connection.getLatestBlockhashAndContext();
      console.log('✅ Latest blockhash obtained:', blockhashCtx.blockhash);

      console.log('=== CALLING TORNADO WITHDRAWAL API ===');
      console.log('Getting proxy wallet signature...');

      const apiResponse = await fetch('/api-tornado/withdraw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          blockhash: blockhashCtx.blockhash,
          instructions: instructions.map(inst => ({
            programId: inst.programId.toString(),
            keys: inst.keys.map(key => ({
              pubkey: key.pubkey.toString(),
              isSigner: key.isSigner,
              isWritable: key.isWritable
            })),
            data: Array.from(inst.data)
          })),
          notePublicKey: noteKeypair.publicKey.toString(),
        }),
      });

      console.log('API response status:', apiResponse.status);
      console.log('API response ok:', apiResponse.ok);

      const result = await apiResponse.json();
      console.log('API response data:', result);

      if (result.success) {
        console.log('✅ Getting proxy wallet signature: SUCCESS');
        
        const transaction = VersionedTransaction.deserialize(bs58.decode(result.transaction));
        console.log('✅ Transaction deserialized successfully');

        console.log('=== SIGNING WITH NOTE KEYPAIR (FRONTEND) ===');
        const noteKeypair = Keypair.fromSecretKey(deserializedNote.privateKey);
        transaction.sign([noteKeypair]);
        console.log('✅ Getting generated wallet signature: SUCCESS');

        console.log('=== SENDING TRANSACTION (FRONTEND) ===');
        const signature = await connection.sendTransaction(transaction, {
          minContextSlot,
          skipPreflight: true,
        });
        console.log('✅ Sent withdrawal tx: SUCCESS');
        console.log('Withdrawal tx hash:', signature);

        console.log('=== CONFIRMING TRANSACTION ===');
        await connection.confirmTransaction({
          signature,
          blockhash: blockhashCtx.blockhash,
          lastValidBlockHeight: blockhashCtx.lastValidBlockHeight,
        });
        console.log('✅ Transaction confirmed successfully');

        const withdrawnAmount = (Number(totalLamports) / 1e9).toFixed(4);
        console.log('Withdrawn amount:', withdrawnAmount, 'SOL');
        toast.success(`Successfully withdrew ${withdrawnAmount} SOL to ${recipientAddress}!`);
        setNote('');
        setRecipientAddress('');
      } else {
        console.error('❌ API returned error:', result.error);
        console.error('Error details:', result.details);
        throw new Error(result.error || 'Withdrawal failed');
      }

    } catch (error) {
      console.error('=== WITHDRAWAL ERROR ===');
      console.error('Error type:', typeof error);
      console.error('Error message:', error instanceof Error ? error.message : 'Unknown error');
      console.error('Full error:', error);
      toast.error(`Failed to withdraw: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsShielding(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard!');
  };

  const downloadNote = () => {
    const blob = new Blob([generatedNote], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-mystify-sol-${fixedAmounts[selectedAmountIndex[0]]}-${generatedNote.slice(-8)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleNoteChange = useCallback(async (value: string) => {
    setNote(value);
    if (value && value.startsWith('mystify-0.2.0-')) {
      const balance = await queryNoteBalance(value);
      setNoteBalance(balance);
    } else {
      setNoteBalance("0.0000");
    }
  }, []);

  const extractTransactionHash = (noteString: string): string | null => {
    try {
      if (!noteString.startsWith('mystify-0.2.0-')) {
        return null;
      }
      
      const noteContent = noteString.replace('mystify-0.2.0-', '');
      const parts = noteContent.split('-');
      if (parts.length !== 2) {
        return null;
      }
      
      return Buffer.from(parts[1], 'base64').toString('utf8');
    } catch (error) {
      console.error('Failed to extract transaction hash:', error);
      return null;
    }
  };

  return (
    <div className="h-screen bg-background p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-cyber-dark via-background to-cyber-surface opacity-90" />
      <div className="absolute top-20 left-20 w-64 h-64 bg-cyber-glow opacity-5 rounded-full blur-3xl animate-cyber-pulse" />
      <div className="absolute bottom-20 right-20 w-48 h-48 bg-cyber-secondary opacity-5 rounded-full blur-3xl animate-cyber-pulse" style={{ animationDelay: '1s' }} />
      
      <div className="absolute top-4 right-4 z-20">
        <button
          onClick={connected ? disconnect : () => {
            select(PhantomWalletName);
            connect();
          }}
          disabled={connecting}
          className="bg-transparent text-white font-mono text-sm px-4 py-3 min-w-0 w-auto h-12 rounded-md border border-cyber-glow/30 hover:bg-cyber-glow/10 transition-colors"
        >
          {connecting ? 'Connecting...' : connected ? 'Connected' : 'Connect'}
        </button>
      </div>

      <div className="relative z-10 max-w-2xl mx-auto py-8 transform scale-[0.8] origin-top">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Image 
              src="/finalogo.svg" 
              alt="Mystify Logo" 
              width={40} 
              height={40} 
              className="h-10 w-10 animate-glow"
            />
            <h1 className="text-4xl font-bold text-cyber-glow animate-glow font-mono">
              MYSTIFY
            </h1>
          </div>
          <p className="text-muted-foreground font-mono text-sm tracking-wider">
            <button 
              onClick={() => setIsComplianceMode(!isComplianceMode)}
              className="text-cyber-glow hover:text-white transition-colors cursor-pointer underline"
            >
              {isComplianceMode ? "MIXING" : "COMPLIANCE"}
            </button> • <a 
              href="https://dexscreener.com" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-cyber-glow hover:text-white transition-colors cursor-pointer underline"
            >
              DexScreener
            </a> • <a 
              href="https://x.com/Mystify_Sol/" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-cyber-glow hover:text-white transition-colors cursor-pointer underline"
            >
              X/Twitter
            </a>
          </p>
          <div className="flex items-center justify-center gap-4 mt-4 text-xs text-cyber-glow font-mono">
            <div className="flex items-center gap-1">
              <LockIcon className="h-3 w-3" />
              <span>ENCRYPTED</span>
            </div>
            <div className="flex items-center gap-1">
              <EyeOffIcon className="h-3 w-3" />
              <span>PRIVATE</span>
            </div>
          </div>
        </div>

        <Card className="bg-cyber-surface border-cyber-glow/30 shadow-cyber">
          <CardHeader>
            <CardTitle className="text-cyber-glow font-mono">
              {isComplianceMode ? "COMPLIANCE TOOL" : "Myst PROTOCOL"}
            </CardTitle>
            <CardDescription className="text-muted-foreground font-mono text-xs">
              {isComplianceMode 
                ? "Generate cryptographically verified proof of transactional history"
                : "Anonymize your on-chain holdings with Myst"
              }
            </CardDescription>
          </CardHeader>
          
          <CardContent>
            {isComplianceMode ? (
              <div className="space-y-6">
                <div className="text-center space-y-4">
                  <p className="text-white text-sm font-mono leading-relaxed">
                    Financial Privacy is a right that all on-chain participants should have.
                    However, we know that some times compliance is neccessary. With Mystify, you can provide your
                    note string and receive a receipt showing the transaction hash that you used to deposit funds. 
                    This might be neccesary to show where funds in your withdrawal address came from. 
                  </p>
                  <p className="text-white text-sm font-mono">
                    To generate a compliance report, please enter your Mystify Note below.
                  </p>
                </div>

                <div className="space-y-4">
                  <div>
                    <Label htmlFor="compliance-note" className="text-cyber-glow font-mono text-sm">
                      Note
                    </Label>
                    <Textarea
                      id="compliance-note"
                      placeholder="Please enter your note"
                      value={complianceNote}
                      onChange={(e) => setComplianceNote(e.target.value)}
                      className="mt-2 bg-cyber-dark border-cyber-glow/30 text-cyber-glow font-mono placeholder:text-muted-foreground resize-none"
                      rows={4}
                    />
                  </div>

                  {complianceNote && complianceNote.startsWith('mystify-0.2.0-') && (
                    <div className="bg-cyber-dark p-4 rounded-lg border border-cyber-glow/30">
                      <h4 className="text-cyber-glow font-mono text-sm mb-2">Transaction Details:</h4>
                      <div className="space-y-2 text-xs font-mono">
                        <div>
                          <span className="text-muted-foreground">Transaction Hash: </span>
                          <span className="text-cyber-glow break-all">
                            {extractTransactionHash(complianceNote) || 'Invalid note format'}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Note Format: </span>
                          <span className="text-cyber-glow">mystify-0.2.0</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <Tabs defaultValue="deposit" className="w-full">
                <TabsList className="grid w-full grid-cols-2 bg-cyber-dark border border-cyber-glow/20">
                  <TabsTrigger 
                    value="deposit" 
                    className="font-mono data-[state=active]:bg-cyber-glow data-[state=active]:text-cyber-dark"
                  >
                    <ArrowDownIcon className="h-4 w-4 mr-2" />
                    DEPOSIT
                  </TabsTrigger>
                  <TabsTrigger 
                    value="withdraw" 
                    className="font-mono data-[state=active]:bg-cyber-glow data-[state=active]:text-cyber-dark"
                  >
                    <ArrowUpIcon className="h-4 w-4 mr-2" />
                    WITHDRAW
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="deposit" className="space-y-6 mt-6">
                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <Label className="text-cyber-glow font-mono text-sm">AMOUNT (SOL)</Label>
                      <span className="text-cyber-glow font-mono text-lg font-bold">
                        {fixedAmounts[selectedAmountIndex[0]]} SOL
                      </span>
                    </div>
                    
                    <div className="px-3 py-6">
                      <Slider
                        value={selectedAmountIndex}
                        onValueChange={setSelectedAmountIndex}
                        max={3}
                        min={0}
                        step={1}
                        className="w-full"
                      />
                      <div className="flex justify-between text-xs text-muted-foreground font-mono mt-2">
                        <span>0.1 SOL</span>
                        <span>1 SOL</span>
                        <span>10 SOL</span>
                        <span>100 SOL</span>
                      </div>
                    </div>

                    <Button 
                      variant="cyber" 
                      className="w-full py-6 text-lg"
                      onClick={handleDeposit}
                      disabled={!connected || isShielding}
                    >
                      {isShielding ? 'PROCESSING...' : 'INITIATE DEPOSIT'}
                    </Button>
                  </div>
                </TabsContent>

                <TabsContent value="withdraw" className="space-y-6 mt-6 transform scale-[0.9] origin-top">
                  <div className="space-y-4">
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <Label htmlFor="note" className="text-cyber-glow font-mono text-sm">
                          SECRET NOTE
                        </Label>
                        {note && (
                          <span className="text-cyber-glow font-mono text-xs">
                            Balance: {noteBalance} SOL
                          </span>
                        )}
                      </div>
                      <Textarea
                        id="note"
                        placeholder="Paste your secret note here..."
                        value={note}
                        onChange={(e) => handleNoteChange(e.target.value)}
                        className="mt-2 bg-cyber-dark border-cyber-glow/30 text-cyber-glow font-mono placeholder:text-muted-foreground resize-none"
                        rows={4}
                      />
                      <p className="text-xs text-muted-foreground font-mono mt-1">
                        This note was generated during your deposit transaction
                      </p>
                    </div>

                    <div>
                      <Label htmlFor="recipient" className="text-cyber-glow font-mono text-sm">
                        RECIPIENT ADDRESS
                      </Label>
                      <Input
                        id="recipient"
                        placeholder="Solana address..."
                        value={recipientAddress}
                        onChange={(e) => setRecipientAddress(e.target.value)}
                        className="mt-2 bg-cyber-dark border-cyber-glow/30 text-cyber-glow font-mono placeholder:text-muted-foreground"
                      />
                      <p className="text-xs text-muted-foreground font-mono mt-1">
                        Destination address for your anonymous withdrawal
                      </p>
                    </div>

                    <Button 
                      variant="cyber" 
                      className="w-full py-6 text-lg"
                      onClick={handleWithdraw}
                      disabled={!note || !recipientAddress || isShielding || parseFloat(noteBalance) === 0}
                    >
                      {isShielding ? 'PROCESSING...' : 'EXECUTE WITHDRAWAL'}
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
        </Card>

        <div className="text-center mt-8 text-xs text-muted-foreground font-mono">
          <p>NO LOGS • NO KYC • NO TRACES</p>
          <p className="mt-1">Your privacy is your right.</p>
        </div>
      </div>

      {showNotePopup && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-cyber-surface border border-cyber-glow/30 rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-cyber-glow font-mono text-lg">BACKUP YOUR NOTE</h3>
              <button
                onClick={() => setShowNotePopup(false)}
                className="text-cyber-glow hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            
            <p className="text-white text-sm mb-4 font-mono">
              Please back up your note. You will need it later to withdraw your deposit.
              Treat your note as a private key - never share it with anyone.
            </p>

            <div className="bg-cyber-dark p-3 rounded-lg mb-4 relative">
              <p className="text-cyber-glow font-mono text-xs break-all">
                {generatedNote}
              </p>
              <button
                onClick={() => copyToClipboard(generatedNote)}
                className="absolute top-2 right-2 text-cyber-glow hover:text-white"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={() => copyToClipboard(generatedNote)}
                variant="cyber"
                className="flex-1"
              >
                <Copy className="h-4 w-4 mr-2" />
                COPY
              </Button>
              <Button
                onClick={downloadNote}
                variant="cyber"
                className="flex-1"
              >
                <Download className="h-4 w-4 mr-2" />
                DOWNLOAD
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
