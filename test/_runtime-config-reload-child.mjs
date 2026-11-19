// Fresh-process reader for test/runtime-credential-publish.test.js.
//
// Imports the real runtime-config module against the caller's DATA_DIR and
// writes the live pair plus the effective (runtime-or-env) values to argv[2].
// No network: test/setup-env.mjs + scripts/mutation-network-deny.mjs are
// preloaded by the parent.

import { writeFileSync } from 'node:fs';
import {
  getCredentials,
  getEffectiveApiKey,
  getEffectiveDashboardPasswordStored,
} from '../src/runtime-config.js';

writeFileSync(process.argv[2], JSON.stringify({
  credentials: getCredentials(),
  effectiveApiKey: getEffectiveApiKey(),
  effectivePassword: getEffectiveDashboardPasswordStored(),
}));
