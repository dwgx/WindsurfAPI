// #108 (nalayahfowlkest-ship-it / zhangzhang-bit): user with a real
// Windows project at E:\Desktop\新建文件夹 asks "analyze the project".
// v2.0.45 successfully extracts the cwd and lifts it into the
// tool_calling_section, but the model still describes a non-existent
// empty Node template named `workspace-devinxse` with src/index.js,
// README.md, package.json — files the user has never seen.
//
// Root cause two parts:
//
//   1. The proxy creates a placeholder dir at /home/user/projects/
//      workspace-${apiKeyHash} so the upstream LS has a workspace to
//      register (closes a fingerprint gap). Old scaffold seeded a
//      `package.json` (name: "my-project") + `src/index.js` ("Hello,
//      world!") + a "Getting Started" `README.md` — looks like a real
//      but trivial Node project to anything reading the file tree.
//
//   2. Cascade upstream snapshots that workspace into its system prompt
//      as `<workspace_information>` / `<workspace_layout>`. Models read
//      that snapshot as the user's real project and "analyze" it,
//      ignoring the env-facts block we inject into tool_calling_section
//      that says the real cwd is on Windows.
//
// Two-prong fix:
//
//   - tool-emulation.js: when an env block is emitted, append a neutral
//     precedence note pointing at workspace_information/workspace_layout
//     stubs as proxy infrastructure. Wording avoids the banned jailbreak
//     phrases (no "ignore", no "for this request only") so Opus' own
//     injection guard doesn't trip.
//
//   - client.js: rebrand the scaffold so every file is unmistakably a
//     placeholder. package.json name = "proxy-workspace-stub", README
//     leads with "# Proxy workspace placeholder", description says
//     "NOT the user project". Plus a one-shot upgrade migration that
//     rewrites legacy "my-project" scaffolds in place.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildToolPreambleForProto, buildSchemaCompactToolPreambleForProto, buildSkinnyToolPreambleForProto, buildCompactToolPreambleForProto } from '../src/handlers/tool-emulation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = readFileSync(join(__dirname, '..', 'src/client.js'), 'utf8');

const TOOLS = [{ type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object' } } }];
const ENV = '- Working directory: E:\\Desktop\\新建文件夹\n- Platform: win32';

describe('tool preamble: workspace_layout precedence note (#108)', () => {
  test('full-tier preamble includes the stub-override note when env is present', () => {
    const out = buildToolPreambleForProto(TOOLS, 'auto', ENV);
    assert.match(out, /workspace_information.*workspace_layout|workspace_layout.*workspace_information/i,
      'must mention both workspace_information and workspace_layout so the model can identify the upstream snapshot');
    assert.match(out, /placeholder directory created by the proxy/i,
      'must explicitly call the snapshot a proxy placeholder, not user content');
    assert.match(out, /authoritative working directory/i,
      'must label the env-facts cwd as authoritative so the model trusts it over the snapshot');
  });

  test('schema-compact tier also carries the stub-override note', () => {
    const out = buildSchemaCompactToolPreambleForProto(TOOLS, 'auto', ENV);
    assert.match(out, /placeholder directory created by the proxy/i);
  });

  test('skinny tier also carries the stub-override note', () => {
    const out = buildSkinnyToolPreambleForProto(TOOLS, 'auto', ENV);
    assert.match(out, /placeholder directory created by the proxy/i);
  });

  test('compact tier also carries the stub-override note', () => {
    const out = buildCompactToolPreambleForProto(TOOLS, 'auto', ENV);
    assert.match(out, /placeholder directory created by the proxy/i);
  });

  test('preamble omits the override note entirely when no env is provided', () => {
    // The old behaviour (#54) was: no env → no env block. The override
    // note is only meaningful next to a real cwd; emitting it without
    // the cwd it overrides would just confuse the model.
    const out = buildToolPreambleForProto(TOOLS, 'auto', '');
    assert.doesNotMatch(out, /workspace_information|workspace_layout/i,
      'no env → no override note (the note has no cwd to point at)');
  });

  test('override wording avoids jailbreak-flavored phrases banned by feedback_tool_preamble_rules.md', () => {
    // PR #51 found that Opus' injection guard rejects the entire request
    // when our preamble uses "ignore prior framing" / "for this request
    // only" / "[Tool-calling context]" wording. Our new override note
    // must stay in neutral declarative voice.
    const out = buildToolPreambleForProto(TOOLS, 'auto', ENV);
    assert.doesNotMatch(out, /\bignore\s+(?:any|previous|prior)/i,
      'must not say "ignore prior" — banned by injection-guard rules');
    assert.doesNotMatch(out, /for this request only/i,
      'must not say "for this request only" — banned by injection-guard rules');
    assert.doesNotMatch(out, /disregard\s+.*\b(?:system|prior)/i,
      'must not say "disregard the system" — banned by injection-guard rules');
    assert.doesNotMatch(out, /\[Tool-calling context/i,
      'must not use [Tool-calling context] section markers — banned');
  });
});

describe('workspace scaffold: stub-labeled content (#108)', () => {
  test('writeStubFiles produces a package.json named proxy-workspace-stub', () => {
    assert.match(CLIENT_JS, /name:\s*'proxy-workspace-stub'/,
      'scaffold package.json name must be "proxy-workspace-stub" so the model cannot mistake it for a real project');
  });

  test('scaffold description and README explicitly disown ownership of the user project', () => {
    assert.match(CLIENT_JS, /NOT the user project/,
      'scaffold description must say "NOT the user project" so the model reading workspace_layout has clear signal');
    assert.match(CLIENT_JS, /Proxy workspace placeholder/,
      'scaffold README must lead with "Proxy workspace placeholder" header');
    assert.match(CLIENT_JS, /lives on the calling client/,
      'scaffold README must point the reader at the calling client for the real workspace');
  });

  test('legacy-scaffold migration is wired up so existing accounts get rewritten on next call', () => {
    // Without migration, _seededWorkspaces is in-memory and existsSync()
    // short-circuits the rewrite. Existing accounts upgraded from
    // pre-#108 still carry the "my-project" stub and would never
    // self-heal until the dir is manually deleted.
    assert.match(CLIENT_JS, /isLegacyScaffold/,
      'must export an isLegacyScaffold detector');
    assert.match(CLIENT_JS, /pkg\?\.name !== 'proxy-workspace-stub'/,
      'detector must key on package.json name (the only field guaranteed across legacy variants)');
    assert.match(CLIENT_JS, /Workspace scaffold migrated to #108/,
      'must log a distinct migration message so operators can grep for it on upgrade');
  });

  test('old "my-project" / Hello-world / Getting Started strings are gone from current scaffold', () => {
    // Defensive: a future refactor that brings back the project-shaped
    // stub would silently regress #108.
    assert.doesNotMatch(CLIENT_JS, /name:\s*'my-project'/,
      'scaffold must not name itself "my-project" again');
    assert.doesNotMatch(CLIENT_JS, /Hello, world/,
      'scaffold must not seed src/index.js with "Hello, world!" again');
    assert.doesNotMatch(CLIENT_JS, /## Getting Started/,
      'scaffold README must not look like a real project getting-started page');
  });
});
