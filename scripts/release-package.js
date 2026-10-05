'use strict';

// Distribution reads immutable Git blobs, never the working directory or .env.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 500;
const PREFIX = 'conversa-livre/';
const FORMAT = 'conversa-livre-release';
const essential = ['.env.example', 'LICENSE', 'README.md', 'app.js', 'package.json', 'package-lock.json', 'src/server.js', 'scripts/run-tests.js', 'scripts/prepare-installation.js', 'scripts/package-release.js', 'scripts/release-package.js', 'test/server.test.js', 'docs/INSTALADOR-CPANEL.md', 'docs/PACOTE-INSTALACAO.md'];
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
function allowed(name) {
  return typeof name === 'string' && (['.env.example', 'LICENSE', 'README.md', 'AGENTS.md', 'app.js', 'passenger.cjs', 'package.json', 'package-lock.json'].includes(name)
    || /^(src|scripts)\/[a-z0-9-]+\.js$/.test(name)
    || /^public\/[a-z0-9-]+\.(js|html|css)$/.test(name)
    || /^test\/(helpers\/)?[a-z0-9.-]+\.js$/.test(name)
    || /^docs\/[A-Z0-9-]+\.md$/.test(name)
    || /^docs\/images\/installation-overview\.svg$/.test(name));
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) fail('invalid-manifest');
}
function validateManifest(m) {
  exactKeys(m, ['format', 'formatVersion', 'version', 'commit', 'tree', 'files']);
  if (m.format !== FORMAT || m.formatVersion !== 1 || typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)
      || typeof m.commit !== 'string' || !/^[a-f0-9]{40}$/.test(m.commit) || typeof m.tree !== 'string' || !/^[a-f0-9]{40}$/.test(m.tree)
      || !Array.isArray(m.files) || m.files.length > MAX_FILES) fail('invalid-manifest');
  let previous = '', total = 0;
  for (const file of m.files) {
    exactKeys(file, ['path', 'bytes', 'sha256']);
    if (!allowed(file.path) || file.path <= previous || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('invalid-manifest');
    previous = file.path; total += file.bytes;
  }
  if (total > MAX_BYTES || essential.some(name => !m.files.some(f => f.path === name))) fail('incomplete-release');
  return m;
}
function validatePackageFiles(entries, manifest) {
  const names = [...entries.keys()].sort();
  if (names.join('\n') !== manifest.files.map(f => f.path).join('\n')) fail('unexpected-package-files');
  for (const file of manifest.files) {
    const data = entries.get(file.path);
    if (!Buffer.isBuffer(data) || data.length !== file.bytes || sha256(data) !== file.sha256) fail('file-integrity-mismatch');
  }
  let pkg, lock;
  try { pkg = JSON.parse(entries.get('package.json')); lock = JSON.parse(entries.get('package-lock.json')); } catch { fail('invalid-package-metadata'); }
  if (pkg.name !== 'conversa-livre' || pkg.version !== manifest.version || pkg.license !== 'MIT'
      || lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version
      || JSON.stringify(pkg.dependencies) !== JSON.stringify(lock.packages?.['']?.dependencies)) fail('incompatible-lockfile');
  const template = entries.get('.env.example').toString('utf8');
  for (const key of ['SETUP_TOKEN', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
    const lines = template.split(/\r?\n/).filter(line => line.startsWith(key + '='));
    if (lines.length !== 1 || lines[0] !== key + '=') fail('unsafe-environment-template');
  }
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(PREFIX + name, 'utf8'), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12); // fixed DOS 1980-01-01, stored, UTF-8
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(0x81a40000, 38); // regular file, 0644
    directory.writeUInt32LE(offset, 42); central.push(directory, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, directory, end]); if (bytes.length > MAX_BYTES) fail('release-too-large'); return bytes;
}
function buildRelease(entries, identity) {
  if (!(entries instanceof Map) || entries.size > MAX_FILES) fail('invalid-source');
  const sorted = new Map([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const files = [...sorted].map(([name, data]) => {
    if (!allowed(name) || !Buffer.isBuffer(data)) fail('invalid-source');
    return { path: name, bytes: data.length, sha256: sha256(data) };
  });
  const manifest = validateManifest({ format: FORMAT, formatVersion: 1, ...identity, files });
  validatePackageFiles(sorted, manifest);
  sorted.set('.release.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return { bytes: zip(sorted), manifest };
}
function readZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_BYTES) fail('invalid-zip');
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
      || bytes.readUInt16LE(end + 20)) fail('invalid-zip');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count > MAX_FILES + 1 || bytes.readUInt16LE(end + 8) !== count || start + size !== end) fail('invalid-zip');
  const entries = new Map(); let cursor = start, expectedOffset = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('invalid-zip');
    const length = bytes.readUInt32LE(cursor + 20), filenameLength = bytes.readUInt16LE(cursor + 28), offset = bytes.readUInt32LE(cursor + 42);
    if (bytes.readUInt16LE(cursor + 4) !== 0x314 || bytes.readUInt16LE(cursor + 6) !== 20
        || bytes.readUInt16LE(cursor + 8) !== 0x800 || bytes.readUInt16LE(cursor + 10) !== 0
        || bytes.readUInt16LE(cursor + 12) !== 0 || bytes.readUInt16LE(cursor + 14) !== 33
        || bytes.readUInt32LE(cursor + 24) !== length || bytes.readUInt16LE(cursor + 30) || bytes.readUInt16LE(cursor + 32)
        || bytes.readUInt16LE(cursor + 34) || bytes.readUInt16LE(cursor + 36) || bytes.readUInt32LE(cursor + 38) !== 0x81a40000
        || cursor + 46 + filenameLength > end || offset !== expectedOffset || offset + 30 > start) fail('invalid-zip');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + filenameLength), name = nameBytes.toString('utf8');
    const relative = name.slice(PREFIX.length);
    if (!name.startsWith(PREFIX) || !Buffer.from(name).equals(nameBytes)
        || (!allowed(relative) && relative !== '.release.json') || entries.has(relative)) fail('unsafe-zip-path');
    const dataStart = offset + 30 + filenameLength, dataEnd = dataStart + length;
    if (dataEnd > start || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 4) !== 20
        || bytes.readUInt16LE(offset + 6) !== 0x800 || bytes.readUInt16LE(offset + 8) !== 0
        || bytes.readUInt16LE(offset + 10) !== 0 || bytes.readUInt16LE(offset + 12) !== 33
        || bytes.readUInt32LE(offset + 14) !== bytes.readUInt32LE(cursor + 16)
        || bytes.readUInt32LE(offset + 18) !== length || bytes.readUInt32LE(offset + 22) !== length
        || bytes.readUInt16LE(offset + 26) !== filenameLength || bytes.readUInt16LE(offset + 28)
        || !bytes.subarray(offset + 30, dataStart).equals(nameBytes)) fail('invalid-zip');
    const data = bytes.subarray(dataStart, dataEnd);
    if (crc32(data) !== bytes.readUInt32LE(cursor + 16)) fail('zip-integrity-mismatch');
    entries.set(relative, data); expectedOffset = dataEnd; cursor += 46 + filenameLength;
  }
  if (cursor !== end || expectedOffset !== start) fail('invalid-zip');
  return entries;
}
function manifestFrom(entries) {
  let parsed;
  try { parsed = JSON.parse(entries.get('.release.json')); } catch { fail('invalid-manifest'); }
  entries.delete('.release.json'); const manifest = validateManifest(parsed); validatePackageFiles(entries, manifest); return manifest;
}
function verifyArchive(bytes) { return manifestFrom(readZip(bytes)); }
function readRevision(root, revision = 'HEAD') {
  if (revision !== 'HEAD' && !/^[a-f0-9]{40}$/.test(revision)) fail('invalid-revision');
  const git = args => execFileSync('git', ['-C', root, ...args], { maxBuffer: MAX_BYTES, timeout: 15000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = git(['rev-parse', '--verify', revision + '^{commit}']).toString().trim();
  const tree = git(['rev-parse', '--verify', commit + '^{tree}']).toString().trim();
  const selected = git(['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(line); if (!match) fail('invalid-git-tree'); return match;
  }).filter(match => allowed(match[4]));
  if (selected.length > MAX_FILES) fail('release-too-large');
  const entries = new Map(); let total = 0;
  for (const [, mode, type, blob, name] of selected) {
    if (mode !== '100644' || type !== 'blob') fail('unsafe-source-mode');
    const data = git(['cat-file', 'blob', blob]); total += data.length; if (total > MAX_BYTES) fail('release-too-large'); entries.set(name, data);
  }
  let version; try { version = JSON.parse(entries.get('package.json')).version; } catch { fail('invalid-package-metadata'); }
  return buildRelease(entries, { commit, tree, version });
}
function readBounded(file, limit = MAX_BYTES) {
  if (!path.isAbsolute(file)) fail('absolute-path-required');
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('invalid-file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || (process.platform !== 'win32' && opened.dev !== stat.dev)) fail('file-changed');
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) { const read = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!read) break; length += read; }
    if (length > limit) fail('release-too-large'); return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function writeNew(file, bytes) {
  if (!path.isAbsolute(file) || !file.endsWith('.zip')) fail('absolute-zip-path-required');
  verifyArchive(bytes); // A broken package is never written as a completed artifact.
  const fd = fs.openSync(file, 'wx', 0o644);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function verifyDirectory(directory) {
  if (!path.isAbsolute(directory) || fs.lstatSync(directory).isSymbolicLink()) fail('invalid-directory');
  const root = fs.realpathSync(directory), metadata = readBounded(path.join(root, '.release.json'));
  let manifest; try { manifest = validateManifest(JSON.parse(metadata)); } catch { fail('invalid-manifest'); }
  const entries = new Map();
  for (const file of manifest.files) {
    let parent = root;
    for (const component of file.path.split('/').slice(0, -1)) {
      parent = path.join(parent, component); const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-installed-path');
    }
    entries.set(file.path, readBounded(path.join(root, file.path), file.bytes));
  }
  validatePackageFiles(entries, manifest); return manifest;
}
module.exports = { MAX_BYTES, PREFIX, allowed, essential, sha256, crc32, zip, buildRelease, readZip, verifyArchive, readRevision, readBounded, writeNew, verifyDirectory, validateManifest };
