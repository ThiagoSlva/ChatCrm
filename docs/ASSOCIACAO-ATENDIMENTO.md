# Associação manual entre atendimento e contato

Recorte da v0.8.0: ligar um atendimento a um contato já cadastrado na mesma área, trocar ou remover essa associação e consultar seu histórico. Visitante, contato e oportunidade continuam entidades distintas. Nenhum nome, e-mail ou telefone comprova identidade; a associação não autentica o visitante, não une contas e não concede acesso ao CRM ou a outras conversas. Nenhuma oportunidade é criada automaticamente.

## Permissões e integridade

A equipe pode ler a associação e seus eventos quando a sessão e o usuário estão ativos e a área do atendimento está ativa. Operadores precisam do vínculo atual com essa área; administradores podem ler as áreas ativas. A autorização é consultada no banco a cada operação, inclusive após revogação, desativação ou troca de responsável.

Só o responsável por um atendimento `open` pode alterar sua associação. Essa regra inclui administradores: ser administrador não permite editar o atendimento de outra pessoa. Atendimento aguardando responsável ou encerrado permite leitura autorizada, mas recusa mudanças com 409. Um contato candidato precisa pertencer à mesma área da conversa, inclusive quando quem edita é administrador; candidato ausente ou de outra área recebe 404.

Cada operação adquire a trava da linha permanente `cl_schema` antes da primeira leitura consistente, consulta a capacidade e revalida ator, sessão, conversa, área e vínculo na mesma transação. A gravação da associação e seu evento é indivisível. Joins de leitura restringem o contato à área atual da conversa e não expõem IDs, nomes ou classificação de contatos de outra área.

## API da equipe

Rotas protegidas pela sessão da equipe:

| Método e rota | Comportamento |
| --- | --- |
| `GET /api/crm/conversations/:id/contact` | Retorna `{link}`; atendimento ausente ou sem acesso recebe 404. |
| `PATCH /api/crm/conversations/:id/contact` | Recebe exatamente `{version, contactId}`; exige origem/CSRF válidos e retorna `{link}`. |
| `GET /api/crm/conversations/:id/contact/events?page=1&limit=20` | Retorna `{events,total,page,limit}` em versão decrescente; página 1..10000, limite 1..50. |

IDs são números inteiros de 1 a 4294967295. `contactId` aceita somente ID válido ou `null`; `null` remove a associação. `version` é um inteiro de 0 a 4294967295. Campos extras, arrays, coerção de tipos e parâmetros de consulta não previstos são recusados. Não existe rota equivalente para visitante.

A resposta `link` contém somente:

```json
{
  "conversationId": 123,
  "departmentId": 4,
  "version": 0,
  "contactId": null,
  "contactName": null,
  "contactKind": null,
  "updatedAt": null,
  "canEdit": true
}
```

Sem registro anterior, a versão é 0. O primeiro vínculo grava versão 1. Trocar ou remover incrementa a versão; a linha permanece mesmo com `contactId:null`, impedindo que uma remoção seguida de nova associação pareça a primeira gravação. Uma versão desatualizada recebe 409, mesmo quando o contato desejado coincide com o atual. Com a versão correta, repetir o mesmo valor retorna o estado atual sem gravação, nova versão ou evento. Remover uma associação que nunca existiu com `{version:0,contactId:null}` também não cria registro.

Após uma resposta de gravação incerta, consulte o estado atual e revise a versão antes de reenviar. A versão é uma proteção contra sobrescrita; não existe chave idempotente independente para esse PATCH. Não sobrescrever automaticamente uma alteração feita por outro responsável.

`canEdit` reflete o responsável e estado atuais. Nomes e classificação do contato também são atuais. Cada evento contém exatamente `version`, `contactId`, `contactName`, `actorName` e `createdAt`. O histórico guarda os identificadores e a data UTC de cada mudança; nomes são obtidos por joins atuais, inclusive para autores hoje desativados. Ele não é uma cópia histórica dos nomes, não retorna e-mail/telefone/empresa e não expõe dados ao visitante.

Uma conversa aceita até 100 mudanças registradas; a instalação aceita até 50000 eventos de associação. Uma nova mudança acima desses limites recebe 429. Leitura e no-op com versão correta continuam disponíveis. Não apagar histórico nem reduzir versões para contornar os limites. Credenciais/sessões inválidas recebem 401; schema ainda sem o módulo recebe 503.

## Banco e migração explícita

Schema6 acrescenta duas tabelas InnoDB com FKs locais RESTRICT, sem alterar registros das treze tabelas anteriores:

- `cl_conversation_contacts`: PK `conversation_id` para `cl_chat_conversations`; `contact_id` nullable para `cl_contacts`; versão unsigned com padrão 1; `updated_by` para `cl_users`; data `updated_at` UTC explícita sem DEFAULT.
- `cl_conversation_contact_events`: PK composta `(conversation_id,version)`; conversa referenciando a linha de associação; contato nullable; autor para `cl_users`; data `created_at` UTC explícita sem DEFAULT.

A referência do evento à linha atual exige que a associação sobreviva à remoção do contato. O backend insere o evento com `INSERT SELECT` dos valores persistidos, usando o mesmo ator/data da atualização. Uma falha no evento reverte também a nova associação ou a mudança de versão.

Publique primeiro a release v0.8 compatível com schema5 e confirme o hash em `/health`. Valide acesso, atendimento, contatos e vendas antes do DDL; apenas a associação deve responder preparação pendente/503 enquanto `conversationContacts` não está disponível. O cron de deploy não migra banco, e o bootstrap/configuração privados não mudam.

Antes da migração, crie e revalide um backup privado atualizado de todas as treze tabelas do schema5, com permissões restritas. Preserve uma release v0.8 compatível para recuperação. Execute o migrador explicitamente com o runtime Node da aplicação e o ambiente privado, seguindo [DEPLOY-CPANEL.md](DEPLOY-CPANEL.md). Ele só avança o marcador para6 depois de validar as duas novas tabelas e toda a estrutura anterior; preparação parcial não permite usar o módulo.

Depois, compare os registros anteriores e canais privados com a evidência pré-migração; confirme quinze tabelas, schema6, capacidade `conversationContacts:true` e hash servido. Código v0.7 não aceita schema6: não recuperar uma release antiga incompatível, não reduzir marcador e não apagar tabelas para voltar. Recuperação de código deve usar uma release compatível; restauração de dados requer procedimento privado verificado. A existência de backup não comprova restauração.

## Verificação manual e evidências

Com `CHATCRM_APP_ROOT` definido privadamente e o ambiente Node da aplicação ativado, execute explicitamente:

```sh
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-conversation-contacts-database.js"
```

O verificador só opera com schema6 validado. Cria administradores/operadores, sessões, duas áreas, contatos, visitantes e conversas sintéticos em uma transação externa nunca confirmada. Operações do repositório usam savepoints; não autentica nem altera a senha de usuários reais, não publica canais e não envia mensagens. A injeção de falha de evento alcança somente IDs sintéticos dessa execução. Todos os dados temporários são revertidos, sem DDL nem limpeza ampla.

O fingerprint compara registros e DDL lógico das quinze tabelas antes/depois, também após falha funcional quando a leitura inicial foi concluída. Ignora somente o avanço legítimo de `AUTO_INCREMENT`, pois números consumidos pelo InnoDB não são revertidos. Não imprime registros, credenciais ou caminhos privados. Não executar esse script automaticamente no cron/CI.

Critérios verificáveis: versão inicial0 e no-op sem linha; primeira associação/evento1; troca, remoção e reassociação sem ABA; conflito de versão antes de no-op; contato da mesma área; responsável/estado atuais incluindo administrador; paginação e campos seguros; nomes atuais; revogação/expiração/desativação; falha de evento revertendo criação e edição; limite por conversa e preservação integral após rollback. O ensaio do limite por conversa usa 100 eventos sintéticos revertidos; não comprova saturação real de 50000 eventos globais.

Este ensaio de uma conexão não comprova concorrência entre conexões, processos ou carga. O verificador anterior `verify-crm-concurrency.js` é exclusivo de schema5 e recusa schema6; não o execute depois desta migração. Seu resultado anterior continua válido para o recorte já homologado de oportunidades, sem ampliar a prova à associação. Validar depois HTTP/CSRF, respostas incertas, teclado, largura móvel e fluxo autenticado, registrando resultados reais na memória do projeto. Implementação e testes locais não equivalem a homologação no servidor.


## Interface e homologação v0.8

Em /atendimento, o contexto fica recolhido até consulta manual. Busque contatos da mesma área, escolha entre todas as páginas e confira a alteração preparada; salvar exige confirmação humana. Consultar/adotar uma versão após erro não salva nem reaplica o pedido. Ao recolher/trocar conversa, o pedido incerto fica somente na memória da aba e exige revalidação ao retornar; troca de conta/revogação elimina esse contexto. Sem armazenamento permanente no navegador ou polling adicional.

Contato indisponível não comprova revogação da conversa: a interface limpa CRM e revalida metadata antes de ocultar chat. Falha na revalidação bloqueia alterações e preserva seleção/rascunho. Associação503 mantém atendimento disponível. Nomes atuais no histórico não comprovam identidade.

Em02/10/2026:161 testes locais/CI/cron,31 ensaios DOM sintéticos,13checks MariaDB de associação com rollback e39HTTPS passaram. Visual autenticado foi revisado em fixture local sintética, desktop1280/móvel390; no domínio publicou-se a entrada sem sessão. Evidências e limites completos em [ANDAMENTO.md](ANDAMENTO.md). Concorrência real deste módulo, duas pessoas HTTPS e restauração seguem pendentes.
