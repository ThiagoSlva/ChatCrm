# Respostas rápidas no atendimento

Desde v0.14.0, o responsável por um atendimento aberto pode usar seis modelos originais para preparar respostas: boas-vindas, entender a solicitação, conferir informações, combinar próximos passos, confirmar solução e agradecer o contato.

Em Atendimento, selecione uma conversa assumida por você, abra **Respostas rápidas**, busque um modelo e confira a prévia. **Acrescentar ao rascunho** mantém o texto que já existe e adiciona o modelo separado por uma linha em branco. O editor recebe o foco no fim do texto; você pode alterar a resposta antes de usar **Enviar resposta**. Selecionar ou inserir um modelo não envia mensagem, encerra atendimento ou altera o CRM.

Os modelos de boas-vindas e agradecimento usam somente o nome informado pelo visitante, o nome do operador e a área da conversa confirmada. Esses valores são texto literal, nunca HTML ou comandos. Nomes são normalizados, controles removidos e limitados a80 caracteres com reticências quando necessário. Confira a prévia: o nome do visitante não comprova identidade. Não há acesso adicional a contatos, histórico ou campanhas.

O texto combinado precisa caber no limite de2.000 caracteres. Se ultrapassar, a inserção é recusada sem cortar ou substituir o rascunho. Enquanto o envio aguarda confirmação, os modelos ficam bloqueados para conservar o texto e sua chave de reenvio. Mudança de responsável, encerramento, estado não confirmado, operação em curso ou sessão inválida também impedem a inserção. O servidor continua verificando permissões no envio normal.

Busca ignora acentos e diferenças de maiúsculas; resultados e prévia têm labels. Tab percorre os controles, o seletor funciona com o teclado e Escape recolhe o painel devolvendo o foco ao botão. A busca fica fora do formulário de envio para Enter nela não enviar a resposta. Atualizações de estado conservam modelo, pesquisa e rascunho; selecionar outra conversa recolhe e reinicia o painel. Logout/revogação limpam os dados visíveis.

Esta primeira biblioteca vem no código público e não possui cadastro, edição permanente, favoritos ou compartilhamento de modelos por empresa/área. Editar o rascunho não altera o modelo. Não armazena os modelos ou rascunhos em localStorage/sessionStorage, não acrescenta endpoints de escrita, migração ou envio automático. O rascunho continua limitado à aba e sessão atuais, como no atendimento existente. Um catálogo privado gerido pelo administrador, com versões e escopos, é evolução pendente; a biblioteca inicial não deve ser chamada de catálogo compartilhado completo.

## Evidências e limites desta entrega

Sete testes de comportamento verificam variáveis literais, busca, adição sem envio, limite sem corte, chave pendente, bloqueios, Escape, limpeza e preservação nas atualizações. Os testes existentes de polling continuam aprovados e as URLs de assets novos são verificadas pelo hash do conteúdo. Suíte Windows356 testes355pass0fail1skip específico de Linux/57.8981622s.

A skill do projeto `docs/skills/chatcrm-frontend-quality/SKILL.md` foi aplicada. Revisão no navegador real com persistência simulada e dados fictícios: desktop,390px, nomes longos, Tab/seletor, busca sem acentos/vazia, Enter sem envio, Escape/foco, rascunho preservado, envio com resposta perdida/reenvio sem duplicação e revogação. Quatro controles novos mediram44/47/49/44px de altura em390px, largura291px e sem overflow horizontal do documento. Screenshots e provas ficam locais em storage ignorado. Isso não comprova leitor de tela, teclado virtual em aparelho físico, persistência MySQL desse ensaio ou fluxo autenticado no domínio hospedado; não garante perfeição. Deploy/CI/pacote e assets hospedados são registrados no andamento após confirmação.
