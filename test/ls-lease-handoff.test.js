import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WindsurfClient } from '../src/client.js';
import { __testing as chat } from '../src/handlers/chat.js';
import { beginLsUse, endLsUse, __resetLsPoolForTests } from '../src/langserver.js';
import { detachedRegistry } from '../src/detached-registry.js';
import { activeSseCount } from '../src/sse-registry.js';

const PORT = 42117;

describe('Cascade lease acquisition', () => {
  for (const failurePoint of ['options', 'acquire', 'missing entry']) {
    it('does not call release when acquisition fails at ' + failurePoint, async () => {
      const client = new WindsurfClient('', PORT, '');
      const error = new Error('Synthetic pre-RPC stop');
      const released = [];
      let acquireCalls = 0;
      const messages = [];
      messages.reduce = () => { throw error; };
      const opts = {
        get onChunk() {
          if (failurePoint === 'options') throw error;
        },
        acquireLease() {
          acquireCalls++;
          if (failurePoint === 'acquire') throw error;
          return null;
        },
        releaseLease: lease => released.push(lease),
      };

      await assert.rejects(client.cascadeChat(messages, 1, 'synthetic', opts), error);
      assert.equal(acquireCalls, failurePoint === 'options' ? 0 : 1);
      assert.deepEqual(released, []);
    });
  }
});

describe('detached Cascade lease handoff', () => {
  afterEach(() => {
    detachedRegistry.reset();
    __resetLsPoolForTests();
  });

  for (const failurePoint of ['handler options', 'producer body']) {
    it('releases the issued lease once when the resume stops in ' + failurePoint, async () => {
      const entry = { key: 'default', port: PORT, csrfToken: '', generation: 1, activeRequests: 0 };
      const key = 'synthetic-detached-turn';
      const callerKey = 'session:synthetic';
      __resetLsPoolForTests([entry]);
      assert.ok(detachedRegistry.admit({
        key, callerKey,
        snapshot: { version: 2, stepOffset: 0, consumedThrough: 0, chunks: [] },
        pin: {
          lsPort: entry.port, lsGeneration: entry.generation,
          accountId: 'synthetic', cascadeId: 'synthetic-cascade', sessionId: 'synthetic-session',
          deadline: Date.now() + 60_000,
        },
      }).token);

      const abort = Object.assign(new Error('Synthetic abort before any transport'), { name: 'AbortError' });
      const messages = [{ role: 'user', content: 'synthetic' }];
      const cascadeMessages = [];
      let injected = false;
      const stop = () => {
        assert.equal(detachedRegistry.lookup(key, callerKey)?.state, 'claimed');
        assert.equal(entry.activeRequests, 1);
        injected = true;
        throw abort;
      };
      cascadeMessages.reduce = stop;

      let issued;
      let producerCalls = 0;
      let producerAcquires = 0;
      const released = [];
      class ObservedClient extends WindsurfClient {
        cascadeChat(...args) {
          producerCalls++;
          return super.cascadeChat(...args);
        }
      }
      const deps = {
        detachKey: key,
        WindsurfClient: ObservedClient,
        get completion() {
          if (failurePoint === 'handler options' && issued) stop();
          return null;
        },
        beginLsUse(port) {
          issued = beginLsUse(port);
          return issued;
        },
        endLsUse(lease) {
          released.push(lease);
          endLsUse(lease);
        },
        acquireLsUse(port) {
          producerAcquires++;
          return beginLsUse(port);
        },
        ensureLs() { assert.fail('a detached resume should never start a language server'); },
        waitForAccount() { assert.fail('the synthetic abort should never retry'); },
      };
      const response = Object.assign(new EventEmitter(), {
        writableEnded: false,
        write: () => true,
        end() { this.writableEnded = true; },
      });
      const { handler } = chat.streamResponse(
        'test-chat', 0, 'synthetic', 'synthetic', 'synthetic', messages, cascadeMessages,
        1, 'synthetic', true, null, false, '', 'test-request', false, callerKey, deps,
      );
      const sseBefore = activeSseCount();
      await handler(response);

      assert.ok(injected, 'the fixture reached the lease handoff');
      assert.ok(issued, 'the handler acquired a genuine request handle');
      assert.equal(producerCalls, failurePoint === 'handler options' ? 0 : 1);
      assert.equal(producerAcquires, 0);
      assert.equal(released.length, 1);
      assert.equal(released[0], issued);
      assert.equal(entry.activeRequests, 0);
      assert.equal(detachedRegistry.lookup(key, callerKey)?.state, 'running');
      assert.equal(activeSseCount(), sseBefore);
    });
  }
});
