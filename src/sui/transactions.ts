import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getRpcClient, getSuiClient } from "./client";
import { getNetworkConfig } from "../config/network";
import { loadUserKeypair } from "./wallets";
import { logger } from "../helpers/logger";
import type { TransactionResult } from "./types";

/**
 * Execute a transaction and wait for confirmation
 */
// Transport for transaction execution. gRPC is the default (JSON-RPC sunsets
// 2026-07-31); validated live on testnet (create_manager + coin-input PTBs).
// Override with SUI_EXECUTE_TRANSPORT=jsonrpc to instantly revert if needed.
const EXECUTE_TRANSPORT = (process.env.SUI_EXECUTE_TRANSPORT || "grpc").toLowerCase();

export async function executeTransaction(
  tx: Transaction,
  signer: Ed25519Keypair
): Promise<TransactionResult> {
  return EXECUTE_TRANSPORT === "grpc"
    ? executeViaGrpc(tx, signer)
    : executeViaJsonRpc(tx, signer);
}

async function executeViaJsonRpc(
  tx: Transaction,
  signer: Ed25519Keypair
): Promise<TransactionResult> {
  const client = getRpcClient();

  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
      },
    });

    const success = result.effects?.status?.status === "success";
    if (!success) {
      const error = result.effects?.status?.error || "Unknown error";
      logger.error({ digest: result.digest, error }, "Transaction failed");
      return {
        digest: result.digest,
        success: false,
        effects: result.effects,
        objectChanges: result.objectChanges,
        error,
      };
    }

    logger.info({ digest: result.digest }, "Transaction executed successfully");
    return {
      digest: result.digest,
      success: true,
      effects: result.effects,
      objectChanges: result.objectChanges,
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

async function executeViaGrpc(
  tx: Transaction,
  signer: Ed25519Keypair
): Promise<TransactionResult> {
  const client = getSuiClient();

  try {
    // gRPC TransactionExecutionService.ExecuteTransaction. `objectTypes` makes
    // the SDK request the effects.changed_objects mask so created object ids +
    // types come back (used to find the new PredictManager on create_manager).
    const result: any = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      include: { effects: true, objectTypes: true },
    });

    // gRPC returns a discriminated union: { $kind, Transaction | FailedTransaction }.
    // The digest/status/effects/objectTypes live nested under that key, not at top level.
    const data = result?.Transaction ?? result?.FailedTransaction ?? result;
    const digest = data?.digest ?? "";
    const success = result?.$kind === "Transaction" && data?.status?.success === true;

    if (!success) {
      const err = data?.status?.error;
      const error =
        typeof err === "string"
          ? err
          : err?.message ?? err?.description ?? JSON.stringify(err ?? "Unknown error");
      logger.error({ digest, error }, "Transaction failed (gRPC)");
      return { digest, success: false, effects: data?.effects, error };
    }

    // Normalize gRPC `objectTypes` (objectId -> type map) into the objectChanges
    // shape consumers expect ({ objectId, objectType }).
    const objectChanges = Object.entries(data?.objectTypes ?? {}).map(
      ([objectId, objectType]) => ({ type: "created", objectId, objectType })
    );

    logger.info({ digest }, "Transaction executed successfully (gRPC)");
    return {
      digest,
      success: true,
      effects: data?.effects,
      objectChanges,
    };
  } catch (error) {
    logger.error({ error }, "Failed to execute transaction (gRPC)");
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
 * Format explorer link for transaction
 */
export function getExplorerTxLink(digest: string): string {
  return `${getNetworkConfig().endpoints.explorerBase}/tx/${digest}`;
}

/**
 * Format explorer link for object
 */
export function getExplorerObjectLink(objectId: string): string {
  return `${getNetworkConfig().endpoints.explorerBase}/object/${objectId}`;
}

/**
 * Format explorer link for address
 */
export function getExplorerAddressLink(address: string): string {
  return `${getNetworkConfig().endpoints.explorerBase}/account/${address}`;
}
