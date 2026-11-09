/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * End-to-End Encryption (E2EE) & Authenticated Voice Call Signaling Crypto Service for Spark
 *
 * Cryptographic Architecture & Security Design:
 * 1. Strict Key Separation (Never Reuses ECDH Keys for ECDSA):
 *    - Key Agreement Keypair: ECDH over NIST P-256 (secp256r1), usages: ['deriveKey', 'deriveBits'] ONLY.
 *    - Digital Signature Keypair: ECDSA over NIST P-256 (secp256r1) with SHA-256, usages: ['sign'] / ['verify'] ONLY.
 *    - Separate independent random private scalars are generated for ECDH and ECDSA. Reusing the same curve point
 *      for both ECDH and ECDSA is explicitly rejected during bundle verification.
 *
 * 2. Private-Key Storage Design & Honest Browser Limitations:
 *    - Both the ECDH private key and ECDSA signing private key are generated with `extractable: false` at creation time
 *      and stored as native structured-cloned `CryptoKey` handles in IndexedDB (`SparkE2EESecretsStore` v2).
 *    - Private keys are NEVER exported to JWK or stored as plaintext/extractable JSON in IndexedDB or localStorage.
 *      Any legacy v1 record containing `privateKeyJwk` is automatically migrated by generating fresh `extractable: false`
 *      `CryptoKey` pairs and purging `privateKeyJwk`.
 *    - Documented Browser Limitation: Storing `extractable: false` `CryptoKey` handles in IndexedDB prevents raw private
 *      scalar (`d`) extraction via `crypto.subtle.exportKey()` or JSON serialization. However, in a standard Web browser
 *      without per-operation hardware WebAuthn prompts, same-origin JavaScript (e.g. during an active XSS compromise)
 *      can still obtain the `CryptoKey` handle from IndexedDB and invoke `crypto.subtle.sign()` or `deriveBits()` as an
 *      in-session oracle while the page is open. Clearing site storage also erases IndexedDB keys, requiring key rotation.
 *
 * 3. Identity Binding, Key Registration, Key Rotation & Mismatch Rejection (TOFU Pinning):
 *    - Each user publishes a `PublishedUserCryptoKeyBundle` (`spark_key_bundle_v2`) containing distinct ECDH and ECDSA
 *      public keys, SHA-256 key fingerprints, `keyRotationVersion`, and a cryptographic `identityBinding` signed by
 *      the user's ECDSA P-256 private key over `userId | keyRotationVersion | ecdhFingerprint | ecdsaFingerprint | issuedAt`.
 *    - When a peer's key bundle is fetched, its self-signed `identityBinding` and distinct key coordinates are verified first,
 *      and then checked against the local `peer_key_pins` store.
 *    - Newly fetched signing keys that differ from an existing pinned key for that user are NEVER silently trusted:
 *      any unapproved key change or version downgrade is rejected (`trusted: false, keyMismatchDetected: true`) until
 *      explicitly approved via `approvePeerKeyRotation()`.
 */

import {
  PeerPinnedKeyRecord,
  PublishedIdentityBinding,
  PublishedPublicKeyDescriptor,
  PublishedUserCryptoKeyBundle,
} from '../types';
import { getSupabase, isSupabaseConfigured } from './supabase';

const DB_NAME = 'SparkE2EESecretsStore';
const DB_VERSION = 2;
const STORE_NAME = 'device_identity_keys';
const PIN_STORE_NAME = 'peer_key_pins';

export const E2EE_VERSION = 'e2ee_ecdh_aes_gcm_v1';
export const KEY_BUNDLE_VERSION = 'spark_key_bundle_v2';
export const IDENTITY_BINDING_VERSION = 'spark_id_bind_v2';

export interface StoredDeviceKeyMaterial {
  userId: string;
  keyRotationVersion: number;
  ecdhPrivateKey: CryptoKey;
  ecdhPublicKey: CryptoKey;
  ecdsaSigningPrivateKey: CryptoKey;
  ecdsaVerifyPublicKey: CryptoKey;
  ecdhPublicJwk: JsonWebKey;
  ecdsaPublicJwk: JsonWebKey;
  ecdhFingerprint: string;
  ecdsaFingerprint: string;
  publishedBundle: PublishedUserCryptoKeyBundle;
  createdAt: string;
  rotatedAt: string;
}

export interface VerifiedPeerKeyBundleResult {
  trusted: boolean;
  status:
    | 'pinned_first_use'
    | 'matched_pin'
    | 'key_mismatch_rejected'
    | 'version_downgrade_rejected'
    | 'invalid_bundle_rejected';
  keyMismatchDetected: boolean;
  reason?: string;
  peerUserId?: string;
  keyRotationVersion?: number;
  ecdhPublicKey?: CryptoKey;
  ecdsaVerifyPublicKey?: CryptoKey;
  ecdhFingerprint?: string;
  ecdsaFingerprint?: string;
  bundle?: PublishedUserCryptoKeyBundle;
  pinnedRecord?: PeerPinnedKeyRecord;
}

// In-memory caches (purged on logout)
const conversationKeyCache = new Map<string, CryptoKey>();
const directionalCallKeyCache = new Map<string, CryptoKey>();
const inflightKeyPairPromises = new Map<string, Promise<DeviceIdentityKeyPairResult>>();
const inflightKeySyncPromises = new Map<string, Promise<void>>();
const pendingNewKeyConfirmPromises = new Map<string, Promise<boolean>>();
const declinedNewKeyOnDeviceUsers = new Set<string>();

export interface DeviceIdentityKeyPairResult {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicJwk: PublishedUserCryptoKeyBundle;
  signingPrivateKey: CryptoKey;
  verificationPublicKey: CryptoKey;
  ecdhFingerprint: string;
  ecdsaFingerprint: string;
  keyRotationVersion: number;
  publishedBundle: PublishedUserCryptoKeyBundle;
}

// Fallback stores used ONLY in headless/Node test environments where window.indexedDB is absent
const memoryDeviceKeyStore = new Map<string, StoredDeviceKeyMaterial>();
const memoryPeerPinStore = new Map<string, PeerPinnedKeyRecord>();
const memoryPublishedSupabaseKeys = new Map<string, PublishedUserCryptoKeyBundle>();

function getSubtleCrypto(): SubtleCrypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle;
  }
  if (typeof window !== 'undefined' && window.crypto?.subtle) {
    return window.crypto.subtle;
  }
  throw new Error('WebCrypto SubtleCrypto API is not available in this environment.');
}

function isIndexedDBAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openDeviceKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDBAvailable()) {
      reject(new Error('IndexedDB is not available on this platform.'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'userId' });
      }
      if (!db.objectStoreNames.contains(PIN_STORE_NAME)) {
        db.createObjectStore(PIN_STORE_NAME, { keyPath: 'pinId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Convert ArrayBuffer / Uint8Array to Base64
export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert Base64 to Uint8Array
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Convert ArrayBuffer / Uint8Array to lowercase hex
export function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function isWebCryptoAvailable(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.subtle !== 'undefined'
  );
}

/**
 * Computes a deterministic SHA-256 hex fingerprint over a P-256 public key's coordinates and intended usage.
 */
export async function computePublicKeyFingerprint(
  publicJwk: { kty?: string; crv?: string; x?: string; y?: string },
  keyUsage: 'keyAgreement' | 'digitalSignature'
): Promise<string> {
  if (
    !publicJwk ||
    publicJwk.kty !== 'EC' ||
    publicJwk.crv !== 'P-256' ||
    typeof publicJwk.x !== 'string' ||
    !publicJwk.x ||
    typeof publicJwk.y !== 'string' ||
    !publicJwk.y
  ) {
    throw new Error('Invalid P-256 public JWK coordinates for fingerprint calculation.');
  }
  const subtle = getSubtleCrypto();
  const encoder = new TextEncoder();
  const canonical = `spark_p256_fp_v2|${keyUsage}|P-256|${publicJwk.x}|${publicJwk.y}`;
  const digest = await subtle.digest('SHA-256', encoder.encode(canonical));
  return bufferToHex(digest);
}

/**
 * Canonical string covered by the ECDSA P-256 identity-binding signature.
 */
export function serializeIdentityBindingCanonical(params: {
  userId: string;
  keyRotationVersion: number;
  ecdhFingerprint: string;
  ecdsaFingerprint: string;
  issuedAt: string;
}): string {
  return [
    IDENTITY_BINDING_VERSION,
    params.userId,
    String(params.keyRotationVersion),
    params.ecdhFingerprint,
    params.ecdsaFingerprint,
    params.issuedAt,
  ].join('|');
}

/**
 * Imports a public P-256 JWK strictly as an ECDH public key (`usages: []`).
 */
export async function importEcdhPublicKeyFromJwk(publicKeyJwk: JsonWebKey): Promise<CryptoKey> {
  if (!publicKeyJwk || publicKeyJwk.kty !== 'EC' || publicKeyJwk.crv !== 'P-256' || !publicKeyJwk.x || !publicKeyJwk.y) {
    throw new Error('Invalid ECDH P-256 public JWK.');
  }
  const subtle = getSubtleCrypto();
  return subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: publicKeyJwk.x,
      y: publicKeyJwk.y,
      ext: true,
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

/**
 * Imports a public P-256 JWK strictly as an ECDSA verification public key (`usages: ['verify']`).
 */
export async function importPublicVerificationKeyFromJwk(
  publicKeyJwk: JsonWebKey
): Promise<CryptoKey> {
  if (!publicKeyJwk || publicKeyJwk.kty !== 'EC' || publicKeyJwk.crv !== 'P-256' || !publicKeyJwk.x || !publicKeyJwk.y) {
    throw new Error('Invalid ECDSA P-256 public JWK.');
  }
  const subtle = getSubtleCrypto();
  return subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: publicKeyJwk.x,
      y: publicKeyJwk.y,
      ext: true,
      key_ops: ['verify'],
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
}

/**
 * Generates SEPARATE, NON-EXTRACTABLE (`extractable: false`) ECDH P-256 and ECDSA P-256 key pairs,
 * signs the cryptographic `identityBinding` linking both public keys to `userId` and `keyRotationVersion`,
 * and returns the complete `StoredDeviceKeyMaterial`.
 */
async function generateSeparatedNonExtractableDeviceKeys(
  userId: string,
  keyRotationVersion: number,
  createdAt?: string
): Promise<StoredDeviceKeyMaterial> {
  const subtle = getSubtleCrypto();

  // 1. Generate independent ECDH P-256 key pair with extractable: FALSE on the private key
  const ecdhPair = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false, // Private key is non-extractable from birth!
    ['deriveKey', 'deriveBits']
  );

  // 2. Generate independent ECDSA P-256 key pair with extractable: FALSE on the private key
  const ecdsaPair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // Private key is non-extractable from birth!
    ['sign', 'verify']
  );

  // 3. Export ONLY the public keys to JWK
  const rawEcdhPub = await subtle.exportKey('jwk', ecdhPair.publicKey);
  const rawEcdsaPub = await subtle.exportKey('jwk', ecdsaPair.publicKey);

  if (!rawEcdhPub.x || !rawEcdhPub.y || !rawEcdsaPub.x || !rawEcdsaPub.y) {
    throw new Error('Failed to export public JWK coordinates.');
  }

  // Enforce strict domain separation: ECDH and ECDSA public keys must never share coordinates
  if (rawEcdhPub.x === rawEcdsaPub.x && rawEcdhPub.y === rawEcdsaPub.y) {
    throw new Error('Cryptographic key separation violation: ECDH and ECDSA keys collided.');
  }

  const ecdhPublicJwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: rawEcdhPub.x,
    y: rawEcdhPub.y,
    ext: true,
  };

  const ecdsaPublicJwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: rawEcdsaPub.x,
    y: rawEcdsaPub.y,
    ext: true,
  };

  const [ecdhFingerprint, ecdsaFingerprint] = await Promise.all([
    computePublicKeyFingerprint(ecdhPublicJwk, 'keyAgreement'),
    computePublicKeyFingerprint(ecdsaPublicJwk, 'digitalSignature'),
  ]);

  const nowIso = new Date().toISOString();
  const bindingCanonical = serializeIdentityBindingCanonical({
    userId,
    keyRotationVersion,
    ecdhFingerprint,
    ecdsaFingerprint,
    issuedAt: nowIso,
  });

  const bindingSigBytes = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    ecdsaPair.privateKey,
    new TextEncoder().encode(bindingCanonical)
  );

  const identityBinding: PublishedIdentityBinding = {
    version: IDENTITY_BINDING_VERSION,
    userId,
    keyRotationVersion,
    ecdhFingerprint,
    ecdsaFingerprint,
    issuedAt: nowIso,
    signature: bufferToBase64(bindingSigBytes),
  };

  const ecdhDescriptor: PublishedPublicKeyDescriptor = {
    kty: 'EC',
    crv: 'P-256',
    x: rawEcdhPub.x,
    y: rawEcdhPub.y,
    alg: 'ECDH-ES+HKDF-256',
    keyUsage: 'keyAgreement',
    fingerprint: ecdhFingerprint,
  };

  const ecdsaDescriptor: PublishedPublicKeyDescriptor = {
    kty: 'EC',
    crv: 'P-256',
    x: rawEcdsaPub.x,
    y: rawEcdsaPub.y,
    alg: 'ES256',
    keyUsage: 'digitalSignature',
    fingerprint: ecdsaFingerprint,
  };

  const publishedBundle: PublishedUserCryptoKeyBundle = {
    // Top-level ECDH coordinates preserve backward compatibility with 1-to-1 chat E2EE
    kty: 'EC',
    crv: 'P-256',
    x: rawEcdhPub.x,
    y: rawEcdhPub.y,
    ext: true,
    bundleVersion: KEY_BUNDLE_VERSION,
    algorithm: 'ECDH-P256+ECDSA-P256-v2',
    userId,
    keyRotationVersion,
    ecdhPublicKey: ecdhDescriptor,
    ecdsaSigningPublicKey: ecdsaDescriptor,
    identityBinding,
  };

  return {
    userId,
    keyRotationVersion,
    ecdhPrivateKey: ecdhPair.privateKey,
    ecdhPublicKey: ecdhPair.publicKey,
    ecdsaSigningPrivateKey: ecdsaPair.privateKey,
    ecdsaVerifyPublicKey: ecdsaPair.publicKey,
    ecdhPublicJwk,
    ecdsaPublicJwk,
    ecdhFingerprint,
    ecdsaFingerprint,
    publishedBundle,
    createdAt: createdAt || nowIso,
    rotatedAt: nowIso,
  };
}

function formatDeviceKeyPairOutput(mat: StoredDeviceKeyMaterial): DeviceIdentityKeyPairResult {
  return {
    publicKey: mat.ecdhPublicKey,
    privateKey: mat.ecdhPrivateKey,
    publicJwk: mat.publishedBundle,
    signingPrivateKey: mat.ecdsaSigningPrivateKey,
    verificationPublicKey: mat.ecdsaVerifyPublicKey,
    ecdhFingerprint: mat.ecdhFingerprint,
    ecdsaFingerprint: mat.ecdsaFingerprint,
    keyRotationVersion: mat.keyRotationVersion,
    publishedBundle: mat.publishedBundle,
  };
}

/**
 * Validates whether a stored IndexedDB record has valid separated ECDH and ECDSA CryptoKey handles.
 */
function isValidStoredNonExtractableRecord(record: any, expectedUserId: string): record is StoredDeviceKeyMaterial {
  if (!record || record.userId !== expectedUserId) return false;
  if (
    !record.ecdhPrivateKey ||
    !record.ecdhPublicKey ||
    !record.ecdsaSigningPrivateKey ||
    !record.ecdsaVerifyPublicKey ||
    !record.publishedBundle
  ) {
    return false;
  }
  if (
    record.ecdhPrivateKey.algorithm?.name !== 'ECDH' ||
    record.ecdsaSigningPrivateKey.algorithm?.name !== 'ECDSA'
  ) {
    return false;
  }
  return true;
}

/**
 * Preserves an existing local ECDH private key from a legacy record without generating a new ECDH key pair.
 */
async function preserveExistingLocalRecordIfPresent(
  record: any,
  userId: string
): Promise<StoredDeviceKeyMaterial | null> {
  if (!record) return null;
  if (isValidStoredNonExtractableRecord(record, userId)) {
    return record;
  }

  const subtle = getSubtleCrypto();
  let ecdhPrivateKey: CryptoKey | null =
    record.ecdhPrivateKey?.algorithm?.name === 'ECDH'
      ? record.ecdhPrivateKey
      : record.privateKey?.algorithm?.name === 'ECDH'
      ? record.privateKey
      : null;

  let ecdhPublicKey: CryptoKey | null =
    record.ecdhPublicKey?.algorithm?.name === 'ECDH'
      ? record.ecdhPublicKey
      : record.publicKey?.algorithm?.name === 'ECDH'
      ? record.publicKey
      : null;

  let ecdhPublicJwk: JsonWebKey | null =
    record.ecdhPublicJwk?.x && record.ecdhPublicJwk?.y
      ? record.ecdhPublicJwk
      : record.publicKeyJwk?.x && record.publicKeyJwk?.y
      ? record.publicKeyJwk
      : record.publishedBundle?.x && record.publishedBundle?.y
      ? {
          kty: 'EC',
          crv: 'P-256',
          x: record.publishedBundle.x,
          y: record.publishedBundle.y,
          ext: true,
        }
      : null;

  if (!ecdhPrivateKey && record.privateKeyJwk?.d && record.privateKeyJwk?.x && record.privateKeyJwk?.y) {
    try {
      ecdhPrivateKey = await subtle.importKey(
        'jwk',
        record.privateKeyJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveKey', 'deriveBits']
      );
      if (!ecdhPublicJwk) {
        ecdhPublicJwk = {
          kty: 'EC',
          crv: 'P-256',
          x: record.privateKeyJwk.x,
          y: record.privateKeyJwk.y,
          ext: true,
        };
      }
    } catch {
      ecdhPrivateKey = null;
    }
  }

  if (!ecdhPrivateKey) {
    return null;
  }

  if (!ecdhPublicJwk && ecdhPublicKey) {
    try {
      const exported = await subtle.exportKey('jwk', ecdhPublicKey);
      if (exported.x && exported.y) {
        ecdhPublicJwk = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y, ext: true };
      }
    } catch {}
  }

  if (!ecdhPublicKey && ecdhPublicJwk) {
    try {
      ecdhPublicKey = await importEcdhPublicKeyFromJwk(ecdhPublicJwk);
    } catch {}
  }

  if (!ecdhPublicKey || !ecdhPublicJwk?.x || !ecdhPublicJwk?.y) {
    return null;
  }

  let ecdsaSigningPrivateKey: CryptoKey | null =
    record.ecdsaSigningPrivateKey?.algorithm?.name === 'ECDSA'
      ? record.ecdsaSigningPrivateKey
      : null;
  let ecdsaVerifyPublicKey: CryptoKey | null =
    record.ecdsaVerifyPublicKey?.algorithm?.name === 'ECDSA'
      ? record.ecdsaVerifyPublicKey
      : null;
  let ecdsaPublicJwk: JsonWebKey | null =
    record.ecdsaPublicJwk?.x && record.ecdsaPublicJwk?.y ? record.ecdsaPublicJwk : null;

  if (!ecdsaSigningPrivateKey || !ecdsaVerifyPublicKey || !ecdsaPublicJwk) {
    const ecdsaPair = await subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify']
    );
    const rawEcdsaPub = await subtle.exportKey('jwk', ecdsaPair.publicKey);
    ecdsaSigningPrivateKey = ecdsaPair.privateKey;
    ecdsaVerifyPublicKey = ecdsaPair.publicKey;
    ecdsaPublicJwk = {
      kty: 'EC',
      crv: 'P-256',
      x: rawEcdsaPub.x,
      y: rawEcdsaPub.y,
      ext: true,
    };
  }

  const keyRotationVersion =
    typeof record.keyRotationVersion === 'number' && record.keyRotationVersion >= 1
      ? record.keyRotationVersion
      : 1;

  const [ecdhFingerprint, ecdsaFingerprint] = await Promise.all([
    computePublicKeyFingerprint(ecdhPublicJwk, 'keyAgreement'),
    computePublicKeyFingerprint(ecdsaPublicJwk, 'digitalSignature'),
  ]);

  const nowIso = new Date().toISOString();
  const bindingCanonical = serializeIdentityBindingCanonical({
    userId,
    keyRotationVersion,
    ecdhFingerprint,
    ecdsaFingerprint,
    issuedAt: nowIso,
  });

  const bindingSigBytes = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    ecdsaSigningPrivateKey,
    new TextEncoder().encode(bindingCanonical)
  );

  const publishedBundle: PublishedUserCryptoKeyBundle = {
    kty: 'EC',
    crv: 'P-256',
    x: ecdhPublicJwk.x,
    y: ecdhPublicJwk.y,
    ext: true,
    bundleVersion: KEY_BUNDLE_VERSION,
    algorithm: 'ECDH-P256+ECDSA-P256-v2',
    userId,
    keyRotationVersion,
    ecdhPublicKey: {
      kty: 'EC',
      crv: 'P-256',
      x: ecdhPublicJwk.x,
      y: ecdhPublicJwk.y,
      alg: 'ECDH-ES+HKDF-256',
      keyUsage: 'keyAgreement',
      fingerprint: ecdhFingerprint,
    },
    ecdsaSigningPublicKey: {
      kty: 'EC',
      crv: 'P-256',
      x: ecdsaPublicJwk.x!,
      y: ecdsaPublicJwk.y!,
      alg: 'ES256',
      keyUsage: 'digitalSignature',
      fingerprint: ecdsaFingerprint,
    },
    identityBinding: {
      version: IDENTITY_BINDING_VERSION,
      userId,
      keyRotationVersion,
      ecdhFingerprint,
      ecdsaFingerprint,
      issuedAt: nowIso,
      signature: bufferToBase64(bindingSigBytes),
    },
  };

  return {
    userId,
    keyRotationVersion,
    ecdhPrivateKey,
    ecdhPublicKey,
    ecdsaSigningPrivateKey,
    ecdsaVerifyPublicKey,
    ecdhPublicJwk,
    ecdsaPublicJwk,
    ecdhFingerprint,
    ecdsaFingerprint,
    publishedBundle,
    createdAt: record.createdAt || nowIso,
    rotatedAt: record.rotatedAt || nowIso,
  };
}

/**
 * Reads an existing device identity key pair from local storage without ever generating a new key pair.
 */
export async function getExistingDeviceIdentityKeyPair(
  userId: string
): Promise<DeviceIdentityKeyPairResult | null> {
  if (!userId || !isWebCryptoAvailable()) return null;

  if (!isIndexedDBAvailable()) {
    const existing = memoryDeviceKeyStore.get(userId);
    if (!existing) return null;
    const preserved = await preserveExistingLocalRecordIfPresent(existing, userId);
    if (!preserved) return null;
    memoryDeviceKeyStore.set(userId, preserved);
    return formatDeviceKeyPairOutput(preserved);
  }

  const db = await openDeviceKeyDatabase();
  const rawRecord = await new Promise<any>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const getReq = tx.objectStore(STORE_NAME).get(userId);
    getReq.onsuccess = () => resolve(getReq.result || null);
    getReq.onerror = () => reject(getReq.error);
  });

  if (!rawRecord) return null;
  if (isValidStoredNonExtractableRecord(rawRecord, userId)) {
    return formatDeviceKeyPairOutput(rawRecord);
  }

  const upgraded = await preserveExistingLocalRecordIfPresent(rawRecord, userId);
  if (!upgraded) return null;

  await new Promise<void>((resolve, reject) => {
    const writeTx = db.transaction(STORE_NAME, 'readwrite');
    writeTx.objectStore(STORE_NAME).put(upgraded);
    writeTx.oncomplete = () => resolve();
    writeTx.onerror = () => reject(writeTx.error);
  });

  return formatDeviceKeyPairOutput(upgraded);
}

/**
 * Fetches the user's current public_key entry in `user_crypto_keys` from the server.
 */
async function fetchServerUserPublicKeyRaw(userId: string): Promise<{
  exists: boolean;
  publicKey: any | null;
  errorOccurred: boolean;
}> {
  if (typeof window === 'undefined' && headlessTestRegistryEnabled) {
    const mem = memoryPublishedSupabaseKeys.get(userId) || null;
    return { exists: Boolean(mem), publicKey: mem, errorOccurred: false };
  }

  if (!isSupabaseConfigured()) {
    return { exists: false, publicKey: null, errorOccurred: false };
  }

  const supabase = getSupabase();
  if (!supabase) {
    return { exists: false, publicKey: null, errorOccurred: false };
  }

  try {
    const { data, error } = await supabase
      .from('user_crypto_keys')
      .select('public_key')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      return { exists: false, publicKey: null, errorOccurred: true };
    }

    return {
      exists: Boolean(data?.public_key),
      publicKey: data?.public_key || null,
      errorOccurred: false,
    };
  } catch {
    return { exists: false, publicKey: null, errorOccurred: true };
  }
}

function extractEcdhCoordinates(rawKey: any): { x: string; y: string } | null {
  if (!rawKey || typeof rawKey !== 'object') return null;
  const source =
    rawKey.ecdhPublicKey && typeof rawKey.ecdhPublicKey === 'object'
      ? rawKey.ecdhPublicKey
      : rawKey;
  if (typeof source.x === 'string' && source.x && typeof source.y === 'string' && source.y) {
    return { x: source.x, y: source.y };
  }
  return null;
}

/**
 * Compares the server's stored public key with this device's own public key.
 */
export function doesServerPublicKeyMatchLocal(
  serverPublicKey: any,
  localBundle: PublishedUserCryptoKeyBundle
): boolean {
  const serverEcdh = extractEcdhCoordinates(serverPublicKey);
  const localEcdh = extractEcdhCoordinates(localBundle);
  if (!serverEcdh || !localEcdh) return false;
  if (serverEcdh.x !== localEcdh.x || serverEcdh.y !== localEcdh.y) {
    return false;
  }

  if (
    serverPublicKey?.ecdsaSigningPublicKey?.x &&
    serverPublicKey?.ecdsaSigningPublicKey?.y &&
    localBundle?.ecdsaSigningPublicKey?.x &&
    localBundle?.ecdsaSigningPublicKey?.y
  ) {
    if (
      serverPublicKey.ecdsaSigningPublicKey.x !== localBundle.ecdsaSigningPublicKey.x ||
      serverPublicKey.ecdsaSigningPublicKey.y !== localBundle.ecdsaSigningPublicKey.y
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Shows a clear message when this device has no private key but the server already has a public key
 * for this user, and resolves true ONLY if the user explicitly confirms generating a new key.
 */
function confirmNewDeviceKeyGeneration(userId: string): Promise<boolean> {
  if (pendingNewKeyConfirmPromises.has(userId)) {
    return pendingNewKeyConfirmPromises.get(userId)!;
  }

  const promise = new Promise<boolean>((resolve) => {
    if (typeof document === 'undefined' || !document.body) {
      resolve(false);
      return;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,0.65);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,sans-serif;';

    const card = document.createElement('div');
    card.style.cssText =
      'max-width:400px;width:100%;background:#ffffff;border-radius:20px;padding:24px;box-shadow:0 20px 45px rgba(15,23,42,0.25);border:1px solid #e2e8f0;color:#0f172a;';

    const title = document.createElement('h3');
    title.textContent = 'Encryption Key Missing on This Device';
    title.style.cssText = 'margin:0 0 10px 0;font-size:17px;font-weight:700;color:#0f172a;';

    const body = document.createElement('p');
    body.textContent =
      'This device does not have your encryption private key, so older encrypted messages cannot be read on this device. Do you want to generate a new encryption key for this device?';
    body.style.cssText = 'margin:0 0 20px 0;font-size:14px;line-height:1.5;color:#475569;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText =
      'padding:10px 16px;border-radius:12px;border:1px solid #cbd5e1;background:#f8fafc;color:#334155;font-size:13px;font-weight:600;cursor:pointer;';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'Generate New Key';
    confirmBtn.style.cssText =
      'padding:10px 16px;border-radius:12px;border:none;background:#7c3aed;color:#ffffff;font-size:13px;font-weight:700;cursor:pointer;';

    const cleanup = (confirmed: boolean) => {
      try {
        overlay.remove();
      } catch {}
      resolve(confirmed);
    };

    cancelBtn.onclick = () => cleanup(false);
    confirmBtn.onclick = () => cleanup(true);

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }).finally(() => {
    pendingNewKeyConfirmPromises.delete(userId);
  });

  pendingNewKeyConfirmPromises.set(userId, promise);
  return promise;
}

/**
 * Retrieves the device's separated ECDH P-256 and ECDSA P-256 key pairs from IndexedDB.
 * - Rule 2: If a private key already exists on this device, NEVER generate a new key pair.
 * - Rule 4: If this device has no private key but the server already has a public key for this user,
 *   do NOT silently generate a new one and overwrite; show a clear message that older messages can't
 *   be read on this device, and generate a new key only after the user confirms.
 */
export async function getOrCreateDeviceIdentityKeyPair(
  userId: string
): Promise<DeviceIdentityKeyPairResult> {
  if (!isWebCryptoAvailable()) {
    throw new Error('WebCrypto API is not available in this browser context.');
  }

  if (inflightKeyPairPromises.has(userId)) {
    return inflightKeyPairPromises.get(userId)!;
  }

  const task = (async (): Promise<DeviceIdentityKeyPairResult> => {
    // 1. If a private key already exists on this device, NEVER generate a new key pair.
    const existingLocal = await getExistingDeviceIdentityKeyPair(userId);
    if (existingLocal) {
      return existingLocal;
    }

    // 2. No private key exists on this device. Check if the server already has a public key for this user.
    const serverStatus = await fetchServerUserPublicKeyRaw(userId);
    if (serverStatus.errorOccurred) {
      throw new Error(
        'Could not verify existing public key on server; refusing to generate a new key pair.'
      );
    }

    let nextVersion = 1;
    if (serverStatus.exists && serverStatus.publicKey) {
      if (declinedNewKeyOnDeviceUsers.has(userId)) {
        throw new Error(
          'Older messages cannot be read on this device because the private key is not present on this device.'
        );
      }

      const confirmed = await confirmNewDeviceKeyGeneration(userId);
      if (!confirmed) {
        declinedNewKeyOnDeviceUsers.add(userId);
        throw new Error(
          'Older messages cannot be read on this device. New key generation was cancelled by user.'
        );
      }

      const serverVersion = Number(serverStatus.publicKey?.keyRotationVersion);
      nextVersion = Number.isInteger(serverVersion) && serverVersion >= 1 ? serverVersion + 1 : 2;
    }

    const freshMaterial = await generateSeparatedNonExtractableDeviceKeys(userId, nextVersion);

    if (!isIndexedDBAvailable()) {
      memoryDeviceKeyStore.set(userId, freshMaterial);
      return formatDeviceKeyPairOutput(freshMaterial);
    }

    const db = await openDeviceKeyDatabase();
    await new Promise<void>((resolve, reject) => {
      const writeTx = db.transaction(STORE_NAME, 'readwrite');
      writeTx.objectStore(STORE_NAME).put(freshMaterial);
      writeTx.oncomplete = () => resolve();
      writeTx.onerror = () => reject(writeTx.error);
    });

    if (serverStatus.exists) {
      await syncPublicKeyToSupabase(userId, freshMaterial.publishedBundle);
    }

    return formatDeviceKeyPairOutput(freshMaterial);
  })().finally(() => {
    inflightKeyPairPromises.delete(userId);
  });

  inflightKeyPairPromises.set(userId, task);
  return task;
}

/**
 * Explicitly rotates the local user's ECDH P-256 and ECDSA P-256 key pairs, increments `keyRotationVersion`,
 * signs a new identity binding, persists the non-extractable `CryptoKey` handles, and syncs to Supabase.
 */
export async function rotateLocalDeviceKeys(
  userId: string
): Promise<PublishedUserCryptoKeyBundle> {
  if (!isWebCryptoAvailable()) {
    throw new Error('WebCrypto API is not available.');
  }

  let currentVersion = 0;
  let createdAt: string | undefined;

  if (!isIndexedDBAvailable()) {
    const existing = memoryDeviceKeyStore.get(userId);
    if (existing) {
      currentVersion = existing.keyRotationVersion;
      createdAt = existing.createdAt;
    }
    const rotated = await generateSeparatedNonExtractableDeviceKeys(
      userId,
      currentVersion + 1,
      createdAt
    );
    memoryDeviceKeyStore.set(userId, rotated);
    await syncPublicKeyToSupabase(userId, rotated.publishedBundle);
    return rotated.publishedBundle;
  }

  const db = await openDeviceKeyDatabase();
  const rotatedMaterial = await new Promise<StoredDeviceKeyMaterial>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const getReq = tx.objectStore(STORE_NAME).get(userId);

    getReq.onsuccess = async () => {
      const existing = getReq.result;
      if (existing && typeof existing.keyRotationVersion === 'number') {
        currentVersion = existing.keyRotationVersion;
        createdAt = existing.createdAt;
      }
      try {
        const fresh = await generateSeparatedNonExtractableDeviceKeys(
          userId,
          currentVersion + 1,
          createdAt
        );
        const writeTx = db.transaction(STORE_NAME, 'readwrite');
        writeTx.objectStore(STORE_NAME).put(fresh);
        writeTx.oncomplete = () => resolve(fresh);
        writeTx.onerror = () => reject(writeTx.error);
      } catch (e) {
        reject(e);
      }
    };
    getReq.onerror = () => reject(getReq.error);
  });

  await syncPublicKeyToSupabase(userId, rotatedMaterial.publishedBundle);
  return rotatedMaterial.publishedBundle;
}

// Flag used strictly in automated Node.js unit tests (typeof window === 'undefined')
let headlessTestRegistryEnabled = false;

export function enableHeadlessTestKeyRegistry(enabled: boolean): void {
  if (typeof window !== 'undefined') {
    throw new Error('Test key registry cannot be enabled in a browser environment.');
  }
  headlessTestRegistryEnabled = enabled;
}

/**
 * Publishes the current user's separated public key bundle (ECDH + ECDSA + signed identityBinding) to Supabase.
 * Rule 3: Only upsert the public key to Supabase if the server has no key for this user,
 * or the server's key differs from this device's own public key. If they match, make no write.
 */
export async function syncPublicKeyToSupabase(
  userId: string,
  publicKeyMaterial?: JsonWebKey | PublishedUserCryptoKeyBundle
): Promise<void> {
  if (!userId) return;

  if (inflightKeySyncPromises.has(userId)) {
    return inflightKeySyncPromises.get(userId)!;
  }

  const syncTask = (async () => {
    let bundleToPublish: PublishedUserCryptoKeyBundle | null = null;

    if (
      publicKeyMaterial &&
      'bundleVersion' in publicKeyMaterial &&
      publicKeyMaterial.bundleVersion === KEY_BUNDLE_VERSION
    ) {
      bundleToPublish = publicKeyMaterial as PublishedUserCryptoKeyBundle;
    } else {
      const existingLocal = await getExistingDeviceIdentityKeyPair(userId);
      if (!existingLocal) {
        return;
      }
      bundleToPublish = existingLocal.publishedBundle;
    }

    if (typeof window === 'undefined' && headlessTestRegistryEnabled) {
      const existingMem = memoryPublishedSupabaseKeys.get(userId);
      if (existingMem && doesServerPublicKeyMatchLocal(existingMem, bundleToPublish)) {
        return;
      }
      memoryPublishedSupabaseKeys.set(userId, bundleToPublish);
      return;
    }

    if (!isSupabaseConfigured()) return;
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      const { data: existingRow, error: selectError } = await supabase
        .from('user_crypto_keys')
        .select('public_key')
        .eq('user_id', userId)
        .maybeSingle();

      if (selectError) {
        console.warn('Could not read existing public key from Supabase:', selectError.message);
        return;
      }

      // If the server already has a key for this user and it matches this device's own public key, make no write.
      if (
        existingRow?.public_key &&
        doesServerPublicKeyMatchLocal(existingRow.public_key, bundleToPublish)
      ) {
        return;
      }

      const payload = {
        user_id: userId,
        public_key: bundleToPublish,
        algorithm: 'ECDH-P256+ECDSA-P256-v2',
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('user_crypto_keys')
        .upsert(payload, { onConflict: 'user_id' });

      if (error) {
        console.warn(
          'Could not sync public key bundle to Supabase (run SQL migration if table is missing):',
          error.message
        );
      }
    } catch (err) {
      console.warn('Error in syncPublicKeyToSupabase:', err);
    }
  })().finally(() => {
    inflightKeySyncPromises.delete(userId);
  });

  inflightKeySyncPromises.set(userId, syncTask);
  return syncTask;
}

/**
 * Cryptographically verifies a `PublishedUserCryptoKeyBundle` for:
 * 1. Explicit algorithm and version metadata (`spark_key_bundle_v2`, `ECDH-P256+ECDSA-P256-v2`).
 * 2. Strict user ID binding (`bundle.userId === expectedUserId` and `identityBinding.userId === expectedUserId`).
 * 3. Strict key separation (`ecdhPublicKey` and `ecdsaSigningPublicKey` must have different coordinates & fingerprints).
 * 4. Recomputed SHA-256 fingerprints matching both descriptors and `identityBinding`.
 * 5. Valid ECDSA P-256 signature over `serializeIdentityBindingCanonical(identityBinding)`.
 */
export async function verifyPublishedKeyBundleIntegrity(
  expectedUserId: string,
  rawBundle: unknown
): Promise<{
  valid: boolean;
  reason?: string;
  bundle?: PublishedUserCryptoKeyBundle;
  ecdhPublicKey?: CryptoKey;
  ecdsaVerifyPublicKey?: CryptoKey;
  ecdhFingerprint?: string;
  ecdsaFingerprint?: string;
}> {
  if (!expectedUserId || !rawBundle || typeof rawBundle !== 'object') {
    return { valid: false, reason: 'Missing or malformed public key bundle.' };
  }

  const candidate = rawBundle as Partial<PublishedUserCryptoKeyBundle>;
  if (
    candidate.bundleVersion !== KEY_BUNDLE_VERSION ||
    candidate.algorithm !== 'ECDH-P256+ECDSA-P256-v2'
  ) {
    return {
      valid: false,
      reason:
        'Peer key bundle is missing v2 separated ECDH+ECDSA algorithm/version metadata.',
    };
  }

  if (
    candidate.userId !== expectedUserId ||
    typeof candidate.keyRotationVersion !== 'number' ||
    !Number.isInteger(candidate.keyRotationVersion) ||
    candidate.keyRotationVersion < 1
  ) {
    return {
      valid: false,
      reason: 'Key bundle userId or keyRotationVersion is invalid.',
    };
  }

  const ecdhDesc = candidate.ecdhPublicKey;
  const ecdsaDesc = candidate.ecdsaSigningPublicKey;
  const binding = candidate.identityBinding;

  if (
    !ecdhDesc ||
    ecdhDesc.kty !== 'EC' ||
    ecdhDesc.crv !== 'P-256' ||
    ecdhDesc.alg !== 'ECDH-ES+HKDF-256' ||
    ecdhDesc.keyUsage !== 'keyAgreement' ||
    !ecdhDesc.x ||
    !ecdhDesc.y ||
    !ecdhDesc.fingerprint
  ) {
    return { valid: false, reason: 'Invalid ECDH public key descriptor in bundle.' };
  }

  if (
    !ecdsaDesc ||
    ecdsaDesc.kty !== 'EC' ||
    ecdsaDesc.crv !== 'P-256' ||
    ecdsaDesc.alg !== 'ES256' ||
    ecdsaDesc.keyUsage !== 'digitalSignature' ||
    !ecdsaDesc.x ||
    !ecdsaDesc.y ||
    !ecdsaDesc.fingerprint
  ) {
    return { valid: false, reason: 'Invalid ECDSA signing public key descriptor in bundle.' };
  }

  // Enforce strict key separation: never allow ECDH and ECDSA keys to share curve coordinates
  if (
    (ecdhDesc.x === ecdsaDesc.x && ecdhDesc.y === ecdsaDesc.y) ||
    ecdhDesc.fingerprint === ecdsaDesc.fingerprint
  ) {
    return {
      valid: false,
      reason:
        'Key separation violation: ECDH key agreement key and ECDSA signing key must be distinct.',
    };
  }

  // Ensure top-level backward-compatible coordinates match the ECDH descriptor
  if (candidate.x !== ecdhDesc.x || candidate.y !== ecdhDesc.y) {
    return {
      valid: false,
      reason: 'Top-level JWK coordinates do not match ECDH public key descriptor.',
    };
  }

  if (
    !binding ||
    binding.version !== IDENTITY_BINDING_VERSION ||
    binding.userId !== expectedUserId ||
    binding.keyRotationVersion !== candidate.keyRotationVersion ||
    !binding.issuedAt ||
    !binding.signature
  ) {
    return { valid: false, reason: 'Invalid or mismatched identityBinding metadata.' };
  }

  try {
    const [computedEcdhFp, computedEcdsaFp] = await Promise.all([
      computePublicKeyFingerprint(ecdhDesc, 'keyAgreement'),
      computePublicKeyFingerprint(ecdsaDesc, 'digitalSignature'),
    ]);

    if (
      computedEcdhFp !== ecdhDesc.fingerprint ||
      computedEcdhFp !== binding.ecdhFingerprint ||
      computedEcdsaFp !== ecdsaDesc.fingerprint ||
      computedEcdsaFp !== binding.ecdsaFingerprint
    ) {
      return {
        valid: false,
        reason: 'Recomputed SHA-256 public key fingerprints do not match bundle claims.',
      };
    }

    const [ecdhPublicKey, ecdsaVerifyPublicKey] = await Promise.all([
      importEcdhPublicKeyFromJwk(ecdhDesc),
      importPublicVerificationKeyFromJwk(ecdsaDesc),
    ]);

    const canonicalBinding = serializeIdentityBindingCanonical({
      userId: expectedUserId,
      keyRotationVersion: candidate.keyRotationVersion,
      ecdhFingerprint: computedEcdhFp,
      ecdsaFingerprint: computedEcdsaFp,
      issuedAt: binding.issuedAt,
    });

    const sigOk = await verifyCallSignalSignature(
      canonicalBinding,
      binding.signature,
      ecdsaVerifyPublicKey
    );

    if (!sigOk) {
      return {
        valid: false,
        reason: 'Identity binding ECDSA P-256 signature verification failed.',
      };
    }

    return {
      valid: true,
      bundle: candidate as PublishedUserCryptoKeyBundle,
      ecdhPublicKey,
      ecdsaVerifyPublicKey,
      ecdhFingerprint: computedEcdhFp,
      ecdsaFingerprint: computedEcdsaFp,
    };
  } catch (err: any) {
    return {
      valid: false,
      reason: err?.message || 'Failed to import or verify peer key bundle.',
    };
  }
}

async function getPinnedPeerKeyRecord(
  localUserId: string,
  peerUserId: string
): Promise<PeerPinnedKeyRecord | null> {
  const pinId = `${localUserId}:${peerUserId}`;
  if (!isIndexedDBAvailable()) {
    return memoryPeerPinStore.get(pinId) || null;
  }

  const db = await openDeviceKeyDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PIN_STORE_NAME, 'readonly');
    const req = tx.objectStore(PIN_STORE_NAME).get(pinId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function savePinnedPeerKeyRecord(record: PeerPinnedKeyRecord): Promise<void> {
  const pinId = `${record.localUserId}:${record.peerUserId}`;
  const stored = { ...record, pinId };
  if (!isIndexedDBAvailable()) {
    memoryPeerPinStore.set(pinId, record);
    return;
  }

  const db = await openDeviceKeyDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PIN_STORE_NAME, 'readwrite');
    tx.objectStore(PIN_STORE_NAME).put(stored);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Verifies a peer's `PublishedUserCryptoKeyBundle` and enforces Trust-On-First-Use (TOFU) key pinning
 * and strict mismatch / unapproved-rotation rejection.
 *
 * Security rule: NEVER silently trust a newly fetched signing or ECDH key if a different key is already
 * pinned for `peerUserId`. Any key change or version downgrade is rejected until explicitly approved
 * via `approvePeerKeyRotation()`.
 */
export async function verifyAndPinPeerKeyBundle(
  localUserId: string,
  peerUserId: string,
  rawBundle: unknown
): Promise<VerifiedPeerKeyBundleResult> {
  const integrity = await verifyPublishedKeyBundleIntegrity(peerUserId, rawBundle);
  if (
    !integrity.valid ||
    !integrity.bundle ||
    !integrity.ecdhPublicKey ||
    !integrity.ecdsaVerifyPublicKey ||
    !integrity.ecdhFingerprint ||
    !integrity.ecdsaFingerprint
  ) {
    return {
      trusted: false,
      status: 'invalid_bundle_rejected',
      keyMismatchDetected: false,
      reason: integrity.reason || 'Invalid peer cryptographic key bundle.',
    };
  }

  const existingPin = await getPinnedPeerKeyRecord(localUserId, peerUserId);
  const nowIso = new Date().toISOString();

  if (!existingPin) {
    const newPin: PeerPinnedKeyRecord = {
      localUserId,
      peerUserId,
      keyRotationVersion: integrity.bundle.keyRotationVersion,
      ecdhFingerprint: integrity.ecdhFingerprint,
      ecdsaFingerprint: integrity.ecdsaFingerprint,
      ecdhPublicJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: integrity.bundle.ecdhPublicKey.x,
        y: integrity.bundle.ecdhPublicKey.y,
        ext: true,
      },
      ecdsaPublicJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: integrity.bundle.ecdsaSigningPublicKey.x,
        y: integrity.bundle.ecdsaSigningPublicKey.y,
        ext: true,
      },
      pinnedAt: nowIso,
      updatedAt: nowIso,
    };
    await savePinnedPeerKeyRecord(newPin);

    return {
      trusted: true,
      status: 'pinned_first_use',
      keyMismatchDetected: false,
      peerUserId,
      keyRotationVersion: integrity.bundle.keyRotationVersion,
      ecdhPublicKey: integrity.ecdhPublicKey,
      ecdsaVerifyPublicKey: integrity.ecdsaVerifyPublicKey,
      ecdhFingerprint: integrity.ecdhFingerprint,
      ecdsaFingerprint: integrity.ecdsaFingerprint,
      bundle: integrity.bundle,
      pinnedRecord: newPin,
    };
  }

  // Check for version downgrade attack
  if (integrity.bundle.keyRotationVersion < existingPin.keyRotationVersion) {
    return {
      trusted: false,
      status: 'version_downgrade_rejected',
      keyMismatchDetected: true,
      peerUserId,
      keyRotationVersion: integrity.bundle.keyRotationVersion,
      ecdhFingerprint: integrity.ecdhFingerprint,
      ecdsaFingerprint: integrity.ecdsaFingerprint,
      bundle: integrity.bundle,
      reason: `Peer key rotation version downgrade rejected (fetched v${integrity.bundle.keyRotationVersion} < pinned v${existingPin.keyRotationVersion}).`,
      pinnedRecord: existingPin,
    };
  }

  // Check whether either the ECDSA signing key or ECDH key changed compared to the pinned fingerprint
  if (
    integrity.ecdsaFingerprint !== existingPin.ecdsaFingerprint ||
    integrity.ecdhFingerprint !== existingPin.ecdhFingerprint ||
    integrity.bundle.keyRotationVersion !== existingPin.keyRotationVersion
  ) {
    return {
      trusted: false,
      status: 'key_mismatch_rejected',
      keyMismatchDetected: true,
      peerUserId,
      keyRotationVersion: integrity.bundle.keyRotationVersion,
      ecdhFingerprint: integrity.ecdhFingerprint,
      ecdsaFingerprint: integrity.ecdsaFingerprint,
      bundle: integrity.bundle,
      reason:
        'Security alert: Peer signing/identity key changed from the pinned fingerprint. Spark never silently trusts a newly fetched signing key; explicit key rotation approval is required.',
      pinnedRecord: existingPin,
    };
  }

  return {
    trusted: true,
    status: 'matched_pin',
    keyMismatchDetected: false,
    peerUserId,
    keyRotationVersion: integrity.bundle.keyRotationVersion,
    ecdhPublicKey: integrity.ecdhPublicKey,
    ecdsaVerifyPublicKey: integrity.ecdsaVerifyPublicKey,
    ecdhFingerprint: integrity.ecdhFingerprint,
    ecdsaFingerprint: integrity.ecdsaFingerprint,
    bundle: integrity.bundle,
    pinnedRecord: existingPin,
  };
}

/**
 * Explicitly approves a peer's rotated key bundle after out-of-band / user confirmation.
 * Enforces that:
 * 1. The new bundle passes full cryptographic integrity & self-signature verification (`verifyPublishedKeyBundleIntegrity`).
 * 2. If a previous pin exists, `newBundle.keyRotationVersion > existingPin.keyRotationVersion` (unless `allowNewDeviceKeyReset` is explicitly passed by user UI confirmation when a peer signed in on a new device).
 * 3. `expectedNewEcdsaFingerprint` matches the new bundle's ECDSA fingerprint.
 */
export async function approvePeerKeyRotation(
  localUserId: string,
  peerUserId: string,
  rawNewBundle: unknown,
  expectedNewEcdsaFingerprint: string,
  allowNewDeviceKeyReset = false
): Promise<VerifiedPeerKeyBundleResult> {
  const integrity = await verifyPublishedKeyBundleIntegrity(peerUserId, rawNewBundle);
  if (
    !integrity.valid ||
    !integrity.bundle ||
    !integrity.ecdhPublicKey ||
    !integrity.ecdsaVerifyPublicKey ||
    !integrity.ecdhFingerprint ||
    !integrity.ecdsaFingerprint
  ) {
    return {
      trusted: false,
      status: 'invalid_bundle_rejected',
      keyMismatchDetected: false,
      reason: integrity.reason || 'Cannot approve invalid peer key bundle.',
    };
  }

  if (integrity.ecdsaFingerprint !== expectedNewEcdsaFingerprint) {
    return {
      trusted: false,
      status: 'key_mismatch_rejected',
      keyMismatchDetected: true,
      reason: 'Provided ECDSA fingerprint does not match the candidate rotated key bundle.',
    };
  }

  const existingPin = await getPinnedPeerKeyRecord(localUserId, peerUserId);
  if (
    existingPin &&
    !allowNewDeviceKeyReset &&
    integrity.bundle.keyRotationVersion <= existingPin.keyRotationVersion
  ) {
    return {
      trusted: false,
      status: 'version_downgrade_rejected',
      keyMismatchDetected: true,
      reason: `Rotated key bundle must have a strictly higher keyRotationVersion than pinned v${existingPin.keyRotationVersion}.`,
      pinnedRecord: existingPin,
    };
  }

  const nowIso = new Date().toISOString();
  const effectiveVersion = existingPin
    ? Math.max(integrity.bundle.keyRotationVersion, existingPin.keyRotationVersion)
    : integrity.bundle.keyRotationVersion;

  const updatedPin: PeerPinnedKeyRecord = {
    localUserId,
    peerUserId,
    keyRotationVersion: effectiveVersion,
    ecdhFingerprint: integrity.ecdhFingerprint,
    ecdsaFingerprint: integrity.ecdsaFingerprint,
    ecdhPublicJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: integrity.bundle.ecdhPublicKey.x,
      y: integrity.bundle.ecdhPublicKey.y,
      ext: true,
    },
    ecdsaPublicJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: integrity.bundle.ecdsaSigningPublicKey.x,
      y: integrity.bundle.ecdsaSigningPublicKey.y,
      ext: true,
    },
    pinnedAt: existingPin?.pinnedAt || nowIso,
    updatedAt: nowIso,
  };

  await savePinnedPeerKeyRecord(updatedPin);

  return {
    trusted: true,
    status: 'matched_pin',
    keyMismatchDetected: false,
    peerUserId,
    keyRotationVersion: effectiveVersion,
    ecdhPublicKey: integrity.ecdhPublicKey,
    ecdsaVerifyPublicKey: integrity.ecdsaVerifyPublicKey,
    ecdhFingerprint: integrity.ecdhFingerprint,
    ecdsaFingerprint: integrity.ecdsaFingerprint,
    bundle: integrity.bundle,
    pinnedRecord: updatedPin,
  };
}

/**
 * Fetches the peer's published key bundle from Supabase (or headless test registry)
 * and verifies + pins it against `localUserId`'s pin store.
 * Never silently trusts an unverified or changed signing key.
 */
export async function fetchAndVerifyPeerKeyBundle(
  localUserId: string,
  recipientUserId: string
): Promise<VerifiedPeerKeyBundleResult> {
  if (!localUserId || !recipientUserId || localUserId === recipientUserId) {
    return {
      trusted: false,
      status: 'invalid_bundle_rejected',
      keyMismatchDetected: false,
      reason: 'Invalid local or peer user ID.',
    };
  }

  if ((typeof window === 'undefined' && headlessTestRegistryEnabled) || !isSupabaseConfigured()) {
    const memBundle = memoryPublishedSupabaseKeys.get(recipientUserId);
    if (!memBundle) {
      return {
        trusted: false,
        status: 'invalid_bundle_rejected',
        keyMismatchDetected: false,
        reason: 'Peer key bundle is not registered.',
      };
    }
    return verifyAndPinPeerKeyBundle(localUserId, recipientUserId, memBundle);
  }

  const supabase = getSupabase();
  if (!supabase) {
    return {
      trusted: false,
      status: 'invalid_bundle_rejected',
      keyMismatchDetected: false,
      reason: 'Supabase client is unavailable.',
    };
  }

  try {
    const { data, error } = await supabase
      .from('user_crypto_keys')
      .select('user_id, public_key, algorithm')
      .eq('user_id', recipientUserId)
      .maybeSingle();

    if (error || !data?.public_key) {
      return {
        trusted: false,
        status: 'invalid_bundle_rejected',
        keyMismatchDetected: false,
        reason:
          'Peer E2EE identity & signing key bundle is not registered in user_crypto_keys yet.',
      };
    }

    return await verifyAndPinPeerKeyBundle(localUserId, recipientUserId, data.public_key);
  } catch (err: any) {
    return {
      trusted: false,
      status: 'invalid_bundle_rejected',
      keyMismatchDetected: false,
      reason: err?.message || 'Failed to fetch peer key bundle.',
    };
  }
}

/**
 * Backward-compatible helper for 1-to-1 chat E2EE (`chatService.ts`).
 * Imports the ECDH P-256 public key from `public.user_crypto_keys`.
 */
export async function fetchRecipientPublicKey(
  recipientUserId: string
): Promise<CryptoKey | null> {
  if ((typeof window === 'undefined' && headlessTestRegistryEnabled) || !isSupabaseConfigured()) {
    const memBundle = memoryPublishedSupabaseKeys.get(recipientUserId);
    if (!memBundle) return null;
    try {
      return await importEcdhPublicKeyFromJwk(memBundle.ecdhPublicKey);
    } catch {
      return null;
    }
  }
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('user_crypto_keys')
      .select('public_key')
      .eq('user_id', recipientUserId)
      .maybeSingle();

    if (error || !data?.public_key) {
      return null;
    }

    const raw = data.public_key as any;
    const ecdhSource = raw?.ecdhPublicKey?.x ? raw.ecdhPublicKey : raw;
    return await importEcdhPublicKeyFromJwk(ecdhSource);
  } catch (err) {
    console.warn('Failed to fetch/import recipient ECDH public key:', err);
    return null;
  }
}

/**
 * Derives the shared conversation AES-256-GCM symmetric key using ECDH + HKDF-SHA256 (used by chat E2EE).
 */
export async function deriveConversationKey(
  myPrivateKey: CryptoKey,
  otherPublicKey: CryptoKey,
  conversationId: string
): Promise<CryptoKey> {
  const subtle = getSubtleCrypto();

  const sharedBits = await subtle.deriveBits(
    { name: 'ECDH', public: otherPublicKey },
    myPrivateKey,
    256
  );

  const hkdfKey = await subtle.importKey(
    'raw',
    sharedBits,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  const encoder = new TextEncoder();
  const salt = encoder.encode(`Spark-Salt-${conversationId}`);
  const info = encoder.encode('Spark-E2EE-v1-ConversationAESKey');

  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Derives a DIRECTIONAL AES-256-GCM key for 1-to-1 voice call signaling using ECDH + HKDF-SHA256.
 * Binds `conversationId`, `senderId -> targetUserId`, and key fingerprints into the HKDF info.
 */
export async function deriveDirectionalCallSignalKey(
  myEcdhPrivateKey: CryptoKey,
  peerEcdhPublicKey: CryptoKey,
  conversationId: string,
  senderId: string,
  targetUserId: string
): Promise<CryptoKey> {
  if (!conversationId || !senderId || !targetUserId || senderId === targetUserId) {
    throw new Error('Invalid directional call key parameters.');
  }

  const subtle = getSubtleCrypto();
  let peerFingerprint = 'default';
  try {
    const exportedPeer = await subtle.exportKey('jwk', peerEcdhPublicKey);
    if (exportedPeer.x && exportedPeer.y) {
      peerFingerprint = `${exportedPeer.x}.${exportedPeer.y}`;
    }
  } catch {}

  const cacheKey = `${conversationId}:${senderId}->${targetUserId}:${peerFingerprint}`;
  if (directionalCallKeyCache.has(cacheKey)) {
    return directionalCallKeyCache.get(cacheKey)!;
  }

  const sharedBits = await subtle.deriveBits(
    { name: 'ECDH', public: peerEcdhPublicKey },
    myEcdhPrivateKey,
    256
  );

  const hkdfKey = await subtle.importKey(
    'raw',
    sharedBits,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  const encoder = new TextEncoder();
  const salt = encoder.encode(`Spark-CallSignal-Salt-v2:${conversationId}`);
  const info = encoder.encode(
    `Spark-CallSignal-AES256GCM-v2:${conversationId}:${senderId}->${targetUserId}`
  );

  const directionalKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  directionalCallKeyCache.set(cacheKey, directionalKey);
  return directionalKey;
}

/**
 * Signs a canonical voice call signal payload using the sender's dedicated ECDSA P-256 private key (SHA-256).
 */
export async function signCallSignalCanonical(
  canonicalPlaintext: string,
  signingPrivateKey: CryptoKey
): Promise<string> {
  if (signingPrivateKey.algorithm?.name !== 'ECDSA') {
    throw new Error('Signing key must be a dedicated ECDSA CryptoKey.');
  }
  const subtle = getSubtleCrypto();
  const encoder = new TextEncoder();
  const data = encoder.encode(canonicalPlaintext);
  const sigBuffer = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    signingPrivateKey,
    data
  );
  return bufferToBase64(sigBuffer);
}

/**
 * Verifies an ECDSA P-256 (SHA-256) signature over the canonical voice call signal payload
 * using the sender's pinned/verified ECDSA public key.
 */
export async function verifyCallSignalSignature(
  canonicalPlaintext: string,
  signatureBase64: string,
  senderVerifyPublicKey: CryptoKey
): Promise<boolean> {
  if (
    !canonicalPlaintext ||
    !signatureBase64 ||
    !senderVerifyPublicKey ||
    senderVerifyPublicKey.algorithm?.name !== 'ECDSA'
  ) {
    return false;
  }
  try {
    const subtle = getSubtleCrypto();
    const encoder = new TextEncoder();
    const data = encoder.encode(canonicalPlaintext);
    const sigBytes = base64ToUint8Array(signatureBase64);
    return await subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      senderVerifyPublicKey,
      sigBytes as unknown as BufferSource,
      data as unknown as BufferSource
    );
  } catch {
    return false;
  }
}

/**
 * Encrypts a message using AES-256-GCM with a unique, cryptographically random 12-byte IV.
 */
export async function encryptE2EEMessage(
  plaintext: string,
  conversationKey: CryptoKey
): Promise<{ ciphertext: string; iv: string; version: string }> {
  const subtle = getSubtleCrypto();
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));

  const ciphertextBuffer = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    conversationKey,
    plaintextBytes
  );

  return {
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
    version: E2EE_VERSION,
  };
}

/**
 * Decrypts an encrypted message using AES-256-GCM.
 */
export async function decryptE2EEMessage(
  ciphertextBase64: string,
  ivBase64: string,
  conversationKey: CryptoKey
): Promise<string | null> {
  try {
    const subtle = getSubtleCrypto();
    const ciphertext = base64ToUint8Array(ciphertextBase64);
    const iv = base64ToUint8Array(ivBase64);
    if (iv.byteLength !== 12) {
      return null;
    }

    const decryptedBuffer = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
      },
      conversationKey,
      ciphertext as unknown as BufferSource
    );

    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer);
  } catch {
    return null;
  }
}

/**
 * Purges in-memory cryptographic session caches on user signout.
 */
export function purgeCryptoSessionMemory(): void {
  conversationKeyCache.clear();
  directionalCallKeyCache.clear();
  inflightKeyPairPromises.clear();
  inflightKeySyncPromises.clear();
  pendingNewKeyConfirmPromises.clear();
  declinedNewKeyOnDeviceUsers.clear();
  memoryDeviceKeyStore.clear();
  memoryPeerPinStore.clear();
  memoryPublishedSupabaseKeys.clear();
}
