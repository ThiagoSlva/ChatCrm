'use strict';
const backup = require('./configuration-backup');
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length === 2 && args[0] === '--verify' && !args[1].startsWith('--')) return { mode: args[0], file: args[1] };
  if (args.length === 3 && ['--create', '--restore-new'].includes(args[0]) && args.slice(1).every(a => !a.startsWith('--'))) {
    return { mode: args[0], file: args[1], directory: args[2] };
  }
  return null;
}
function main(args = process.argv.slice(2)) {
  const parsed = parseArguments(args);
  if (!parsed || parsed.help) {
    (parsed ? process.stdout : process.stderr).write('Uso: npm run backup:configuration -- --create ARQUIVO_PRIVADO PASTA_ORIGEM\n     npm run backup:configuration -- --verify ARQUIVO_PRIVADO\n     npm run backup:configuration -- --restore-new ARQUIVO_PRIVADO PASTA_NOVA_PRIVADA\nCaminhos absolutos; restauracao em pasta nova de revisao, sem ativar configuracao. Guia: docs/BACKUP-CONFIGURACAO.md\n');
    process.exitCode = parsed ? 0 : 2; return;
  }
  let summary, code;
  if (parsed.mode === '--create') {
    summary = backup.writeConfiguration(parsed.file, backup.captureConfiguration(parsed.directory)); code = 'configuration-backup-created';
  } else {
    const snapshot = backup.readConfiguration(parsed.file);
    summary = parsed.mode === '--verify' ? backup.validateConfiguration(snapshot) : backup.restoreConfiguration(parsed.directory, snapshot);
    code = parsed.mode === '--verify' ? 'configuration-backup-verified' : 'configuration-staged';
  }
  process.stdout.write(JSON.stringify({ ok: true, code, ...summary }) + '\n');
}
module.exports = { parseArguments, main };
if (require.main === module) {
  try { main(); } catch {
    process.stderr.write('Operacao de configuracao nao confirmada. Nenhum conteudo privado foi exibido. Preserve o artefato e eventual pasta parcial; use outro nome e consulte o guia.\n');
    process.exitCode = 1;
  }
}
