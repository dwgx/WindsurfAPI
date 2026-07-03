import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRouterModel,
  parseAssignTags,
  encodeAssignModelRequest,
  decodeAssignModelResponse,
  assignModel,
} from '../src/devin-connect-catalog.js';
import { writeStringField, writeMessageField, parseFields } from '../src/proto.js';

// Build a synthetic AssignModelResponse with the default tag layout:
//   #1 assignment { #1 model_uid, #2 assignment_jwt, #3 harness_uids* }
function buildAssignResponse({ modelUid, jwt, harness = [] } = {}) {
  const inner = [];
  if (modelUid != null) inner.push(writeStringField(1, modelUid));
  if (jwt != null) inner.push(writeStringField(2, jwt));
  for (const h of harness) inner.push(writeStringField(3, h));
  return writeMessageField(1, Buffer.concat(inner));
}

describe('isRouterModel', () => {
  it('flags the known router families', () => {
    assert.equal(isRouterModel('adaptive'), true);
    assert.equal(isRouterModel('ADAPTIVE'), true); // case-insensitive
    assert.equal(isRouterModel('arena-fast'), true);
    assert.equal(isRouterModel('arena-anything'), true);
  });

  it('does not flag concrete models', () => {
    assert.equal(isRouterModel('claude-opus-4.8'), false);
    assert.equal(isRouterModel('swe-1.6-slow'), false);
    assert.equal(isRouterModel('gpt-5.5'), false);
    assert.equal(isRouterModel(''), false);
    assert.equal(isRouterModel(null), false);
  });

  it('honors DEVIN_CONNECT_ROUTER_MODELS extension (exact + prefix)', () => {
    const env = { DEVIN_CONNECT_ROUTER_MODELS: 'auto,smart-*' };
    assert.equal(isRouterModel('auto', env), true);
    assert.equal(isRouterModel('smart-pick', env), true);
    assert.equal(isRouterModel('claude-opus-4.8', env), false);
    // built-ins still apply alongside the extension
    assert.equal(isRouterModel('adaptive', env), true);
  });
});

describe('parseAssignTags', () => {
  it('returns the default layout when unset', () => {
    const t = parseAssignTags({});
    assert.deepEqual(t, {
      req_model_uid: 2, resp_assignment: 1, asg_model_uid: 1, asg_jwt: 2, asg_harness: 3,
    });
  });

  it('applies valid overrides and ignores garbage / unknown keys', () => {
    const t = parseAssignTags({
      DEVIN_CONNECT_ASSIGN_TAGS: 'resp_assignment=4,asg_model_uid=7,bogus=9,asg_jwt=xx,asg_harness=-1',
    });
    assert.equal(t.resp_assignment, 4);   // overridden
    assert.equal(t.asg_model_uid, 7);     // overridden
    assert.equal(t.asg_jwt, 2);           // non-int ignored → default
    assert.equal(t.asg_harness, 3);       // negative ignored → default
    assert.equal('bogus' in t, false);    // unknown key not added
  });
});

describe('encode/decode AssignModel round-trip', () => {
  it('encodes the request model_uid at the configured tag', () => {
    const body = encodeAssignModelRequest('adaptive');
    const fields = parseFields(body);
    // default req_model_uid tag is 2
    const f = fields.find((x) => x.field === 2 && x.wireType === 2);
    assert.ok(f, 'model_uid encoded at tag 2');
    assert.equal(f.value.toString('utf8'), 'adaptive');
  });

  it('decodes a full ModelAssignment', () => {
    const raw = buildAssignResponse({
      modelUid: 'claude-opus-4-8-medium', jwt: 'eyJhbGc.sig', harness: ['h1', 'h2'],
    });
    assert.deepEqual(decodeAssignModelResponse(raw), {
      model_uid: 'claude-opus-4-8-medium',
      assignment_jwt: 'eyJhbGc.sig',
      harness_uids: ['h1', 'h2'],
    });
  });

  it('returns null on an empty assignment (no model_uid)', () => {
    assert.equal(decodeAssignModelResponse(buildAssignResponse({ jwt: 'x' })), null);
    assert.equal(decodeAssignModelResponse(Buffer.alloc(0)), null); // no assignment field at all
  });

  it('respects tag overrides symmetrically', () => {
    const env = { DEVIN_CONNECT_ASSIGN_TAGS: 'resp_assignment=4,asg_model_uid=7,asg_jwt=8' };
    const tags = parseAssignTags(env);
    // build a response in the overridden layout
    const inner = Buffer.concat([writeStringField(7, 'm-uid'), writeStringField(8, 'jwt')]);
    const raw = writeMessageField(4, inner);
    assert.deepEqual(decodeAssignModelResponse(raw, tags), {
      model_uid: 'm-uid', assignment_jwt: 'jwt', harness_uids: [],
    });
  });
});

describe('assignModel (transport guards)', () => {
  it('throws NO_TOKEN when no token is available', async () => {
    await assert.rejects(
      () => assignModel({ modelUid: 'adaptive', env: {} }),
      (e) => e.code === 'NO_TOKEN',
    );
  });

  it('throws BAD_REQUEST when modelUid is missing', async () => {
    await assert.rejects(
      () => assignModel({ token: 'fake', env: {} }),
      (e) => e.code === 'BAD_REQUEST',
    );
  });
});
