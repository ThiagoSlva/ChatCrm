'use strict';
const fs = require('node:fs'), path = require('node:path');
const { performance } = require('node:perf_hooks');
const SHA = /^[a-f0-9]{40}$/, NAME = /^release-[A-Za-z0-9]{6}$/;
function fail() { throw new Error('release-inventory-unconfirmed'); }
// Windows lstat can report dev=0 while fstat reports the volume serial.
function sameFile(a, b) { return (process.platform === 'win32' || a.dev === b.dev) && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }
function readSmall(file, limit) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameFile(before, fs.fstatSync(fd))) fail();
    const bytes = Buffer.alloc(limit + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > limit || !sameFile(before, fs.fstatSync(fd)) || !sameFile(before, fs.lstatSync(file))) fail();
    return { text: bytes.subarray(0, count).toString('utf8'), stat: before };
  } finally { fs.closeSync(fd); }
}
function releaseName(releases, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail();
  const resolved = path.resolve(target), name = path.basename(resolved);
  if (path.dirname(resolved) !== releases || !NAME.test(name)) fail();
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) fail();
  return name;
}
function activeName(root, releases) {
  const file = path.join(root, 'current');
  if (!fs.lstatSync(file).isSymbolicLink()) fail();
  return releaseName(releases, path.resolve(root, fs.readlinkSync(file)));
}
function inspectReleases({ root, keep = 3, minAgeDays = 7, now = Date.now(), maxEntries = 50000, timeoutMs = 5000 } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Number.isInteger(keep) || keep < 1 || keep > 100 ||
      !Number.isInteger(minAgeDays) || minAgeDays < 1 || minAgeDays > 3650 || !Number.isFinite(now) ||
      !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000000 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) fail();
  root = path.resolve(root);
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) fail();
  root = fs.realpathSync(root);
  const releases = path.join(root, 'releases');
  if (!fs.lstatSync(releases).isDirectory() || fs.lstatSync(releases).isSymbolicLink()) fail();
  const stateFile = path.join(root, '.deployed.json'), initial = readSmall(stateFile, 8192);
  const state = JSON.parse(initial.text);
  if (!state || !SHA.test(state.commit) || !Number.isFinite(Date.parse(state.deployedAt))) fail();
  const current = activeName(root, releases), recorded = releaseName(releases, state.release);
  if (current !== recorded) fail();
  const previous = state.previousRelease === null ? null : releaseName(releases, state.previousRelease);
  const names = fs.readdirSync(releases).sort(), rows = [], warnings = new Set();
  const started = performance.now(); let visited = 0, totalBytes = 0;
  function budget() { if (++visited > maxEntries || performance.now() - started > timeoutMs) fail(); }
  function measure(directory, depth = 0) {
    budget(); if (depth > 32) fail();
    const before = fs.lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail();
    let bytes = 0;
    for (const name of fs.readdirSync(directory)) {
      budget(); const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { warnings.add('symbolic-links-not-followed'); continue; }
      if (stat.isDirectory()) bytes += measure(file, depth + 1);
      else if (stat.isFile()) bytes += stat.size;
      else warnings.add('special-files-not-measured');
      if (!Number.isSafeInteger(bytes)) fail();
    }
    if (!sameFile(before, fs.lstatSync(directory))) fail();
    return bytes;
  }
  for (const name of names) {
    budget(); const directory = path.join(releases, name), stat = fs.lstatSync(directory);
    if (!NAME.test(name) || !stat.isDirectory() || stat.isSymbolicLink()) {
      warnings.add('unrecognized-entries-preserved'); continue;
    }
    const row = { name, commit: null, version: null, bytes: null, completedAt: null, protection: [] };
    if (name === current) row.protection.push('current');
    if (name === previous) row.protection.push('previous');
    try {
      const marker = readSmall(path.join(directory, '.deploy-commit'), 41);
      const commit = marker.text.trim(); if (!SHA.test(commit)) fail();
      const pkg = JSON.parse(readSmall(path.join(directory, 'package.json'), 32768).text);
      if (pkg.name !== 'conversa-livre' || pkg.license !== 'MIT' || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) fail();
      row.commit = commit; row.version = pkg.version; row.completedAt = marker.stat.mtimeMs;
      row.bytes = measure(directory); totalBytes += row.bytes;
      if (!Number.isSafeInteger(totalBytes)) fail();
      const finalMarker = readSmall(path.join(directory, '.deploy-commit'), 41);
      if (finalMarker.text !== marker.text || !sameFile(finalMarker.stat, marker.stat)) fail();
    } catch { row.protection.push('unconfirmed'); warnings.add('incomplete-or-unmeasured-release'); }
    rows.push(row);
  }
  const currentRow = rows.find(r => r.name === current), previousRow = rows.find(r => r.name === previous);
  if (!currentRow || currentRow.commit !== state.commit || currentRow.protection.includes('unconfirmed') ||
      (previous && (!previousRow || previousRow.protection.includes('unconfirmed')))) fail();
  rows.filter(r => !r.protection.includes('unconfirmed')).sort((a,b) => b.completedAt - a.completedAt || a.name.localeCompare(b.name))
    .slice(0, keep).forEach(r => r.protection.push('recent'));
  for (const row of rows) if (row.completedAt === null || now - row.completedAt < minAgeDays * 86400000) row.protection.push('age');
  const exists = file => { try { fs.lstatSync(path.join(root, file)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  if (exists('.current-next') || exists('.deployed.json.next')) warnings.add('deployment-in-progress');
  const finalState = readSmall(stateFile, 8192);
  if (finalState.text !== initial.text || !sameFile(finalState.stat, initial.stat) || activeName(root, releases) !== current ||
      JSON.stringify(fs.readdirSync(releases).sort()) !== JSON.stringify(names)) warnings.add('snapshot-changed');
  // Any uncertainty suppresses the whole suggestion. This is never a deletion plan.
  const reviewReady = warnings.size === 0;
  const candidates = reviewReady ? rows.filter(r => r.protection.length === 0).map(r => r.name) : [];
  return { ok: true, code: 'release-inventory', readOnly: true, reviewReady, current, previous, keep, minAgeDays,
    measuredBytes: totalBytes, entriesVisited: visited, warnings: [...warnings].sort(), releases: rows,
    candidatesForReview: candidates, candidateBytes: rows.filter(r => candidates.includes(r.name)).reduce((n,r) => n + r.bytes, 0) };
}
module.exports = { inspectReleases };
