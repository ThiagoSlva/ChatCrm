# Backup privado e restauração — schemas 1 a 10

Esta ferramenta exporta instalações completas nas versões de schema 1 a 10 e restaura em um **schema da mesma versão já preparado, sem dados**, com a aplicação de destino parada. O schema 9 contém 21 tabelas; o schema 10 contém 22, incluindo o catálogo privado de respostas. Não substitui backup da configuração, arquivos privados ou hospedagem. Não usa conta do autor, serviço pago ou cron. Consulte o andamento para distinguir ensaios locais e hospedados.

| Versão do schema | Tabelas esperadas |
| --- | ---: |
| 1 | 4 |
| 2 | 6 |
| 3 | 10 |
| 4 | 11 |
| 5 | 13 |
| 6 | 15 |
| 7 | 17 |
| 8 | 18 |
| 9 | 21 |
| 10 | 22 |

O contrato é fixo para cada versão, incluindo a ausência de `public_chat` no schema 2. Versões desconhecidas, tabelas faltantes ou de uma etapa posterior e estruturas parciais são recusadas. Não remova tabelas ou diminua o marcador para contornar uma recusa. Snapshots de schema 9 feitos anteriormente mantêm o mesmo formato e podem ser verificados/restaurados.

## Criar e conferir

Escolha uma pasta privada **fora do checkout, current/releases e pasta pública**. No Linux, o diretório precisa ter modo 700 e o arquivo 600; em Windows, use uma pasta com ACL restrita ao dono. O programa recusa caminhos relativos, pastas públicas, symlinks de arquivo e arquivos existentes. Não exibe registros, nomes, e-mails, hashes de senha ou parâmetros de conexão.

Na instalação direta, com `.env` privado configurado:

```sh
npm run backup:database -- --create /CAMINHO_PRIVADO/backup-unico.json
npm run backup:database -- --verify /CAMINHO_PRIVADO/backup-unico.json
```

Use um nome novo a cada backup. A pasta precisa existir. No fluxo de releases, defina os caminhos privados conforme o [guia de deploy](DEPLOY-CPANEL.md):

```sh
source "$CHATCRM_NODE_ENV"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/backup-database.js" --create "$CHATCRM_BACKUP_FILE"
node "$CHATCRM_APP_ROOT/current/scripts/backup-database.js" --verify "$CHATCRM_BACKUP_FILE"
```

`CHATCRM_BACKUP_FILE` deve ser absoluto e apontar para um arquivo novo na pasta privada. Nunca coloque senha em argumentos. `--verify` não carrega `.env` nem conecta ao banco; verifica formato, tamanho, contrato, marcador e checksum offline. Ajuda: `npm run backup:database -- --help`.

O backup usa uma conexão própria, fuso UTC, trava de migração e transação InnoDB somente de leitura com fotografia consistente. Confere todas as tabelas/engines/colunas daquela versão e os validadores dos módulos já presentes, recusa triggers visíveis e não executa DDL/DML no banco de origem. Busca páginas de até 200 linhas, até 25.000 linhas no total e 16 MiB de artefato; ultrapassar limites recusa a operação, sem truncar silenciosamente. Conexão, comandos e encerramento têm prazo de 15 segundos por operação. [Fotografia consistente no MariaDB](https://mariadb.com/docs/server/reference/sql-statements/transactions/start-transaction) e [travas cooperativas](https://mariadb.com/docs/server/reference/sql-functions/secondary-functions/miscellaneous-functions/get_lock) fundamentam esse procedimento.

O formato JSON inclui dados, hashes de senha, identificadores, limites persistidos e próximos IDs. Não contém senha do banco, SETUP_TOKEN, URL ou conteúdo de `.env`. Não é SQL executável nem dump genérico. SHA256 verifica integridade; não autentica a origem nem cifra o conteúdo. Use somente seus backups confiáveis, mantenha cópia privada fora da máquina e proteja sua transferência. Nunca publique arquivo ou amostras de linhas no Git, site ou conversa.

Uma escrita interrompida pode deixar arquivo privado incompleto: nenhum sucesso é informado. Preserve-o, use `--verify` e escolha outro nome para novo backup. O programa nunca sobrescreve ou remove backups. Checksum correto não comprova restauração.

## Restaurar sem substituir dados existentes

1. Preserve a instalação de origem e uma cópia verificada do backup. Confira `schemaVersion` no resumo de `--verify`. Prepare uma instalação de destino isolada, compatível com essa versão, usando banco exclusivo **novo**, usuário próprio e configuração privada. Não use o banco instalado de origem.
2. Para schema 10, siga [instalação simples](INSTALADOR-CPANEL.md) para preparar somente a estrutura. Para versões anteriores, usando esta ferramenta atual e a configuração apontada ao destino novo, execute `npm run migrate:database -- --target-version N --require-empty`, substituindo `N` pela versão inteira de 1 a 10 do backup. A opção exige banco vazio sob a trava de migração; não autoriza downgrade ou retomada de estrutura parcial. **Não crie a empresa ou administrador pelo navegador**: eles virão do backup.
3. Remova SETUP_TOKEN da configuração de destino e mantenha a aplicação Node de destino parada durante toda a recuperação. O comando recusa SETUP_TOKEN ainda configurado, mas não controla processos externos; confirme a parada pelo seu painel. Não permita acesso web ou outro processo escrevendo no destino até concluir.
4. Confira o artefato offline. A configuração de conexão agora deve apontar para o **destino vazio**. Nenhuma credencial é copiada pelo programa.
5. Execute explicitamente:

   ```sh
   npm run backup:database -- --restore-empty /CAMINHO_PRIVADO/backup-verificado.json
   ```

   Em releases:

   ```sh
   node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/backup-database.js" --restore-empty "$CHATCRM_BACKUP_FILE"
   ```

6. Só prossiga depois de `database-restored`/saída 0. Execute `check:installation` no destino. Confirme empresa/administrador, departamentos, atendimento, CRM, portal e permissões com identidades de teste antes de liberar uso. Depois inicie esta aplicação de destino pelo painel.

O restaurador valida o arquivo antes de conectar, obtém a trava cooperativa, confere a versão exata e recusa **qualquer registro** além da única linha do marcador, inclusive quotas ou sessões. `restore-schema-mismatch` significa que o destino possui outra versão: a operação é recusada antes de alterar contadores ou registros. Não cria bancos/tabelas, não atualiza a versão, não executa SQL fornecido pelo JSON e não faz DELETE, UPDATE, DROP ou TRUNCATE. Nomes são fixos e inserções são parametrizadas. Confere novamente a versão e a ausência de dados após obter a trava da linha do schema, que protege o primeiro cadastro.

Restauração e atualização são operações separadas. Depois de restaurar uma versão anterior, confira os dados em manutenção, faça um novo backup verificado dessa versão e consulte o [guia de instalação e acesso](INSTALACAO-ACESSO.md) antes da migração explícita para a versão atual. Não restaure diretamente um backup antigo em schema 9 nem inicie módulos ausentes como se estivessem instalados.

Preserva IDs, valores, Unicode, datas UTC, preferências, auditoria, quotas e próximos IDs de AUTO_INCREMENT, inclusive lacunas de exclusões antigas. As contas conservam hashes de senha e códigos de recuperação. As sessões da equipe e do portal **não são reativadas**: os usuários precisam entrar novamente. Tokens anônimos de visitantes e seus prazos são dados conservados; isto não é ferramenta de rotação de todas as credenciais. Não envia campanha, e-mail, push ou mensagem durante a recuperação.

Antes de COMMIT, compara todos os registros restaurados com o snapshot, considerando as duas tabelas de sessões vazias, e confere contadores. Dados entram numa transação; falhas de inserção/validação revertem o lote inteiro. `rowsRestored` exclui marcador e sessões descartadas; `revokedSessions` informa a quantidade descartada.

## Se a resposta não confirmar

- Artefato inválido/incompatível, caminho/permissões inadequados ou tamanho excedido: corrigir o problema sem modificar o backup original.
- Destino com registros: **recusado antes de alterações**. Não apagar dados para repetir; escolha um destino isolado vazio.
- Falha de inserção: dados transacionais voltam ao estado vazio. DDL que elevou contadores acontece antes da transação e não é revertido pelo MySQL. Preserve estrutura e diagnostique; se continuar vazia e válida, é possível retomar explicitamente com a aplicação ainda parada.
- Resposta de COMMIT perdida ou falha no encerramento: estado sem confirmação, mesmo que o banco já tenha sido restaurado. Diagnostique antes de repetir. Destino ocupado recusa replay; não limpa o banco automaticamente.
- Timeout: conexão própria encerrada e resultado sem confirmação. Não diminuir marcador, trocar credenciais ou descartar estrutura para obter sucesso.

O procedimento exige manutenção do destino: travas cooperativas não bloqueiam administradores SQL externos ou outros programas que ignorem o protocolo. Não há promessa de recuperação online, restauração entre schemas diferentes, streaming ilimitado ou compatibilidade com todos os provedores.

## O que completar no backup da instalação

Use [backup de configuração](BACKUP-CONFIGURACAO.md) para guardar `.env` e bootstrap opcional na própria hospedagem e preparar uma cópia em pasta privada nova. Guarde separadamente a revisão compatível do código e arquivos operacionais que você realmente utiliza. O banco é apenas uma parte; os snapshots não são uma fotografia conjunta automática. Não copiar `.env` para releases ou pasta pública; revisar os parâmetros de conexão/origem no destino. Retenção, criptografia opcional e recuperação completa da hospedagem continuam no plano.

Os ensaios em MariaDB local usam dados exclusivamente fictícios, com origem preservada e destino isolado. Não significam que dados ou credenciais operacionais do cPanel foram restaurados. As evidências executadas ficam em [ANDAMENTO.md](ANDAMENTO.md).
