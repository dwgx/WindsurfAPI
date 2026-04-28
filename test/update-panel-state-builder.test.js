import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdatePanelStateWithUserStatusRequest } from '../src/windsurf.js';
import { getAllFields, getField, parseFields } from '../src/proto.js';

describe('buildUpdatePanelStateWithUserStatusRequest', () => {
  it('emits metadata only unless raw user_status bytes are provided', () => {
    const emptyReq = buildUpdatePanelStateWithUserStatusRequest('apikey', 'sess', null);
    const emptyFields = parseFields(emptyReq);

    assert.ok(getField(emptyFields, 1, 2));
    assert.equal(getAllFields(emptyFields, 2).length, 0);

    const userStatusBytes = Buffer.from([0x08, 0x05]);
    const req = buildUpdatePanelStateWithUserStatusRequest('apikey', 'sess', userStatusBytes);
    const fields = parseFields(req);
    const userStatus = getField(fields, 2, 2);

    assert.ok(getField(fields, 1, 2));
    assert.ok(userStatus);
    assert.equal(userStatus.value.length, userStatusBytes.length);
    assert.deepEqual(Buffer.from(userStatus.value), userStatusBytes);
  });
});
