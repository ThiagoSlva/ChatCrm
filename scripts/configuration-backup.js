'use strict';

const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { privatePath } = require('./database-backup');
const names = ['.env', 'passenger.cjs'];
const MAX_FILE_BYTES = 65536, MAX_BYTES = 196608;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw Object.assign(Error(code), { code }); }
function keys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === [...expected].sort().join('|');
}

// No parent links: an apparently private path must not redirect to a public folder.
function plainPath(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0')) fail('configuration-path-invalid');
  const resolved = path.resolve(target), parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    if (/^(public|public_html|www|htdocs|\.git|current|releases|node_modules)$/i.test(part)) fail('configuration-path-invalid');
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('configuration-path-invalid');
  }
  return resolved;
}
function privateFilePath(target) {
  // privatePath additionally excludes this checkout and requires a private parent.
  const resolved = privatePath(target);
  plainPath(path.dirname(target));
  return resolved;
}
function readFile(target, maxBytes, secret = true) {
  plainPath(path.dirname(target));
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes ||
      (process.platform !== 'win32' && (before.mode & (secret ? 0o077 : 0o022)))) fail('configuration-file-invalid');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (stat.ino !== before.ino || stat.size !== before.size || stat.nlink !== 1 ||
        (process.platform !== 'win32' && (stat.dev !== before.dev || (stat.mode & (secret ? 0o077 : 0o022))))) fail('configuration-file-invalid');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0, read;
    while (length < buffer.length && (read = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += read;
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(target);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs ||
        named.isSymbolicLink() || named.ino !== stat.ino || named.nlink !== 1 ||
        (process.platform !== 'win32' && (named.dev !== stat.dev || (named.mode & (secret ? 0o077 : 0o022))))) fail('configuration-changed');
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

function validateConfiguration(snapshot) {
  if (!keys(snapshot, ['format', 'version', 'payload', 'sha256']) || snapshot.format !== 'conversa-livre-configuration' || snapshot.version !== 1 ||
      !keys(snapshot.payload, ['createdAt', 'toolVersion', 'files']) || typeof snapshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) fail('configuration-backup-invalid');
  const p = snapshot.payload;
  if (typeof p.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.createdAt) ||
      !Number.isFinite(Date.parse(p.createdAt)) || new Date(p.createdAt).toISOString() !== p.createdAt ||
      typeof p.toolVersion !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(p.toolVersion) ||
      !Array.isArray(p.files) || p.files.length < 1 || p.files.length > names.length) fail('configuration-backup-invalid');
  let total = 0;
  for (let i = 0; i < p.files.length; i++) {
    const f = p.files[i];
    if (!keys(f, ['name', 'bytes', 'base64', 'sha256']) || f.name !== names[i] || !Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > MAX_FILE_BYTES ||
        typeof f.base64 !== 'string' || f.base64.length !== Math.ceil(f.bytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64) ||
        typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) fail('configuration-backup-invalid');
    const bytes = Buffer.from(f.base64, 'base64');
    if (bytes.length !== f.bytes || bytes.toString('base64') !== f.base64 || digest(bytes) !== f.sha256) fail('configuration-backup-invalid');
    total += bytes.length;
  }
  if (JSON.stringify(snapshot).length > MAX_BYTES || digest(JSON.stringify(p)) !== snapshot.sha256) fail('configuration-backup-invalid');
  // Only non-sensitive metadata is ever returned to the command line.
  return { files: p.files.length, bytes: total, createdAt: p.createdAt, toolVersion: p.toolVersion };
}

function captureConfiguration(source) {
  const root = plainPath(source), stat = fs.lstatSync(root);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o022))) fail('configuration-path-invalid');
  const files = [];
  for (const name of names) {
    const file = path.join(root, name);
    if (name !== '.env') {
      try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    }
    const bytes = readFile(file, MAX_FILE_BYTES, name === '.env');
    files.push({ name, bytes: bytes.length, base64: bytes.toString('base64'), sha256: digest(bytes) });
  }
  // Detect ordinary concurrent edits/additions/removals. This is not a filesystem snapshot.
  for (const name of names) {
    const original = files.find(f => f.name === name), file = path.join(root, name);
    if (original) {
      if (digest(readFile(file, MAX_FILE_BYTES, name === '.env')) !== original.sha256) fail('configuration-changed');
    } else {
      try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      fail('configuration-changed');
    }
  }
  const payload = { createdAt: new Date().toISOString(), toolVersion: require('../package.json').version, files };
  const snapshot = { format: 'conversa-livre-configuration', version: 1, payload, sha256: digest(JSON.stringify(payload)) };
  validateConfiguration(snapshot); return snapshot;
}

function writeConfiguration(target, snapshot) {
  const summary = validateConfiguration(snapshot), file = privateFilePath(target);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(snapshot) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return summary;
}
function readConfiguration(target) {
  const file = privateFilePath(target), bytes = readFile(file, MAX_BYTES + 1);
  const snapshot = JSON.parse(bytes.toString('utf8'));
  validateConfiguration(snapshot); return snapshot;
}
function restoreConfiguration(target, snapshot) {
  const summary = validateConfiguration(snapshot), destination = privateFilePath(target);
  // Reserve an entirely new private staging folder. Never merge, overwrite or activate.
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const f of snapshot.payload.files) {
    const file = path.join(destination, f.name), fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, Buffer.from(f.base64, 'base64')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (digest(readFile(file, MAX_FILE_BYTES)) !== f.sha256) fail('configuration-restore-unconfirmed');
  }
  return summary;
}
module.exports = { captureConfiguration, validateConfiguration, writeConfiguration, readConfiguration, restoreConfiguration, MAX_FILE_BYTES, MAX_BYTES };
