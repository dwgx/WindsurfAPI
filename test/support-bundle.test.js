// Tests for scripts/support-bundle.mjs (GapSweep2 §3.1, hardened in wave 7).
//
// The bundle exists so a reporter can attach one file instead of hand-collecting traces.
// Three properties are load-bearing and all are pinned here:
//
//   1. No credential leaves the machine. Text legs are redacted before packaging (field
//      values, account emails, presigned-URL query credentials) and the shared secret
//      rules (scripts/secret-rules.mjs) are still the gate: a hit refuses the whole
//      bundle. The upstream request protobuf is NOT shipped verbatim — its ClientMetadata
//      session token / user JWT are replaced with `[redacted]`, and a binary leg the
//      bundler cannot prove credential-free is omitted (size + sha256 stay in the
//      manifest). The fixtures below use the REAL `buildGetChatMessageRequest()`, so the
//      credential sits exactly where it sits on the wire, not in a hand-made blob.
//   2. The archive must still carry the evidence that is safe. The redacted request keeps
//      its system prompt, messages, model and config byte-for-byte; only the credential
//      values change.
//   3. The archive is a real zip. The zip reader is deliberately local: the repository
//      has no runtime dependencies, and shelling out to `unzip`/PowerShell would make the
//      test platform-dependent. Store-method entries are trivial to read.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGetChatMessageRequest, __testing } from '../src/devin-connect.js';
import { getField, parseFields, writeMessageField, writeStringField } from '../src/proto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'support-bundle.mjs');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// Contains a fixture marker on purpose: `test/` fixtures are allow-listed by shape in
// scripts/secret-rules.mjs, and this file is scanned by scripts/secret-scan.mjs on every
// gate run. The bundler stages it under `traces/…`, where that exemption does not apply, so
// it still trips the gate — which is exactly the behaviour under test.
const PLANTED_TOKEN = 'sk-fixtureA1b2C3d4E5f6G7h8I9j0K1l2M3';

// A JWT-shaped account credential. The `fixture` marker keeps the repository's own secret
// scan happy; the bundler must not depend on the marker (staged paths lose the test/
// exemption), which is why the assertion is on the exact bytes, not on a rule match.
const JWT_TOKEN = 'devin-session-token$eyJfixtureHeaderAA.eyJfixturePayloadBB.fixtureSignatureCC';

// Opaque session credential: mixed case + digits, no `devin-session-token$` prefix. This is
// the shape the shared scanner cannot recognise, so only the protobuf redactor can stop it.
const OPAQUE_TOKEN = 'opaqueFixtureSess1onA1b2C3d4E5f6G7h8';

// A normal trace token (not JWT-shaped, not the opaque negative fixture).
const CLEAN_TOKEN = 'devin-session-token$fixtureCleanTraceToken123456';

const ACCOUNT_EMAIL = 'alice.fixture@corp-mail.test';
const PRESIGNED_URL = 'https://bucket.s3.amazonaws.com/report.png'
  + '?X-Amz-Algorithm=AWS4-HMAC-SHA256'
  + '&X-Amz-Credential=AKIAFIXTURE%2F20260101%2Fus-east-1%2Fs3%2Faws4_request'
  + '&X-Amz-Date=20260101T000000Z'
  + '&X-Amz-Expires=900'
  + '&X-Amz-SignedHeaders=host'
  + '&X-Amz-Signature=deadbeefcafebabe0123456789abcdef';

// A binary leg with NUL, non-UTF-8 and ASCII bytes. It is NOT a request protobuf, so the
// bundler must omit it rather than ship bytes it cannot prove credential-free.
const BINARY_LEG = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0x41, 0x42, 0x43, 0x00, 0x0a, 0x10]);

const CLIENT_LEG = `${JSON.stringify({
  traceId: '0001-a',
  protocol: 'openai',
  headers: { Authorization: 'Bearer SECRET', 'x-api-key': 'SECRET-header-key' },
  callerKey: 'SECRET-caller',
  body: {
    model: 'claude-sonnet-4.6',
    token: '',
    messages: [{ role: 'user', content: 'hello' }],
  },
}, null, 2)}\n`;

// The real wire builder, so the token lands in ClientMetadata #3 exactly as production
// writes it. `messages` is the OpenAI-shaped input the handler passes.
function buildRequest(token, text = 'hello') {
  return buildGetChatMessageRequest({
    token,
    model: 'claude-sonnet-4.6',
    messages: [{ role: 'user', content: text }],
    sessionId: 'fixture-session',
  });
}

// Parse a request buffer back to its ClientMetadata subfields.
function requestMetadata(buffer) {
  const top = parseFields(buffer);
  const metadata = getField(top, 1, 2);
  assert.ok(metadata, 'request has a ClientMetadata field');
  return parseFields(metadata.value);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Minimal reader for the store-only archives support-bundle writes. It walks the central
// directory (the authoritative index) and then each local header to find the data offset,
// so a malformed local header fails here instead of being papered over.
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'zip has an end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let cursor = centralOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, 'central directory header signature');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `local header signature for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, {
      method,
      data: buffer.subarray(dataStart, dataStart + compressedSize),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function runBundle(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      WINDSURFAPI_SKIP_DOTENV: '1',
      ...env,
    },
  });
}

function writeTraceFile(root, traceId, name, content) {
  const dir = join(root, 'trace', traceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

// Bundle one trace directory in a throwaway workspace. Returns the spawn result, the
// output directory and the parsed zip (or null when the bundler refused).
function bundleTrace(traceId, files, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'windsurfapi-support-case-'));
  const outDir = join(root, 'out');
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeTraceFile(root, traceId, name, content);
  const result = runBundle(['--trace-dir', join(root, 'trace'), '--out', outDir, '--traces', '5'], env);
  const zips = readdirSync(outDir).filter((name) => name.endsWith('.zip'));
  return {
    root,
    outDir,
    result,
    zips,
    zip: zips.length === 1 ? readZip(readFileSync(join(outDir, zips[0]))) : null,
  };
}

function allZipBytes(zip) {
  return Buffer.concat([...zip.values()].map((entry) => entry.data));
}

describe('support-bundle', () => {
  let workspace;
  let outDir;
  let zipPath;
  let zipEntries;
  let manifest;
  let cleanRequest;

  before(() => {
    workspace = mkdtempSync(join(tmpdir(), 'windsurfapi-support-test-'));
    outDir = join(workspace, 'out');
    mkdirSync(outDir, { recursive: true });

    cleanRequest = buildRequest(CLEAN_TOKEN, 'hello from the clean fixture');
    writeTraceFile(workspace, '0000-old', '01-client-req.json', '{"traceId":"0000-old"}\n');
    writeTraceFile(workspace, '0001-a', '01-client-req.json', CLIENT_LEG);
    writeTraceFile(workspace, '0001-a', '03-upstream-req.bin', cleanRequest);
    writeTraceFile(workspace, '0001-a', '04-upstream-res.bin', BINARY_LEG);
    writeTraceFile(workspace, '0002-b', '05-client-res.json', '{"traceId":"0002-b","status":200}\n');

    // "Newest" must be decided by mtime, not by name alone: the directory names are
    // sortable here, but an operator copying traces around breaks that assumption.
    utimesSync(join(workspace, 'trace', '0000-old'), new Date(1_000_000), new Date(1_000_000));
    utimesSync(join(workspace, 'trace', '0001-a'), new Date(2_000_000), new Date(2_000_000));
    utimesSync(join(workspace, 'trace', '0002-b'), new Date(3_000_000), new Date(3_000_000));

    const result = runBundle(
      ['--trace-dir', join(workspace, 'trace'), '--out', outDir, '--traces', '2'],
      {
        WINDSURFAPI_TRACE: '1',
        WINDSURFAPI_TRACE_DIR: join(workspace, 'trace'),
        DEVIN_CONNECT: '1',
        CASCADE_MODE: 'native',
        WINDSURFAPI_FAKE_TOKEN: PLANTED_TOKEN,
      },
    );
    assert.equal(result.status, 0, `bundler failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const zips = readdirSync(outDir).filter((name) => name.endsWith('.zip'));
    assert.equal(zips.length, 1, 'exactly one bundle is written');
    zipPath = join(outDir, zips[0]);
    zipEntries = readZip(readFileSync(zipPath));
    manifest = JSON.parse(zipEntries.get('manifest.json').data.toString('utf8'));
  });

  after(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('redacts text credentials, keeps only the newest N traces, and snapshots switches safely', () => {
    assert.match(zipPath, /support-bundle-\d{8}T\d{6}Z\.zip$/, 'UTC-stamped file name');

    // Last-N selection: the oldest trace is omitted, the two newest are included.
    const names = [...zipEntries.keys()];
    assert.ok(names.includes('traces/0001-a/01-client-req.json'));
    assert.ok(names.includes('traces/0002-b/05-client-res.json'));
    assert.ok(!names.some((name) => name.includes('0000-old')), 'oldest trace is not in the bundle');

    // Redaction: no text entry carries the fixture secrets.
    for (const [name, entry] of zipEntries) {
      const text = entry.data.toString('utf8');
      assert.ok(!text.includes('SECRET'), `${name} must not contain the redacted header value`);
      assert.ok(!text.includes(PLANTED_TOKEN), `${name} must not contain the planted token`);
    }
    const client = zipEntries.get('traces/0001-a/01-client-req.json').data.toString('utf8');
    assert.match(client, /"Authorization": "\[redacted\]"/);
    assert.match(client, /"callerKey": "\[redacted\]"/);
    // An empty credential value is not a secret and must survive as valid JSON (the
    // redactor's whitespace backtracking used to eat the space and break the document).
    assert.match(client, /"token": ""/);
    // The redaction is value-only: JSON structure and non-secret fields survive.
    assert.match(client, /"model": "claude-sonnet-4\.6"/);
    assert.doesNotThrow(() => JSON.parse(client), 'redacted JSON leg still parses');

    const environment = JSON.parse(zipEntries.get('environment.json').data.toString('utf8'));
    assert.equal(environment.version, PACKAGE_VERSION);
    assert.equal(environment.health.version, PACKAGE_VERSION);
    assert.equal(environment.health.packageVersion, PACKAGE_VERSION);
    assert.match(environment.health.commit, /^[a-f0-9]{7,12}$/, 'health commit is a git sha');
    assert.match(environment.health.source, /getVersionInfo/);
    assert.equal(environment.traces.source, '--trace-dir');
    assert.deepEqual(environment.traces.included, ['0001-a', '0002-b']);
    assert.equal(environment.traces.omitted, 1);
    assert.ok(environment.traces.redactions.some((item) => item.path.endsWith('01-client-req.json')));

    // Switch snapshot: booleans/enums only, no token-named variable, no path-shaped value.
    assert.equal(environment.switches.WINDSURFAPI_TRACE, '1');
    assert.equal(environment.switches.DEVIN_CONNECT, '1');
    assert.equal(environment.switches.CASCADE_MODE, 'native');
    assert.equal(environment.switches.WINDSURFAPI_FAKE_TOKEN, undefined);
    assert.equal(environment.switches.WINDSURFAPI_TRACE_DIR, undefined);
    for (const [name, value] of Object.entries(environment.switches)) {
      assert.match(name, /^(WINDSURFAPI|DEVIN|CASCADE)_/);
      assert.match(value, /^(?:0|1|true|false|on|off|yes|no|[a-z][a-z0-9_-]{0,23})$/);
    }
    assert.ok(!JSON.stringify(environment).includes(PLANTED_TOKEN));
  });

  it('manifest.json lists every archived file with a matching sha256', () => {
    const sidecarPath = zipPath.replace(/\.zip$/, '.manifest.json');
    assert.ok(existsSync(sidecarPath), 'a sidecar manifest is written next to the zip');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    assert.deepEqual(sidecar, manifest, 'sidecar and in-zip manifest are the same document');

    assert.equal(manifest.scan.findings, 0);
    assert.equal(manifest.files.length, zipEntries.size - 1, 'every entry except manifest.json is listed');
    for (const file of manifest.files) {
      const entry = zipEntries.get(file.path);
      assert.ok(entry, `manifest lists ${file.path}, which exists in the zip`);
      assert.equal(entry.data.length, file.bytes, `${file.path} byte count`);
      assert.equal(sha256(entry.data), file.sha256, `${file.path} sha256 matches stored bytes`);
    }
    assert.ok(!manifest.files.some((file) => file.path === 'manifest.json'), 'manifest does not list itself');
  });

  it('redacts the ClientMetadata session token and keeps the request evidence readable', () => {
    const entry = zipEntries.get('traces/0001-a/03-upstream-req.bin');
    assert.ok(entry, 'the redactable request leg is present');

    const metadata = requestMetadata(entry.data);
    assert.equal(getField(metadata, 1, 2).value.toString('utf8'), 'chisel');
    assert.equal(getField(metadata, 3, 2).value.toString('utf8'), '[redacted]',
      'the account session token is replaced, not shipped');
    assert.ok(!entry.data.includes(Buffer.from(CLEAN_TOKEN)), 'no token bytes survive anywhere in the leg');

    // Evidence that is not a credential survives: model, system prompt, message text.
    assert.ok(entry.data.includes(Buffer.from('claude-sonnet-4.6')), 'model survives');
    assert.ok(entry.data.includes(Buffer.from('hello from the clean fixture')), 'message text survives');

    // The stored sha256 is over the redacted bytes, and the manifest says so.
    const listed = manifest.files.find((file) => file.path === 'traces/0001-a/03-upstream-req.bin');
    assert.equal(listed.sha256, sha256(entry.data));
    assert.equal(listed.sourceSha256, sha256(cleanRequest));
    assert.deepEqual(listed.transforms, ['client-metadata-credentials']);
  });

  it('omits a binary leg it cannot prove credential-free and records size + sha256', () => {
    assert.ok(!zipEntries.has('traces/0001-a/04-upstream-res.bin'),
      'an unrecognised binary leg never enters the archive');
    const omitted = manifest.binaryLegs.omitted.find((item) => item.path === 'traces/0001-a/04-upstream-res.bin');
    assert.ok(omitted, 'the omitted leg is listed in the manifest');
    assert.equal(omitted.bytes, BINARY_LEG.length);
    assert.equal(omitted.sha256, sha256(BINARY_LEG));
    assert.match(omitted.reason, /not a (?:redactable )?GetChatMessageRequest/);
    assert.ok(!allZipBytes(zipEntries).includes(BINARY_LEG), 'the raw bytes are not in the archive');
  });

  it('refuses to package when the shared secret rules match, and writes nothing', () => {
    const refusalRoot = mkdtempSync(join(tmpdir(), 'windsurfapi-support-refuse-'));
    try {
      const traceDir = join(refusalRoot, 'trace');
      const refusalOut = join(refusalRoot, 'out');
      mkdirSync(refusalOut, { recursive: true });
      writeTraceFile(refusalRoot, '0003-c', '02-routing.json', `${JSON.stringify({ note: PLANTED_TOKEN })}\n`);

      const result = runBundle(['--trace-dir', traceDir, '--out', refusalOut, '--traces', '3']);
      assert.equal(result.status, 1, `expected the secret gate to refuse:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /02-routing\.json:1 openai-api-key/);
      assert.match(result.stderr, /refusing to package/);
      assert.deepEqual(readdirSync(refusalOut), [], 'no zip and no manifest are written on refusal');
      assert.ok(!result.stderr.includes(PLANTED_TOKEN), 'the finding is reported without echoing the secret');
      assert.ok(!result.stdout.includes(PLANTED_TOKEN));
    } finally {
      rmSync(refusalRoot, { recursive: true, force: true });
    }
  });
});

describe('support-bundle: credential shapes the shared scanner misses', () => {
  it('redacts a JWT-shaped session token instead of refusing the normal workflow', () => {
    const caseRun = bundleTrace('0001-jwt', { '03-upstream-req.bin': buildRequest(JWT_TOKEN, 'jwt fixture') });
    try {
      assert.equal(caseRun.result.status, 0,
        `a normal Connect trace must still bundle:\nstdout: ${caseRun.result.stdout}\nstderr: ${caseRun.result.stderr}`);
      assert.equal(caseRun.zips.length, 1);
      assert.ok(!allZipBytes(caseRun.zip).includes(Buffer.from(JWT_TOKEN)),
        'the JWT token bytes are not in the archive');
      const metadata = requestMetadata(caseRun.zip.get('traces/0001-jwt/03-upstream-req.bin').data);
      assert.equal(getField(metadata, 3, 2).value.toString('utf8'), '[redacted]');
    } finally {
      rmSync(caseRun.root, { recursive: true, force: true });
    }
  });

  it('redacts an opaque session token the shared scanner cannot recognise', () => {
    const caseRun = bundleTrace('0001-opaque', { '03-upstream-req.bin': buildRequest(OPAQUE_TOKEN, 'opaque fixture') });
    try {
      assert.equal(caseRun.result.status, 0,
        `the opaque credential is redacted, not fatal:\nstdout: ${caseRun.result.stdout}\nstderr: ${caseRun.result.stderr}`);
      assert.equal(caseRun.zips.length, 1);
      assert.ok(!allZipBytes(caseRun.zip).includes(Buffer.from(OPAQUE_TOKEN)),
        'the opaque token bytes are not in the archive');
      const metadata = requestMetadata(caseRun.zip.get('traces/0001-opaque/03-upstream-req.bin').data);
      assert.equal(getField(metadata, 3, 2).value.toString('utf8'), '[redacted]');
    } finally {
      rmSync(caseRun.root, { recursive: true, force: true });
    }
  });

  it('redacts a request that the text heuristic would classify as text', () => {
    // The real builder emits tags above 0x7f (#31's tag is 0xFA), so its output is binary.
    // This minimal request reuses the real ClientMetadata builder's #1/#3 VALUES but drops
    // the binary #31 fingerprint, which makes `isText()` true. The bundler must still
    // recognise it as a request and redact #3; otherwise a future builder change could turn
    // the request leg into a "text" leg that skips protobuf redaction.
    const metadata = Buffer.concat(
      parseFields(__testing.buildClientMetadata(OPAQUE_TOKEN))
        .filter((field) => field.field === 1 || field.field === 3)
        .map((field) => writeStringField(field.field, field.value.toString('utf8'))),
    );
    const printable = Buffer.concat([
      writeMessageField(1, metadata),
      writeStringField(2, 'printable system prompt'),
      writeStringField(3, 'printable message'),
    ]);
    assert.ok(!printable.includes(0), 'fixture has no NUL byte');
    assert.ok(Buffer.from(printable.toString('utf8'), 'utf8').equals(printable),
      'fixture is valid UTF-8, i.e. the text heuristic would call it text');

    const caseRun = bundleTrace('0001-printable', { '03-upstream-req.bin': printable });
    try {
      assert.equal(caseRun.result.status, 0,
        `printable request must bundle:\nstdout: ${caseRun.result.stdout}\nstderr: ${caseRun.result.stderr}`);
      assert.ok(!allZipBytes(caseRun.zip).includes(Buffer.from(OPAQUE_TOKEN)),
        'the opaque token is redacted even though the leg looks like text');
      const metadata = requestMetadata(caseRun.zip.get('traces/0001-printable/03-upstream-req.bin').data);
      assert.equal(getField(metadata, 3, 2).value.toString('utf8'), '[redacted]');
    } finally {
      rmSync(caseRun.root, { recursive: true, force: true });
    }
  });

  it('redacts an address in the generated environment snapshot instead of refusing it', () => {
    const caseRun = bundleTrace(
      '0001-env',
      { '01-client-req.json': '{"traceId":"0001-env"}\n' },
      { WINDSURFAPI_BUILD_COMMIT_MESSAGE: `fix: reply to ${ACCOUNT_EMAIL}` },
    );
    try {
      assert.equal(caseRun.result.status, 0,
        `our own metadata must not trip the gate:\nstdout: ${caseRun.result.stdout}\nstderr: ${caseRun.result.stderr}`);
      const environmentText = caseRun.zip.get('environment.json').data.toString('utf8');
      assert.ok(!environmentText.includes(ACCOUNT_EMAIL), 'the commit message address is redacted');
      assert.match(environmentText, /\[redacted\]/);
      const environment = JSON.parse(environmentText);
      assert.equal(environment.health.commitMessage, 'fix: reply to [redacted]');
      assert.ok(environment.environmentRedactions >= 1);
    } finally {
      rmSync(caseRun.root, { recursive: true, force: true });
    }
  });

  it('redacts the optional user JWT in ClientMetadata #21 as well as the session token', () => {
    const userJwt = 'eyJfixtureHeaderAA.eyJfixturePayloadBB.fixtureSignatureCC';
    const request = buildGetChatMessageRequest({
      token: OPAQUE_TOKEN,
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'user jwt fixture' }],
      sessionId: 'fixture-session',
      userJwt,
    });
    const sourceMetadata = requestMetadata(request);
    assert.equal(getField(sourceMetadata, 3, 2).value.toString('utf8'), OPAQUE_TOKEN);
    assert.equal(getField(sourceMetadata, 21, 2).value.toString('utf8'), userJwt,
      'the fixture really carries a #21 user JWT');

    const caseRun = bundleTrace('0001-userjwt', { '03-upstream-req.bin': request });
    try {
      assert.equal(caseRun.result.status, 0,
        `both metadata credentials are redactable:\nstdout: ${caseRun.result.stdout}\nstderr: ${caseRun.result.stderr}`);
      const bytes = allZipBytes(caseRun.zip);
      assert.ok(!bytes.includes(Buffer.from(OPAQUE_TOKEN)), 'session token bytes are gone');
      assert.ok(!bytes.includes(Buffer.from(userJwt)), 'user JWT bytes are gone');
      const metadata = requestMetadata(caseRun.zip.get('traces/0001-userjwt/03-upstream-req.bin').data);
      assert.equal(getField(metadata, 3, 2).value.toString('utf8'), '[redacted]');
      assert.equal(getField(metadata, 21, 2).value.toString('utf8'), '[redacted]');
      assert.ok(metadata.some((field) => field.field === 1 && field.wireType === 2
        && field.value.toString('utf8') === 'chisel'), 'the rest of ClientMetadata survives');
    } finally {
      rmSync(caseRun.root, { recursive: true, force: true });
    }
  });

  it('redacts account emails and presigned-URL query credentials from text legs', () => {
    const routing = {
      traceId: '0001-id',
      backend: 'devin-connect',
      selector: 'claude-sonnet-4.6',
      account: ACCOUNT_EMAIL,
      accountTier: 'pro',
    };
    const client = {
      traceId: '0001-id',
      body: {
        model: 'claude-sonnet-4.6',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: PRESIGNED_URL } },
            // An empty query credential is not a secret; it must not turn the bundle into
            // a refusal (the residual gate tolerates an empty value).
            { type: 'image_url', image_url: { url: 'https://example.test/img.png?token=' } },
          ],
        }],
      },
    };
    const caseRun = bundleTrace('0001-id', {
      '01-client-req.json': `${JSON.stringify(client, null, 2)}\n`,
      '02-routing.json': `${JSON.stringify(routing, null, 2)}\n`,
    });
    try {
      assert.equal(caseRun.result.status, 0,
        `redaction must keep the bundle usable:\nstdout: ${caseRun.result.stdout}\nstderr: ${caseRun.result.stderr}`);
      assert.equal(caseRun.zips.length, 1);

      const routingText = caseRun.zip.get('traces/0001-id/02-routing.json').data.toString('utf8');
      assert.ok(!routingText.includes(ACCOUNT_EMAIL), 'the account email is not in the archive');
      assert.match(routingText, /"account": "\[redacted\]"/);
      assert.doesNotThrow(() => JSON.parse(routingText), 'redacted routing JSON still parses');

      const clientText = caseRun.zip.get('traces/0001-id/01-client-req.json').data.toString('utf8');
      assert.ok(!clientText.includes('AKIAFIXTURE'), 'the presigned credential id is not in the archive');
      assert.ok(!clientText.includes('deadbeefcafebabe0123456789abcdef'), 'the signature is not in the archive');
      assert.ok(!clientText.includes('X-Amz-Signature=deadbeef'), 'the signature parameter is redacted');
      assert.match(clientText, /X-Amz-Signature=\[redacted\]/);
      assert.doesNotThrow(() => JSON.parse(clientText), 'redacted client JSON still parses');

      const bytes = allZipBytes(caseRun.zip);
      assert.ok(!bytes.includes(Buffer.from(ACCOUNT_EMAIL)));
      assert.ok(!bytes.includes(Buffer.from('deadbeefcafebabe0123456789abcdef')));
    } finally {
      rmSync(caseRun.root, { recursive: true, force: true });
    }
  });

  it('refuses when a request credential also appears in a text leg the redactor cannot recognise', () => {
    const caseRun = bundleTrace('0001-leak', {
      '03-upstream-req.bin': buildRequest(OPAQUE_TOKEN, 'leak fixture'),
      // `note`, not `token`: the field-name redactor has no reason to touch it. Only the
      // credential-value search can prove this leg unsafe.
      '02-routing.json': `${JSON.stringify({ note: OPAQUE_TOKEN })}\n`,
    });
    try {
      assert.equal(caseRun.result.status, 1,
        `expected the credential-value gate to refuse:\nstdout: ${caseRun.result.stdout}\nstderr: ${caseRun.result.stderr}`);
      assert.match(caseRun.result.stderr, /credential-value/);
      assert.match(caseRun.result.stderr, /refusing to package/);
      assert.deepEqual(readdirSync(caseRun.outDir), [], 'no zip and no manifest are written on refusal');
      assert.ok(!caseRun.result.stderr.includes(OPAQUE_TOKEN), 'the finding is reported without echoing the credential');
      assert.ok(!caseRun.result.stdout.includes(OPAQUE_TOKEN));
    } finally {
      rmSync(caseRun.root, { recursive: true, force: true });
    }
  });
});

describe('support-bundle: sensitive field names the word-boundary list missed (S5-P3)', () => {
  it('redacts *_token / *_key / *_secret / jwt / bearer / credential spellings, nested, with hex/UUID values', () => {
    // The values deliberately carry no shape the shared scanner recognises:
    // hex and UUID forms are what opaque session material looks like, and the
    // pre-fix list shipped them whenever the KEY spelled a name the \b could
    // not cross (`_` is a word char — \btoken\b never fired inside csrf_token)
    // or simply was not enumerated (jwt, credential, bearer, *_key).
    const HEX = 'deadbeefcafebabe0123456789abcdef0123456789abcdef01234567';
    const UUIDV = '11111111-2222-4333-8444-555555555555';
    const CAMEL = 'camelFixtureSortKey99';
    const leg = `${JSON.stringify({
      traceId: '0009-names',
      nested: {
        deep: {
          csrf_token: HEX,        // \btoken\b cannot cross the underscore
          session_token: UUIDV,   // was enumerated; stays pinned
          accessToken: HEX,       // camel spelling OAuth payloads use
          client_secret: UUIDV,   // \bsecret\b — same underscore gap
          private_key: HEX,
          jwt: UUIDV,
          credential: HEX,
          bearer: UUIDV,
          sort_key: CAMEL,        // *_key family was absent entirely
          '__RequestVerificationToken': HEX,
        },
      },
      headers: { 'x-custom-token': HEX, 'set-cookie': UUIDV },
      benign: { requestId: 'r_123', modelName: 'swe-fixture', sort_keys: 'plural-stays' },
    }, null, 2)}\n`;

    const caseRun = bundleTrace('0009-names', { '02-routing.json': leg });
    try {
      assert.equal(caseRun.result.status, 0,
        `the named-field gate must redact, not refuse:\nstdout: ${caseRun.result.stdout}\nstderr: ${caseRun.result.stderr}`);
      const bytes = allZipBytes(caseRun.zip);
      for (const value of [HEX, UUIDV, CAMEL]) {
        assert.ok(!bytes.includes(Buffer.from(value)),
          `value ${value.slice(0, 16)}… reached the archive under a missed field name`);
      }
      const text = caseRun.zip.get('traces/0009-names/02-routing.json').data.toString('utf8');
      assert.doesNotThrow(() => JSON.parse(text), 'the redacted leg must stay valid JSON');
      // Non-secret fields survive; a plural name is NOT a credential field —
      // the tail must terminate the name.
      assert.match(text, /"requestId": "r_123"/);
      assert.match(text, /"sort_keys": "plural-stays"/);
    } finally {
      rmSync(caseRun.root, { recursive: true, force: true });
    }
  });

  it('the residual check sees the same names (a missed name must refuse, not ship)', () => {
    // If SECRET_FIELD ever stops recognising a name RESIDUAL_FIELD knows, the
    // residual pass is the refuse-path. Prove the shared list keeps them in
    // sync: a leg whose only secret sits under a name added in this wave must
    // bundle cleanly BECAUSE both patterns see it — assert via the manifest.
    const value = 'residualFixtureProbe42';
    const leg = `${JSON.stringify({ traceId: '0008-res', meta: { csrfToken: value } }, null, 2)}\n`;
    const caseRun = bundleTrace('0008-res', { '02-routing.json': leg });
    try {
      assert.equal(caseRun.result.status, 0,
        `status 0 means the name was redacted, not missed:\nstderr: ${caseRun.result.stderr}`);
      const text = caseRun.zip.get('traces/0008-res/02-routing.json').data.toString('utf8');
      assert.match(text, /"csrfToken": "\[redacted\]"/);
      assert.ok(!allZipBytes(caseRun.zip).includes(Buffer.from(value)));
    } finally {
      rmSync(caseRun.root, { recursive: true, force: true });
    }
  });
});
