import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getSuiClient } from "./client";
import { loadUserKeypair } from "./wallets";
import { logger } from "../helpers/logger";
import type { TransactionResult } from "./types";

/**
 * Execute a transaction and wait for confirmation
 */
export async function executeTransaction(
  tx: Transaction,
  signer: Ed25519Keypair
): Promise<TransactionResult> {
  const client = getSuiClient();

  try {
    // Sign and execute the transaction
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
      },
    });

    // Check if transaction was successful
    const success = result.effects?.status?.status === "success";

    if (!success) {
      const error = result.effects?.status?.error || "Unknown error";
      logger.error(
        { digest: result.digest, error },
        "Transaction failed"
      );

      return {
        digest: result.digest,
        success: false,
        effects: result.effects,
        error,
      };
    }

    logger.info(
      { digest: result.digest },
      "Transaction executed successfully"
    );

    return {
      digest: result.digest,
      success: true,
      effects: result.effects,
    };
  } catch (error) {
    logger.error({ error }, "Failed to execute transaction");
    
    return {
      digest: "",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute a transaction with a user's encrypted custodial wallet
 */
export async function executeUserTransaction(
  telegramId: string,
  password: string,
  tx: Transaction
): Promise<TransactionResult> {
  const keypair = loadUserKeypair(telegramId, password);
  return executeTransaction(tx, keypair);
}

/**
 * Wait for a transaction to be confirmed
 */
export async function waitForTransaction(
  digest: string,
  timeoutMs: number = 30000
): Promise<boolean> {
  const client = getSuiClient();
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await client.getTransactionBlock({
        digest,
        options: {
          showEffects: true,
        },
      });

      if (result.effects?.status?.status === "success") {
        return true;
      }

      if (result.effects?.status?.status === "failure") {
        logger.error(
          { digest, error: result.effects.status.error },
          "Transaction failed"
        );
        return false;
      }
    } catch (error) {
      // Transaction not found yet, continue waiting
    }

    // Wait 1 second before checking again
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  logger.warn({ digest }, "Transaction confirmation timeout");
  return false;
}

/**
 * Get transaction details
 */
export async function getTransaction(digest: string) {
  const client = getSuiClient();

  try {
    return await client.getTransactionBlock({
      digest,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
        showInput: true,
      },
    });
  } catch (error) {
    logger.error({ error, digest }, "Failed to get transaction");
    throw error;
  }
}

/**
 * Format explorer link for transaction
 */
export function getExplorerTxLink(digest: string, network: "testnet" | "mainnet" = "testnet"): string {
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}

/**
 * Format explorer link for object
 */
export function getExplorerObjectLink(objectId: string, network: "testnet" | "mainnet" = "testnet"): string {
  return `https://suiscan.xyz/${network}/object/${objectId}`;
}

/**
 * Format explorer link for address
 */
export function getExplorerAddressLink(address: string, network: "testnet" | "mainnet" = "testnet"): string {
  return `https://suiscan.xyz/${network}/account/${address}`;
}

/**
 * Estimate gas for a transaction
 */
export async function estimateGas(tx: Transaction): Promise<bigint> {
  const client = getSuiClient();

  try {
    // Dry run the transaction to estimate gas
    const dryRunResult = await client.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client }),
    });

    if (dryRunResult.effects.status.status !== "success") {
      throw new Error("Dry run failed: " + dryRunResult.effects.status.error);
    }

    // Get gas used from effects
    const gasUsed = dryRunResult.effects.gasUsed;
    const totalGas = 
      BigInt(gasUsed.computationCost) +
      BigInt(gasUsed.storageCost) -
      BigInt(gasUsed.storageRebate);

    return totalGas;
  } catch (error) {
    logger.error({ error }, "Failed to estimate gas");
    throw error;
  }
}
