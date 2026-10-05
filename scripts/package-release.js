'use strict';
const path = require('node:path');
const release = require('./release-package');
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  if (args.length === 2 && ['--output', '--verify', '--verify-directory'].includes(args[0]) && path.isAbsolute(args[1])) return { mode: args[0].slice(2), file: args[1], revision: 'HEAD' };
  if (args.length === 4 && args[0] === '--output' && path.isAbsolute(args[1]) && args[2] === '--commit' && /^[a-f0-9]{40}$/.test(args[3])) return { mode: 'output', file: args[1], revision: args[3] };
  throw Error('invalid-arguments');
}
function main(args) {
  let options;
  try { options = parseArguments(args); } catch { process.stderr.write('Uso inválido. Consulte --help.\n'); return 2; }
  if (options.mode === 'help') {
    process.stdout.write('Pacote de instalação Conversa Livre\n--output CAMINHO_ABSOLUTO.zip [--commit SHA40] (Git necessário; somente revisão commitada)\n--verify CAMINHO_ABSOLUTO.zip (offline)\n--verify-directory PASTA_ABSOLUTA (arquivos do manifesto; configuração e dependências não verificadas)\nNão carrega .env, não conecta ao banco e não substitui arquivos.\n'); return 0;
  }
  try {
    let manifest, bytes;
    if (options.mode === 'output') { const built = release.readRevision(path.resolve(__dirname, '..'), options.revision); bytes = built.bytes; manifest = built.manifest; release.writeNew(options.file, bytes); }
    else if (options.mode === 'verify') { bytes = release.readBounded(options.file); manifest = release.verifyArchive(bytes); }
    else manifest = release.verifyDirectory(options.file);
    process.stdout.write(JSON.stringify({ ok: true, mode: options.mode, version: manifest.version, commit: manifest.commit, files: manifest.files.length, ...(bytes ? { bytes: bytes.length, sha256: release.sha256(bytes) } : {}), integrityOnly: true }) + '\n'); return 0;
  } catch { process.stderr.write('Pacote não confirmado. Confira revisão, integridade, caminho e arquivos existentes. Detalhes privados omitidos.\n'); return 1; }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parseArguments, main };
