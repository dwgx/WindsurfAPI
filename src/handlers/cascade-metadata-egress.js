import { sanitizeText, PathSanitizeStream } from '../sanitize.js';
import { resolveModel, getModelInfo } from '../models.js';

// The real leak reported in #185 is small (one internal metadata record wrapped
// around the assistant answer), but the stream gate must never become an
// unbounded whole-response accumulator. 128 KiB is deliberately generous for
// the observed envelope while still putting a hard ceiling on delayed output.
export const CASCADE_METADATA_MAX_BUFFER_BYTES = 128 * 1024;

const CASCADE_METADATA_KEYS = ['name', 'provider', 'model', 'description'];

// Every cross-chunk identity pattern has an explicit finite separator bound.
// The stream retains enough context for the largest accepted attribution
// phrase, but still releases ordinary prose instead of accumulating a response.
const CASCADE_ATTRIBUTION_WHITESPACE_MAX_CHARS = 512;
const CASCADE_ATTRIBUTION_PUNCTUATION_PADDING_MAX_CHARS = 256;
const CASCADE_IDENTITY_STREAM_CONTEXT_CHARS = 640;
const CASCADE_IDENTITY_START = /\b(?:cascade|developed|created|built|codeium|windsurf|i|my|as|acting|the)\b/ig;
const CASCADE_FIXED_IDENTITY_PREFIXES = [
  'developed by codeium', 'developed by windsurf',
  'created by codeium', 'created by windsurf',
  'built by codeium', 'built by windsurf',
  'codeium cascade', "codeium's cascade", 'codeium’s cascade',
  'windsurf cascade', "windsurf's cascade", 'windsurf’s cascade',
  'i am cascade', "i'm cascade", 'my name is cascade',
  'cascade, an ai coding assistant',
  'as cascade', 'acting as cascade',
  'cascade workspace', "cascade's workspace", 'cascade’s workspace',
  'the cascade workspace', "the cascade's workspace", 'the cascade’s workspace',
  ...['a', 'an'].flatMap(article => [
    `cascade is ${article} assistant`,
    `cascade is ${article} ai assistant`,
    `cascade is ${article} coding assistant`,
    `cascade is ${article} ai coding assistant`,
  ]),
];
const CASCADE_COMBINED_ATTRIBUTION = new RegExp(
  String.raw`\bCascade(?:\s{1,${CASCADE_ATTRIBUTION_WHITESPACE_MAX_CHARS}}|\s{0,${CASCADE_ATTRIBUTION_PUNCTUATION_PADDING_MAX_CHARS}}(?:,|[-\u2014\u2013])\s{0,${CASCADE_ATTRIBUTION_PUNCTUATION_PADDING_MAX_CHARS}})made by (Codeium|Windsurf)\b`,
  'gi',
);

function isCombinedAttributionPrefix(fragment) {
  const lower = fragment.toLowerCase();
  if (!'cascade'.startsWith(lower) && !lower.startsWith('cascade')) return false;
  if (lower.length <= 'cascade'.length) return true;

  const rest = lower.slice('cascade'.length);
  const tails = ['made by codeium', 'made by windsurf'];
  const canFinishTail = suffix => tails.some(tail => tail.startsWith(suffix));

  // Plain-whitespace separator: Cascade + 1..512 whitespace + made by ...
  let i = 0;
  while (i < rest.length && /\s/u.test(rest[i])
      && i < CASCADE_ATTRIBUTION_WHITESPACE_MAX_CHARS) i++;
  if (i > 0 && i <= CASCADE_ATTRIBUTION_WHITESPACE_MAX_CHARS) {
    if (i === rest.length || canFinishTail(rest.slice(i))) return true;
  }

  // Punctuation separator: up to 256 whitespace, comma/dash, up to another
  // 256 whitespace, then the same made-by tail.
  i = 0;
  while (i < rest.length && /\s/u.test(rest[i])
      && i < CASCADE_ATTRIBUTION_PUNCTUATION_PADDING_MAX_CHARS) i++;
  if (i === rest.length && i <= CASCADE_ATTRIBUTION_PUNCTUATION_PADDING_MAX_CHARS) return true;
  if (i > CASCADE_ATTRIBUTION_PUNCTUATION_PADDING_MAX_CHARS
      || !/^(?:,|[-\u2014\u2013])$/u.test(rest[i] || '')) return false;
  i++;
  let padding = 0;
  while (i < rest.length && /\s/u.test(rest[i])
      && padding < CASCADE_ATTRIBUTION_PUNCTUATION_PADDING_MAX_CHARS) {
    i++;
    padding++;
  }
  if (i === rest.length) return true;
  if (padding > CASCADE_ATTRIBUTION_PUNCTUATION_PADDING_MAX_CHARS) return false;
  return canFinishTail(rest.slice(i));
}

function canContinueCascadeIdentity(fragment) {
  if (!fragment || fragment.length > CASCADE_IDENTITY_STREAM_CONTEXT_CHARS) return false;
  const lower = fragment.toLowerCase();
  return CASCADE_FIXED_IDENTITY_PREFIXES.some(prefix => prefix.startsWith(lower))
    || isCombinedAttributionPrefix(fragment);
}

function cascadeIdentityHoldStart(text) {
  const windowStart = Math.max(0, text.length - CASCADE_IDENTITY_STREAM_CONTEXT_CHARS);
  const candidates = [];

  // Complete identity start tokens whose remaining bytes can still grow into
  // an accepted phrase.
  CASCADE_IDENTITY_START.lastIndex = 0;
  const recent = text.slice(windowStart);
  let match;
  while ((match = CASCADE_IDENTITY_START.exec(recent)) !== null) {
    const start = windowStart + match.index;
    if (canContinueCascadeIdentity(text.slice(start))) candidates.push(start);
  }

  // Also retain a token split across provider chunks (`Wind`, `I am Cas`, …),
  // but only when the suffix is itself a grammar prefix at a word boundary.
  for (let start = windowStart; start < text.length; start++) {
    const previous = text[start - 1] || '';
    if (start > 0 && /[\p{L}\p{N}_]/u.test(previous)) continue;
    if (canContinueCascadeIdentity(text.slice(start))) candidates.push(start);
  }
  if (!candidates.length) return text.length;

  let hold = text.length;
  for (const candidate of candidates) {
    let start = candidate;
    // Close over overlapping grammar prefixes. For example, `Cascade` is a
    // possible combined-attribution start, but in `I am Cascade ...` the
    // earlier `I am ` must remain attached; otherwise the stream can emit the
    // prefix separately and strand the self-name/provider rewrite.
    let changed;
    do {
      changed = false;
      const earlierWindow = Math.max(windowStart, start - CASCADE_IDENTITY_STREAM_CONTEXT_CHARS);
      CASCADE_IDENTITY_START.lastIndex = 0;
      const earlierText = text.slice(earlierWindow, start);
      let earlier;
      while ((earlier = CASCADE_IDENTITY_START.exec(earlierText)) !== null) {
        const earlierStart = earlierWindow + earlier.index;
        if (canContinueCascadeIdentity(text.slice(earlierStart, start))) {
          start = earlierStart;
          changed = true;
          break;
        }
      }
    } while (changed);
    hold = Math.min(hold, start);
  }
  return hold;
}

const MODEL_PROVIDERS = {
  claude: 'Anthropic', gpt: 'OpenAI', gemini: 'Google', deepseek: 'DeepSeek',
  grok: 'xAI', qwen: 'Alibaba', kimi: 'Moonshot', glm: 'Zhipu', swe: 'Windsurf',
  o3: 'OpenAI', o4: 'OpenAI',
};

const PROVIDER_DISPLAY_NAMES = {
  alibaba: 'Alibaba',
  anthropic: 'Anthropic',
  astraflow: 'Astraflow',
  deepseek: 'DeepSeek',
  google: 'Google',
  minimax: 'MiniMax',
  moonshot: 'Moonshot',
  openai: 'OpenAI',
  orcarouter: 'OrcaRouter',
  windsurf: 'Windsurf',
  xai: 'xAI',
  zhipu: 'Zhipu',
};

function cascadeProviderDisplayName(modelName) {
  const resolvedModel = resolveModel(modelName);
  const providerKey = getModelInfo(resolvedModel)?.provider;
  if (providerKey) return PROVIDER_DISPLAY_NAMES[providerKey] || providerKey;

  // Live/dynamic catalog names can exist before the static model table learns
  // them. Preserve the old family-prefix fallback for those names, while
  // resolving normal caller aliases (sonnet-4.6, ws-sonnet, fable-5, …) above.
  const prefix = Object.keys(MODEL_PROVIDERS)
    .find(key => modelName.toLowerCase().startsWith(key));
  return prefix ? MODEL_PROVIDERS[prefix] : null;
}

function skipJsonWhitespace(text, start) {
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')) i++;
  return i;
}

function scanJsonString(text, start) {
  if (text[start] !== '"') return -1;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      if (i >= text.length) return -1;
      continue;
    }
    if (ch === '"') return i + 1;
    // JSON strings cannot contain literal C0 control bytes. JSON.parse below
    // also validates escapes, but rejecting them here keeps the scanner exact.
    if (ch.charCodeAt(0) <= 0x1f) return -1;
  }
  return -1;
}

function parseJsonStringToken(text, start) {
  const end = scanJsonString(text, start);
  if (end < 0) return null;
  try {
    return { end, value: JSON.parse(text.slice(start, end)) };
  } catch {
    return null;
  }
}

/**
 * Parse only the one internal record #185 proved on the wire.
 *
 * This is intentionally stricter than JSON.parse + Object.keys: duplicate
 * top-level keys are rejected instead of being silently collapsed, every value
 * must be a JSON string, the key set must be exactly the four observed fields,
 * and the self name must be the literal `Cascade`. Any extra, missing, nested,
 * differently-cased, or lookalike object is ordinary caller-visible JSON.
 */
export function parseCascadeMetadataEnvelope(text) {
  if (typeof text !== 'string' || !text) return null;
  let i = skipJsonWhitespace(text, 0);
  if (text[i] !== '{') return null;
  i = skipJsonWhitespace(text, i + 1);

  const entries = [];
  if (text[i] === '}') return null;
  while (i < text.length) {
    const keyToken = parseJsonStringToken(text, i);
    if (!keyToken) return null;
    i = skipJsonWhitespace(text, keyToken.end);
    if (text[i] !== ':') return null;
    i = skipJsonWhitespace(text, i + 1);

    const valueToken = parseJsonStringToken(text, i);
    if (!valueToken) return null;
    entries.push([keyToken.value, valueToken.value]);
    i = skipJsonWhitespace(text, valueToken.end);

    if (text[i] === ',') {
      i = skipJsonWhitespace(text, i + 1);
      continue;
    }
    if (text[i] !== '}') return null;
    i = skipJsonWhitespace(text, i + 1);
    if (i !== text.length) return null;
    break;
  }

  if (entries.length !== CASCADE_METADATA_KEYS.length) return null;
  const values = Object.create(null);
  for (const [key, value] of entries) {
    if (!CASCADE_METADATA_KEYS.includes(key) || Object.hasOwn(values, key)) return null;
    values[key] = value;
  }
  if (!CASCADE_METADATA_KEYS.every(key => Object.hasOwn(values, key))) return null;
  if (values.name !== 'Cascade') return null;
  if (['provider', 'model', 'description'].some(key => values[key].trim().length === 0)) return null;
  return {
    name: values.name,
    provider: values.provider,
    model: values.model,
    description: values.description,
  };
}

function looksLikeJsonPayload(text) {
  if (typeof text !== 'string') return false;
  const s = text.trim();
  if (!s) return false;
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try { JSON.parse(s); return true; } catch { return false; }
  }
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (!fenced) return false;
  const inner = fenced[1].trim();
  if (!((inner.startsWith('{') && inner.endsWith('}')) || (inner.startsWith('[') && inner.endsWith(']')))) {
    return false;
  }
  try { JSON.parse(inner); return true; } catch { return false; }
}

function isJsonWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function isHexDigit(ch) {
  const code = ch.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x46)
    || (code >= 0x61 && code <= 0x66);
}

// Incremental recognizer for the complete JSON container shapes that
// looksLikeJsonPayload() preserves. A prefix that remains valid JSON cannot be
// classified as structured until EOF: a later byte can still turn
// {"message":"I am Cascade"} into malformed prose with trailing text. Holding
// only these bounded candidates is the unavoidable price of keeping valid JSON
// byte semantics while neutralizing malformed identity text identically on
// stream and non-stream exits.
class JsonContainerPrefixParser {
  constructor(onScan) {
    this.onScan = typeof onScan === 'function' ? onScan : null;
    this.mode = 'before-root';
    this.stack = [];
    this.started = false;
    this.fenceTicks = 0;
    this.tokenType = '';
    this.stringRole = '';
    this.stringPhase = 'plain';
    this.unicodeDigitsRemaining = 0;
    this.literalExpected = '';
    this.literalIndex = 0;
    this.numberText = '';
    this.confirmedUtf8Bytes = 0;
    this.pendingHighSurrogate = false;
  }

  get bufferedUtf8Bytes() {
    return this.confirmedUtf8Bytes + (this.pendingHighSurrogate ? 3 : 0);
  }

  feed(text, maxBufferBytes = Number.POSITIVE_INFINITY) {
    let inspected = 0;
    let status = this.mode === 'after-root' ? 'complete' : 'possible';
    for (let i = 0; i < text.length; i++) {
      inspected++;
      this.#countUtf8CodeUnit(text.charCodeAt(i));
      if (this.bufferedUtf8Bytes > maxBufferBytes) {
        status = 'overflow';
        break;
      }
      status = this.#consume(text[i]);
      if (status === 'mismatch') break;
    }
    if (inspected && this.onScan) this.onScan(inspected);
    return status;
  }

  #countUtf8CodeUnit(code) {
    if (this.pendingHighSurrogate) {
      if (code >= 0xdc00 && code <= 0xdfff) {
        this.confirmedUtf8Bytes += 4;
        this.pendingHighSurrogate = false;
        return;
      }
      this.confirmedUtf8Bytes += 3;
      this.pendingHighSurrogate = false;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      this.pendingHighSurrogate = true;
    } else if (code <= 0x7f) {
      this.confirmedUtf8Bytes++;
    } else if (code <= 0x7ff) {
      this.confirmedUtf8Bytes += 2;
    } else {
      this.confirmedUtf8Bytes += 3;
    }
  }

  #top() {
    return this.stack[this.stack.length - 1] || null;
  }

  #beginString(role) {
    this.tokenType = 'string';
    this.stringRole = role;
    this.stringPhase = 'plain';
    this.unicodeDigitsRemaining = 0;
    return 'possible';
  }

  #completeValue() {
    const top = this.#top();
    if (!top || !['value', 'value-or-end', 'value-required'].includes(top.state)) {
      return 'mismatch';
    }
    top.state = 'comma-or-end';
    return 'possible';
  }

  #closeContainer(type) {
    const top = this.#top();
    if (!top || top.type !== type) return 'mismatch';
    this.stack.pop();
    if (this.stack.length === 0) {
      this.mode = 'after-root';
      return 'complete';
    }
    return this.#completeValue();
  }

  #startValue(ch) {
    if (ch === '{') {
      this.stack.push({ type: 'object', state: 'key-or-end' });
      return 'possible';
    }
    if (ch === '[') {
      this.stack.push({ type: 'array', state: 'value-or-end' });
      return 'possible';
    }
    if (ch === '"') return this.#beginString('value');
    if (ch === 't' || ch === 'f' || ch === 'n') {
      this.tokenType = 'literal';
      this.literalExpected = ch === 't' ? 'true' : (ch === 'f' ? 'false' : 'null');
      this.literalIndex = 1;
      return 'possible';
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      this.tokenType = 'number';
      this.numberText = ch;
      return 'possible';
    }
    return 'mismatch';
  }

  #consumeString(ch) {
    if (this.stringPhase === 'unicode') {
      if (!isHexDigit(ch)) return 'mismatch';
      this.unicodeDigitsRemaining--;
      if (this.unicodeDigitsRemaining === 0) this.stringPhase = 'plain';
      return 'possible';
    }
    if (this.stringPhase === 'escape') {
      if (ch === 'u') {
        this.stringPhase = 'unicode';
        this.unicodeDigitsRemaining = 4;
        return 'possible';
      }
      if ('"\\/bfnrt'.includes(ch)) {
        this.stringPhase = 'plain';
        return 'possible';
      }
      return 'mismatch';
    }
    if (ch === '\\') {
      this.stringPhase = 'escape';
      return 'possible';
    }
    if (ch === '"') {
      this.tokenType = '';
      if (this.stringRole === 'key') {
        const top = this.#top();
        if (!top || top.type !== 'object' || !['key-or-end', 'key-required'].includes(top.state)) {
          return 'mismatch';
        }
        top.state = 'colon';
        return 'possible';
      }
      return this.#completeValue();
    }
    if (ch.charCodeAt(0) <= 0x1f) return 'mismatch';
    return 'possible';
  }

  #consumeLiteral(ch) {
    if (ch !== this.literalExpected[this.literalIndex]) return 'mismatch';
    this.literalIndex++;
    if (this.literalIndex === this.literalExpected.length) {
      this.tokenType = '';
      return this.#completeValue();
    }
    return 'possible';
  }

  #consumeNumber(ch) {
    if ((ch >= '0' && ch <= '9') || ch === '-' || ch === '+' || ch === '.' || ch === 'e' || ch === 'E') {
      this.numberText += ch;
      return 'possible';
    }
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(this.numberText)) {
      return 'mismatch';
    }
    this.tokenType = '';
    const completed = this.#completeValue();
    if (completed === 'mismatch') return completed;
    return this.#consume(ch);
  }

  #consume(ch) {
    if (this.tokenType === 'string') return this.#consumeString(ch);
    if (this.tokenType === 'literal') return this.#consumeLiteral(ch);
    if (this.tokenType === 'number') return this.#consumeNumber(ch);

    if (this.mode === 'fence-open') {
      if (ch !== '`') return 'mismatch';
      this.fenceTicks++;
      if (this.fenceTicks === 3) this.mode = 'fence';
      return 'possible';
    }
    if (this.mode === 'fence') return 'possible';
    if (this.mode === 'after-root') return isJsonWhitespace(ch) ? 'complete' : 'mismatch';

    if (this.mode === 'before-root') {
      if (isJsonWhitespace(ch)) return 'possible';
      if (ch === '`') {
        this.started = true;
        this.mode = 'fence-open';
        this.fenceTicks = 1;
        return 'possible';
      }
      if (ch !== '{' && ch !== '[') return 'mismatch';
      this.started = true;
      this.mode = 'container';
      return this.#startValue(ch);
    }

    const top = this.#top();
    if (!top) return 'mismatch';
    if (top.type === 'object') {
      if (top.state === 'key-or-end') {
        if (isJsonWhitespace(ch)) return 'possible';
        if (ch === '}') return this.#closeContainer('object');
        if (ch === '"') return this.#beginString('key');
        return 'mismatch';
      }
      if (top.state === 'key-required') {
        if (isJsonWhitespace(ch)) return 'possible';
        return ch === '"' ? this.#beginString('key') : 'mismatch';
      }
      if (top.state === 'colon') {
        if (isJsonWhitespace(ch)) return 'possible';
        if (ch !== ':') return 'mismatch';
        top.state = 'value';
        return 'possible';
      }
      if (top.state === 'value') {
        if (isJsonWhitespace(ch)) return 'possible';
        return this.#startValue(ch);
      }
      if (top.state === 'comma-or-end') {
        if (isJsonWhitespace(ch)) return 'possible';
        if (ch === ',') {
          top.state = 'key-required';
          return 'possible';
        }
        return ch === '}' ? this.#closeContainer('object') : 'mismatch';
      }
      return 'mismatch';
    }

    if (top.state === 'value-or-end') {
      if (isJsonWhitespace(ch)) return 'possible';
      if (ch === ']') return this.#closeContainer('array');
      return this.#startValue(ch);
    }
    if (top.state === 'value-required') {
      if (isJsonWhitespace(ch)) return 'possible';
      return this.#startValue(ch);
    }
    if (top.state === 'comma-or-end') {
      if (isJsonWhitespace(ch)) return 'possible';
      if (ch === ',') {
        top.state = 'value-required';
        return 'possible';
      }
      return ch === ']' ? this.#closeContainer('array') : 'mismatch';
    }
    return 'mismatch';
  }
}

export function neutralizeCascadeIdentity(text, modelName, {
  preserveStructured = true,
} = {}) {
  if (!text || !modelName) return text;
  if (preserveStructured && looksLikeJsonPayload(text)) return text;
  const provider = cascadeProviderDisplayName(modelName);
  let output = text;

  // Rewrite combined attribution before the shorter first-person pattern can
  // consume only "I am Cascade" and strand "made by Windsurf" behind it.
  // Even an unknown/private model still loses the Cascade self-name; only the
  // provider attribution remains unchanged when it cannot be inferred safely.
  output = output.replace(
    CASCADE_COMBINED_ATTRIBUTION,
    (_match, originalProvider) => `${modelName}, made by ${provider || originalProvider}`,
  );

  if (provider) {
    output = output
      .replace(/\bdeveloped by (?:Codeium|Windsurf)\b/gi, () => `developed by ${provider}`)
      .replace(/\bcreated by (?:Codeium|Windsurf)\b/gi, () => `created by ${provider}`)
      .replace(/\bbuilt by (?:Codeium|Windsurf)\b/gi, () => `built by ${provider}`);
  }

  return output
    .replace(/\b(?:Codeium|Windsurf)(?:['’]s)? Cascade\b/gi, () => modelName)
    // First-person identity claims
    .replace(/\bI am Cascade\b/gi, () => `I am ${modelName}`)
    .replace(/\bI'm Cascade\b/gi, () => `I'm ${modelName}`)
    .replace(/\bmy name is Cascade\b/gi, () => `my name is ${modelName}`)
    // Third-person self-reference common in Cascade prose
    .replace(/\bCascade, an AI coding assistant\b/gi, () => `${modelName}, an AI assistant`)
    .replace(/\bCascade is an? (?:AI )?(?:coding )?assistant\b/gi, () => `${modelName} is an AI assistant`)
    .replace(/\b(?:As|Acting as) Cascade\b/gi, () => `As ${modelName}`)
    // Cascade-flavoured workspace narration. sanitizeText has already removed
    // any internal path before these narrative prefixes are rewritten.
    .replace(/\b(?:the )?Cascade(?:['’]s)? workspace\b/gi, 'the workspace');
}

class CascadeOrdinaryEgressStream {
  constructor(modelName) {
    this.modelName = modelName;
    this.preserveStructured = true;
    this.pathStream = new PathSanitizeStream();
    this.identityPending = '';
    this.closed = false;
  }

  #feedIdentity(clean) {
    if (clean) this.identityPending += clean;
    if (!this.identityPending) return '';

    // Retain only a suffix that is still a real prefix of one of the bounded
    // identity languages. Merely seeing a later token such as `Cascade` or
    // `Windsurf` is not enough: if punctuation has already disproved that token
    // as a fresh phrase start, the complete earlier phrase can be transformed
    // and released without splitting it at the stream boundary.
    const cut = cascadeIdentityHoldStart(this.identityPending);
    if (cut <= 0) return '';

    const ready = this.identityPending.slice(0, cut);
    this.identityPending = this.identityPending.slice(cut);
    return neutralizeCascadeIdentity(ready, this.modelName, {
      preserveStructured: this.preserveStructured,
    });
  }

  markMalformed() {
    this.preserveStructured = false;
  }

  feed(raw) {
    if (!raw) return '';
    if (this.closed) throw new Error('CascadeOrdinaryEgressStream.feed() after flush()');
    return this.#feedIdentity(this.pathStream.feed(String(raw)));
  }

  flush() {
    if (this.closed) return '';
    this.closed = true;
    const ready = this.#feedIdentity(this.pathStream.flush());
    const tail = neutralizeCascadeIdentity(this.identityPending, this.modelName, {
      preserveStructured: this.preserveStructured,
    });
    this.identityPending = '';
    return ready + tail;
  }
}

/**
 * One-shot Cascade text egress.
 *
 * Only the exact #185 envelope is unwrapped, and only when neither the request
 * nor the completed turn says the JSON is intentional. Every other structured
 * payload keeps its JSON structure/identity semantics, while the established
 * path-redaction boundary still applies to every text response.
 */
export function transformCascadeEgressText(text, modelName, {
  allowMetadataUnwrap = true,
  hasToolCalls = false,
} = {}) {
  if (typeof text !== 'string' || !text) return text;
  const envelope = parseCascadeMetadataEnvelope(text);
  if (envelope && allowMetadataUnwrap && !hasToolCalls) {
    return neutralizeCascadeIdentity(sanitizeText(envelope.description), modelName);
  }

  // A leading-object mismatch is the sabotage boundary for metadata unwrapping:
  // no best-effort key guessing or nested search. It is not a bypass for the
  // pre-existing path sanitizer (#108); structured payloads retain all other
  // bytes and neutralizeCascadeIdentity deliberately leaves valid JSON alone.
  return neutralizeCascadeIdentity(sanitizeText(text), modelName);
}

/**
 * Incremental egress gate for the Cascade text channel.
 *
 * Normal prose continues through ordinary path/identity egress immediately.
 * A syntactically possible JSON object, array, or fenced JSON payload is held
 * until EOF because a later byte can still turn it into malformed prose; the
 * exact #185 object is the only shape eligible for unwrapping. Any proven
 * mismatch or cap overflow is released in original order with no byte deletion.
 * The cap is injectable solely so sabotage tests can cross it with tiny fixtures.
 */
export class CascadeMetadataEgressStream {
  constructor({
    modelName,
    allowMetadataUnwrap = true,
    maxBufferBytes = CASCADE_METADATA_MAX_BUFFER_BYTES,
  } = {}) {
    this.modelName = modelName;
    this.allowMetadataUnwrap = !!allowMetadataUnwrap;
    this.maxBufferBytes = Number.isFinite(maxBufferBytes) && maxBufferBytes > 0
      ? Math.floor(maxBufferBytes)
      : CASCADE_METADATA_MAX_BUFFER_BYTES;
    this.state = 'probe';
    this.candidateChunks = [];
    // Diagnostic work counter: unlike wall-clock assertions, this lets the
    // regression suite prove that arbitrary one-code-unit feeds stay linear.
    this.candidateScanSteps = 0;
    this.payloadParser = new JsonContainerPrefixParser((count) => {
      this.candidateScanSteps += count;
    });
    this.ordinaryStream = new CascadeOrdinaryEgressStream(modelName);
    this.closed = false;
  }

  releaseCandidate({ malformed = false } = {}) {
    const pending = this.candidateChunks.join('');
    this.candidateChunks = [];
    // A candidate is released before EOF only when it is definitely malformed
    // or crosses the hard cap. Both cases use ordinary egress so identity and
    // path handling stay identical to the one-shot transform.
    this.state = 'passthrough-ordinary';
    if (malformed) this.ordinaryStream.markMalformed();
    return this.ordinaryStream.feed(pending);
  }

  feed(delta) {
    if (!delta) return '';
    if (this.closed) throw new Error('CascadeMetadataEgressStream.feed() after flush()');
    const chunk = String(delta);
    if (this.state === 'passthrough-ordinary') return this.ordinaryStream.feed(chunk);

    this.candidateChunks.push(chunk);
    const payloadStatus = this.payloadParser.feed(chunk, this.maxBufferBytes);
    if (payloadStatus === 'mismatch') return this.releaseCandidate({ malformed: true });
    if (payloadStatus === 'overflow') return this.releaseCandidate();
    if (this.payloadParser.started) this.state = 'candidate';
    return '';
  }

  flush({ hasToolCalls = false, incomplete = false } = {}) {
    if (this.closed) return '';
    this.closed = true;
    if (this.state === 'passthrough-ordinary') return this.ordinaryStream.flush();

    const pending = this.candidateChunks.join('');
    if (this.state === 'candidate') {
      // EOF is the only point where valid JSON/fenced JSON is authoritative.
      // transformCascadeEgressText preserves complete structured payloads,
      // unwraps only the exact metadata envelope, and neutralizes incomplete or
      // malformed candidates. `incomplete` is therefore naturally handled by
      // the same one-shot policy without a second divergent classification.
      this.candidateChunks = [];
      return transformCascadeEgressText(pending, this.modelName, {
        allowMetadataUnwrap: this.allowMetadataUnwrap,
        hasToolCalls,
      });
    }

    // Whitespace-only stream: it never became a JSON candidate, so preserve
    // the existing path-stream semantics and release its tail.
    this.candidateChunks = [];
    return this.ordinaryStream.feed(pending) + this.ordinaryStream.flush();
  }
}
