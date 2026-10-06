# Inventário de releases antes da retenção

O cron de testes conserva todas as releases, inclusive pastas de deploys interrompidos. Desde v0.13.5, `check:releases` ajuda a medir esse acúmulo sem apagar, mover ou alterar arquivos. O comando é manual; não entra no cron, startup ou servidor web e não conecta ao banco nem lê `.env` ou backups.

Com o runtime Node da aplicação ativo, defina `CHATCRM_APP_ROOT` como a pasta privada da aplicação e execute fora de um deploy:

```sh
node "$CHATCRM_APP_ROOT/current/scripts/check-releases.js" --root "$CHATCRM_APP_ROOT" --keep 3 --min-age-days 7
```

Também existe `npm run check:releases -- --root PASTA_ABSOLUTA`. A raiz precisa conter `releases`, o link `current` e o recibo `.deployed.json` do nosso deploy. Uma instalação manual extraída de ZIP sem essa estrutura não usa este comando; ele não cria essa estrutura.

O relatório JSON inclui nomes das releases, commit, versão, tamanhos e motivos de proteção. Guarde a saída em local privado, fora da raiz pública, se precisar comparar execuções. Erros são genéricos e não imprimem caminhos internos ou conteúdo dos arquivos. O relatório completo é operacional e não deve ser publicado com metadados reais da conta.

São sempre preservadas para revisão:

- A release apontada por `current` e a anterior registrada no recibo, independentemente de idade ou quantidade.
- As três releases confirmadas mais recentes, além das proteções anteriores. `--keep` aceita1 a100.
- Releases concluídas há menos de sete dias. `--min-age-days` aceita1 a3650; a idade usa a data do marcador `.deploy-commit`, não garante a data original do commit.
- Pastas incompletas, entradas desconhecidas e links. O inventário não segue links encontrados na árvore medida.

`candidatesForReview` mostra somente nomes de releases antigas sem essas proteções, quando toda a inspeção termina sem avisos. Não é uma lista autorizada para exclusão. `reviewReady` significa que o inventário conseguiu formar sugestões nesse instante; não confirma autenticidade do código, compatibilidade com o banco atual ou existência de backup.

Uma raiz/recibo/link ativo inconsistente impede o inventário. Link temporário `.current-next`, recibo `.deployed.json.next`, pastas incompletas, links, entradas desconhecidas ou mudança observada durante a leitura suprimem todas as sugestões. Código de saída0 indica inventário sem avisos;1 indica inspeção não confirmada ou avisos;2 indica argumentos inválidos. Corrija a causa identificada sem apagar o arquivo para silenciar o aviso e execute novamente quando o deploy terminar.

O limite é50.000 entradas,32 níveis de subpastas e cinco segundos verificados entre operações de filesystem. Ao alcançar limite de entradas/tempo, a medição para e devolve relatório parcial com `scan-entry-limit` ou `scan-time-limit`, `measurementComplete: false` e nenhuma sugestão. `releaseEntries` conta entradas diretas e `measuredReleases` conta as releases efetivamente medidas; `measuredBytes` nunca deve ser tomado como total quando a medição é incompleta. Identidades ativa/anterior são conferidas antes da medição. Um acesso ao disco que bloqueia não tem cancelamento próprio. O tamanho soma bytes lógicos de arquivos regulares, inclusive dependências: não mede blocos reais, espaço recuperável, compressão ou deduplicação; hardlinks podem ser contados mais de uma vez. Configuração, backups, clone Git, logs e arquivos fora de `releases` não entram na medição. O relatório é uma observação limitada, sem trava global ou garantia de snapshot atômico contra outros processos.

Antes de definir uma limpeza, confira backup recente de banco/configuração, schema atual, pacote compatível para recuperação e ausência de deploy/recuperação em curso. Preserve também versões necessárias a uma restauração planejada, mesmo que apareçam entre as sugestões. A limpeza automática, rotação de logs e retenção de dados do CRM continuam pendentes; nenhuma exclusão foi implementada ou autorizada por este diagnóstico. Consulte [deploy](DEPLOY-CPANEL.md) e [backup](BACKUP-RESTAURACAO.md).
