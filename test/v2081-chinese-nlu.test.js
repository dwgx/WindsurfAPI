// v2.0.81 — Chinese NLU recovery + bilingual anti-narrate dialect.
//
// #125 DuZunTianXia caught GLM-5.1 emitting Chinese narration:
//   "用户想查看项目目录下的文件。让我用 Bash 来列出当前工作目录下的文件。"
//   "The user wants to see what files are in the current project directory.
//    Let me list the files in the workspace."
// Pre-v2.0.81 the English-only Layer 3 verb regex didn't match
// "让我用 Bash" so Layer 3 never fired. This adds Chinese verbs to
// the verb list, Chinese param keywords to the arg-pattern list, and
// Chinese vocabulary to the actionable-detector. Dialect preambles
// also get bilingual anti-narrate rules so models that respect
// instructions are nudged away from "让我用..." in the first place.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractIntentFromNarrative } from '../src/handlers/intent-extractor.js';
import { buildToolPreambleForProto } from '../src/handlers/tool-emulation.js';

const fnTool = (name, props = { command: 'string' }, required = ['command']) => ({
  type: 'function',
  function: {
    name, description: `${name} description`,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])),
      required,
    },
  },
});

const SHELL = fnTool('shell_exec');
const BASH = fnTool('Bash');
const READ = fnTool('Read', { file_path: 'string' }, ['file_path']);

describe('Chinese verb recognition (Layer 3)', () => {
  it('catches "让我用 Bash 命令 \'ls\'" with concrete value', () => {
    const r = extractIntentFromNarrative(
      "让我用 Bash 命令 'ls' 列出文件",
      [BASH], { lastUserText: '看看本地有哪些文件' },
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'Bash');
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { command: 'ls' });
  });

  it('catches "调用 shell_exec 命令 \'echo HELLO\'"', () => {
    const r = extractIntentFromNarrative(
      "调用 shell_exec 命令 'echo HELLO'",
      [SHELL], { lastUserText: '运行 echo' },
    );
    assert.equal(r.length, 1);
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { command: 'echo HELLO' });
  });

  it('catches "使用 Read 工具 路径 \'/etc/hostname\'"', () => {
    const r = extractIntentFromNarrative(
      "使用 Read 工具 路径 '/etc/hostname' 来读取",
      [READ], { lastUserText: '读取一下 /etc/hostname' },
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'Read');
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { file_path: '/etc/hostname' });
  });

  it('catches "我会用 shell_exec 命令为 \'ls -la\'" (Chinese formal style)', () => {
    const r = extractIntentFromNarrative(
      "我会用 shell_exec 命令为 'ls -la'",
      [SHELL], { lastUserText: '列出文件' },
    );
    assert.equal(r.length, 1);
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { command: 'ls -la' });
  });
});

describe('Chinese actionable-prompt detection', () => {
  it('"看看本地有哪些文件" triggers actionable', () => {
    // Layer 3 only fires when user prompt is actionable. Without
    // Chinese vocabulary, GLM-5.1 traffic with Chinese user messages
    // would always skip Layer 3 even if narrate was clean.
    const r = extractIntentFromNarrative(
      "调用 shell_exec 命令 'ls'",
      [SHELL], { lastUserText: '看看本地有哪些文件' },
    );
    assert.equal(r.length, 1);
  });

  it('"运行一下 echo" triggers actionable', () => {
    const r = extractIntentFromNarrative(
      "调用 shell_exec 命令 'echo HI'",
      [SHELL], { lastUserText: '运行一下 echo HI' },
    );
    assert.equal(r.length, 1);
  });

  it('"分析这个项目" triggers actionable (project keyword)', () => {
    const r = extractIntentFromNarrative(
      "调用 shell_exec 命令 'cat README.md'",
      [SHELL], { lastUserText: '分析这个项目' },
    );
    assert.equal(r.length, 1);
  });

  it('"今天天气怎么样" does NOT trigger actionable (no shell verbs)', () => {
    const r = extractIntentFromNarrative(
      "调用 shell_exec 命令 'date'",
      [SHELL], { lastUserText: '今天天气怎么样' },
    );
    assert.equal(r.length, 0);
  });
});

describe('Chinese narrative still rejects placeholder values', () => {
  // Mirror H-2 behaviour for Chinese narration — GLM emitting "用命令"
  // (the literal Chinese for "with command") must not be promoted.
  it('rejects "调用 shell_exec 命令 \'命令\'"', () => {
    const r = extractIntentFromNarrative(
      "调用 shell_exec 命令 '命令'",
      [SHELL], { lastUserText: '运行 echo' },
    );
    assert.equal(r.length, 0);
  });

  it('rejects "用 shell_exec 来运行某个命令" (no concrete value)', () => {
    // GLM-5.1's actual pattern from #125 — narrate intent without
    // ever giving the literal command string. NLU has nothing to
    // capture, returns empty.
    const r = extractIntentFromNarrative(
      "让我用 Bash 来列出当前工作目录下的文件",
      [BASH], { lastUserText: '看看本地文件' },
    );
    assert.equal(r.length, 0);
  });
});

describe('English Layer 3 still works (regression guard)', () => {
  it('"I should call shell_exec function with the command \'echo HELLO\'"', () => {
    const r = extractIntentFromNarrative(
      "I should call the shell_exec function with the command 'echo HELLO'",
      [SHELL], { lastUserText: 'run echo' },
    );
    assert.equal(r.length, 1);
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { command: 'echo HELLO' });
  });
});

describe('Dialect preambles include Chinese anti-narrate rules', () => {
  const tools = [SHELL];

  it('glm47 dialect preamble mentions Chinese anti-narrate', () => {
    const p = buildToolPreambleForProto(tools, 'auto', 'glm-4.7', 'zhipu', null);
    assert.ok(/中文/.test(p), 'glm47 preamble should reference Chinese rules');
    assert.ok(/让我用/.test(p), 'glm47 should specifically forbid "让我用" narration');
  });

  it('openai_json_xml dialect mentions Chinese rules', () => {
    const p = buildToolPreambleForProto(tools, 'auto', 'gemini-2.5-flash', 'google', null);
    assert.ok(/中文|让我/.test(p), 'openai_json_xml preamble should include Chinese rules');
  });

  it('kimi_k2 dialect mentions Chinese rules', () => {
    const p = buildToolPreambleForProto(tools, 'auto', 'kimi-k2', 'moonshot', null);
    assert.ok(/中文|让我/.test(p), 'kimi_k2 preamble should include Chinese rules');
  });
});
