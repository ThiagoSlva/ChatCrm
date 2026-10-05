'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyDirectory } = require('../scripts/release-package');

// Public source verification only: never load .env, connect to SQL or invoke Git.
function resolveReleaseIdentity(root, env, version) {
  if (env.APP_COMMIT !== undefined && env.APP_COMMIT !== '') {
    return typeof env.APP_COMMIT === 'string' && /^[a-f0-9]{40}$/.test(env.APP_COMMIT)
      ? { commit: env.APP_COMMIT, source: 'environment' }
      : { commit: null, source: 'unconfirmed' };
  }
  try {
    fs.lstatSync(path.join(root, '.release.json'));
  } catch (error) {
    return { commit: null, source: error.code === 'ENOENT' ? 'unavailable' : 'unconfirmed' };
  }
  try {
    const manifest = verifyDirectory(root);
    if (manifest.version !== version) return { commit: null, source: 'unconfirmed' };
    return { commit: manifest.commit, source: 'verified-package' };
  } catch {
    // A failed integrity check cannot be turned into a trusted revision label.
    return { commit: null, source: 'unconfirmed' };
  }
}

module.exports = { resolveReleaseIdentity };
