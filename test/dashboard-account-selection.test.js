// Selection safety for the merged 账号管理 page (Q4 G1).
//
// The defect this file pins: `_selectedAccounts` used to survive filter/search
// changes, so a 50-id selection made before filtering was still live after the
// table showed 3 rows — and `POST /accounts/batch {op:'delete'}` deleted all 50.
//
// These tests execute the SHIPPED methods (brace-sliced out of index.html), not
// a mirror implementation: a stub `self` supplies only the collaborators the
// method calls, so the filter-key guard and the delete scope are the real ones.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function methodParts(name) {
  let at = HTML.indexOf(`\n  ${name}(`);
  if (at === -1) at = HTML.indexOf(`\n  async ${name}(`);
  assert.notEqual(at, -1, `${name} must exist as a method in the dashboard App object`);
  const open = HTML.indexOf('{', at);
  const decl = HTML.slice(at + 3, open);
  const params = HTML.slice(HTML.indexOf(name, at) + name.length, open).trim();
  const isAsync = /^async\s/.test(decl);
  let depth = 0;
  let end = -1;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `could not delimit the body of ${name}`);
  return { params, body: HTML.slice(open, end), isAsync };
}

const I18n = {
  t: (key, vars) => `${key}|${JSON.stringify(vars || {})}`,
};

function method(name, self) {
  const { params, body, isAsync } = methodParts(name);
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  const fn = new Function('I18n', 'self', '...args',
    `return (${isAsync ? 'async ' : ''}function ${name}${params} ${body}).apply(self, args);`);
  return (...args) => fn(I18n, self, ...args);
}

function baseSelf(overrides = {}) {
  const calls = { toast: [], clear: 0, loads: 0, api: [] };
  const self = {
    accountsQuery: '',
    accountsTier: '',
    accountsStatus: '',
    accountsFlagged: false,
    _selectedAccounts: new Set(),
    _selectionMode: 'ids',
    _selectionFilterKey: null,
    toast: (...args) => calls.toast.push(args),
    clearAccountSelection: () => {
      calls.clear++;
      self._selectedAccounts.clear();
      self._selectionMode = 'ids';
      self._selectionFilterKey = null;
    },
    loadAccounts: async () => { calls.loads++; },
    api: async (methodName, path, body) => {
      calls.api.push({ methodName, path, body });
      return { success: true, ids: [], results: [] };
    },
    _syncSelectAllState: () => {},
    _updateBatchBar: () => {},
    ...overrides,
  };
  self.accountOperationsBusy = method('accountOperationsBusy', self);
  self.recordAccountActionResult = method('recordAccountActionResult', self);
  self.accountsFilterKey = method('accountsFilterKey', self);
  self._selectionMatchesFilters = method('_selectionMatchesFilters', self);
  self._rememberSelectionScope = method('_rememberSelectionScope', self);
  self._dropStaleSelection = method('_dropStaleSelection', self);
  return { self, calls };
}

describe('selection is scoped to the filter that produced it', () => {
  it('changes the filter key for every server param', () => {
    const { self } = baseSelf();
    const base = self.accountsFilterKey();
    for (const patch of [{ accountsQuery: 'a' }, { accountsTier: 'pro' }, { accountsStatus: 'banned' }, { accountsFlagged: true }]) {
      const other = baseSelf({ ...patch });
      assert.notEqual(other.self.accountsFilterKey(), base, `filter key must change for ${JSON.stringify(patch)}`);
    }
  });

  it('clears the selection when the status filter changes', () => {
    const { self, calls } = baseSelf();
    self._selectedAccounts.add('hidden-row');
    self._selectionFilterKey = self.accountsFilterKey();
    method('setAccountsStatus', self)('banned');
    assert.equal(self.accountsStatus, 'banned');
    assert.equal(calls.clear, 1, 'a filter change must clear the armed selection');
    assert.equal(self._selectedAccounts.size, 0);
    assert.equal(calls.loads, 1);
  });

  it('clears the selection at search-input time, before the 300 ms reload', () => {
    const { self, calls } = baseSelf({ accountsQuery: 'old' });
    self._selectedAccounts.add('hidden-row');
    self._selectionFilterKey = self.accountsFilterKey();
    method('onAccountsSearchInput', self)('new');
    assert.equal(calls.clear, 1, 'delete must not act during the debounce window');
    assert.equal(self.accountsQuery, 'new');
  });

  it('drops a stale selection on reload and tells the operator', () => {
    const { self, calls } = baseSelf({ accountsStatus: 'banned' });
    self._selectedAccounts.add('hidden-row');
    self._selectionFilterKey = 'a-filter-that-no-longer-matches';
    assert.equal(self._dropStaleSelection(), true);
    assert.equal(calls.clear, 1);
    assert.equal(self._selectedAccounts.size, 0);
    assert.match(calls.toast[0][0], /accounts\.batch\.selectionCleared/);
  });

  it('remembers "select all matching" as an explicit all scope', async () => {
    const { self } = baseSelf({ accountsStatus: 'banned' });
    const selectAll = method('selectAllMatching', self);
    const prevDocument = globalThis.document;
    globalThis.document = { querySelectorAll: () => [] };
    try {
      self.api = async () => ({ ids: ['a', 'b'] });
      await selectAll();
      assert.equal(self._selectionMode, 'all');
      assert.equal(self._selectionFilterKey, self.accountsFilterKey());
      assert.deepEqual([...self._selectedAccounts], ['a', 'b']);
    } finally {
      globalThis.document = prevDocument;
    }
  });

  it('refuses an oversized "select all" without changing the current scope', async () => {
    const { self, calls } = baseSelf();
    self._selectionMode = 'ids';
    self._selectionFilterKey = self.accountsFilterKey();
    self.api = async () => ({ ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`) });
    const selectAll = method('selectAllMatching', self);
    const prevDocument = globalThis.document;
    globalThis.document = { querySelectorAll: () => [] };
    try {
      await selectAll();
    } finally {
      globalThis.document = prevDocument;
    }
    assert.equal(self._selectionMode, 'ids');
    assert.equal(calls.toast[0][0], 'accounts.batch.tooMany|{"max":1000}');
  });
});

describe('batch delete only deletes the confirmed scope', () => {
  it('sends exactly the selected ids and names the scope in the confirmation', async () => {
    const { self, calls } = baseSelf();
    self._selectedAccounts = new Set(['a', 'b']);
    self._selectionMode = 'ids';
    self._selectionFilterKey = self.accountsFilterKey();
    let confirmDesc = '';
    self.confirm = async (title, desc) => { confirmDesc = desc; return true; };
    self._batchResults = new Map();
    self.setBatchProgress = () => {};
    self.renderBatchFailures = () => {};
    self._accountDetails = new Map();
    self._cardsByAccount = new Map();
    self.translateError = (e) => e;
    self.api = async (methodName, path, body) => {
      calls.api.push({ methodName, path, body });
      return {
        success: true,
        results: body.ids.map((id) => ({ id, ok: true })),
        failed: [], skipped: [], okCount: body.ids.length, failCount: 0, skippedCount: 0, attempted: body.ids.length,
      };
    };
    const batch = method('batchAccountOp', self);
    await batch('delete');
    assert.equal(calls.api.length, 1);
    assert.equal(calls.api[0].path, '/accounts/batch');
    assert.deepEqual(calls.api[0].body, { ids: ['a', 'b'], op: 'delete' });
    assert.match(confirmDesc, /accounts\.batch\.scopeSelected/);
  });

  it('aborts a delete whose selection belongs to a different filter', async () => {
    const { self, calls } = baseSelf({ accountsStatus: 'banned' });
    self._selectedAccounts = new Set(['hidden-row']);
    self._selectionFilterKey = 'the-filter-before-the-change';
    const batch = method('batchAccountOp', self);
    await batch('delete');
    assert.equal(calls.api.length, 0, 'no batch request may run with a stale scope');
    assert.equal(calls.clear, 1);
    assert.equal(calls.toast[0][1], 'error');
    assert.match(calls.toast[0][0], /accounts\.batch\.selectionCleared/);
  });
});
