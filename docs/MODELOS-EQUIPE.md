# Modelos privados da equipe

O administrador cadastra respostas em `/respostas`, com título, texto, disponibilidade e escopo: toda a empresa ou uma área. Os textos ficam no MySQL e são consultados por APIs autenticadas; não são incorporados aos arquivos públicos do site. Limite de 500 modelos, incluindo desativados. Não há exclusão neste módulo: desative para preservar o registro.

Na caixa de atendimento, assuma uma conversa aberta, escolha **Respostas rápidas → Modelos da equipe**, busque e confira a prévia. **Acrescentar ao rascunho** consulta novamente a permissão e a versão do modelo. Se ele mudou, confira a nova prévia antes de clicar novamente. O rascunho anterior permanece, com uma linha em branco separando os textos. O envio continua sendo uma ação explícita do operador no formulário de resposta.

Somente o responsável pela conversa aberta consulta o catálogo do atendimento. A área precisa estar ativa e o operador vinculado a ela. São exibidos modelos ativos da empresa e daquela área. Administradores podem gerenciar todos os modelos, inclusive desativados; para usar um modelo no atendimento também precisam ser o responsável. Remover o vínculo, desativar a área, transferir o responsável ou revogar a sessão impede novas consultas. Um modelo já acrescentado vira texto editável no rascunho: desativá-lo não apaga respostas ou rascunhos existentes.

## Variáveis e limites

As únicas variáveis são `{{visitante}}`, `{{operador}}` e `{{area}}`. A substituição usa texto literal em uma única passagem; não executa HTML ou outras variáveis dentro dos nomes. Não use segredos nos modelos. Título: até 100 caracteres; texto: até 2.000. O limite da mensagem é conferido novamente depois da substituição e do acréscimo ao rascunho; se exceder 2.000 caracteres, nenhum texto é alterado. Nomes interpolados são limitados e limpos de controles visuais. Modelos básicos originais continuam disponíveis sem o catálogo privado.

## Edição concorrente e rede

A criação usa uma chave por pedido. Quando a rede não confirma o resultado, os campos ficam bloqueados e **Reenviar o mesmo pedido** reutiliza exatamente a chave e o corpo originais. O mesmo pedido não cria um segundo modelo. A chave reutilizada com conteúdo diferente é recusada.

A edição exige a versão lida. Se outra pessoa editou, a API retorna 409 e a tela preserva sua proposta, mostrando a versão atual do servidor. Compare texto, escopo e disponibilidade; só então use **Revisei: continuar com esta versão** e salve. O botão adota a versão atual para a próxima tentativa, mantendo seus campos propostos. Uma resposta perdida após edição pode resultar nesse mesmo conflito na repetição; não significa que o primeiro pedido falhou. Uma gravação sem alterações mantém a versão.

## Instalação e atualização

Schema 10 acrescenta somente `cl_reply_templates` ao schema 9 completo. O cron publica código e testa releases; não migra banco. Código v0.15.0 reconhece schemas 1 a 10, e o catálogo retorna 503 até a migração explícita. `replyCatalogImplemented` em `/health` indica código disponível; a capacidade autenticada `replies` indica schema preparado, sem comprovar homologação integral.

Antes de atualizar uma instalação existente, faça backup privado fresco do banco e da configuração conforme [backup e restauração](BACKUP-RESTAURACAO.md). Publique código compatível e, na aplicação dedicada e com configuração privada carregada, execute `npm run migrate:database -- --target-version 10`; valide com `npm run check:installation`. Banco novo pode usar o [instalador](INSTALADOR-CPANEL.md), cujo alvo atual é 10.

Backups de schema 10 contêm os modelos e seus contadores. A restauração exige destino vazio preparado explicitamente na mesma versão e revoga sessões. Não faça downgrade do marcador nem ative código antigo que recusa schema 10; recuperação do schema 9 requer destino separado vazio preparado como 9 e seu backup correspondente. Dados privados, configurações e backups nunca devem ir ao GitHub.

API: administração em `GET/POST /api/replies/templates`, `GET/PUT /api/replies/templates/:id`; consulta do operador em `GET /api/chat/team/conversations/:id/replies` e `GET /api/chat/team/conversations/:id/replies/:templateId`. Listas aceitam `page` (1–10.000), `limit` (1–50) e `q` (até 100 caracteres); o padrão é 20 por página. Busca trata `%` e `_` literalmente. Escritas exigem sessão de administrador, origem autorizada e CSRF. Criação recebe `departmentId` (inteiro ou null), `title`, `text`, `active` (booleano), `clientKey` (32 hex); edição recebe os quatro campos e `version` (inteiro positivo), sem chave de criação. Não há endpoint que envie uma mensagem ao selecionar um modelo.

Favoritos, atalhos personalizados, histórico completo de edição, anexos, editor de fluxos e transferência explícita para humano permanecem no backlog. A entrega não equivale a CRM completo nem a garantia de perfeição.
