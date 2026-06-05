import { getDatabase, type UserWallet } from "./schema";

export type CreateUserWalletInput = {
  telegramId: string;
  suiAddress: string;
  encryptedPrivateKey: string;
  salt: string;
  iv: string;
  authTag: string;
  kdf: string;
};

export function getUserWallet(telegramId: string): UserWallet | null {
  const db = getDatabase();
  return (
    (db
      .prepare("SELECT * FROM user_wallets WHERE telegram_id = ?")
      .get(telegramId) as UserWallet | undefined) || null
  );
}

export function createUserWallet(input: CreateUserWalletInput): UserWallet {
  const db = getDatabase();
  const now = Date.now();

  db.prepare(
    `INSERT INTO user_wallets (
      telegram_id,
      sui_address,
      encrypted_private_key,
      salt,
      iv,
      auth_tag,
      kdf,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.telegramId,
    input.suiAddress,
    input.encryptedPrivateKey,
    input.salt,
    input.iv,
    input.authTag,
    input.kdf,
    now,
    now
  );

  const wallet = getUserWallet(input.telegramId);
  if (!wallet) {
    throw new Error("Failed to create user wallet");
  }

  return wallet;
}

export function userWalletExists(telegramId: string): boolean {
  return getUserWallet(telegramId) !== null;
}

/**
 * Get the user's PredictManager object id, if one has been created.
 */
export function getUserManagerId(telegramId: string): string | null {
  return getUserWallet(telegramId)?.predict_manager_id || null;
}

/**
 * Persist the PredictManager object id for a user after on-chain creation.
 */
export function setUserManagerId(telegramId: string, managerId: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE user_wallets SET predict_manager_id = ?, updated_at = ? WHERE telegram_id = ?"
  ).run(managerId, Date.now(), telegramId);
}
