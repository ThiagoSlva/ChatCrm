# Contatos e leads — primeiro recorte do CRM

A v0.6.0 adiciona cadastro manual em /contatos, com nome, classificação (lead, contato ou cliente), empresa, e-mail e telefone opcionais. A mesma pessoa pode mudar de classificação sem criar outro cadastro. Oportunidades e etapas do funil serão entidades separadas; este módulo ainda não inclui funil, histórico de alterações, notas, tarefas, importação, exclusão, verificação de identidade ou associação automática ao chat.

Cada cadastro pertence a uma área ativa. Administrador acessa áreas ativas; operador acessa somente aquelas às quais está vinculado no momento da requisição. Remover vínculo ou desativar a área impede novas leituras e alterações, preservando o registro. A área do cadastro não pode ser alterada nesta versão. Ter e-mail/telefone cadastrado não representa consentimento para campanhas.

## Uso

Em /acesso, prepare as áreas e vínculos da equipe. Entre na sua conta e abra /contatos. Crie um cadastro na área responsável; busque por nome, e-mail, telefone ou empresa, filtre por classificação/área e abra o detalhe para editar. Atualização manual preserva rascunhos nesta aba. Nenhum dado pessoal, rascunho ou token é armazenado em localStorage ou no endereço da página.

Se uma criação perder a resposta, confirme o mesmo cadastro: o formulário preserva dados e chave para não duplicar. Em uma edição concorrente ou de resultado incerto, consulte os dados atuais, compare com o rascunho e confirme a versão que deseja usar antes de salvar. Nenhuma alteração conflitante é mesclada automaticamente. Trocar de identidade ou sair limpa os rascunhos; fechar a aba pode perdê-los.

## Contrato implementado

Todas as rotas exigem sessão da equipe. POST/PATCH exigem origem própria e CSRF. Dados são revalidados dentro da transação com ator, sessão e vínculo atuais.

| Rota | Comportamento |
| --- | --- |
| GET /api/crm/contacts | Lista paginada e total somente do escopo autorizado |
| GET /api/crm/contacts/:id | Detalhe autorizado; ausente/inacessível retorna 404 |
| POST /api/crm/contacts | Criação com departmentId, name, kind e clientKey; e-mail/telefone/empresa opcionais |
| PATCH /api/crm/contacts/:id | version obrigatória e pelo menos um campo editável; versão antiga retorna 409 |

Lista: page 1–10000, limit 1–50 (padrão 20), kind all/lead/contact/customer, departmentId opcional e q até 100 caracteres. Busca trata %, _, ! e barra como texto literal; a collation do banco determina equivalência de caixa/acentos. Contagem e página compartilham filtros/escopo. Ordenação por atualização e ID decrescentes. Não há unicidade obrigatória por e-mail ou telefone; a deduplicação assistida ainda será implementada.

Campos: nome normalizado NFC com 2–100 caracteres; empresa até 100; e-mail ASCII até 254 com formato básico e minúsculas; telefone até 40 usando números, espaço, +, parênteses e hífen. Caracteres de controle e campos desconhecidos são recusados. Email/telefone informados não provam identidade. Respostas públicas incluem somente id, departmentId, departmentName, name, email, phone, company, kind, version, createdAt e updatedAt; nunca chave de reenvio, hash ou criador interno.

Criação retorna 201; reenvio canônico com a mesma chave hexadecimal de 32 caracteres e ator retorna 200 com o cadastro atual, inclusive depois de editado. Dados divergentes na mesma chave retornam 409. Revalida-se acesso antes de responder ao reenvio. Limite inicial de 5.000 cadastros por instalação; nova criação além desse limite retorna 429, mas reenvio já existente continua autorizado. Edição normalizada sem mudança mantém versão; não se permite transbordamento do contador.

## Migração e recuperação

Schema v4 adiciona apenas cl_contacts, com índices, chaves estrangeiras restritas e unicidade de criador/chave. A aplicação v0.6 funciona com v3 enquanto contatos responde 503. A migração é explícita e aditiva; nunca roda no cron. Uma estrutura parcial incompatível é recusada sem marcar v4.

1. Publique a release revisada v0.6, confira Actions, testes do deploy e hash em /health.
2. Em v3, confirme acesso/equipe/departamentos/chat e a indisponibilidade esperada de contatos. Faça backup privado atualizado de todas as dez tabelas e preserve uma release v0.6 compatível para recuperação.
3. Com Node ativo e CHATCRM_APP_ROOT privado definido, execute:

~~~sh
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/migrate-database.js"
~~~

4. Confirme schema v4 e preservação dos registros anteriores. Execute explicitamente os verificadores; eles não fazem parte do cron:

~~~sh
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-contacts-database.js"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-chat-database.js"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-access.js" "$CHATCRM_APP_ROOT/.first-access.json"
~~~

O SQL usa registros sintéticos em transação externa revertida, comparando registros e schemas lógicos anteriores das onze tabelas. Contadores AUTO_INCREMENT podem avançar apesar do rollback. O HTTPS abre/encerra apenas sua sessão de verificação e faz leituras no CRM, sem criar cadastros reais. Nenhum verificador comprova carga ou corrida entre conexões distintas.

Após v4, v0.5 ou anterior não aceita o schema; não recuperar essas releases, diminuir marcador ou apagar tabelas. Preserve configuração privada e backup atualizado. Restauração e recuperação com dados de atendimento reais ainda precisam ser ensaiadas antes de produção. Consulte [deploy](DEPLOY-CPANEL.md) e [andamento](ANDAMENTO.md) para resultados verificados.
