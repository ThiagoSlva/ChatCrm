# Inscrição e descadastro no portal — v0.10

Esta entrega prepara a escolha de receber novidades no canal próprio. Não implementa envio de campanhas, caixa de novidades, agendamento, WhatsApp ou e-mail. campaignsImplemented continua false. Nenhuma conta é inscrita ao cadastrar contato/lead, abrir atendimento ou criar/recuperar acesso.

## Escolha do cliente

Somente a sessão própria do portal consulta/altera sua inscrição, em GET/POST /api/portal/subscription. Cookies e CSRF são os do portal, com Origem exata e JSON estrito. Não recebe accountId de um operador ou do cliente; a identidade vem da sessão revalidada na mesma transação da gravação.

DTO público: preference contém subscribed, version, noticeVersion e updatedAt. Sem evento, subscribed:false/version:0. A escolha tem aviso portal-news-v1: receber novidades desta empresa na caixa do portal e poder cancelar sem mudar atendimentos. Não é uma garantia de identidade civil/e-mail ou de conformidade legal universal.

A interface usa ações separadas e explícitas, estado textual e feedback acessível. A confirmação depende da resposta da API. Em resultado incerto, bloqueia nova escolha, consulta o estado salvo e permite reenviar somente a mesma chave/payload quando não confirmado. Não guarda tokens, consentimento ou rascunho em armazenamento do navegador. Atendimento e inscrição têm estados separados.

## Histórico e alterações simultâneas

Schema8 acrescenta somente cl_portal_subscription_events: account_id/version como chave primária, chave única por conta/client_key, estado, versão do aviso, hash do pedido e UTC. A conta existente e o vínculo ao visitante são preservados. Eventos são imutáveis pela API; a preferência é o evento mais recente. Ausência de histórico significa descadastrado.

POST requer subscribed:boolean, version:uint incluindo zero, noticeVersion:portal-news-v1 e clientKey:32hex. Versão antiga com chave nova retorna409. Repetição da chave com outro conteúdo retorna409. Replay válido não cria evento e retorna a escolha ATUAL; replay de uma inscrição anterior depois do descadastro nunca reinscreve nem mostra estado antigo. Pedido sem mudança não cria histórico.

Uma quota de100 alterações por conta nas últimas24h limita novas inscrições; a expiração é natural. Descadastro de uma inscrição ativa permanece permitido mesmo nessa quota. Não limpar quotas ou histórico para obter novas tentativas. Histórico/retencão e execução de campanhas ainda precisam de evolução; não presumir confirmação de recebimento ou leitura.

Campanhas futuras devem revalidar conta ativa, última inscrição e preferência de canal durante cada envio. Descadastro deverá impedir fila pendente. Este módulo não envia mensagens e não deve ser usado para prometer essas etapas como concluídas.

## Atualização e homologação

v0.10 aceita schemas1..8; em7, atendimento/portal continuam funcionando e apenas inscrição retorna503. Publicar e verificar a release compatível antes de DDL. Fazer backup privado fresco das dezessete tabelas existentes, incluindo limites, com checksum/fingerprint e permissões privadas; backup anterior sem integridade não serve como prova. Preserve uma release0.10 compatível.

~~~sh
node --env-file="$APP_ROOT/.env" "$APP_ROOT/current/scripts/migrate-database.js"
node --env-file="$APP_ROOT/.env" "$APP_ROOT/current/scripts/check-installation.js" --json
node --env-file="$APP_ROOT/.env" "$APP_ROOT/current/scripts/verify-subscriptions-database.js"
~~~

Migrador padrão prepara8 em instalações novas e atualiza7. CREATE IF NOT EXISTS permite retomar a tabela parcial; marcador só avança depois de conferir tipos/defaults, collation, InnoDB, índices e FK local RESTRICT. Nunca diminuir o marcador, apagar tabelas ou usar código0.9 depois de8. Compare registros/DDL anteriores: somente o valor previsto do marcador7→8 pode mudar. Não executar scripts antigos de fixtures HTTPS7 em8; eles recusam outro schema por segurança.

O verificador SQL18 usa duas identidades sintéticas em uma transação externa revertida. Confere isolamento, default desligado, replay, versão antiga, falha de inserção revertida, quota diária/expiração/descadastro e preferência preservada após recuperação. Compara registros/DDL das dezoito tabelas depois do rollback. Não equivale a concorrência entre conexões, teste HTTPS publicado, frontend, carga, retenção ou restauração.

Frontend deve seguir docs/skills/chatcrm-frontend-quality/SKILL.md. Ensaios locais reais usam somente dados sintéticos e são registrados em ANDAMENTO.md; captura local não prova sessão hospedada. O cron não migra, não cria clientes e não executa estes verificadores.
