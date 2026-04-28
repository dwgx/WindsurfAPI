import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeartbeatRequest } from '../src/windsurf.js';
import { getAllFields, getField, parseFields } from '../src/proto.js';

function metadataStrings(buf) {
  return Object.fromEntries(
    parseFields(buf)
      .filter(field => field.wireType === 2)
      .map(field => [field.field, field.value.toString('utf8')])
  );
}

describe('buildHeartbeatRequest', () => {
  it('emits metadata only with Windsurf fingerprint fields', () => {
    const req = buildHeartbeatRequest('apikey', 'sess');
    const fields = parseFields(req);
    const metadata = getField(fields, 1, 2);

    assert.ok(metadata);
    assert.equal(getAllFields(fields, 2).length, 0);
    assert.equal(getAllFields(fields, 3).length, 0);

    const meta = metadataStrings(metadata.value);
    assert.equal(meta[1], 'windsurf');
    assert.equal(meta[2], '2.0.67');
  });
});
