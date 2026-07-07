// api/_turnkey.js — Turnkey remote signer (HSM/TEE-backed keys)
//
// The private key is generated inside Turnkey's secure enclave and NEVER leaves
// it. Orlix only holds a P-256 *API key* used to authenticate ("stamp") signing
// requests. The transaction is signed remotely and returned already-signed — the
// signing key never touches Orlix memory, disk, or logs.
//
// Required env:
//   TURNKEY_API_PUBLIC_KEY   compressed P-256 public key hex (66 chars)
//   TURNKEY_API_PRIVATE_KEY  P-256 private key hex (64 chars)
//   TURNKEY_ORGANIZATION_ID  Turnkey organization / sub-org id
//   TURNKEY_SIGN_WITH        the Ethereum address (or private-key id) to sign with
//   TURNKEY_BASE_URL         optional, defaults to https://api.turnkey.com
'use strict';

const crypto = require('crypto');

const BASE_URL = () => process.env.TURNKEY_BASE_URL || 'https://api.turnkey.com';

function isConfigured() {
  return !!(process.env.TURNKEY_API_PUBLIC_KEY && process.env.TURNKEY_API_PRIVATE_KEY
    && process.env.TURNKEY_ORGANIZATION_ID && process.env.TURNKEY_SIGN_WITH);
}

function signerAddress() {
  return (process.env.TURNKEY_SIGN_WITH || '').trim();
}

// ── P-256 point decompression (needed to build a JWK from the api key pair) ────
const P  = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A  = P - 3n;
const B  = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function modpow(base, exp, mod) {
  let r = 1n; base %= mod;
  while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; exp >>= 1n; base = (base * base) % mod; }
  return r;
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Build a node KeyObject for the Turnkey API private key from the compressed
// public key (for x/y) + the raw private scalar (d).
function apiPrivateKey() {
  const pub  = Buffer.from(process.env.TURNKEY_API_PUBLIC_KEY.trim(), 'hex'); // 33 bytes
  const priv = Buffer.from(process.env.TURNKEY_API_PRIVATE_KEY.trim(), 'hex'); // 32 bytes
  const prefix = pub[0];               // 0x02 (even y) or 0x03 (odd y)
  const x = BigInt('0x' + pub.subarray(1, 33).toString('hex'));
  // y^2 = x^3 + a*x + b (mod p); p ≡ 3 (mod 4) so y = (y2)^((p+1)/4)
  const y2 = (modpow(x, 3n, P) + (A * x) % P + B) % P;
  let y = modpow(y2, (P + 1n) / 4n, P);
  if ((y & 1n) !== BigInt(prefix & 1)) y = P - y;
  const to32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(priv), x: b64url(to32(x)), y: b64url(to32(y)) },
    format: 'jwk',
  });
}

// Turnkey "stamp": ECDSA-P256/SHA-256 (DER) over the exact request body,
// wrapped as base64url JSON in the X-Stamp header.
function stamp(body) {
  const signature = crypto.sign('sha256', Buffer.from(body, 'utf8'), {
    key: apiPrivateKey(), dsaEncoding: 'der',
  }).toString('hex');
  return b64url(Buffer.from(JSON.stringify({
    publicKey: process.env.TURNKEY_API_PUBLIC_KEY.trim(),
    scheme:    'SIGNATURE_SCHEME_TK_API_P256',
    signature,
  })));
}

// Sign an unsigned EIP-1559 tx (hex, with or without 0x) remotely.
// Returns the signed raw transaction hex (0x-prefixed) ready to broadcast.
async function signTransaction(unsignedTxHex) {
  if (!isConfigured()) throw new Error('Turnkey signer not configured');
  const body = JSON.stringify({
    type: 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2',
    timestampMs: String(Date.now()),
    organizationId: process.env.TURNKEY_ORGANIZATION_ID.trim(),
    parameters: {
      signWith: signerAddress(),
      unsignedTransaction: unsignedTxHex.replace(/^0x/, ''),
      type: 'TRANSACTION_TYPE_ETHEREUM',
    },
  });

  const r = await fetch(`${BASE_URL()}/public/v1/submit/sign_transaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Stamp': stamp(body) },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Turnkey ${r.status}: ${text.slice(0, 300)}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Turnkey: bad JSON response'); }
  const signed = data?.activity?.result?.signTransactionResult?.signedTransaction;
  if (!signed) throw new Error('Turnkey: no signedTransaction in response (activity may be pending/failed)');
  return signed.startsWith('0x') ? signed : '0x' + signed;
}

module.exports = { isConfigured, signerAddress, signTransaction };
