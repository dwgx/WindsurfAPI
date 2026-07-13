#!/usr/bin/env node
/**
 * Inline-sync gate.
 *
 * Some dashboard logic (pool-event detection) lives BOTH as a testable ESM
 * module (src/dashboard/pool-events.js) AND inlined into index.html (the
 * single-file "just open it" constraint). They must not drift. Exact-text
 * matching is brittle (method vs function syntax differs), so instead we extract
 * the semantically load-bearing tokens from each and assert they agree:
 *   - the account-state priority chain (disabled→error→quota→rate_limited→capacity)
 *   - the transition severity rules
 *   - the backoff / collapse behaviour
 *
 * Exit 0 = in sync; 1 = drift (fix BOTH copies).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const moduleSrc = fs.readFileSync(path.join(root, 'src/dashboard/pool-events.js'), 'utf8');
const diffSrc = fs.readFileSync(path.join(root, 'src/dashboard/diff.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(root, 'src/dashboard/index.html'), 'utf8');

let fail = 0;
const check = (name, ok) => {
  if (ok) { console.log(`${GREEN}✓${RESET} ${name}`); }
  else { console.log(`${RED}✗${RESET} ${name} — inline copy in index.html drifted from src/dashboard/pool-events.js`); fail = 1; }
};

// The load-bearing invariants, expressed as substrings that MUST appear in both.
// State priority chain (order matters — same sequence in both).
const stateChain = [
  `'disabled'`, `'banned'`, `'error'`, `quotaCooled`, `'quota'`,
  `rateLimited`, `'rate_limited'`, `capacityThrottled`, `'capacity'`, `'active'`,
];
// Transition rule tokens.
const transitionTokens = [`'recovered'`, `'success'`, `'disabled' || to === 'quota'`, `'error'`, `'warn'`];
// Behaviour constants / tokens.
const behaviourTokens = [`primed`, `lastState`, `lastEmitAt`, `backoffMs`, `collapseAt`, `type: 'summary'`];

const bothHave = (tok) => moduleSrc.includes(tok) && htmlSrc.includes(tok);

check('state priority chain present in both', stateChain.every(bothHave));
check('transition severity rules present in both', transitionTokens.every(bothHave));
check('detector behaviour tokens present in both', behaviourTokens.every(bothHave));

// Ordering check: in BOTH files the state checks appear in the same relative
// order (a reordering would change which state wins).
function order(src, toks) {
  const idxs = toks.map(t => src.indexOf(t));
  return idxs.every((v, i) => i === 0 || v >= idxs[i - 1]);
}
const orderToks = [`if (a.status === 'disabled'`, `if (a.status === 'error'`, `if (a.quotaCooled)`, `if (a.rateLimited)`, `if (a.capacityThrottled)`];
// module uses these exact forms; inline mirror uses the same. Verify order in each.
const modOrderOk = order(moduleSrc, orderToks);
const htmlOrderOk = order(htmlSrc, orderToks);
check('state-check order identical (module)', modOrderOk);
check('state-check order identical (inline)', htmlOrderOk);

// diff.js ↔ inline LCS mirror: the load-bearing DP recurrence + walk tokens.
const diffTokens = [
  `lcs[i + 1][j + 1] + 1`,
  `Math.max(lcs[i + 1][j], lcs[i][j + 1])`,
  `lcs[i + 1][j] >= lcs[i][j + 1]`,
  `op: 'del'`, `op: 'add'`, `op: 'ctx'`,
];
const diffBoth = (tok) => diffSrc.includes(tok) && htmlSrc.includes(tok);
check('LCS diff recurrence + walk present in both (diff.js ↔ inline)', diffTokens.every(diffBoth));

if (fail) {
  console.log(`\n${RED}Inline sync FAILED${RESET} — inline logic in index.html disagrees with its module. Update both.`);
  process.exit(1);
}
console.log(`\n${GREEN}Inline sync OK${RESET}`);
