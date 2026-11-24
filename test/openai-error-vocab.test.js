import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeOpenAIErrorType,
  normalizeOpenAIErrorBody,
  OFFICIAL_OPENAI_ERROR_TYPES,
} from '../src/handlers/chat.js';
import { bodyTooLargePayload } from '../src/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// O10: OpenAI-family error.type vocabulary normalization at the egress boundary.
describe('O10 normalizeOpenAIErrorType — internal → official mapping', () => {
  const cases = [
    ['invalid_request', 'invalid_request_error'],
    ['auth_error', 'api_error'],
    ['not_found', 'not_found_error'],
    ['rate_limit_exceeded', 'rate_limit_error'],
    ['pool_exhausted', 'api_error'],
    ['ls_pool_exhausted', 'api_error'],
    ['ls_unavailable', 'api_error'],
    ['upstream_error', 'api_error'],
    ['upstream_transient_error', 'api_error'],
    ['upstream_internal_error', 'api_error'],
    ['upstream_deadline_exceeded', 'api_error'],
    ['timeout_error', 'api_error'],
    ['capacity_error', 'api_error'],
    ['model_blocked', 'permission_error'],
    ['model_not_available', 'api_error'],
    ['payload_too_large', 'invalid_request_error'],
    ['unsupported_media', 'invalid_request_error'],
    ['unsupported_tool_boundary', 'invalid_request_error'],
    ['fabricated_tool_result', 'api_error'],
    ['policy_blocked', 'invalid_request_error'],
    ['backend_error', 'api_error'],
    ['backend_unavailable', 'api_error'],
    ['backend_pool_exhausted', 'api_error'],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${input} → ${expected}`, () => {
      assert.equal(normalizeOpenAIErrorType(input), expected);
    });
  }
});

describe('O10 normalizeOpenAIErrorType — official words pass through', () => {
  for (const t of OFFICIAL_OPENAI_ERROR_TYPES) {
    it(`passes official ${t} through unchanged`, () => {
      assert.equal(normalizeOpenAIErrorType(t), t);
    });
  }
});

describe('O10 normalizeOpenAIErrorType — unknown word falls back by status', () => {
  it('unknown + 429 → rate_limit_error', () => {
    assert.equal(normalizeOpenAIErrorType('weird_word', 429), 'rate_limit_error');
  });
  it('unknown + 500 → api_error', () => {
    assert.equal(normalizeOpenAIErrorType('weird_word', 500), 'api_error');
  });
  it('unknown + 400 → invalid_request_error', () => {
    assert.equal(normalizeOpenAIErrorType('weird_word', 400), 'invalid_request_error');
  });
  it('unknown + 401 → authentication_error', () => {
    assert.equal(normalizeOpenAIErrorType('weird_word', 401), 'authentication_error');
  });
  it('unknown + 403 → permission_error', () => {
    assert.equal(normalizeOpenAIErrorType('weird_word', 403), 'permission_error');
  });
  it('unknown + 404 → not_found_error', () => {
    assert.equal(normalizeOpenAIErrorType('weird_word', 404), 'not_found_error');
  });
  it('unknown with no status defaults to api_error (500)', () => {
    assert.equal(normalizeOpenAIErrorType('weird_word'), 'api_error');
  });
});

describe('O10 invariant — every mapped value is an official type', () => {
  it('all internal-to-official targets are in OFFICIAL_OPENAI_ERROR_TYPES', () => {
    const internalInputs = [
      'invalid_request', 'auth_error', 'not_found', 'rate_limit_exceeded',
      'pool_exhausted', 'upstream_error', 'model_blocked', 'model_not_available',
      'payload_too_large', 'policy_blocked', 'backend_error',
    ];
    for (const input of internalInputs) {
      assert.ok(
        OFFICIAL_OPENAI_ERROR_TYPES.has(normalizeOpenAIErrorType(input)),
        `${input} mapped to a non-official type`,
      );
    }
  });
});

describe('O10 normalizeOpenAIErrorBody', () => {
  it('rewrites internal type in an error body', () => {
    const body = { error: { type: 'pool_exhausted', message: 'x' } };
    normalizeOpenAIErrorBody(body, 503);
    assert.equal(body.error.type, 'api_error');
  });
  it('no-op on a success body (no .error)', () => {
    const body = { choices: [{ index: 0 }] };
    normalizeOpenAIErrorBody(body, 200);
    assert.deepEqual(body, { choices: [{ index: 0 }] });
  });
  it('no-op when error has no type', () => {
    const body = { error: { message: 'x' } };
    normalizeOpenAIErrorBody(body, 400);
    assert.deepEqual(body, { error: { message: 'x' } });
  });
  it('passes an already-official type through', () => {
    const body = { error: { type: 'invalid_request_error', message: 'x' } };
    normalizeOpenAIErrorBody(body, 400);
    assert.equal(body.error.type, 'invalid_request_error');
  });
});

describe('O10 server.js literal — bodyTooLargePayload openai', () => {
  it('uses official invalid_request_error', () => {
    assert.equal(bodyTooLargePayload('openai').error.type, 'invalid_request_error');
  });
});

describe('O10 source-level — OpenAI-family literals are official', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
  it('no bare invalid_request literal remains', () => {
    assert.doesNotMatch(src, /type: 'invalid_request'[^_]/);
  });
  it('no bare not_found literal remains', () => {
    assert.doesNotMatch(src, /type: 'not_found'[^_]/);
  });
  it('the three OpenAI no-account routes use the shared api_error envelope', () => {
    const start = src.indexOf('function rejectAccountAdmission(');
    const end = src.indexOf('\n}\n', start);
    assert.ok(start >= 0 && end > start, 'missing admission response helper');
    const noAccount = src.slice(start, end);
    assert.match(noAccount, /type: 'api_error'/);
    assert.doesNotMatch(noAccount, /type: 'auth_error'/);
    for (const surface of ['chat_completions', 'completions', 'responses']) {
      assert.ok(src.includes(`rejectAccountAdmission(res, fallbackRequestId, '${surface}')`), surface);
    }
  });
});
