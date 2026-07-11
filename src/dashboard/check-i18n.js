#!/usr/bin/env node
/**
 * I18n Regression Protection Script
 *
 * This script checks for:
 * 1. Hardcoded Chinese text in dashboard HTML/JS
 * 2. Missing translation keys in locale files
 * 3. Keys present in one locale but not the other
 *
 * Usage: node check-i18n.js
 * Exit code: 0 if all checks pass, 1 if violations found
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let exitCode = 0;
let violations = 0;

function logError(msg) {
  console.log(`${RED}✗${RESET} ${msg}`);
  violations++;
  exitCode = 1;
}

function logWarn(msg) {
  console.log(`${YELLOW}⚠${RESET} ${msg}`);
}

function logOk(msg) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}

// Chinese character regex
const CHINESE_REGEX = /[\u4e00-\u9fff]/;

// Patterns that are allowed to contain Chinese (whitelisted)
const WHITELIST_PATTERNS = [
  /data-i18n(?:-[\w-]+)?=/,  // i18n attributes are ok
  /id="lang-indicator"/, // compact language toggle label
  /indicator\.textContent\s*=/, // compact language toggle label
  /\/\/.*/,      // comments
  /https?:\/\//,  // URLs
  /windsurf\.com/, // windsurf domain
  /firebase/,     // Firebase references
];

function isWhitelisted(line) {
  return WHITELIST_PATTERNS.some(p => p.test(line));
}

// ---- Check #8 helpers: hardcoded English literals in the App <script> region ----

// DOM sinks whose assigned string is rendered to the user.
const COPY_SINK = '(?:textContent|innerText|placeholder|title|value|label|alt|ariaLabel)';
const HTML_SINK = '(?:innerHTML|outerHTML)';
const QUOTE = "['\"`]";

// Technical tokens that read identically in any locale — never worth translating.
const UNIVERSAL_TERMS = new Set([
  'pid', 'rss', 'cpu', 'ram', 'gpu', 'sqlite', 'url', 'uri', 'api', 'id', 'ip',
  'http', 'https', 'json', 'html', 'css', 'dns', 'tls', 'ssl', 'ok', 'uuid',
  'cap', 'sse', 'acp', 'ls', 'rpc', 'jwt', 'ttl', 'md5', 'sha', 'utc', 'io',
]);

// Distinguish user-facing display copy from code (identifiers, CSS, URLs, enums,
// acronyms, config samples). Multi-word phrases are almost always copy; single
// tokens must clear a stack of code-shaped exclusions.
function looksLikeDisplayCopy(text) {
  const t = String(text).trim();
  if (!t) return false;
  if (t.includes('${') || t.includes('{{')) return false;         // interpolated
  if (!/[A-Za-z]{2,}/.test(t)) return false;                      // needs real letters
  if (/^[\d.,\s%+×x/:()[\]|·—–-]+$/.test(t)) return false;        // pure numbers/units/symbols
  if (/\n/.test(t)) return false;                                 // multiline = code/config sample
  if (/^[#/]/.test(t)) return false;                              // comment / path / hash
  if (/[A-Za-z0-9_]+=[^=]/.test(t) && !/\s\S+\s/.test(t)) return false; // KEY=value with no prose
  if (/[a-z-]+\s*:\s*[^;]+;/.test(t)) return false;               // inline css declaration
  // JS expression fragments that leak through the ${…} strip when a template has
  // nested braces (e.g. an inline IIFE): "0) + (tt.cache_read", "a && b", "x.y".
  // Real display copy never contains these operator/member-access shapes.
  if (/[)(]/.test(t) && /[+\-*/%]|&&|\|\||=>|\breturn\b/.test(t)) return false; // arithmetic/logic w/ parens
  if (/\|\||&&|=>|\?\.|\.\w+\s*\(/.test(t)) return false;          // logic ops / optional chain / method call
  // Member access `obj.prop` — but ONLY when it looks like code, not prose or a
  // decimal. Require the left side to START with a letter/underscore (excludes
  // "95.5") and the property to be a snake_case/camelCase identifier of 2+ chars
  // that isn't a natural sentence boundary. This still catches "tt.cache_read" /
  // "obj.method" while NOT skipping real copy like "v2.0", "95.5%", or "e.g.".
  if (/(?:^|[^A-Za-z0-9])[A-Za-z_]\w*\.[a-z_]\w+(?![A-Za-z0-9. ])/.test(t) && /_|[a-z][A-Z]/.test(t)) return false;
  const isMultiWord = /\S\s+\S/.test(t);
  if (!isMultiWord) {
    if (/^[a-z][\w-]*$/.test(t)) return false;                    // camel/kebab identifier
    if (/^[A-Z][A-Z0-9_]+$/.test(t)) return false;                // CONSTANT
    if (/^[\w-]+\.[\w.-]+$/.test(t)) return false;                // dotted key / filename
    if (/^https?:/.test(t) || /\.(js|css|html|json|svg|png)$/.test(t)) return false;
    if (/^\d*\s*(ms|px|em|rem|s|kb|mb|gb|%)$/i.test(t)) return false; // unit
    const bare = t.replace(/[^A-Za-z0-9]/g, '');
    if (bare.length < 4) return false;                            // short = abbreviation/acronym
    if (UNIVERSAL_TERMS.has(bare.toLowerCase())) return false;
  }
  return true;
}

// Scan the App <script>...</script> region for hardcoded English string literals
// that reach the user. Returns [{ kind, text, line }]. Deliberately conservative:
// tuned to 0 findings on the current index.html so any hit is a genuine regression.
// Not exported: this module runs checks + process.exit() at load, so it must not
// be imported. Check #8 is exercised via subprocess in test/check-i18n.test.js.
function scanScriptRegionForEnglish(htmlContent) {
  const bodyStart = htmlContent.indexOf('<body>');
  const scriptStart = htmlContent.indexOf('<script>', bodyStart >= 0 ? bodyStart : 0);
  if (scriptStart < 0) return [];
  const script = htmlContent.slice(scriptStart);
  const baseLine = htmlContent.slice(0, scriptStart).split('\n').length - 1;
  const lineAt = (idx) => baseLine + script.slice(0, idx).split('\n').length;

  const findings = [];
  const litRe = '(' + QUOTE + ')((?:\\\\.|(?!\\1)[^\\\\])*)\\1';
  let m;

  // Copy sinks: the whole RHS literal is user text.
  const copyRe = new RegExp('\\.' + COPY_SINK + '\\s*\\+?=\\s*' + litRe, 'g');
  while ((m = copyRe.exec(script)) !== null) {
    if (m[1] === '`' && m[2].includes('${')) continue;
    if (looksLikeDisplayCopy(m[2])) findings.push({ kind: 'copy', text: m[2].slice(0, 60), line: lineAt(m.index) });
  }

  // HTML sinks: extract text nodes between tags. Strip ${...} interpolations first
  // (their JS — arrow =>, comparisons — carries stray < > that fake tag/text
  // boundaries), then split metadata rows ("PID … · RSS …") on separators so an
  // acronym label list does not read as one blob while real prose still flags.
  const htmlRe = new RegExp('\\.' + HTML_SINK + '\\s*\\+?=\\s*' + litRe, 'g');
  while ((m = htmlRe.exec(script)) !== null) {
    const frag = m[2].replace(/\$\{[^}]*\}/g, ' ');
    const textRe = />([^<>]+)</g;
    let t;
    while ((t = textRe.exec(frag)) !== null) {
      for (const phrase of t[1].split(/\s*[·|]\s*/)) {
        if (looksLikeDisplayCopy(phrase)) findings.push({ kind: 'html', text: phrase.trim().slice(0, 60), line: lineAt(m.index) });
      }
    }
  }
  return findings;
}

function checkFileForChinese(filePath, content) {
  const lines = content.split('\n');
  let found = false;

  lines.forEach((line, idx) => {
    if (CHINESE_REGEX.test(line) && !isWhitelisted(line)) {
      logError(`${filePath}:${idx + 1}: ${line.trim().slice(0, 80)}`);
      found = true;
    }
  });

  return found;
}

function extractKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      keys.push(...extractKeys(v, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function compareLocales(enKeys, zhKeys) {
  const enSet = new Set(enKeys);
  const zhSet = new Set(zhKeys);

  const onlyInEn = enKeys.filter(k => !zhSet.has(k));
  const onlyInZh = zhKeys.filter(k => !enSet.has(k));

  return { onlyInEn, onlyInZh };
}

// Main checks
console.log('\n📋 I18n Regression Check\n');

// 1. Check HTML file for hardcoded Chinese
const htmlPath = path.join(__dirname, 'index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
console.log('Checking index.html for hardcoded Chinese...');
const htmlHasChinese = checkFileForChinese('index.html', htmlContent);
if (!htmlHasChinese) {
  logOk('No hardcoded Chinese found in HTML');
}

// 2. Check API files for Chinese error messages
const apiPath = path.join(__dirname, '../dashboard/api.js');
if (fs.existsSync(apiPath)) {
  const apiContent = fs.readFileSync(apiPath, 'utf-8');
  console.log('\nChecking api.js for Chinese error messages...');

  // Look for Chinese in error messages (not in comments)
  const lines = apiContent.split('\n');
  let foundApiChinese = false;
  lines.forEach((line, idx) => {
    // Skip comments
    if (/^\s*\/\//.test(line)) return;
    // Check for Chinese in error: or throw new Error(
    if (/error.*:.*'[^']*[一-鿿]/.test(line) || /throw new Error\('[^']*[一-鿿]/.test(line)) {
      if (!isWhitelisted(line)) {
        logError(`api.js:${idx + 1}: ${line.trim().slice(0, 80)}`);
        foundApiChinese = true;
      }
    }
  });

  if (!foundApiChinese) {
    logOk('No Chinese error messages found in API');
  }
}

// 3. Compare locale files
console.log('\nComparing locale files...');
const enPath = path.join(__dirname, 'i18n/en.json');
const zhPath = path.join(__dirname, 'i18n/zh-CN.json');

const enJson = JSON.parse(fs.readFileSync(enPath, 'utf-8'));
const zhJson = JSON.parse(fs.readFileSync(zhPath, 'utf-8'));

const enKeys = extractKeys(enJson).sort();
const zhKeys = extractKeys(zhJson).sort();

const { onlyInEn, onlyInZh } = compareLocales(enKeys, zhKeys);

if (onlyInEn.length > 0) {
  logError(`Keys in en.json but missing in zh-CN.json (${onlyInEn.length}):`);
  onlyInEn.forEach(k => console.log(`  - ${k}`));
}

if (onlyInZh.length > 0) {
  logError(`Keys in zh-CN.json but missing in en.json (${onlyInZh.length}):`);
  onlyInZh.forEach(k => console.log(`  - ${k}`));
}

if (onlyInEn.length === 0 && onlyInZh.length === 0) {
  logOk('Locale files are synchronized');
}

// 4. Check for data-i18n usage consistency
console.log('\nChecking data-i18n attribute usage...');
const i18nRegex = /data-i18n="([^"]+)"/g;
const usedKeys = [];
let match;
while ((match = i18nRegex.exec(htmlContent)) !== null) {
  usedKeys.push(match[1]);
}

// Check if all used keys exist in locales
const missingInLocales = [];
for (const key of usedKeys) {
  if (key.includes('${')) continue;
  // Navigate nested key path
  const parts = key.split('.');
  let enVal = enJson;
  let zhVal = zhJson;
  let exists = true;

  for (const part of parts) {
    enVal = enVal?.[part];
    zhVal = zhVal?.[part];
    if (enVal === undefined || zhVal === undefined) {
      exists = false;
      break;
    }
  }

  if (!exists) {
    missingInLocales.push(key);
  }
}

if (missingInLocales.length > 0) {
  logError(`data-i18n keys missing in locales (${missingInLocales.length}):`);
  missingInLocales.forEach(k => console.log(`  - ${k}`));
} else {
  logOk('All data-i18n keys exist in locales');
}

// 5. Check for I18n.t() calls in JavaScript code
console.log('\nChecking I18n.t() calls in JavaScript code...');
const i18nCallRegex = /I18n\.t\(['"`]([^'"`]+)['"`]/g;
const jsKeys = [];
while ((match = i18nCallRegex.exec(htmlContent)) !== null) {
  jsKeys.push(match[1]);
}

// Also check for I18n.t() with variables (e.g., I18n.t(key))
const i18nVarRegex = /I18n\.t\(\s*([^)]+)\s*\)/g;
while ((match = i18nVarRegex.exec(htmlContent)) !== null) {
  const keyExpr = match[1].trim();
  // Skip quoted strings (already captured), template literals, and bare identifiers
  // (variables like `key`, `errKey`, `errCode` — runtime-resolved, not literal keys)
  if (/^[`'"']/.test(keyExpr)) continue;
  if (/^\${/.test(keyExpr)) continue;
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(keyExpr)) continue;
  jsKeys.push(keyExpr);
}

// Deduplicate
const uniqueJsKeys = [...new Set(jsKeys)];

// Check if all I18n.t() keys exist in locales
const missingJsKeys = [];
for (const key of uniqueJsKeys) {
  // Skip template expressions and variables
  if (key.includes('${') || key === 'key' || key.includes('?') || key.includes('vars') || key.endsWith('.') || key.includes('+')) continue;

  // Navigate nested key path
  const parts = key.split('.');
  let enVal = enJson;
  let zhVal = zhJson;
  let exists = true;

  for (const part of parts) {
    enVal = enVal?.[part];
    zhVal = zhVal?.[part];
    if (enVal === undefined || zhVal === undefined) {
      exists = false;
      break;
    }
  }

  if (!exists) {
    missingJsKeys.push(key);
  }
}

if (missingJsKeys.length > 0) {
  logError(`I18n.t() keys missing in locales (${missingJsKeys.length}):`);
  missingJsKeys.forEach(k => console.log(`  - ${k}`));
} else {
  logOk('All I18n.t() keys exist in locales');
}

// 6. Chinese in localizable attributes without a data-i18n-* counterpart.
// The whole-line whitelist above (any `data-i18n`) used to hide a hardcoded
// Chinese title/placeholder on an element that only had data-i18n for its text
// — so English users saw Chinese tooltips. Check each attribute individually.
console.log('\nChecking title / placeholder / aria-label attributes for un-i18n Chinese...');
const ATTR_PAIRS = [
  ['title', 'data-i18n-title'],
  ['placeholder', 'data-i18n-placeholder'],
  ['aria-label', 'data-i18n-aria-label'],
];
const openTagRe = /<[a-zA-Z][^>]*>/g;
let attrChineseViolations = 0;
let tagMatch;
while ((tagMatch = openTagRe.exec(htmlContent)) !== null) {
  const tag = tagMatch[0];
  if (tag.includes('${')) continue; // dynamic value — resolved at runtime
  for (const [attr, i18nAttr] of ATTR_PAIRS) {
    const am = new RegExp(`\\b${attr}="([^"]*)"`).exec(tag);
    if (am && CHINESE_REGEX.test(am[1]) && !tag.includes(i18nAttr + '=')) {
      const ln = htmlContent.slice(0, tagMatch.index).split('\n').length;
      logError(`index.html:${ln}: <${attr}> has un-i18n Chinese (add ${i18nAttr}): ${am[1].slice(0, 50)}`);
      attrChineseViolations++;
    }
  }
}
if (attrChineseViolations === 0) {
  logOk('No un-i18n Chinese in title / placeholder / aria-label attributes');
}

// 7. Hardcoded English text nodes in the static HTML body (Prev/Next class).
// The Chinese check can't catch these; without them a plain >Next</button> ships
// untranslated. Scope to the static body (before the App <script>), skip dynamic
// (${}) and non-copy tags, and allow a few brand/legal tokens.
console.log('\nChecking static HTML body for hardcoded (non-i18n) English text...');
const bodyStart = htmlContent.indexOf('<body>');
const appScriptStart = htmlContent.indexOf('<script>', bodyStart);
const bodyStartLine = htmlContent.slice(0, bodyStart).split('\n').length - 1;
const bodyHtml = bodyStart >= 0 && appScriptStart >= 0 ? htmlContent.slice(bodyStart, appScriptStart) : '';
const TEXT_ALLOW = /^(WindsurfAPI|bydwgx1337|©\s*Windsurf|windsurf\.com|v\d)/;
const SKIP_TAGS = /^(svg|path|option|br|hr|script|style|code|pre)/i;
const tokenRe = /<([a-zA-Z/!][^>]*)>|([^<]+)/g;
let lastOpenTag = '';
let tok;
let hardcodedEnglishViolations = 0;
while ((tok = tokenRe.exec(bodyHtml)) !== null) {
  if (tok[1] !== undefined) {
    if (!/^\//.test(tok[1])) lastOpenTag = tok[1];
    continue;
  }
  const text = tok[2].trim();
  if (!text || text.includes('${') || text.includes('{{') || CHINESE_REGEX.test(text)) continue;
  if (!/[A-Za-z]{2,}/.test(text)) continue;                    // needs real words
  if (/^[\d.,\s%+×x/:()[\]|·—–-]+$/.test(text)) continue;      // pure numbers/units/symbols
  if (TEXT_ALLOW.test(text)) continue;                         // brand / legal / version
  const tagName = lastOpenTag.split(/[\s>]/)[0].toLowerCase();
  if (SKIP_TAGS.test(tagName)) continue;
  if (/data-i18n(?:-[\w-]+)?=/.test(lastOpenTag)) continue;    // element carries an i18n default
  const ln = bodyStartLine + bodyHtml.slice(0, tok.index).split('\n').length;
  logError(`index.html:${ln}: hardcoded English text (add data-i18n): "${text.slice(0, 50)}"`);
  hardcodedEnglishViolations++;
}
if (hardcodedEnglishViolations === 0) {
  logOk('No hardcoded English text nodes in static HTML body');
}

// 8. Hardcoded English string literals in the App <script> region.
// Checks #6/#7 stop at the <script> tag, so the entire JS half — where most
// runtime copy is generated — was unguarded: `el.textContent = 'Save'` or an
// innerHTML template with English text nodes ships untranslated with a green
// gate (and `I18n.t('k') || 'English'` fallbacks are a fake safety net). This
// scan flags literals assigned to DOM copy sinks / text nodes inside innerHTML
// that bypass I18n.t(). It is calibrated to 0 findings on the current file;
// WARN-FIRST (never touches exitCode) so a future regression is visible without
// breaking the tree — promote to logError once the codebase stays clean.
console.log('\nChecking App <script> region for hardcoded (non-i18n) English string literals...');
const jsEnglishFindings = scanScriptRegionForEnglish(htmlContent);
if (jsEnglishFindings.length === 0) {
  logOk('No hardcoded English string literals in App <script> region');
} else {
  logWarn(`Hardcoded English string literal(s) in App <script> region (${jsEnglishFindings.length}) — wrap in I18n.t():`);
  jsEnglishFindings.forEach((f) => console.log(`  - index.html:${f.line}: [${f.kind}] "${f.text}"`));
}

// Summary
console.log(`\n${'='.repeat(50)}`);
if (violations === 0) {
  console.log(`${GREEN}✓ All i18n checks passed!${RESET}`);
} else {
  console.log(`${RED}✗ Found ${violations} violation(s)${RESET}`);
}
console.log(`${'='.repeat(50)}\n`);

process.exit(exitCode);
