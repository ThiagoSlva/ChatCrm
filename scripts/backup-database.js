'use strict';
const { captureSnapshot, restoreSnapshot, writeSnapshot, readSnapshot, validateSnapshot, privatePath, withConnection } = require('./database-backup');

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length !== 2 || !['--create','--verify','--restore-empty'].includes(args[0]) || args[1].startsWith('--')) return null;
  return { mode: args[0], file: args[1] };
}
async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args || args.help) {
    (args ? process.stdout : process.stderr).write('Uso: npm run backup:database -- (--create|--verify|--restore-empty) CAMINHO_ABSOLUTO_PRIVADO\nSchemas completos reconhecidos: 1 a 9. Restauracao somente com aplicacao parada, SETUP_TOKEN removido e mesma versao de schema preparada sem dados. Guia: docs/BACKUP-RESTAURACAO.md\n');
    process.exitCode = args ? 0 : 2; return;
  }
  privatePath(args.file);
  if (args.mode === '--create' && require('node:fs').existsSync(args.file)) throw Error('Backup already exists');
  if (args.mode === '--verify') {
    const summary = validateSnapshot(readSnapshot(args.file));
    process.stdout.write(JSON.stringify({ ok: true, code: 'backup-verified', ...summary }) + '\n'); return;
  }
  // Verify the complete artifact before loading configuration or connecting.
  const snapshot = args.mode === '--restore-empty' ? readSnapshot(args.file) : null;
  require('../src/server').loadEnvironment();
  if (args.mode === '--restore-empty' && process.env.SETUP_TOKEN) throw Error('Remove setup secret before restoring');
  const summary = await withConnection(process.env, async connection => {
    if (snapshot) return restoreSnapshot(connection, snapshot);
    const captured = await captureSnapshot(connection);
    return writeSnapshot(args.file, captured);
  });
  process.stdout.write(JSON.stringify({ ok: true, code: snapshot ? 'database-restored' : 'backup-created', ...summary }) + '\n', () => process.exit(0));
}
module.exports = { parseArguments };
if (require.main === module) main().catch(() => {
  process.stderr.write('Operacao de backup/restauracao nao confirmada. Nenhum valor privado foi exibido. Preserve arquivos e estrutura; consulte o guia antes de retomar. Dados transacionais podem ter sido revertidos, mas DDL de contadores e resposta de COMMIT perdida exigem diagnostico.\n');
  process.exit(1);
});
