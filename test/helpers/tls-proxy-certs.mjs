// Synthetic TLS fixtures for the outbound-proxy connector tests.
//
// Generated at import time from ephemeral RSA key pairs: no private key material is
// stored in this file, so the repository secret scanner keeps its meaning (a
// checked-in key-shaped block is always a finding). The two certificates are
// deliberately distinct because the connector suite needs both a positive and a
// hostname-mismatch control:
//
//   CERT_A is valid for localhost, 127.0.0.1 and ::1 (positive controls).
//   CERT_B is valid for localhost only, so dialing 127.0.0.1 with it exercises
//   hostname verification failure while the certificate chain itself is trusted.
//
// The DER/X.509 writer below is test-only and deliberately minimal: v3, self-signed,
// SHA-256 with RSA, basicConstraints CA:TRUE and subjectAltName. node:crypto supplies
// the key pair, the public-key DER and the signature; no external tool is required.
// test/tls-proxy-certs.test.js asserts the resulting signature and SANs.

import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// --- minimal DER writer -----------------------------------------------------

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const octetString = (body) => tlv(0x04, body);
const bitString = (body) => tlv(0x03, Buffer.from([0x00]), body);
const boolean = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8String = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const context = (tag, body) => tlv(0xa0 + tag, body);
const nullValue = () => tlv(0x05);

function integer(buffer) {
  let start = 0;
  while (start < buffer.length - 1 && buffer[start] === 0) start++;
  let body = buffer.subarray(start);
  // DER INTEGER is signed: a leading zero keeps a high-bit payload positive.
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0x00]), body]);
  return tlv(0x02, body);
}

function oid(dotted) {
  const arcs = dotted.split('.').map(Number);
  const body = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let n = arc >>> 7; n > 0; n >>>= 7) chunk.unshift(0x80 | (n & 0x7f));
    body.push(...chunk);
  }
  return tlv(0x06, Buffer.from(body));
}

function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const year = date.getUTCFullYear();
  return year >= 1950 && year < 2050
    ? tlv(0x17, Buffer.from(iso.slice(2) + 'Z', 'ascii')) // UTCTime: YYMMDDHHMMSSZ
    : tlv(0x18, Buffer.from(iso + 'Z', 'ascii')); // GeneralizedTime: YYYYMMDDHHMMSSZ
}

const sha256WithRsa = () => sequence(oid('1.2.840.113549.1.1.11'), nullValue());
const commonName = (name) => sequence(set(sequence(oid('2.5.4.3'), utf8String(name))));

function extension(id, critical, value) {
  return sequence(
    oid(id),
    ...(critical ? [boolean(true)] : []),
    octetString(value),
  );
}

function ipAddressBytes(ip) {
  // Test-only SAN encoder: dotted IPv4 and the exact IPv6 loopback spelling.
  // This intentionally is not a general-purpose IPv6 parser.
  if (ip === '::1') {
    const bytes = Buffer.alloc(16);
    bytes[15] = 1;
    return bytes;
  }
  const octets = ip.split('.');
  if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) {
    throw new TypeError('TLS fixture SAN supports only dotted IPv4 or ::1');
  }
  return Buffer.from(octets.map(Number));
}

function subjectAltName(dnsNames, ipAddresses) {
  return sequence(
    ...dnsNames.map((name) => tlv(0x82, Buffer.from(name, 'ascii'))), // [2] dNSName
    ...ipAddresses.map((ip) => tlv(0x87, ipAddressBytes(ip))), // [7] iPAddress
  );
}

function selfSignedCertificate({ privateKey, publicKey, dnsNames, ipAddresses }) {
  const name = commonName('localhost');
  const now = Date.now();
  const tbs = sequence(
    context(0, integer(Buffer.from([2]))), // version v3
    integer(randomBytes(16)), // serialNumber
    sha256WithRsa(),
    name, // issuer
    sequence(time(new Date(now - 60 * 60 * 1000)), time(new Date(now + 3650 * 24 * 60 * 60 * 1000))),
    name, // subject
    publicKey.export({ type: 'spki', format: 'der' }),
    context(3, sequence(
      extension('2.5.29.19', true, sequence(boolean(true))), // basicConstraints CA:TRUE
      extension('2.5.29.17', false, subjectAltName(dnsNames, ipAddresses)),
    )),
  );
  return sequence(tbs, sha256WithRsa(), bitString(sign('sha256', tbs, privateKey)));
}

function pem(label, der) {
  const lines = der.toString('base64').match(/.{1,64}/g);
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function fixture({ dnsNames, ipAddresses }) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    cert: pem('CERTIFICATE', selfSignedCertificate({ privateKey, publicKey, dnsNames, ipAddresses })),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

const FIXTURE_A = fixture({ dnsNames: ['localhost'], ipAddresses: ['127.0.0.1', '::1'] });
const FIXTURE_B = fixture({ dnsNames: ['localhost'], ipAddresses: [] });

export const CERT_A = FIXTURE_A.cert;
export const KEY_A = FIXTURE_A.key;
export const CERT_B = FIXTURE_B.cert;
export const KEY_B = FIXTURE_B.key;
