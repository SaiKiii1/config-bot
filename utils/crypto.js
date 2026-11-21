// utils/crypto.js
import crypto from 'node:crypto';

const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || crypto.randomBytes(32).toString('hex');

function getEncryptionKey() {
  return crypto.scryptSync(ENCRYPTION_SECRET, 'salt', 32);
}

export function encryptCredential(plainText) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

export function decryptCredential(cipherText) {
  try {
    const [ivHex, tagHex, encryptedHex] = cipherText.split(':');
    if (!ivHex || !tagHex || !encryptedHex) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Credential decryption failed:', err.message);
    return null;
  }
}

export function redactToken(token) {
  if (!token || token.length < 10) return '[REDACTED]';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}