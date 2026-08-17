/**
 * Test suite for GetUserStatusResponse billing decode (decodeUserStatusFull).
 *
 * Wire spec (calibrated 2026-07-07, live Teams paid account):
 *   #1.13.16 = balance (varint, micro-dollar)
 *   #1.13.17 = billing period start (varint, epoch seconds)
 *   #1.13.18 = billing period end (varint, epoch seconds)
 *   #1.13.1.2 = plan name (string)
 *   #1.13.1.21 (repeated) = credit rate table (f32 fixed32)
 *
 * Tests: synthetic protobuf buffers (built with proto.js writers) asserting:
 *   - Balance + period decode correctly (units verified)
 *   - Rate table decodes (f32 readFloatLE)
 *   - Catalog pairing (rate indices → selectors)
 *   - Graceful degradation (missing fields → null, no throw)
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  writeMessageField,
  writeVarintField,
  writeStringField,
  writeFixed64Field,
  writeFixed32Field,
} from '../src/proto.js';
import { decodeUserStatusFull } from '../src/devin-connect-catalog.js';

/** Helper: build a credit-rate entry (fixed32 f32) */
function buildRateEntry(credit) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeFloatLE(credit, 0);
  return writeMessageField(21, writeFixed32Field(2, buf));
}

/** Helper: build #1.13.1 (plan detail) */
function buildPlanDetail({ name, rates = [] }) {
  const planFields = [
    writeStringField(2, name),
    ...rates.map(buildRateEntry),
  ];
  return writeMessageField(1, Buffer.concat(planFields));
}

/** Helper: build #1.13 (billing block) */
function buildDoubleField(field, value) {
  const buf = Buffer.allocUnsafe(8);
  buf.writeDoubleLE(value, 0);
  return writeFixed64Field(field, buf);
}

function buildBillingBlock({ balance, periodStart, periodEnd, acuConsumed, acuLimit, plan }) {
  const billingFields = [];
  if (plan) billingFields.push(buildPlanDetail(plan));
  if (balance != null) billingFields.push(writeVarintField(16, balance));
  if (periodStart != null) billingFields.push(writeVarintField(17, periodStart));
  if (periodEnd != null) billingFields.push(writeVarintField(18, periodEnd));
  if (acuConsumed != null) billingFields.push(buildDoubleField(19, acuConsumed));
  if (acuLimit != null) billingFields.push(buildDoubleField(20, acuLimit));
  return writeMessageField(13, Buffer.concat(billingFields));
}

/** Helper: build full GetUserStatusResponse */
function buildUserStatusResponse({ billing }) {
  const field1 = writeMessageField(1, billing);
  return field1;
}

test('decodeUserStatusFull: paid account with full billing ledger', () => {
  const periodStart = Math.floor(Date.now() / 1000);
  const periodEnd = periodStart + 86400 * 5; // 5-day period
  const balance = 80_000_000; // $80 in micro-dollars

  const billing = buildBillingBlock({
    balance,
    periodStart,
    periodEnd,
    plan: {
      name: 'Teams',
      rates: [25, 50, 6, 1.5, 12],
    },
  });

  const response = buildUserStatusResponse({ billing });
  const result = decodeUserStatusFull(response);

  assert.equal(result.plan, 'teams');
  assert.equal(result.isPaid, true);
  assert.equal(result.balance, 80);          // 80000000 micro-usd / 1e6 = $80
  assert.equal(result.balanceUnit, 'usd');    // already converted to USD
  assert.equal(result.balanceMicro, 80000000); // raw micro-usd preserved
  assert.equal(result.periodStart, periodStart * 1000); // epoch ms (number)
  assert.equal(result.periodEnd, periodEnd * 1000);
  assert.ok(Array.isArray(result.rateTable));
  assert.equal(result.rateTable.length, 5);
  assert.equal(result.rateTable[0], 25);
  assert.equal(result.rateTable[1], 50);
  assert.equal(result.rateTable[2], 6);
  assert.equal(result.rateTable[3], 1.5);
  assert.equal(result.rateTable[4], 12);
});

test('decodeUserStatusFull: discovers fractional ACU accounting without a plan-name gate', () => {
  const billing = buildBillingBlock({
    acuConsumed: 0.1554225,
    acuLimit: 10000,
    plan: { name: 'Unrecognized future plan', rates: [] },
  });

  const result = decodeUserStatusFull(buildUserStatusResponse({ billing }));

  assert.equal(result.acuConsumed, 0.1554225);
  assert.equal(result.acuLimit, 10000);
});

test('decodeUserStatusFull: catalog pairing (rates → selectors)', () => {
  const billing = buildBillingBlock({
    balance: 100_000_000,
    periodStart: 1783411200,
    periodEnd: 1783843200,
    plan: {
      name: 'Teams',
      rates: [25, 50, 6],
    },
  });

  const response = buildUserStatusResponse({ billing });
  const catalog = [
    { selector: 'claude-opus-4-8-medium' },
    { selector: 'claude-5-fable-medium' },
    { selector: 'claude-sonnet-5-medium' },
  ];

  const result = decodeUserStatusFull(response, catalog);

  assert.equal(typeof result.rateTable, 'object');
  assert.equal(result.rateTable['claude-opus-4-8-medium'], 25);
  assert.equal(result.rateTable['claude-5-fable-medium'], 50);
  assert.equal(result.rateTable['claude-sonnet-5-medium'], 6);
});

test('decodeUserStatusFull: free account (minimal billing)', () => {
  const billing = buildBillingBlock({
    plan: { name: 'Free', rates: [] },
  });

  const response = buildUserStatusResponse({ billing });
  const result = decodeUserStatusFull(response);

  assert.equal(result.plan, 'free');
  assert.equal(result.isPaid, false);
  assert.equal(result.balance, null);
  assert.equal(result.balanceUnit, null);
  assert.equal(result.periodStart, null);
  assert.equal(result.periodEnd, null);
  assert.equal(result.acuConsumed, null);
  assert.equal(result.acuLimit, null);
  assert.equal(result.rateTable, null);
});

test('decodeUserStatusFull: partial billing (balance only)', () => {
  const billing = buildBillingBlock({
    balance: 50_000_000,
    plan: { name: 'Pro', rates: [] },
  });

  const response = buildUserStatusResponse({ billing });
  const result = decodeUserStatusFull(response);

  assert.equal(result.plan, 'pro');
  assert.equal(result.isPaid, true);
  assert.equal(result.balance, 50);
  assert.equal(result.balanceUnit, 'usd');
  assert.equal(result.periodStart, null);
  assert.equal(result.periodEnd, null);
});

test('decodeUserStatusFull: graceful degrade on malformed rate entry', () => {
  // Build a rate table with one valid entry and one malformed (wrong field #99 instead of #2)
  const buf = Buffer.allocUnsafe(4);
  buf.writeFloatLE(999, 0);
  const malformedRate = writeMessageField(21, writeFixed32Field(99, buf)); // field #99, not #2

  const planFields = [
    writeStringField(2, 'Teams'),
    buildRateEntry(25), // valid
    malformedRate, // malformed: wrong field number
    buildRateEntry(50), // another valid
  ];
  const billing = writeMessageField(13, writeMessageField(1, Buffer.concat(planFields)));
  const response = buildUserStatusResponse({ billing });

  const result = decodeUserStatusFull(response);

  assert.equal(result.plan, 'teams');
  assert.ok(Array.isArray(result.rateTable));
  assert.equal(result.rateTable.length, 3);
  assert.equal(result.rateTable[0], 25);
  assert.equal(result.rateTable[1], null); // malformed → null (no field #2)
  assert.equal(result.rateTable[2], 50);
});

test('decodeUserStatusFull: empty response (no #1 field)', () => {
  const response = Buffer.alloc(0);
  const result = decodeUserStatusFull(response);

  assert.equal(result.plan, 'unknown');
  assert.equal(result.isPaid, false);
  assert.equal(result.balance, null);
  assert.equal(result.periodStart, null);
  assert.equal(result.periodEnd, null);
  assert.equal(result.rateTable, null);
});

test('decodeUserStatusFull: fallback plan name from #2.#2 (legacy path)', () => {
  // Build a response with plan name only in #2.#2 (no billing block in #1)
  // The #2 field is at the TOP level, not inside #1
  const field2Inner = writeStringField(2, 'Enterprise');
  const field2 = writeMessageField(2, field2Inner);
  const result = decodeUserStatusFull(field2);

  assert.equal(result.plan, 'enterprise');
  assert.equal(result.isPaid, true);
  assert.equal(result.balance, null); // no billing block
});

test('decodeUserStatusFull: rate table longer than catalog (excess ignored)', () => {
  const billing = buildBillingBlock({
    plan: {
      name: 'Teams',
      rates: [25, 50, 6, 1.5, 12],
    },
  });

  const response = buildUserStatusResponse({ billing });
  const catalog = [
    { selector: 'claude-opus-4-8-medium' },
    { selector: 'claude-5-fable-medium' },
    // only 2 models vs 5 rates
  ];

  const result = decodeUserStatusFull(response, catalog);

  assert.equal(Object.keys(result.rateTable).length, 2);
  assert.equal(result.rateTable['claude-opus-4-8-medium'], 25);
  assert.equal(result.rateTable['claude-5-fable-medium'], 50);
  // rates[2..4] are not paired (no catalog entries)
});

test('decodeUserStatusFull: catalog entry without selector (skipped in pairing)', () => {
  const billing = buildBillingBlock({
    plan: { name: 'Teams', rates: [25, 50, 6] },
  });

  const response = buildUserStatusResponse({ billing });
  const catalog = [
    { selector: 'claude-opus-4-8-medium' },
    { selector: null }, // malformed catalog entry
    { selector: 'claude-sonnet-5-medium' },
  ];

  const result = decodeUserStatusFull(response, catalog);

  assert.equal(Object.keys(result.rateTable).length, 2);
  assert.equal(result.rateTable['claude-opus-4-8-medium'], 25);
  assert.equal(result.rateTable['claude-sonnet-5-medium'], 6);
  // index 1 skipped (no selector)
});
