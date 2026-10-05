# Campanhas no canal próprio — v0.11

A administração prepara uma mensagem em `/campanhas`, confere a prévia e adiciona uma fila. A entrega aparece na caixa de novidades de `/portal`, exclusivamente para a conta destinatária. Criar uma campanha não inicia entregas: cada lote de até 50 é acionado manualmente. Não existe envio por WhatsApp, e-mail, SMS ou push, agendamento, importação de destinatários ou inscrição feita por operadores.

## Consentimento e histórico

A prévia considera contas ativas com inscrição atual no aviso `portal-news-v1`. Ela retorna quantidade e hash, sem identidades. A criação confirma novamente esse público; uma mudança exige nova revisão. Cada item guarda a versão exata do consentimento. Sob transação e trava do marcador do schema, imediatamente antes da entrega, a aplicação verifica conta ativa, inscrição mais recente, aviso e mesma versão.

Descadastrar impede a entrega pendente. Reinscrever depois não reativa uma fila antiga: a versão mudou. O processamento marca esses itens como não elegíveis; o contador de pendentes pode incluí-los até o lote ser processado. Uma campanha criada após a nova inscrição pode incluí-los normalmente. Mudanças futuras no aviso também impedem entregar filas antigas.

Cancelar uma campanha cancela apenas itens pendentes. Mensagens já entregues continuam no histórico do destinatário, mesmo após descadastro ou cancelamento. A leitura é uma marcação explícita e idempotente pela conta; não comprova atenção, identidade civil ou abertura por uma pessoa específica. Não há telemetria de abertura nem listas de leitores para operadores.

## Limites e recuperação de pedidos

Título de 2 a 120 caracteres, mensagem de texto simples de 1 a 4.000, normalizados e sem controles inválidos. O limite global da API é 8.192 bytes de JSON; textos com caracteres de vários bytes podem atingir esse limite antes de 4.000 caracteres. HTML é apresentado literalmente. Limites iniciais: 500 campanhas por instalação, 5.000 destinatários por campanha, listagem paginada de 20 na interface e até 50 por chamada de API.

A chave de criação tem 32 caracteres hexadecimais e é única por administrador. Mesmo pedido e chave retornam a campanha existente; mudar o conteúdo sob a chave gera conflito. Cada lote tem outra chave persistida com seu resultado: repetir não avança os próximos 50 destinatários. Os contadores da campanha refletem o estado atual; o resultado do lote repetido conserva o resultado daquele lote.

Se a resposta se perder, a interface conserva pedido e chave na aba e bloqueia novas escolhas. Verificar campanhas consulta a chave de criação; reenviar usa o mesmo pedido. Não há repetição automática de POST, persistência de rascunhos em armazenamento do navegador ou retomada depois de fechar a aba. Não crie outra campanha para tentar confirmar uma anterior sem verificar a lista. Cancelamento também admite reenvio sem duplicar entregas.

## API e autorização

Todas as rotas administrativas revalidam uma sessão ativa de administrador dentro da transação. Operadores não gerenciam campanhas. Escritas exigem origem exata e CSRF. Identidades destinatárias vêm do banco, nunca do corpo da requisição.

| Método e rota | Corpo / resultado |
| --- | --- |
| POST `/api/campaigns/preview` | `{title,text}` → título/texto normalizados, quantidade, aviso e `audienceHash` |
| POST `/api/campaigns` | `{title,text,audienceHash,clientKey}` → `{campaign,created}`, 201 na criação ou 200 no reenvio |
| GET `/api/campaigns?page=1&limit=20` | lista e total; sem mensagem completa nem identidades |
| GET `/api/campaigns/request/:key` | campanha da chave deste administrador ou 404 |
| GET `/api/campaigns/:id` | detalhe e contadores de estado |
| POST `/api/campaigns/:id/process` | `{clientKey}` → campanha, resultado do lote e indicação de reenvio |
| POST `/api/campaigns/:id/cancel` | `{}` → campanha com pendências canceladas |
| GET `/api/portal/news?page=1&limit=20` | sessão do portal; apenas novidades entregues à própria conta |
| POST `/api/portal/news/:id/read` | `{}`; sessão do portal, origem e CSRF; outra conta ou item não entregue retorna 404 |

## Atualização explícita do banco

Schema 9 adiciona `cl_campaigns`, `cl_campaign_recipients` e `cl_campaign_batches` às dezoito tabelas existentes. Todas usam InnoDB; chaves, colunas, índices, collation e referências são validados antes de atualizar o marcador. Não há DDL no cron ou na inicialização.

1. Publicar a release 0.11 e confirmar hash, CI e compatibilidade com schema 8. Somente campanhas/novidades aguardam preparação; atendimento e preferências continuam funcionando.
2. Criar backup privado fresco das dezoito tabelas, incluindo limites; conferir tamanho, checksum e permissões. Registrar fingerprints de dados e DDL lógicos, normalizando somente a alteração prevista do marcador 8 → 9. Preservar uma release compatível com 9 para recuperação.
3. No ambiente dedicado autorizado, com configuração privada carregada, executar `node scripts/migrate-database.js`. Comparar dados anteriores, validar as três tabelas novas vazias e executar `node scripts/check-installation.js`.
4. Executar `node scripts/verify-campaigns-database.js` manualmente. Ele exige exatamente 21 tabelas InnoDB, usa somente fixtures sintéticas não confirmadas, reverte a transação externa e compara o fingerprint completo dos registros e DDL lógicos. Registra apenas resultados genéricos. Não inclui destinatários operacionais nos lotes do ensaio.
5. Conferir a API HTTPS, assets e hash servido. Registrar separadamente evidência SQL real, interface com modelo local e ensaio autenticado HTTPS. Uma dessas evidências não substitui as demais.

Não voltar ao código 0.10 após schema 9, reduzir o marcador ou apagar tabelas para recuperar. Ferramentas HTTPS exclusivas dos schemas 7/8 e seus journals anteriores não devem ser reutilizados como ensaio de campanhas. Não executar fixtures no cron, não zerar quotas e não sobrescrever backups ou journals.

## Escopo restante

Este é um primeiro módulo funcional de campanhas no portal. Trabalhador automático, agendamento, segmentação, filtros avançados, retenção/exportação da auditoria e ensaio de concorrência entre conexões continuam pendentes. O instalador simples e a homologação de recuperação/restauração continuam necessários antes de uma versão pública 1.0. Não representa um CRM completo nem substituição universal da rede de mensagens do WhatsApp.


Verificação autenticada manual: [ensaio HTTPS protegido](VERIFICACAO-HTTPS-CAMPANHAS.md), exclusivo de schema9/base operacional vazia e backup/journal novos. Distinguir testes de rotas/modelos, sessões preparadas e homologação real; nenhuma entrega a pessoas reais.
