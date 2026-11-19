// Fixture integrity for test/helpers/tls-proxy-certs.mjs.
//
// The connector suite trusts these certificates, so each fixture must be a
// well-formed self-signed X.509 whose SANs match the case it is used for:
// CERT_A is the positive control (localhost + 127.0.0.1 + ::1), CERT_B the hostname
// mismatch control (localhost only). Without this check the mismatch test could
// pass for the wrong reason (e.g. a fixture that lost its SANs entirely).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { CERT_A, KEY_A, CERT_B, KEY_B } from './helpers/tls-proxy-certs.mjs';

describe('tls-proxy-certs fixtures', () => {
  it('are self-signed certificates whose signature verifies under their exported key', () => {
    for (const [certPem, keyPem] of [[CERT_A, KEY_A], [CERT_B, KEY_B]]) {
      const cert = new X509Certificate(certPem);
      assert.equal(cert.ca, true, 'trust anchor must carry basicConstraints CA:TRUE');
      assert.equal(cert.subject, cert.issuer, 'fixture must be self-signed');
      assert.equal(cert.verify(createPublicKey(keyPem)), true, 'certificate signature must verify');
      assert.equal(cert.checkPrivateKey(createPrivateKey(keyPem)), true, 'exported key must match the certificate');
    }
  });

  it('CERT_A names localhost, 127.0.0.1 and ::1', () => {
    const cert = new X509Certificate(CERT_A);
    assert.equal(cert.checkHost('localhost'), 'localhost');
    assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(cert.checkIP('::1'), '::1');
  });

  it('CERT_B names localhost but neither loopback IP', () => {
    const cert = new X509Certificate(CERT_B);
    assert.equal(cert.checkHost('localhost'), 'localhost');
    assert.equal(cert.checkIP('127.0.0.1'), undefined);
    assert.equal(cert.checkIP('::1'), undefined);
  });

  it('neither certificate verifies under the other fixture key', () => {
    const certA = new X509Certificate(CERT_A);
    const certB = new X509Certificate(CERT_B);
    assert.equal(certA.verify(createPublicKey(KEY_B)), false);
    assert.equal(certB.verify(createPublicKey(KEY_A)), false);
    assert.equal(certA.checkPrivateKey(createPrivateKey(KEY_B)), false);
    assert.equal(certB.checkPrivateKey(createPrivateKey(KEY_A)), false);
  });
});
