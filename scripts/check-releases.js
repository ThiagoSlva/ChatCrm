'use strict';
const { inspectReleases } = require('./release-inventory');
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const value = {};
  for (let i=0; i<args.length; i+=2) {
    const key = { '--root':'root', '--keep':'keep', '--min-age-days':'minAgeDays' }[args[i]], text=args[i+1];
    if (!key || Object.hasOwn(value,key) || !text || text.startsWith('--')) return null;
    if (key === 'root') value.root=text;
    else { if (!/^[1-9]\d*$/.test(text)) return null; value[key]=Number(text); }
  }
  return value.root ? value : null;
}
function main(args=process.argv.slice(2)) {
  const parsed=parseArguments(args);
  if (!parsed || parsed.help) {
    (parsed ? process.stdout : process.stderr).write('Uso: npm run check:releases -- --root PASTA_ABSOLUTA_DA_APLICACAO [--keep 3] [--min-age-days 7]\nSomente leitura, sem exclusao. Guia: docs/RETENCAO-RELEASES.md\n');
    process.exitCode=parsed ? 0 : 2; return;
  }
  try {
    const result=inspectReleases(parsed); process.stdout.write(JSON.stringify(result)+'\n');
    process.exitCode=result.reviewReady ? 0 : 1;
  } catch {
    process.stderr.write('Inventario de releases nao confirmado. Nenhum arquivo foi alterado ou conteudo privado exibido. Confira a estrutura e o recibo; tente novamente fora de um deploy.\n');
    process.exitCode=1;
  }
}
module.exports={parseArguments,main};
if (require.main===module) main();
