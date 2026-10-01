'use strict';

// Run through cPanel cron with flock, using the application's Node environment.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const home = fs.realpathSync(os.homedir());
const repo = fs.realpathSync(process.argv[2]);
const appRoot = fs.realpathSync(process.argv[3]);
if (!repo.startsWith(home + '/repositories/') || !appRoot.startsWith(home + '/apps/') || repo === appRoot) {
  throw new Error('Use pastas privadas distintas em ~/repositories e ~/apps.');
}
const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
if (git(['remote', 'get-url', 'origin']) !== 'https://github.com/ThiagoSlva/ChatCrm.git') throw new Error('Origem inesperada.');
if (git(['status', '--porcelain'])) throw new Error('Repositorio com alteracoes locais; deploy interrompido.');
if (git(['branch', '--show-current']) !== 'main') throw new Error('O deploy exige a branch main.');
git(['fetch', '--no-tags', 'origin', 'main']);
const commit = git(['rev-parse', 'origin/main']);
const statePath = path.join(appRoot, '.deployed.json');
const previous = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
if (previous?.commit === commit) process.exit(0);
git(['merge', '--ff-only', 'origin/main']);
const releases = path.join(appRoot, 'releases');
fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
const release = fs.mkdtempSync(path.join(releases, 'release-'));
const archive = path.join(release, 'snapshot.tar');
git(['archive', '--format=tar', '--output=' + archive, commit]);
execFileSync('tar', ['-xf', archive, '-C', release], { timeout: 30000 });
fs.unlinkSync(archive);
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: release, stdio: 'inherit', timeout: 240000 });
execFileSync(process.execPath, ['scripts/run-tests.js'], { cwd: release, stdio: 'inherit', timeout: 60000 });
fs.writeFileSync(path.join(release, '.deploy-commit'), commit + '\n');
const current = path.join(appRoot, 'current');
if (fs.existsSync(current) && !fs.lstatSync(current).isSymbolicLink()) throw new Error('current precisa ser um link de release.');
const next = path.join(appRoot, '.current-next');
if (fs.existsSync(next)) throw new Error('Link temporario existente; verifique o deploy anterior.');
fs.symlinkSync(release, next, 'dir');
fs.renameSync(next, current);
fs.writeFileSync(statePath + '.next', JSON.stringify({ commit, release, previousRelease: previous?.release || null, deployedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
fs.renameSync(statePath + '.next', statePath);
fs.mkdirSync(path.join(appRoot, 'tmp'), { recursive: true });
fs.writeFileSync(path.join(appRoot, 'tmp', 'restart.txt'), new Date().toISOString());
process.stdout.write('Release ativada: ' + commit + '\n');
