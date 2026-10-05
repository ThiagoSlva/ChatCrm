'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const release = require('../scripts/release-package');
const { resolveReleaseIdentity } = require('../src/release-identity');
const identity = { version: '0.12.4', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };

function installed(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatcrm-identity-test-'));
  t.after(() => {
    const root = fs.realpathSync(dir);
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^chatcrm-identity-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const entries = new Map(release.essential.map(name => [name, Buffer.from('synthetic public source\n')]));
  const dependencies = { fastify: '5.12.5', mysql2: '3.24.5' };
  entries.set('package.json', Buffer.from(JSON.stringify({ name: 'conversa-livre', version: identity.version, license: 'MIT', dependencies })));
  entries.set('package-lock.json', Buffer.from(JSON.stringify({ name: 'conversa-livre', version: identity.version, packages: { '': { version: identity.version, dependencies } } })));
  entries.set('.env.example', Buffer.from('SETUP_TOKEN=\nDB_NAME=\nDB_USER=\nDB_PASSWORD=\n'));
  const built = release.buildRelease(entries, identity);
  for (const [name, bytes] of release.readZip(built.bytes)) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  return dir;
}

test('identidade do ZIP é confirmada pelas fontes e versão; configuração e arquivos extras não são lidos', t => {
  const dir = installed(t);
  fs.writeFileSync(path.join(dir, '.env'), 'DB_PASSWORD=synthetic-private\u0000');
  fs.mkdirSync(path.join(dir, 'node_modules')); fs.writeFileSync(path.join(dir, 'node_modules/private'), 'private');
  assert.deepEqual(resolveReleaseIdentity(dir, {}, identity.version), { commit: identity.commit, source: 'verified-package' });
  assert.deepEqual(resolveReleaseIdentity(dir, {}, '0.12.5'), { commit: null, source: 'unconfirmed' });
  fs.writeFileSync(path.join(dir, 'app.js'), 'altered');
  assert.deepEqual(resolveReleaseIdentity(dir, {}, identity.version), { commit: null, source: 'unconfirmed' });
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /synthetic-private/);
});

test('manifesto ausente, ilegível, corrompido, grande ou link não é identidade confiável', t => {
  const dir = installed(t), metadata = path.join(dir, '.release.json'), original = fs.readFileSync(metadata);
  fs.unlinkSync(metadata);
  assert.deepEqual(resolveReleaseIdentity(dir, {}, identity.version), { commit: null, source: 'unavailable' });
  for (const bytes of [Buffer.from('{broken'), Buffer.alloc(release.MAX_BYTES + 1)]) {
    fs.writeFileSync(metadata, bytes);
    assert.deepEqual(resolveReleaseIdentity(dir, {}, identity.version), { commit: null, source: 'unconfirmed' });
  }
  fs.unlinkSync(metadata); fs.mkdirSync(metadata);
  assert.deepEqual(resolveReleaseIdentity(dir, {}, identity.version), { commit: null, source: 'unconfirmed' });
  fs.rmdirSync(metadata);
  fs.writeFileSync(metadata, original);
  // A directory junction exercises the same lstat rejection without requiring
  // Windows privileges for file symlinks.
  const linked = path.join(dir, 'linked-root'); fs.symlinkSync(dir, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(resolveReleaseIdentity(linked, {}, identity.version), { commit: null, source: 'unconfirmed' });
});

test('hash explícito do deploy conserva prioridade; valor inválido não esconde erro usando o manifesto', t => {
  const dir = installed(t), commit = 'c'.repeat(40);
  assert.deepEqual(resolveReleaseIdentity(dir, { APP_COMMIT: commit }, identity.version), { commit, source: 'environment' });
  for (const value of ['main', 'A'.repeat(40), ['c'.repeat(40)], null]) {
    assert.deepEqual(resolveReleaseIdentity(dir, { APP_COMMIT: value }, identity.version), { commit: null, source: 'unconfirmed' });
  }
  assert.deepEqual(resolveReleaseIdentity(dir, { APP_COMMIT: '' }, identity.version), { commit: identity.commit, source: 'verified-package' });
});

test('conferência funciona sem Git, configuração ou banco e não imprime segredos nem caminhos em erros', t => {
  const dir = installed(t), modulePath = path.resolve(__dirname, '../src/release-identity.js');
  const script = 'console.log(JSON.stringify(require(process.argv[1]).resolveReleaseIdentity(process.argv[2],{},process.argv[3])))';
  const run = () => spawnSync(process.execPath, ['-e', script, modulePath, dir, identity.version], {
    encoding: 'utf8', env: { PATH: '', DB_HOST: 'invalid.test', DB_PASSWORD: 'private-never-print' }
  });
  let result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).source, 'verified-package');
  fs.writeFileSync(path.join(dir, '.release.json'), '{"password":"private-never-print"}');
  result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).source, 'unconfirmed');
  assert.doesNotMatch(result.stdout + result.stderr, /private-never-print|invalid.test|chatcrm-identity-test-/);
});
