# Oportunidades e etapas — v0.7.0

Este recorte acrescenta vendas manuais em /vendas. Uma oportunidade tem contato, título, valor em reais e etapa. Um contato pode ter várias oportunidades; a classificação lead/contato/cliente continua independente. Não há associação ao chat nesta versão. Consulte ANDAMENTO.md para evidências de publicação e homologação.

## Uso

Cadastre um contato em uma área ativa em /contatos. Em Vendas, procure o contato com busca e paginação, selecione-o e salve título e valor. O cadastro começa em Novo. A lista permite filtrar etapa e área e buscar literalmente título, nome ou empresa do contato. Totais referem-se ao filtro e às áreas autorizadas.

Ao editar, confirme a mudança de etapa: Novo, Qualificado, Proposta, Ganho ou Perdido. É possível reabrir uma oportunidade encerrada. Cada alteração efetiva registra uma versão com título, valor, etapa, data e autor; salvar dados iguais não cria versão. O histórico mostra os valores salvos e o nome atual do autor, mesmo que ele tenha sido posteriormente desativado.

O formulário preserva a chave de criação quando a resposta é incerta. Reenviar o mesmo cadastro com a mesma chave não duplica. Uma edição que perdeu a resposta exige consultar os dados atuais e revisar explicitamente antes de usar uma versão nova; o rascunho não é aplicado automaticamente. Os rascunhos ficam apenas na memória da página e podem ser perdidos ao recarregar/fechar. Sair ou trocar de conta limpa os dados anteriores.

## API da equipe

Sessão da equipe em cookie seguro. Escritas exigem origem da instalação e X-CSRF-Token. Cookie de visitante não permite acessar vendas. Toda operação revalida usuário ativo, sessão válida, área ativa e vínculo atual no banco. Administrações continuam limitadas a áreas ativas.

| Método e rota | Contrato |
| --- | --- |
| GET /api/crm/opportunities | page 1..10000, limit 1..50 (20 padrão), stage all/new/qualified/proposal/won/lost, q até100, departmentId e contactId opcionais. Retorna opportunities,total,page,limit |
| GET /api/crm/opportunities/:id | opportunity ou404 |
| POST /api/crm/opportunities | contactId e title obrigatórios, clientKey de32hex minúsculos, amountCents opcional(default0). 201novo/200replay |
| PATCH /api/crm/opportunities/:id | version obrigatória e ao menos title, amountCents ou stage. Versão antiga409; contato imutável |
| GET /api/crm/opportunities/:id/events | page/limit; events,total,page,limit em versão decrescente, ou404 |

Valores são centavos inteiros de0 a999999999 e currency sempre BRL; API não aceita floats ou outra moeda. O formulário aceita formato brasileiro, por exemplo1.234,56. Título é texto de2..150 após trim/NFC, sem controles; limite bruto também150 unidades UTF-16. Busca literal escapa %, _ e ! e não transforma barra invertida em escape. Repetições de parâmetros, propriedades extras e tipos inválidos são recusados.

Oportunidade expõe somente id,contactId,contactName,departmentId,departmentName,title,amountCents,currency,stage,version,createdAt,updatedAt. Evento expõe version,actorName,title,amountCents,stage,createdAt. Não retorna credenciais, tokens, chaves idempotentes ou hashes.

A chave é por ator e pelo conteúdo normalizado de criação. Replay após edição retorna o estado atual, sem evento adicional. Reuso divergente409; revogação ou área indisponível prevalece sobre replay. Limite global5000 oportunidades; limite429 não invalida replay de um cadastro existente. Ausência/perda de área retorna404. Não existem exclusão, deduplicação automática ou permissão adquirida por seleção.

## Banco e publicação

Schema v5 acrescenta somente cl_opportunities e cl_opportunity_events, com FKs locais RESTRICT e índice único por ator/chave. Histórico e alteração são atômicos: o evento copia valores e data da oportunidade dentro da mesma transação. A trava atual é global por schema e prioriza consistência; desempenho com múltiplas conexões precisa de validação.

1. Rode npm test e revise a release v0.7. Publique a aplicação compatível com v4, confira hash/HTTPS e confirme que somente vendas informa preparação pendente.
2. Crie backup privado atualizado das onze tabelas do schema v4. Guarde uma release v0.7 compatível e valide a preservação antes do DDL.
3. Execute a migração explícita com o ambiente privado. O cron não migra.
4. Confira dados antigos, canais, credenciais/sessões e estrutura5; execute verificadores SQL com rollback e HTTPS e confirme o hash.

Com CHATCRM_APP_ROOT definido no ambiente privado e Node ativo:

```sh
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/migrate-database.js"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-opportunities-database.js"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-contacts-database.js"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-chat-database.js"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-access.js" "$CHATCRM_APP_ROOT/.first-access.json"
```

O migrador valida contatos antes de criar as duas novas tabelas; só marca5 após validar ambos os schemas. Preparação incompleta conserva o marcador anterior. v0.6 não aceita schema5: depois de migrar, recupere uma release compatível v0.7. Não diminuir marcador nem apagar tabelas para recuperar.

## Limites

Este é um funil manual em lista, acessível por teclado e celular. Não inclui quadro arrastável, pipelines personalizados, automações, metas, tarefas, associação ao atendimento ou campanhas. Cadastro e etapa Ganho não comprovam consentimento, identidade ou pagamento. Sem envios de mensagens.

Testes HTTP/modelos, ensaios DOM/fetch e SQL de uma conexão com rollback têm alcances diferentes. O verificador SQL testa falha controlada de evento e compara registros/schema lógico; AUTO_INCREMENT pode avançar. Concorrência entre conexões, visual autenticado, restauração, carga e uso real continuam pendentes enquanto não houver evidência registrada.
