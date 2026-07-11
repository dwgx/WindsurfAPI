// Docker self-update endpoint behavior.
//
// User report (2026-04-29): "为什么docker不支持更新 支持呗。。。" — i.e.,
// the dashboard's existing self-update path bails on docker
// deployments with a hint to run `docker compose pull && up -d`
// manually. v2.0.41 wires an opt-in path that uses /var/run/docker.sock
// + a one-shot deployer sidecar to recreate the container in-place.
//
// We can't actually exercise the docker daemon in unit tests (no
// socket on Windows / CI runners), so static-validate the module
// shape and the api.js wiring.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectDockerSelfUpdate, readSelfContainerId } from '../src/dashboard/docker-self-update.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOD = readFileSync(join(__dirname, '..', 'src/dashboard/docker-self-update.js'), 'utf8');
const API = readFileSync(join(__dirname, '..', 'src/dashboard/api.js'), 'utf8');

describe('docker self-update detection', () => {
  test('reports no-docker-sock when /var/run/docker.sock is absent', async () => {
    // On the test runner there's no docker.sock (Windows) — verify
    // the module returns the structured "not available" shape rather
    // than crashing.
    const r = await detectDockerSelfUpdate();
    assert.equal(r.available, false);
    // The reason should be one of the expected enum values; on a
    // Windows runner it will be no-docker-sock, on Linux without
    // docker the same. Don't pin the exact value because Linux CI
    // boxes might have a different shape.
    assert.match(r.reason, /no-docker-sock|no-self-id|docker-api-unreachable|no-compose-labels/);
  });

  test('readSelfContainerId returns a hex id or null', () => {
    const id = readSelfContainerId();
    if (id !== null) {
      assert.match(id, /^[0-9a-f]{12,64}$/,
        'container id format should be 12-64 hex chars (docker convention)');
    }
  });
});

describe('docker self-update module shape', () => {
  test('uses /var/run/docker.sock unix socket, not a TCP daemon URL', () => {
    assert.match(MOD, /'\/var\/run\/docker\.sock'/,
      'must hardcode /var/run/docker.sock as the daemon socket');
    assert.match(MOD, /socketPath:/,
      'must use http.request with socketPath option (no docker CLI dependency)');
  });

  test('spawns a deployer sidecar that runs docker compose up -d', () => {
    assert.match(MOD, /docker compose -p/,
      'sidecar command must use docker compose -p with the project name');
    assert.match(MOD, /up -d/,
      'sidecar must run `up -d` to recreate the container with the pulled image');
    assert.match(MOD, /AutoRemove: true/,
      'sidecar must auto-remove after exit so we do not leak deployer containers');
  });

  test('the sidecar sleeps before tearing us down', () => {
    // If the sidecar's compose-up runs immediately, the dashboard's
    // HTTP response gets killed before reaching the browser, leaving
    // a confusing "request failed" toast. The sleep buys time.
    assert.match(MOD, /DEPLOYER_DELAY_SECONDS/,
      'must define a delay constant');
    assert.match(MOD, /sleep \$\{DEPLOYER_DELAY_SECONDS\}/,
      'sidecar Cmd must sleep for DEPLOYER_DELAY_SECONDS before pulling/recreating');
  });

  test('audit #11: dockerPull scans the JSONL stream for errors, not just HTTP status', () => {
    // /images/create streams JSONL and returns HTTP 200 even when the pull
    // fails (unknown tag / registry error) — the failure is an {"error":...}
    // line in the body. Treating 200 as success left the deployer on the OLD
    // image. The end handler must inspect the streamed lines for error/errorDetail.
    const pull = MOD.slice(MOD.indexOf('function dockerPull'));
    assert.match(pull, /errorDetail/, 'dockerPull must check for errorDetail in the JSONL stream');
    assert.match(pull, /obj\.error/, 'dockerPull must check for an error field per streamed line');
    assert.match(pull, /split\('\\n'\)/, 'dockerPull must scan the stream line by line');
    // and an error line must lead to reject() (before the final resolve): the
    // error-field check and a reject() call appear, in that order, ahead of the
    // success resolve(buf).
    const errIdx = pull.search(/obj\.error \|\| obj\.errorDetail/);
    const rejIdx = pull.indexOf('reject(new Error(`docker pull ${image} failed');
    const resIdx = pull.indexOf('resolve(buf)');
    assert.ok(errIdx >= 0 && rejIdx > errIdx, 'error-field check must be followed by a reject()');
    assert.ok(resIdx > rejIdx, 'the success resolve(buf) must come after the error-reject path');
  });

  test('shell-quotes the project name and working dir', () => {
    // Both come from compose container labels which we don't fully
    // control — defensive single-quote-wrap so a malformed label
    // can't break out of the `sh -c "..."` payload.
    assert.match(MOD, /shellQuote\(/);
    assert.match(MOD, /function shellQuote/);
  });

  test('aborts when running container has no compose labels', () => {
    // Hand-managed `docker run` containers can't be safely recreated
    // by `docker compose up -d`; we'd lose env / mounts / network.
    // Bail with a clear reason instead.
    assert.match(MOD, /no-compose-labels/,
      'must report no-compose-labels reason when container was not started by compose');
  });
});

describe('docker self-update wired into /self-update', () => {
  test('/self-update/check falls back to docker when git is unavailable', () => {
    const m = API.match(/subpath === '\/self-update\/check'[\s\S]+?\n  \}/);
    assert.ok(m);
    const route = m[0];
    assert.match(route, /detectDockerSelfUpdate\(\)/,
      'must consult docker mode when git mode reports unavailable');
    assert.match(route, /mode: 'docker'/,
      'must label the response so the dashboard can switch UI flows');
  });

  test('/self-update POST falls back to docker when git is unavailable', () => {
    const m = API.match(/subpath === '\/self-update' && method === 'POST'[\s\S]+?\n  \}/);
    assert.ok(m);
    const route = m[0];
    assert.match(route, /runDockerSelfUpdate\(\)/,
      'POST /self-update must call runDockerSelfUpdate when docker mode is available');
  });
});

// User report (2026-05-01): one-click 「更新并重启」on a host that has
// never pulled `docker:24-cli` failed with the dashboard surfacing
//   ✗ Failed to execute 'querySelector' on 'Document': '[data-i18n=
//     "error.docker API POST /containers/create -> 404: {"message":
//     "No such image: docker:24-cli"} "]' is not a valid selector.
//
// Three compounding bugs:
//
//   1. runDockerSelfUpdate only pulled ctx.image (the windsurf-api
//      image) — never pulled DEPLOYER_IMAGE. Fresh hosts hit
//      `/containers/create -> 404 No such image: docker:24-cli`.
//
//   2. The dashboard's applyUpdate() picked `r.detail || r.reason`
//      when constructing the user message, so the long raw error
//      string ("docker API POST /containers/create -> 404: ...") won
//      over the short stable code ("deployer-create-failed"). The long
//      string then went into translateError -> I18n.t -> querySelector
//      and exploded.
//
//   3. I18n.t's zh-CN fallback path did `document.querySelector(
//      '[data-i18n="${key}"]')` with no escaping, so any key containing
//      `"` / `{` / `:` threw DOMException and broke the resolver.
describe('docker self-update: deployer image pulled (#user 2026-05-01)', () => {
  test('runDockerSelfUpdate pulls DEPLOYER_IMAGE before creating the container', () => {
    // Pin the call ordering — pull(ctx.image) must come first (the new
    // app), then pull(DEPLOYER_IMAGE) (the sidecar runtime), then the
    // POST /containers/create. A future refactor that drops the second
    // pull will resurrect the 404 No-such-image symptom.
    const m = MOD.match(/dockerPull\(ctx\.image\)[\s\S]{0,1500}?dockerPull\(DEPLOYER_IMAGE\)[\s\S]{0,1500}?\/containers\/create/);
    assert.ok(m,
      'must pull ctx.image, then pull DEPLOYER_IMAGE, then POST /containers/create — in that order');
  });

  test('deployer-pull-failed reason is reported when the sidecar pull fails', () => {
    assert.match(MOD, /reason: 'deployer-pull-failed'/,
      'a distinct reason code is needed so the frontend can localize it');
  });
});

describe('dashboard: applyUpdate prefers reason over detail (#user 2026-05-01)', () => {
  test('docker-mode error path uses r.reason (short code), not r.detail (free text)', () => {
    const html = readFileSync(join(__dirname, '..', 'src/dashboard/index.html'), 'utf8');
    // The two MUST be in this order: the localized message (from
    // r.reason) is the i18n payload; r.detail goes to the suffix only
    // for debugging visibility. Reversing them lets long unstable
    // strings flow into I18n.t and re-trigger the querySelector crash.
    const m = html.match(/translateError\(r\.reason,\s*'error\.updateFailed'\)[\s\S]{0,400}?r\.detail/);
    assert.ok(m,
      'docker-mode error handling must call translateError with r.reason FIRST and only append r.detail as plain suffix');
  });
});

describe('I18n.t: zh-CN DOM fallback hardened against arbitrary keys (#user 2026-05-01)', () => {
  test('querySelector lookup is guarded by a charset check + try/catch', () => {
    const html = readFileSync(join(__dirname, '..', 'src/dashboard/index.html'), 'utf8');
    // The fallback path must only run on keys that look like real
    // dotted i18n identifiers; CSS.escape AND a try/catch keep us safe
    // even if a future caller still passes garbage.
    assert.match(html, /\/\^\[A-Za-z0-9_\.\-\]\+\$\/\.test\(key\)/,
      'must charset-validate the key before constructing a CSS selector');
    assert.match(html, /CSS\.escape\(key\)/,
      'must CSS.escape the key when building the [data-i18n] selector');
    // The whole try/catch wraps the document.querySelector call.
    const m = html.match(/try\s*\{[\s\S]{0,500}?document\.querySelector\(`\[data-i18n="\$\{CSS\.escape\(key\)\}"\]`\)[\s\S]{0,200}?\}\s*catch/);
    assert.ok(m,
      'querySelector call must sit inside try/catch so a malformed key cannot throw out of the i18n resolver');
  });
});
