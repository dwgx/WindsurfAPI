import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAccountAcuUsage } from '../src/auth.js';
import { __setWindsurfApiPostJsonForTest, getUserStatus } from '../src/windsurf-api.js';

afterEach(() => __setWindsurfApiPostJsonForTest(null));

describe('ACU capability discovery', () => {
  it('normalizes fractional ACU fields from Cascade GetUserStatus', async () => {
    __setWindsurfApiPostJsonForTest(async () => ({
      status: 200,
      raw: '{}',
      data: {
        userStatus: {
          planStatus: {
            planInfo: { planName: 'Unrecognized future plan' },
            acuConsumed: 0.1554225,
            acuLimit: 10000,
          },
        },
      },
    }));

    const status = await getUserStatus('fixture-session-token');
    assert.equal(status.acuConsumed, 0.1554225);
    assert.equal(status.acuLimit, 10000);
  });

  it('treats negative legacy quota sentinels as absent when ACU accounting is present', async () => {
    __setWindsurfApiPostJsonForTest(async () => ({
      status: 200,
      raw: '{}',
      data: {
        userStatus: {
          planStatus: {
            planInfo: {
              planName: 'Unrecognized future plan',
              monthlyPromptCredits: -1,
              monthlyFlexCreditPurchaseAmount: -1,
            },
            usedPromptCredits: -1,
            availablePromptCredits: -1,
            usedFlexCredits: -1,
            availableFlexCredits: -1,
            acuConsumed: 0,
          },
        },
      },
    }));

    const status = await getUserStatus('fixture-session-token');
    assert.deepEqual(status.prompt, { limit: null, used: null, remaining: null });
    assert.deepEqual(status.flex, { limit: null, used: null, remaining: null });
    assert.equal(status.acuConsumed, 0);
  });

  it('prefers the upstream cycle snapshot over the local lifetime counter', () => {
    assert.deepEqual(getAccountAcuUsage({
      credits: { acuConsumed: 0.25, acuLimit: 50 },
      _totalSpend: { acuCost: 0.5 },
    }), {
      consumed: 0.25,
      limit: 50,
      source: 'get_user_status',
    });
  });

  it('keeps a reported zero ACU as a discovered accounting signal', () => {
    assert.deepEqual(getAccountAcuUsage({
      credits: { acuConsumed: 0, acuLimit: null },
    }), {
      consumed: 0,
      limit: null,
      source: 'get_user_status',
    });
  });

  it('does not manufacture zero consumption from a limit-only status', () => {
    assert.equal(getAccountAcuUsage({
      credits: { acuLimit: 50 },
    }), null);

    assert.deepEqual(getAccountAcuUsage({
      credits: { acuLimit: 50 },
      _totalSpend: { acuCost: 0.25 },
    }), {
      consumed: 0.25,
      limit: null,
      source: 'local_billing',
    });
  });

  it('falls back to DEVIN_CONNECT billing without inspecting plan identifiers', () => {
    assert.deepEqual(getAccountAcuUsage({
      credits: { planName: 'anything-at-all' },
      _totalSpend: { acuCost: 0.0006735 },
    }), {
      consumed: 0.0006735,
      limit: null,
      source: 'local_billing',
    });
  });

  it('does not invent ACU support when neither upstream nor billing reports it', () => {
    assert.equal(getAccountAcuUsage({
      credits: { planName: 'Cognition Platform (Enterprise)' },
      _totalSpend: { acuCost: 0 },
    }), null);
  });
});
