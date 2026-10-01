'use strict';

// Entry point only for the cPanel release deployment described in the docs.
const fs = require('node:fs');
const path = require('node:path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const releaseRoot = fs.realpathSync(path.join(__dirname, 'current'));
const releasesRoot = fs.realpathSync(path.join(__dirname, 'releases')) + path.sep;
if (!releaseRoot.startsWith(releasesRoot)) throw new Error('Release fora da pasta permitida.');
process.env.APP_COMMIT = fs.readFileSync(path.join(releaseRoot, '.deploy-commit'), 'utf8').trim();
require(path.join(releaseRoot, 'app.js'));
