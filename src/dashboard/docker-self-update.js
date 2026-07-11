/**
 * In-container docker self-update via /var/run/docker.sock.
 *
 * Strategy: instead of installing the docker CLI inside our image (extra
 * ~80MB) we talk to the docker daemon directly over the unix socket using
 * node's built-in http client. The actual recreate-self-with-new-image
 * step is handled by a one-shot deployer container we spawn — running
 * `docker compose up -d` on the project; it sees the freshly-pulled
 * image vs. our running container's image, stops us, and brings up a new
 * container with the same name + config + new image.
 *
 * Security: this requires the user to mount /var/run/docker.sock into
 * our container, which effectively grants host root (anyone with access
 * to docker.sock can spawn privileged containers). That's why this code
 * path is opt-in — if the socket isn't mounted we just report
 * { available: false, reason: 'no-docker-sock' } and the dashboard
 * falls back to the existing "run `docker compose pull && up -d` on the
 * host" message.
 *
 * Compose label dependency: we need to know the compose project name and
 * working_dir on the host to spawn the deployer with the right binds.
 * Both come from the labels compose attaches to every container it
 * creates: `com.docker.compose.project` and
 * `com.docker.compose.project.working_dir`. If they're missing (e.g. user
 * ran `docker run` directly without compose) we abort with a clear error
 * — recreating a hand-managed container without losing its config is a
 * separate problem we don't want to solve here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

const DOCKER_SOCK = '/var/run/docker.sock';
const DEPLOYER_IMAGE = 'docker:24-cli';
// Wait long enough for the dashboard's HTTP response to flush back to the
// browser before the deployer tears us down. 8s is enough for the toast +
// auto-refresh JS to land; longer waits just confuse the UX.
const DEPLOYER_DELAY_SECONDS = 8;

// Defence-in-depth (audit #2): compose labels come from the container
// runtime and the file's own contract says not to trust them blindly.
// shellQuote() already makes them shell-safe; these validators reject
// malformed/hostile shapes so they can't reach the deployer command at all.
export function isSafeComposeProject(name) {
  return typeof name === 'string' && name.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}
export function isSafeComposeWorkingDir(dir) {
  return typeof dir === 'string' && dir.length <= 4096 && /^\/[^\0\r\n]*$/.test(dir);
}

/**
 * Resolve our own container ID. Try /etc/hostname first (default in
 * docker; first 12 chars of the container ID), then /proc/self/cgroup
 * (full ID; format varies by cgroup version).
 */
export function readSelfContainerId() {
  try {
    const hostname = readFileSync('/etc/hostname', 'utf8').trim();
    if (/^[0-9a-f]{12,64}$/.test(hostname)) return hostname;
  } catch {}
  try {
    const cg = readFileSync('/proc/self/cgroup', 'utf8');
    // Match docker container id in any cgroup line. Format examples:
    //   12:devices:/docker/<id>
    //   0::/system.slice/docker-<id>.scope     (cgroup v2 + systemd)
    //   0::/docker/<id>                         (cgroup v2 plain)
    const m = cg.match(/[0-9a-f]{64}/);
    if (m) return m[0];
  } catch {}
  return null;
}

function dockerRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = httpRequest(
      {
        socketPath: DOCKER_SOCK,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: parsed });
          } else {
            reject(new Error(`docker API ${method} ${path} -> ${res.statusCode}: ${buf.slice(0, 400)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('docker API timeout')));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * The /images/create endpoint streams a JSONL pull progress feed and
 * doesn't terminate until the pull completes. Wait for the response body
 * to drain before returning.
 */
function dockerPull(image) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: DOCKER_SOCK,
        method: 'POST',
        path: `/images/create?fromImage=${encodeURIComponent(image)}`,
        headers: { 'Content-Type': 'application/json' },
        timeout: 600000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks).toString('utf8');
          if (!(res.statusCode >= 200 && res.statusCode < 300)) {
            reject(new Error(`docker pull ${image} -> ${res.statusCode}: ${buf.slice(0, 400)}`));
            return;
          }
          // audit #11: /images/create streams JSONL and returns HTTP 200 EVEN
          // WHEN THE PULL FAILS (unknown tag, auth/registry error) — the failure
          // is an {"error":...} / {"errorDetail":...} line in the body, not the
          // status. Treating 200 as success left the deployer silently on the
          // OLD image. Scan the stream and reject if any line reports an error.
          for (const line of buf.split('\n')) {
            const s = line.trim();
            if (!s) continue;
            let obj;
            try { obj = JSON.parse(s); } catch { continue; }
            if (obj && (obj.error || obj.errorDetail)) {
              const msg = (obj.errorDetail && obj.errorDetail.message) || obj.error || 'unknown docker pull error';
              reject(new Error(`docker pull ${image} failed: ${String(msg).slice(0, 400)}`));
              return;
            }
          }
          resolve(buf);
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('docker pull timeout (10min)')));
    req.end();
  });
}

/**
 * Detect whether docker self-update is feasible.
 * Returns { available, reason, ...detail } so the dashboard can show
 * the right hint when it's not.
 */
export async function detectDockerSelfUpdate() {
  if (!existsSync(DOCKER_SOCK)) {
    return { available: false, reason: 'no-docker-sock', detail: `${DOCKER_SOCK} not mounted` };
  }
  const selfId = readSelfContainerId();
  if (!selfId) {
    return { available: false, reason: 'no-self-id', detail: 'cannot resolve own container id from /etc/hostname or /proc/self/cgroup' };
  }
  let inspect;
  try {
    inspect = await dockerRequest('GET', `/containers/${selfId}/json`);
  } catch (e) {
    return { available: false, reason: 'docker-api-unreachable', detail: e.message };
  }
  const labels = inspect.body?.Config?.Labels || {};
  const project = labels['com.docker.compose.project'];
  const workingDir = labels['com.docker.compose.project.working_dir'];
  const image = inspect.body?.Config?.Image;
  if (!project || !workingDir) {
    return {
      available: false,
      reason: 'no-compose-labels',
      detail: 'container has no com.docker.compose.* labels — was it started via `docker run` instead of `docker compose up`?',
      image, selfId,
    };
  }
  if (!isSafeComposeProject(project) || !isSafeComposeWorkingDir(workingDir)) {
    return {
      available: false,
      reason: 'unsafe-compose-labels',
      detail: 'compose project / working_dir label failed safety validation',
      image, selfId,
    };
  }
  return {
    available: true,
    selfId,
    image,
    project,
    workingDir,
  };
}

/**
 * Run the full self-update flow. Returns immediately after the deployer
 * sidecar is started; the actual recreate happens out-of-band ~8s later.
 */
export async function runDockerSelfUpdate() {
  const ctx = await detectDockerSelfUpdate();
  if (!ctx.available) return { ok: false, ...ctx };

  // Pull the new image. This blocks until the pull finishes — could be
  // 30s-2min for a fresh layer set, but the user is staring at the
  // dashboard and a fast progress signal beats a confusing async
  // "started, check back later" UX.
  try {
    await dockerPull(ctx.image);
  } catch (e) {
    return { ok: false, reason: 'pull-failed', detail: e.message };
  }

  // Also ensure the deployer sidecar image is local. First-time users on
  // a host that has never pulled `docker:24-cli` will otherwise hit
  //   POST /containers/create -> 404: No such image: docker:24-cli
  // (reported as the dashboard "一键更新并重启" failure path). Pull it
  // explicitly. It's tiny (~30 MB) and only runs the one-shot
  // `docker compose up -d`, so this is a one-time cost per host.
  try {
    await dockerPull(DEPLOYER_IMAGE);
  } catch (e) {
    return { ok: false, reason: 'deployer-pull-failed', detail: e.message };
  }

  // Spawn the deployer sidecar. We mount docker.sock and the host
  // project dir (so `docker compose -p ... --project-directory ...`
  // can find the compose file). AutoRemove cleans up the sidecar after
  // it exits regardless of success.
  //
  // The sleep at the start gives the dashboard's HTTP response time to
  // flush back to the browser before our container gets killed.
  let createRes;
  try {
    createRes = await dockerRequest('POST', `/containers/create`, {
      Image: DEPLOYER_IMAGE,
      Cmd: [
        'sh', '-c',
        `set -e; sleep ${DEPLOYER_DELAY_SECONDS}; ` +
        `docker compose -p ${shellQuote(ctx.project)} ` +
        `--project-directory ${shellQuote(ctx.workingDir)} up -d`,
      ],
      Labels: {
        'com.windsurf-api.role': 'self-update-deployer',
        'com.windsurf-api.parent': ctx.selfId,
      },
      HostConfig: {
        AutoRemove: true,
        Binds: [
          `${DOCKER_SOCK}:${DOCKER_SOCK}`,
          `${ctx.workingDir}:${ctx.workingDir}:ro`,
        ],
      },
    });
  } catch (e) {
    return { ok: false, reason: 'deployer-create-failed', detail: e.message };
  }

  const deployerId = createRes.body?.Id;
  if (!deployerId) {
    return { ok: false, reason: 'deployer-create-no-id', detail: JSON.stringify(createRes.body).slice(0, 400) };
  }

  try {
    await dockerRequest('POST', `/containers/${deployerId}/start`, null);
  } catch (e) {
    return { ok: false, reason: 'deployer-start-failed', detail: e.message };
  }

  return {
    ok: true,
    image: ctx.image,
    project: ctx.project,
    workingDir: ctx.workingDir,
    deployerId: deployerId.slice(0, 12),
    delaySeconds: DEPLOYER_DELAY_SECONDS,
    message: `Pulled ${ctx.image}; deployer sidecar will recreate the container in ~${DEPLOYER_DELAY_SECONDS}s.`,
  };
}

// Single-quote-wrap a value for safe injection into a `sh -c "..."`
// payload. Single quotes inside the value get terminated, escaped,
// re-opened: `'foo'` -> `'foo'\''bar'`. The compose project name and
// working_dir come from container labels which we don't fully control,
// so don't trust them blindly.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
