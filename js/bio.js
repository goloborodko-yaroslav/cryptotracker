// Вхід із Face ID / Touch ID через ключ доступу (passkey) з розширенням WebAuthn PRF.
//
// Ключ доступу створюється в «Паролях» Apple (iCloud Keychain). Після Face ID він
// повертає 32-байтовий секрет PRF, із якого виводиться ключ шифрування копії DEK.
// Ні пароль, ні секрет на диск не записуються. Потрібна iOS 18 або новіша.
import { b64 } from './crypto.js';

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const err = (code) => Object.assign(new Error(code), { code });

export const isApple = () => /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
export const name = () => (/iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) || /iPad/.test(navigator.userAgent) ? 'Face ID' : isApple() ? 'Touch ID' : 'біометрією');

export async function available() {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) return false;
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch { return false; }
}

// Створює ключ доступу. Повертає секрет PRF, якщо платформа віддала його одразу.
export async function register() {
  const prfSalt = rand(32);
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'CryptoTracker' },
      user: { id: rand(16), name: 'CryptoTracker', displayName: 'CryptoTracker' },
      challenge: rand(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      timeout: 120000,
      extensions: { prf: { eval: { first: prfSalt } } },
    } });
  } catch (e) { throw err(e?.name === 'NotAllowedError' ? 'CANCELLED' : 'CREATE_FAILED'); }
  const ext = cred.getClientExtensionResults?.() || {};
  if (ext.prf?.enabled === false) throw err('NO_PRF');
  const first = ext.prf?.results?.first;
  return {
    credId: b64.to(new Uint8Array(cred.rawId)),
    prfSalt: b64.to(prfSalt),
    prf: first ? new Uint8Array(first) : null,
  };
}

// Face ID → секрет PRF для збереженого ключа доступу
export async function evaluate(rec) {
  let a;
  try {
    a = await navigator.credentials.get({ publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: 'public-key', id: b64.from(rec.credId) }],
      userVerification: 'required',
      timeout: 120000,
      extensions: { prf: { eval: { first: b64.from(rec.prfSalt) } } },
    } });
  } catch (e) { throw err(e?.name === 'NotAllowedError' ? 'CANCELLED' : 'GET_FAILED'); }
  const first = a.getClientExtensionResults?.().prf?.results?.first;
  if (!first) throw err('NO_PRF');
  return new Uint8Array(first);
}
