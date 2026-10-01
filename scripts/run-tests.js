'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'test')).filter(file => file.endsWith('.test.js')).sort().map(file => path.join(root, 'test', file));
if (!tests.length) throw new Error('Nenhum teste encontrado.');
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', env: { ...process.env, DB_HOST: '', DB_USER: '', DB_NAME: '', DB_PASSWORD: '' } });
process.exitCode = result.status ?? 1;
