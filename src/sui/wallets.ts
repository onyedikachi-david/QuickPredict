import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  type BinaryLike,
  type CipherKey,
} from "crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey, SUI_PRIVATE_KEY_PREFIX } from "@mysten/sui/cryptography";
import { fromHex } from "@mysten/sui/utils";
import { createUserWallet, getUserWallet } from "../db/wallets";
import type { UserWallet } from "../db/schema";

const CIPHER = "aes-256-gcm";
const KDF = "pbkdf2-sha256:310000";
const PBKDF2_ITERATIONS = 310_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

export type CreatedWallet = {
  address: string;
};

export function validateWalletPassword(password: string): void {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters long");
  }
}

function deriveEncryptionKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(
    password,
    salt as unknown as BinaryLike,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha256"
  );
}

function encryptPrivateKey(privateKey: string, password: string) {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveEncryptionKey(password, salt);
  const cipher = createCipheriv(
    CIPHER,
    key as unknown as CipherKey,
    iv as unknown as BinaryLike
  );
  const encrypted =
    cipher.update(privateKey, "utf8", "base64") + cipher.final("base64");

  return {
    encryptedPrivateKey: encrypted,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    kdf: KDF,
  };
}

function decryptPrivateKey(wallet: UserWallet, password: string): string {
  const salt = Buffer.from(wallet.salt, "base64");
  const iv = Buffer.from(wallet.iv, "base64");
  const authTag = Buffer.from(wallet.auth_tag, "base64");
  const encryptedPrivateKey = Buffer.from(wallet.encrypted_private_key, "base64");
  const key = deriveEncryptionKey(password, salt);
  const decipher = createDecipheriv(
    CIPHER,
    key as unknown as CipherKey,
    iv as unknown as BinaryLike
  );
  decipher.setAuthTag(authTag as unknown as NodeJS.ArrayBufferView);

  try {
    return (
      decipher.update(
        encryptedPrivateKey as unknown as NodeJS.ArrayBufferView,
        undefined,
        "utf8"
      ) + decipher.final("utf8")
    );
  } catch {
    throw new Error("Invalid wallet password");
  }
}

export function parsePrivateKey(privateKey: string): Ed25519Keypair {
  if (privateKey.startsWith(SUI_PRIVATE_KEY_PREFIX)) {
    const parsed = decodeSuiPrivateKey(privateKey);

    if (parsed.scheme !== "ED25519") {
      throw new Error(`Wallet private key must use ED25519, received ${parsed.scheme}`);
    }

    return Ed25519Keypair.fromSecretKey(parsed.secretKey);
  }

  const cleanHex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;

  if (!/^[a-fA-F0-9]{64}$/.test(cleanHex)) {
    throw new Error("Wallet private key must be a Sui CLI suiprivkey or 32-byte hex string");
  }

  return Ed25519Keypair.fromSecretKey(fromHex(cleanHex));
}

export function createEncryptedUserWallet(
  telegramId: string,
  password: string
): CreatedWallet {
  validateWalletPassword(password);

  const existingWallet = getUserWallet(telegramId);
  if (existingWallet) {
    throw new Error("Wallet already exists for this user");
  }

  const keypair = Ed25519Keypair.generate();
  const privateKey = keypair.getSecretKey();
  const address = keypair.getPublicKey().toSuiAddress();
  const encrypted = encryptPrivateKey(privateKey, password);

  createUserWallet({
    telegramId,
    suiAddress: address,
    encryptedPrivateKey: encrypted.encryptedPrivateKey,
    salt: encrypted.salt,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    kdf: encrypted.kdf,
  });

  return { address };
}

export function loadUserKeypair(
  telegramId: string,
  password: string
): Ed25519Keypair {
  const wallet = getUserWallet(telegramId);

  if (!wallet) {
    throw new Error("No wallet found. Create one first with /wallet create <password>");
  }

  const privateKey = decryptPrivateKey(wallet, password);
  const keypair = parsePrivateKey(privateKey);
  const address = keypair.getPublicKey().toSuiAddress();

  if (address !== wallet.sui_address) {
    throw new Error("Wallet address mismatch");
  }

  return keypair;
}

export function getUserWalletAddress(telegramId: string): string | null {
  return getUserWallet(telegramId)?.sui_address || null;
}
