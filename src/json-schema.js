/**
 * A bounded, dependency-free JSON Schema validator.
 *
 * Why this exists: `response_format: {type:'json_schema'}` (and Anthropic's
 * `output_config.format`) is a promise to the caller that the body conforms to
 * its schema. This proxy cannot make the model obey — the upstream has no such
 * control — so the honest thing is to CHECK the answer and say so when it does
 * not hold. Before this module the code only "stabilised" the payload by
 * projecting it onto the requested key names, inventing `null`/`true` for keys
 * the model never produced (KH-013).
 *
 * Scope, deliberately: the keyword subset real callers actually ship —
 * type/enum/const, object properties/required/additionalProperties, array
 * items/minItems/maxItems/uniqueItems, string min/maxLength/pattern, numeric
 * bounds, and the anyOf/oneOf/allOf/not combinators, plus local `$ref`
 * (`#/$defs/...`, `#/definitions/...`). Unknown keywords are IGNORED, which is
 * exactly what the JSON Schema spec requires of an implementation that does not
 * know an annotation — it must never turn "I don't understand this" into a
 * failure. A keyword this module DOES support, written malformed (an invalid
 * `pattern`), is a different thing: the schema is not one we can evaluate, and
 * that is reported as `unable` rather than folded into a pass.
 *
 * A `$ref` cycle is not followed: the depth guard reports non-conformance for a
 * schema that cannot be evaluated rather than looping forever.
 *
 * Every judgement is one of exactly three things, and the three are never
 * blurred. "I could not judge, so it passes" is a lie the caller pays for: a
 * schema whose `pattern` was skipped because it looked dangerous used to report
 * `{ok:true}`, so a payload that genuinely violated the schema was returned as
 * a conforming answer, and `not`/`oneOf`/`anyOf` inverted the skip into
 * nonsense (a safe `^(cat|dog)+$` was "refused", making `not` reject a value it
 * should accept and `oneOf` count two matches).
 *
 *   valid   -> { ok: true }
 *   invalid -> { ok: false, path, message }        a real conformance failure
 *   unable  -> { ok: false, path, message, unable: true, code: 'SCHEMA_UNVALIDATED' }
 *              the schema asked for work this module will not spend: a pattern
 *              that exhausts the request's execution budget, a pattern or value
 *              past its size cap, or a schema past the traversal ceiling.
 *
 * `unable` is NOT a pass and NOT a conformance failure: callers must surface it
 * as its own typed failure (the chat handlers map it to
 * STRUCTURED_OUTPUT_UNVALIDATED), and the combinators propagate it instead of
 * folding it into a boolean.
 */

import { Script, createContext } from 'node:vm';

const MAX_REF_DEPTH = 32;

// ---------------------------------------------------------------------------
// Pattern execution budget
//
// A caller-supplied `pattern` is compiled by the platform RegExp engine, which
// backtracks: catastrophic nesting makes the match cost exponential in the
// length of the MODEL's output, so a caller can aim a regex bomb at this
// process's event loop on the request path. A static shape scan cannot close
// that — the canonical bomb has an unbounded number of spellings. `^((a|a))+$`
// defeats a "top-level alternation under a repeat" check by adding one harmless
// group; adjacent quantified atoms (`a*a*a*…$`), backreferences and
// bounded-but-large inner repeats defeat the nesting check.
//
// The only honest bound is to RUN the match under a watchdog that can interrupt
// the engine and to say "I could not judge" when it fires. node:vm provides
// that synchronously, which is what this call chain needs: the four sinks in
// src/handlers/chat.js are synchronous. A constant, trusted script
// (`new RegExp(pattern).test(value)`) is compiled ONCE at module load; the
// caller's pattern and the model's value reach it only as primitive sandbox
// bindings — never interpolated into source — inside a context where code
// generation (eval/Function/WASM) is disabled.
//
// MEASURED (Node v24.19.0, this box): V8's `timeout` does interrupt a
// backtracking regexp. `^((a|a))+$` on 26 `a`s plus a near-miss throws
// ERR_SCRIPT_EXECUTION_TIMEOUT; a 50 ms grant returns at ~57-61 ms (the
// watchdog's overshoot). Safe patterns cost 0.2-0.5 ms each in the shared
// context (`^a+$`, `^(cat|dog)+$`), 0.4 ms for `^[a-z]+$` on a 256 KiB target,
// ~5 ms for `^(a|b)+$` on the same target.
//
// BUDGET_MS is the whole request's allowance, not each pattern's: every
// `pattern` in the schema tree draws from ONE absolute deadline created at the
// top-level call, so a schema with many patterns cannot multiply the bill. The
// deadline is absolute, so only the time actually spent is charged — granting
// the remainder to a pattern that finishes in 0.3 ms costs 0.3 ms.
//
// 50 ms: enough for ~100 ordinary pattern checks, and the worst case a caller
// can force is one budget plus the watchdog's overshoot (~61 ms observed) —
// two orders of magnitude below the 1 s that made the original bomb a release
// blocker, and a fraction of the upstream I/O on the same request.
const BUDGET_MS = 50;

// Traversal ceiling. The schema is caller-controlled too, so its SIZE needs a
// bound that no regex watchdog can provide: a 10^5-entry `allOf`, an enum with
// 10^6 candidates, or an array of 10^6 `uniqueItems` elements would otherwise
// burn wall-clock in plain JavaScript. Steps are charged per schema node
// visited, per enum candidate compared and per uniqueItems element serialised.
// 20_000 is far above any real schema (50_000 trivial stringify steps measured
// ~4.6 ms) and keeps the worst case to single-digit milliseconds.
const MAX_SCHEMA_STEPS = 20_000;

// Input-size caps. Past either one the module says "unable", never "pass":
// silently skipping the match is what let a non-conforming answer through.
const MAX_PATTERN_CHARS = 1024;
const MAX_PATTERN_TARGET_CHARS = 256 * 1024;

const UNVALIDATED = 'SCHEMA_UNVALIDATED';

// A constant, trusted program. `strings: false` means the context cannot
// compile new source, so caller input can never become code even if the regexp
// engine itself is compromised. The sandbox is module state, which is safe
// because validation is synchronous end to end: no other request can interleave
// between writing the bindings and running the script.
const PATTERN_SCRIPT = new Script('new RegExp(pattern).test(value)', { filename: 'json-schema-pattern.js' });
const PATTERN_SANDBOX = { pattern: '', value: '' };
const PATTERN_CONTEXT = createContext(PATTERN_SANDBOX, {
  name: 'json-schema-pattern',
  codeGeneration: { strings: false, wasm: false },
});

function createBudget() {
  return { expiresAt: performance.now() + BUDGET_MS, steps: 0, exhausted: false };
}

/**
 * The module's bounds, exposed so a test can build a fixture at the boundary
 * instead of hard-coding a number that may drift from the implementation.
 * Read-only: the values are the defence, not configuration.
 */
export const __jsonSchemaLimits = Object.freeze({
  BUDGET_MS,
  MAX_SCHEMA_STEPS,
  MAX_PATTERN_CHARS,
  MAX_PATTERN_TARGET_CHARS,
});

function unableWithinBudget(path) {
  return {
    ok: false,
    path,
    message: 'schema could not be validated within budget',
    unable: true,
    code: UNVALIDATED,
    reason: 'budget',
  };
}

function unableCapacity(path, detail) {
  return {
    ok: false,
    path,
    message: `schema could not be validated: ${detail}`,
    unable: true,
    code: UNVALIDATED,
    reason: 'capacity',
  };
}

function unableInvalidPattern(path) {
  return {
    ok: false,
    path,
    message: 'schema could not be validated: the pattern is not a valid regular expression',
    unable: true,
    code: UNVALIDATED,
    reason: 'invalid-pattern',
  };
}

/**
 * Charge `n` steps against the traversal ceiling.
 * @returns {boolean} false once the ceiling is passed.
 */
function chargeSteps(budget, n = 1) {
  budget.steps += n;
  return budget.steps <= MAX_SCHEMA_STEPS;
}

/**
 * Run one `pattern` assertion under the shared budget.
 *
 * `pattern` is a SEARCH assertion, not an anchored full match: the pattern text
 * is used verbatim, ECMA-262 semantics, no implicit `^…$` and no truncation of
 * the value.
 *
 * @returns {null | {ok: false, path: string, message: string, unable?: true, code?: string}}
 *   null when the value conforms, otherwise the verdict. There is no "no
 *   verdict, so pass" case: an invalid pattern, an over-size pattern or value,
 *   and an exhausted budget are all reported as `unable`.
 */
function evaluatePattern(pattern, value, budget, path) {
  if (pattern.length > MAX_PATTERN_CHARS) {
    return unableCapacity(path, `a pattern longer than ${MAX_PATTERN_CHARS} characters cannot be evaluated`);
  }
  if (value.length > MAX_PATTERN_TARGET_CHARS) {
    return unableCapacity(path, `a value longer than ${MAX_PATTERN_TARGET_CHARS} characters cannot be matched against a pattern`);
  }
  if (budget.exhausted) return unableWithinBudget(path);
  const remaining = budget.expiresAt - performance.now();
  if (!(remaining > 0)) return unableWithinBudget(path);

  PATTERN_SANDBOX.pattern = pattern;
  PATTERN_SANDBOX.value = value;
  let matched;
  try {
    matched = PATTERN_SCRIPT.runInContext(PATTERN_CONTEXT, { timeout: Math.max(1, Math.ceil(remaining)) });
  } catch (err) {
    if (err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      // The engine could not finish inside what was left of the request's
      // budget. One bomb spends the budget for the whole schema: handing the
      // next pattern a fresh slice would let a caller multiply the bill by the
      // number of patterns in their schema.
      budget.exhausted = true;
      return unableWithinBudget(path);
    }
    if (err && err.name === 'SyntaxError') {
      // `pattern` is a keyword this module SUPPORTS; the caller wrote it
      // malformed. That is not the neutral "unknown annotation" case (which is
      // an unknown KEYWORD), and folding it into a pass is the same fail-open
      // as refusing a valid pattern: `not` would invert the skip and `oneOf`
      // would count it as a match. Report it as a schema we cannot evaluate.
      return unableInvalidPattern(path);
    }
    budget.exhausted = true;
    return unableCapacity(path, 'the pattern could not be evaluated');
  }
  if (!matched) return { ok: false, path, message: `must match ${pattern}` };
  return null;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, wanted) {
  switch (wanted) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true; // an unknown type name is an annotation we cannot judge
  }
}

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  const path = ref.slice(1).replace(/^\//, '');
  if (!path) return root;
  let cur = root;
  for (const rawPart of path.split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * @returns {{ok: true} | {ok: false, path: string, message: string, unable?: true, code?: string}}
 */
export function validateJsonSchema(value, schema, { path = '$', root = schema, depth = 0, budget = null } = {}) {
  // Created ONCE at the top-level call and threaded through every recursive
  // call below: a sub-schema must never get a fresh allowance.
  const scope = budget ?? createBudget();

  if (schema === undefined || schema === true || schema === null) return { ok: true };
  if (schema === false) return { ok: false, path, message: 'no value is allowed here' };
  if (!isPlainObject(schema)) return { ok: true };
  if (!chargeSteps(scope)) return unableCapacity(path, `the schema exceeds ${MAX_SCHEMA_STEPS} evaluation steps`);
  if (performance.now() > scope.expiresAt) return unableWithinBudget(path);
  if (depth > MAX_REF_DEPTH) {
    return { ok: false, path, message: 'schema $ref nesting is too deep to evaluate' };
  }

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root);
    if (target === undefined) return { ok: false, path, message: `unresolvable schema reference ${schema.$ref}` };
    const viaRef = validateJsonSchema(value, target, { path, root, depth: depth + 1, budget: scope });
    if (!viaRef.ok) return viaRef;
  }

  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    // OpenAPI's `nullable` is an annotation on a typed schema; honour it so a
    // schema written for a different toolchain is not rejected for a reason the
    // caller never wrote down.
    const allowNull = schema.nullable === true && value === null;
    if (!allowNull && !wanted.some((t) => matchesType(value, t))) {
      return {
        ok: false,
        path,
        message: `expected ${wanted.join(' | ')}, got ${typeOf(value)}`,
      };
    }
  }

  if (Array.isArray(schema.enum)) {
    // The charge comes first so an enormous enum is refused before it is
    // walked, and the value is serialised ONCE — the old code re-serialised it
    // per candidate, which is O(candidates × |value|) work the candidate count
    // alone did not bound.
    if (!chargeSteps(scope, schema.enum.length)) {
      return unableCapacity(path, `the schema exceeds ${MAX_SCHEMA_STEPS} evaluation steps`);
    }
    const target = JSON.stringify(value);
    const hit = schema.enum.some((candidate) => JSON.stringify(candidate) === target);
    if (!hit) return { ok: false, path, message: `must be one of ${JSON.stringify(schema.enum)}` };
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    if (JSON.stringify(schema.const) !== JSON.stringify(value)) {
      return { ok: false, path, message: `must equal ${JSON.stringify(schema.const)}` };
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return { ok: false, path, message: `must be >= ${schema.minimum}` };
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return { ok: false, path, message: `must be <= ${schema.maximum}` };
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      return { ok: false, path, message: `must be > ${schema.exclusiveMinimum}` };
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      return { ok: false, path, message: `must be < ${schema.exclusiveMaximum}` };
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const ratio = value / schema.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        return { ok: false, path, message: `must be a multiple of ${schema.multipleOf}` };
      }
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return { ok: false, path, message: `must be at least ${schema.minLength} characters` };
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return { ok: false, path, message: `must be at most ${schema.maxLength} characters` };
    }
    if (typeof schema.pattern === 'string') {
      const verdict = evaluatePattern(schema.pattern, value, scope, path);
      if (verdict) return verdict;
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return { ok: false, path, message: `must have at least ${schema.minItems} items` };
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return { ok: false, path, message: `must have at most ${schema.maxItems} items` };
    }
    if (schema.uniqueItems === true) {
      if (!chargeSteps(scope, value.length)) {
        return unableCapacity(path, `the schema exceeds ${MAX_SCHEMA_STEPS} evaluation steps`);
      }
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) return { ok: false, path, message: 'items must be unique' };
    }
    const itemSchemas = Array.isArray(schema.items) ? schema.items : null;
    if (itemSchemas) {
      for (let i = 0; i < value.length; i++) {
        const sub = itemSchemas[i] ?? schema.additionalItems;
        if (sub === undefined) continue;
        const r = validateJsonSchema(value[i], sub, { path: `${path}[${i}]`, root, depth: depth + 1, budget: scope });
        if (!r.ok) return r;
      }
    } else if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const r = validateJsonSchema(value[i], schema.items, { path: `${path}[${i}]`, root, depth: depth + 1, budget: scope });
        if (!r.ok) return r;
      }
    }
  }

  if (isPlainObject(value)) {
    const props = isPlainObject(schema.properties) ? schema.properties : null;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          return { ok: false, path, message: `missing required property "${key}"` };
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const own = props && Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;
      const sub = own !== undefined ? own : schema.additionalProperties;
      const childPath = `${path}.${key}`;
      if (sub === false) return { ok: false, path: childPath, message: 'additional properties are not allowed' };
      if (sub !== undefined) {
        const r = validateJsonSchema(child, sub, { path: childPath, root, depth: depth + 1, budget: scope });
        if (!r.ok) return r;
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    let pending = null;
    for (const sub of schema.allOf) {
      const r = validateJsonSchema(value, sub, { path, root, depth: depth + 1, budget: scope });
      if (r.unable) { pending ??= r; continue; }
      if (!r.ok) return r;
    }
    // A genuine counterexample in a sibling is decisive even when another
    // branch could not be judged; only when nothing is provably wrong do we
    // report that the combination itself could not be judged.
    if (pending) return pending;
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const results = [];
    let satisfied = false;
    for (const sub of schema.anyOf) {
      const r = validateJsonSchema(value, sub, { path, root, depth: depth + 1, budget: scope });
      // A conforming branch is a witness: it proves the disjunction without
      // needing any other branch judged.
      if (r.ok) { satisfied = true; break; }
      results.push(r);
    }
    if (!satisfied) {
      // A branch we could not judge is not a branch that failed.
      const pending = results.find((r) => r.unable);
      if (pending) return pending;
      return { ok: false, path, message: `does not match any allowed shape (${results.map((r) => r.message).join('; ')})` };
    }
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    const results = [];
    let passed = 0;
    for (const sub of schema.oneOf) {
      const r = validateJsonSchema(value, sub, { path, root, depth: depth + 1, budget: scope });
      results.push(r);
      if (r.ok) passed++;
    }
    // Two matches already disprove `oneOf`, whatever an unjudged branch would
    // have said; otherwise an unjudged branch could still be a second match,
    // so the count is not trustworthy.
    if (passed >= 2) return { ok: false, path, message: `must match exactly one allowed shape, matched ${passed}` };
    const pending = results.find((r) => r.unable);
    if (pending) return pending;
    if (passed !== 1) return { ok: false, path, message: `must match exactly one allowed shape, matched ${passed}` };
  }
  if (schema.not !== undefined) {
    const r = validateJsonSchema(value, schema.not, { path, root, depth: depth + 1, budget: scope });
    // `not` is the one combinator that inverts a verdict, so an unjudged child
    // must never be inverted into a pass.
    if (r.unable) return r;
    if (r.ok) return { ok: false, path, message: 'must not match the forbidden shape' };
  }

  return { ok: true };
}
