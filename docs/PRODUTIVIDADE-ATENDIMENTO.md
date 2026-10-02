# Produtividade no atendimento — v0.5.1

A fila em `/atendimento` inicia com atendimentos ativos e todos os responsáveis. Busca por nome de visitante ou departamento, situação e responsabilidade podem ser combinadas. Aplicar volta à página 1; Limpar restaura o padrão. Busca não percorre o texto de mensagens e não salva nomes na URL da página, no histórico ou no armazenamento persistente do navegador.

Ao assumir, liberar ou encerrar, a conversa selecionada permanece aberta mesmo se sair do filtro ou da página. Uma indicação explica essa condição. O detalhe é confirmado separadamente pela API; falha de rede preserva histórico e rascunho e bloqueia ações até nova confirmação. Revogação de acesso remove o histórico visível. Rascunhos e chaves de reenvio continuam somente na memória da aba e são apagados ao trocar a identidade da equipe.

Ctrl+Enter ou Command+Enter envia pelo mesmo formulário e pela mesma chave idempotente. Enter sozinho insere uma linha; composição de texto não aciona o atalho. O envio exige os mesmos limites, permissões e estado do botão.

## Contrato da API

`GET /api/chat/team/conversations` exige sessão atual da equipe, schema v3 e departamento ativo autorizado. Mantém `{conversations,total,page,limit}`:

| Parâmetro | Valores |
| --- | --- |
| page | 1 a 10000, padrão 1 |
| limit | 1 a 50, padrão 20 |
| status | all (padrão API), active (waiting/open), waiting, open ou closed |
| assignment | any (padrão), me (identidade atual) ou unassigned |
| q | Até 100 caracteres, sem controles; trim e NFC; padrão vazio |

Parâmetros desconhecidos, duplicados e enums inválidos são recusados. Ausência de filtros mantém a listagem anterior. A busca usa parâmetros preparados e escape explícito `!` no LIKE: %, _ e ! são literais, assim como barra invertida. Comparação de maiúsculas/acentos segue a collation do banco. Contagem e página usam exatamente o mesmo escopo e filtros na transação.

`GET /api/chat/team/conversations/:id` retorna `{conversation}` com id, departmentId, departmentName, visitorName, status, assignedTo e updatedAt, independentemente do filtro da fila. Revalida token, conta, departamento e vínculo. Não expõe token, e-mail, hashes ou identidade privada do visitante. Retorna 404 para conversa ausente/inacessível, 401 sem sessão e 503 sem schema preparado.

## Validação e limites

A suíte HTTP cobre combinações, paginação, nomes Unicode, símbolos literais, consultas duplicadas, detalhe fora da fila e acesso revogado. O verificador SQL explícito usa nomes sintéticos e rollback; a verificação HTTPS lê os filtros/detalhe com a conta autorizada, sem persistir conversas. Consulte ANDAMENTO.md para resultados reais. Testes DOM simulados não substituem revisão visual autenticada, concorrência entre conexões nem carga.

A release mantém schema v3, sem DDL, mudança de senha ou habilitação automática de canais. Filtros personalizados salvos, pesquisa de mensagens e respostas rápidas continuam no backlog.

Referências de comportamento: [filtros do Chatwoot](https://www.chatwoot.com/hc/user-guide/articles/1677698771-group-chats-with-filters-save-as-folders) e [painel de atendimento](https://www.chatwoot.com/hc/user-guide/articles/1677231493-lesson-2-dashboard-basics). Os recursos são implementados no código original MIT do projeto.
