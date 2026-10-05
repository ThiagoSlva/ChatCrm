'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const release = require('../scripts/release-package');
const { parseArguments } = require('../scripts/package-release');
const identity = { version: '0.12.1', commit: '1'.repeat(40), tree: '2'.repeat(40) };
function entries() {
  const files = new Map(release.essential.map(name => [name, Buffer.from('conteúdo sintético\n')]));
  const dependencies = { fastify: '5.12.5', mysql2: '3.24.5' };
  files.set('package.json', Buffer.from(JSON.stringify({ name: 'conversa-livre', version: identity.version, license: 'MIT', dependencies })));
  files.set('package-lock.json', Buffer.from(JSON.stringify({ name: 'conversa-livre', version: identity.version, packages: { '': { version: identity.version, dependencies } } })));
  files.set('.env.example', Buffer.from('SETUP_TOKEN=\nDB_NAME=\nDB_USER=\nDB_PASSWORD=\n'));
  return files;
}
function ownedTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatcrm-release-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir), temporaryRoot = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), temporaryRoot); assert.match(path.basename(resolved), /^chatcrm-release-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }); return dir;
}
test('pacote reproduz os mesmos bytes apesar da ordem e contém identidade/manifesto por arquivo', () => {
  const files = entries(), first = release.buildRelease(files, identity), second = release.buildRelease(new Map([...files].reverse()), identity);
  assert.deepEqual(first.bytes, second.bytes); assert.deepEqual(release.verifyArchive(first.bytes), first.manifest);
  assert.equal(release.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(first.manifest.commit, identity.commit);
  assert.equal(first.manifest.files.find(f => f.path === 'README.md').sha256, release.sha256(files.get('README.md')));
});
test('lista permitida exclui dados privados, referências GPL, dependências e caminhos de extração perigosos', () => {
  for (const name of ['.env', '.env.production', '.git/config', '.first-access.json', 'storage/backup.json', 'node_modules/foo.js', 'referencias/Telegram/README.md', '../app.js', '/app.js', 'src/../../.env', 'public\\app.js', 'src/config.json', 'docs/skills/a/SKILL.md', ['src/server.js']]) {
    assert.equal(release.allowed(name), false, String(name));
    const files = entries(); files.set(name, Buffer.from('private')); assert.throws(() => release.buildRelease(files, identity), { code: 'invalid-source' });
  }
});
test('revisão precisa de arquivos essenciais, MIT e lockfile correspondente', () => {
  const missing = entries(); missing.delete('LICENSE'); assert.throws(() => release.buildRelease(missing, identity), { code: 'incomplete-release' });
  const badLock = entries(), lock = JSON.parse(badLock.get('package-lock.json')); lock.packages[''].dependencies.mysql2 = 'different'; badLock.set('package-lock.json', Buffer.from(JSON.stringify(lock)));
  assert.throws(() => release.buildRelease(badLock, identity), { code: 'incompatible-lockfile' });
  assert.throws(() => release.buildRelease(entries(), { ...identity, commit: 'main' }), { code: 'invalid-manifest' });
  const secret = entries(); secret.set('.env.example', Buffer.from('SETUP_TOKEN=\nDB_NAME=\nDB_USER=\nDB_PASSWORD=private\n'));
  assert.throws(() => release.buildRelease(secret, identity), { code: 'unsafe-environment-template' });
});
test('ZIP recusa mudança de dados, CRC, cabeçalhos, arquivo adicional, nome duplicado e travessia', () => {
  const good = release.buildRelease(entries(), identity).bytes;
  const changed = Buffer.from(good); const filenameLength = changed.readUInt16LE(26); changed[30 + filenameLength] ^= 1;
  assert.throws(() => release.verifyArchive(changed), { code: 'zip-integrity-mismatch' });
  for (const offset of [6, 8, 12, 14, 18, 22, 28, good.length - 2, good.length - 6]) {
    const corrupt = Buffer.from(good); corrupt[offset] ^= 1; assert.throws(() => release.verifyArchive(corrupt));
  }
  const files = release.readZip(good); files.set('../.env', Buffer.from('private'));
  assert.throws(() => release.verifyArchive(release.zip(files)), { code: 'unsafe-zip-path' });
  files.delete('../.env'); files.set('src/extra.js', Buffer.from('unexpected'));
  assert.throws(() => release.verifyArchive(release.zip(files)), { code: 'unexpected-package-files' });
  const duplicate = Buffer.from(good), central = duplicate.readUInt32LE(duplicate.length - 6), next = central + 46 + duplicate.readUInt16LE(central + 28);
  // An overlapping second local header cannot be accepted as another file.
  duplicate.writeUInt32LE(0, next + 42); assert.throws(() => release.verifyArchive(duplicate), { code: 'invalid-zip' });
});
test('SHA de arquivo e tipos estritos protegem manifesto mesmo quando CRC é recalculado', () => {
  const built = release.buildRelease(entries(), identity), files = release.readZip(built.bytes);
  files.set('README.md', Buffer.from('substituído'));
  assert.throws(() => release.verifyArchive(release.zip(files)), { code: 'file-integrity-mismatch' });
  const manifest = structuredClone(built.manifest); manifest.files[0].path = [manifest.files[0].path];
  assert.throws(() => release.validateManifest(manifest), { code: 'invalid-manifest' });
  assert.throws(() => release.validateManifest({ ...built.manifest, commit: [identity.commit] }), { code: 'invalid-manifest' });
});
test('artefatos têm limite de tamanho e não recebem bytes anexados nem ZIP comprimido arbitrário', () => {
  assert.throws(() => release.verifyArchive(Buffer.alloc(release.MAX_BYTES + 1)), { code: 'invalid-zip' });
  const built = release.buildRelease(entries(), identity);
  assert.throws(() => release.verifyArchive(Buffer.concat([built.bytes, Buffer.from('extra')])), { code: 'invalid-zip' });
  const manifest = structuredClone(built.manifest); manifest.files[0].bytes = release.MAX_BYTES;
  assert.throws(() => release.validateManifest(manifest), { code: 'incomplete-release' });
});
test('criação exclusiva nunca sobrescreve nem segue link no caminho do artefato', t => {
  const dir = ownedTemp(t), file = path.join(dir, 'release.zip'), built = release.buildRelease(entries(), identity);
  release.writeNew(file, built.bytes); assert.deepEqual(release.readBounded(file), built.bytes);
  assert.throws(() => release.writeNew(file, built.bytes), { code: 'EEXIST' }); assert.deepEqual(fs.readFileSync(file), built.bytes);
  assert.throws(() => release.writeNew(path.join(dir, 'bad.zip'), Buffer.from('invalid')), { code: 'invalid-zip' });
  assert.equal(fs.existsSync(path.join(dir, 'bad.zip')), false);
});
test('diretório extraído confere hashes offline e conserva .env/dependências fora da verificação', t => {
  const dir = ownedTemp(t), built = release.buildRelease(entries(), identity);
  for (const [name, data] of release.readZip(built.bytes)) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
  fs.writeFileSync(path.join(dir, '.env'), 'DB_PASSWORD=synthetic-private');
  assert.deepEqual(release.verifyDirectory(dir), built.manifest);
  fs.writeFileSync(path.join(dir, 'app.js'), 'changed');
  assert.throws(() => release.verifyDirectory(dir), { code: 'file-integrity-mismatch' });
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'DB_PASSWORD=synthetic-private');
});
test('verificação recusa arquivo ausente ou maior que o manifesto sem ler dados privados', t => {
  const dir = ownedTemp(t), built = release.buildRelease(entries(), identity);
  for (const [name, data] of release.readZip(built.bytes)) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
  fs.appendFileSync(path.join(dir, 'README.md'), 'oversized');
  assert.throws(() => release.verifyDirectory(dir), { code: 'invalid-file' });
});
test('diretório extraído recusa junction ou link mesmo apontando para dados com hashes iguais', t => {
  const dir = ownedTemp(t), built = release.buildRelease(entries(), identity);
  for (const [name, data] of release.readZip(built.bytes)) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
  fs.renameSync(path.join(dir, 'src'), path.join(dir, 'source-copy'));
  fs.symlinkSync(path.join(dir, 'source-copy'), path.join(dir, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => release.verifyDirectory(dir), { code: 'unsafe-installed-path' });
});
test('CLI ajuda/verificação não carrega .env nem exige Git ou conexão SQL', t => {
  const dir = ownedTemp(t), file = path.join(dir, 'release.zip'); release.writeNew(file, release.buildRelease(entries(), identity).bytes);
  fs.writeFileSync(path.join(dir, '.env'), 'invalid=\u0000\n');
  const cli = path.resolve(__dirname, '../scripts/package-release.js');
  for (const args of [['--help'], ['--verify', file]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: '', DB_HOST: 'invalid.test', DB_PASSWORD: 'never-print-this' } });
    assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout + result.stderr, /never-print-this/);
  }
  for (const args of [[], ['--output', 'relative.zip'], ['--verify', file, '--force'], ['--output', file, '--commit', '--help']]) assert.throws(() => parseArguments(args));
  const failed = spawnSync(process.execPath, [cli, '--verify', path.join(dir, 'absent.zip')], { encoding: 'utf8' });
  assert.equal(failed.status, 1); assert.doesNotMatch(failed.stderr, /absent.zip|ENOENT/);
});
