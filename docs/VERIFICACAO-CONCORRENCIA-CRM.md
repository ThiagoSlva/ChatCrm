# Verificação de concorrência SQL do CRM

Este guia descreve o verificador manual `scripts/verify-crm-concurrency.js`. Consulte a memória e o andamento para a execução homologada; cada novo ensaio exige preparação e evidências próprias. Os verificadores anteriores, com uma conexão e rollback, não comprovam concorrência entre conexões físicas.

## Preparação

Use uma instalação de testes sem atividade durante todo o ensaio. O banco deve conter exclusivamente as treze tabelas do ChatCrm no schema v5, uma empresa instalada e exatamente um usuário administrador ativo. As dez tabelas operacionais devem estar vazias, incluindo sessões, departamentos, vínculos, visitantes, conversas, mensagens, limites do chat, contatos, oportunidades e eventos. O script recusa um estado incompatível antes de criar fixtures.

Faça antes um backup privado atualizado de todas as treze tabelas, confira sua integridade e preserve uma release compatível com v5. Um backup anterior à migração não cobre o estado atual. Não publique o dump, a configuração, os caminhos internos ou dados de autenticação. A existência do backup não comprova que a restauração foi ensaiada.

Não execute em produção ocupada, banco com dados operacionais, cron ou CI. Não crie credenciais nem amplie permissões para o ensaio. O procedimento não executa migração ou DDL e não abre canais públicos.

## Execução manual

Ative o ambiente Node da aplicação e defina `CHATCRM_APP_ROOT` com o caminho privado da instalação. O arquivo `.env` permanece na hospedagem:

```sh
node --env-file="$CHATCRM_APP_ROOT/.env" \
  "$CHATCRM_APP_ROOT/current/scripts/verify-crm-concurrency.js" \
  --allow-temporary-fixtures
```

A opção reconhece que os dados sintéticos serão temporariamente **confirmados no banco com COMMIT**. Isso permite que duas conexões físicas independentes os enxerguem sob REPEATABLE READ; um único rollback externo não atende a esse objetivo. Nenhum dado real, campanha, canal novo ou alteração de credencial existente faz parte do ensaio.

O verificador deve demonstrar:

- Duas conexões físicas distintas com isolamento REPEATABLE READ.
- Bloqueio pela trava de schema, comprovado pelo erro SQL `ER_LOCK_WAIT_TIMEOUT` / 1205 do servidor antes de liberar o primeiro escritor; um temporizador em Node não substitui essa prova.
- Criações paralelas de uma oportunidade pelo mesmo ator com a mesma chave idempotente, retornando um único negócio e seu replay.
- Duas edições CAS da mesma oportunidade pelo mesmo ator com a mesma versão: exatamente uma vence, a outra recebe conflito; versões e histórico permanecem consistentes.

## Limpeza e evidências

Antes da limpeza, o script libera as barreiras e aguarda todas as operações lançadas terminarem. Depois valida propriedade e dependências de todas as fixtures **antes de qualquer DELETE**. Remove somente seus IDs e chaves sintéticos, em transação com a trava de schema. Uma divergência impede a exclusão; não faça limpeza por prefixo nem apague registros manualmente para forçar aprovação.

Os fingerprints dos registros e do DDL lógico das treze tabelas são comparados antes e depois. Somente o contador `AUTO_INCREMENT` é ignorado: ele pode avançar mesmo quando os dados temporários foram removidos. Não restaure esse contador nem altere tabelas para igualar fingerprints.

Sucesso deve produzir JSON genérico com `ok: true` e a lista `checks`. Registre data UTC, commit executado, hash servido, schema, checks, limpeza e preservação na memória do projeto após conferir a saída. O ensaio de 02/10/2026 passou oito checks no commit1205c079c652112349fac8fab519930c3d7fbdba às17:05:26.119Z, com limpeza e fingerprints preservados. Consulte o andamento para CI, deploy, backup e limites; o resultado não dispensa as condições acima para outra instalação.

Se houver erro, interrupção ou limpeza recusada, preserve a evidência privada e confira resíduos antes de repetir. O encerramento do processo pode deixar fixtures confirmadas. A recuperação exige examinar a propriedade e as dependências; não reutilize o procedimento como ferramenta de exclusão.

## Alcance

Este ensaio cobre duas conexões SQL no mesmo processo. Continuam pendentes carga, múltiplos processos, duas pessoas por HTTP/HTTPS, restauração de backup e saturação real da quota de 5.000 cadastros. Ele também não comprova a interface autenticada.
