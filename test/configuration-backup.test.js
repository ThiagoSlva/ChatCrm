'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const backup = require('../scripts/configuration-backup');
const { parseArguments } = require('../scripts/backup-configuration');
const secret = 'SYNTHETIC-CONFIGURATION-DO-NOT-LOG';
const sign = s => { s.sha256 = crypto.createHash('sha256').update(JSON.stringify(s.payload)).digest('hex'); return s; };
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatcrm-configuration-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^chatcrm-configuration-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const source = path.join(root, 'source'); fs.mkdirSync(source, { mode: 0o700 });
  const env = Buffer.from('DB_PASSWORD="' + secret + '"\r\nAPP_URL=https://example.test\r\n# ação\r\n');
  fs.writeFileSync(path.join(source, '.env'), env, { mode: 0o600 });
  const bootstrap = Buffer.from('throw Error("bootstrap must not execute");\r\n');
  fs.writeFileSync(path.join(source, 'passenger.cjs'), bootstrap, { mode: 0o644 });
  return { root, source, env, bootstrap, file: path.join(root, 'config.json'), target: path.join(root, 'staged') };
}
function cli(args) {
  return spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/backup-configuration.js'), ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: '', DB_HOST: 'unreachable.example.test', DB_PASSWORD: secret, SETUP_TOKEN: secret }
  });
}

test('private configuration round trip preserves exact bytes, excludes unrelated files and never activates bootstrap', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, '.first-access.json'), secret);
  fs.writeFileSync(path.join(f.source, 'unrelated.js'), 'throw Error("unrelated");');
  const snapshot = backup.captureConfiguration(f.source);
  assert.deepEqual(snapshot.payload.files.map(f => f.name), ['.env', 'passenger.cjs']);
  const summary = backup.writeConfiguration(f.file, snapshot);
  assert.equal(summary.files, 2); assert.equal(summary.bytes, f.env.length + f.bootstrap.length);
  assert(!JSON.stringify(summary).includes(secret));
  backup.restoreConfiguration(f.target, backup.readConfiguration(f.file));
  assert.deepEqual(fs.readdirSync(f.target).sort(), ['.env', 'passenger.cjs']);
  assert.deepEqual(fs.readFileSync(path.join(f.target, '.env')), f.env);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'passenger.cjs')), f.bootstrap);
  assert.deepEqual(fs.readFileSync(path.join(f.source, '.env')), f.env);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.target).mode & 0o777, 0o700);
    for (const file of [f.file, path.join(f.target, '.env'), path.join(f.target, 'passenger.cjs')]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('occupied backup and destination refuse replay without changing original bytes or adding files', t => {
  const f = fixture(t), snapshot = backup.captureConfiguration(f.source);
  backup.writeConfiguration(f.file, snapshot); const original = fs.readFileSync(f.file);
  assert.throws(() => backup.writeConfiguration(f.file, snapshot), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(f.file), original);
  fs.mkdirSync(f.target, { mode: 0o700 }); fs.writeFileSync(path.join(f.target, 'preserve.txt'), secret);
  assert.throws(() => backup.restoreConfiguration(f.target, snapshot), { code: 'EEXIST' });
  assert.deepEqual(fs.readdirSync(f.target), ['preserve.txt']);
  assert.equal(fs.readFileSync(path.join(f.target, 'preserve.txt'), 'utf8'), secret);
});

test('malformed manifest, traversal, extra data, duplicate names, corrupt bytes and incompatible formats fail before staging', t => {
  const f = fixture(t), snapshot = backup.captureConfiguration(f.source);
  for (const mutate of [s => s.format = 'conversa-livre-database', s => s.version = 2,
    s => s.password = secret, s => s.payload.extra = secret, s => s.payload.createdAt = '2026-02-30T00:00:00.000Z',
    s => s.payload.toolVersion = 'private path', s => s.payload.files.reverse(), s => s.payload.files[0].name = '../.env',
    s => s.payload.files[1].name = '.env', s => s.payload.files[0].mode = 0o777,
    s => s.payload.files[0].base64 += '\n', s => s.payload.files[0].bytes++,
    s => s.payload.files[0].sha256 = 'a'.repeat(64), s => s.payload.files[0].bytes = backup.MAX_FILE_BYTES + 1,
    s => s.payload.files = [], s => s.payload.files[0].base64 = {}, s => s.payload.files.push(s.payload.files[0])]) {
    const changed = clone(snapshot); mutate(changed); sign(changed);
    assert.throws(() => backup.restoreConfiguration(f.target, changed), { code: 'configuration-backup-invalid' });
    assert.equal(fs.existsSync(f.target), false);
  }
  const corrupt = clone(snapshot); corrupt.sha256 = '0'.repeat(64);
  assert.throws(() => backup.validateConfiguration(corrupt), { code: 'configuration-backup-invalid' });
});

test('empty, missing, oversized and linked source files cannot become a valid configuration backup', t => {
  const f = fixture(t), envFile = path.join(f.source, '.env');
  fs.writeFileSync(envFile, ''); assert.throws(() => backup.captureConfiguration(f.source));
  fs.writeFileSync(envFile, Buffer.alloc(backup.MAX_FILE_BYTES + 1)); assert.throws(() => backup.captureConfiguration(f.source));
  fs.unlinkSync(envFile); assert.throws(() => backup.captureConfiguration(f.source));
  const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, f.env, { mode: 0o600 });
  fs.linkSync(outside, envFile); assert.throws(() => backup.captureConfiguration(f.source), { code: 'configuration-file-invalid' });
  fs.unlinkSync(envFile); fs.writeFileSync(envFile, f.env, { mode: 0o600 });
  fs.unlinkSync(path.join(f.source, 'passenger.cjs'));
  assert.equal(backup.captureConfiguration(f.source).payload.files.length, 1);
});

test('public paths, checkout destinations and redirected parent folders are refused', t => {
  const f = fixture(t), snapshot = backup.captureConfiguration(f.source);
  assert.throws(() => backup.captureConfiguration('relative'));
  assert.throws(() => backup.writeConfiguration(path.resolve(__dirname, '../storage/config.json'), snapshot));
  for (const name of ['public', 'public_html', 'www', 'htdocs', '.git', 'current', 'releases', 'node_modules']) {
    const dir = path.join(f.root, name); fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, '.env'), f.env, { mode: 0o600 });
    assert.throws(() => backup.captureConfiguration(dir), { code: 'configuration-path-invalid' });
    assert.throws(() => backup.writeConfiguration(path.join(dir, 'copy.json'), snapshot));
    assert.throws(() => backup.restoreConfiguration(path.join(dir, 'new'), snapshot));
    assert.equal(fs.existsSync(path.join(dir, 'new')), false);
  }
  const link = path.join(f.root, 'redirected'); fs.symlinkSync(f.source, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => backup.captureConfiguration(link), { code: 'configuration-path-invalid' });
  assert.throws(() => backup.writeConfiguration(path.join(link, 'copy.json'), snapshot));
  assert.throws(() => backup.restoreConfiguration(path.join(link, 'new'), snapshot));
  assert.equal(fs.existsSync(path.join(f.source, 'copy.json')), false);
});

test('Linux permissions and symlinks are checked before exporting or reading secrets', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), snapshot = backup.captureConfiguration(f.source), envFile = path.join(f.source, '.env');
  fs.chmodSync(envFile, 0o644); assert.throws(() => backup.captureConfiguration(f.source)); fs.chmodSync(envFile, 0o600);
  fs.chmodSync(f.source, 0o777); assert.throws(() => backup.captureConfiguration(f.source)); fs.chmodSync(f.source, 0o700);
  fs.chmodSync(f.root, 0o755); assert.throws(() => backup.writeConfiguration(f.file, snapshot)); fs.chmodSync(f.root, 0o700);
  backup.writeConfiguration(f.file, snapshot); fs.chmodSync(f.file, 0o644); assert.throws(() => backup.readConfiguration(f.file)); fs.chmodSync(f.file, 0o600);
  const link = path.join(f.root, 'link.json'); fs.symlinkSync(f.file, link); assert.throws(() => backup.readConfiguration(link));
  fs.unlinkSync(envFile); fs.symlinkSync(f.file, envFile); assert.throws(() => backup.captureConfiguration(f.source));
});

test('interrupted writes preserve a private partial folder and refuse replay', t => {
  const f = fixture(t), snapshot = backup.captureConfiguration(f.source), original = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = (...args) => { if (++calls === 2) throw Error(secret); return original(...args); };
  try { assert.throws(() => backup.restoreConfiguration(f.target, snapshot)); }
  finally { fs.writeFileSync = original; }
  assert.deepEqual(fs.readFileSync(path.join(f.target, '.env')), f.env);
  assert.throws(() => backup.restoreConfiguration(f.target, snapshot), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(path.join(f.source, '.env')), f.env);
});

test('configuration edits during capture are refused instead of reporting a consistent copy', t => {
  const f = fixture(t), original = fs.readSync;
  let changed = false;
  fs.readSync = (...args) => {
    const count = original(...args);
    if (!changed) { changed = true; fs.writeFileSync(path.join(f.source, '.env'), f.env.toString() + '# concurrent edit\n'); }
    return count;
  };
  try { assert.throws(() => backup.captureConfiguration(f.source), { code: 'configuration-changed' }); }
  finally { fs.readSync = original; }
  assert.equal(fs.existsSync(f.file), false);
});

test('CLI offline create/verify/stage neither loads configuration nor leaks private values on any outcome', t => {
  const f = fixture(t);
  for (const args of [[], ['--create', f.file], ['--restore-new', f.file], ['--verify', f.file, '--force'], ['--password', secret], ['--verify', '--json']]) assert.equal(parseArguments(args), null);
  for (const [args, code] of [[['--create', f.file, f.source], 'configuration-backup-created'], [['--verify', f.file], 'configuration-backup-verified'], [['--restore-new', f.file, f.target], 'configuration-staged']]) {
    const result = cli(args);
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).code, code);
    assert(!(result.stdout + result.stderr).includes(secret)); assert(!result.stdout.includes(f.source));
  }
  for (const args of [['--create', f.file, f.source], ['--restore-new', f.file, f.target]]) {
    const result = cli(args); assert.equal(result.status, 1); assert(!(result.stdout + result.stderr).includes(secret));
  }
  fs.writeFileSync(f.file, 'invalid JSON ' + secret); const invalid = cli(['--verify', f.file]);
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert(!invalid.stderr.includes(secret));
  assert.equal(cli(['--help']).status, 0);
});
