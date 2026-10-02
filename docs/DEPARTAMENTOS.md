# Departamentos e vínculos — v0.4.0

Em `/acesso`, o administrador cria áreas como Suporte e Comercial, renomeia, desativa ou reativa e gerencia o vínculo individual de cada operador. São permitidos até 50 departamentos, incluindo os desativados; nomes são únicos sem diferenciar maiúsculas de minúsculas. Não há exclusão física nem mudança de papel por este módulo.

O operador consulta apenas departamentos ativos aos quais está vinculado. Sem vínculo, não recebe acesso; trocar um ID não revela outra área. Remover o vínculo nega a próxima requisição, mesmo usando a sessão existente. Desativar um departamento preserva os vínculos e impede o acesso dos operadores; reativar permite novamente o acesso de operadores ativos ainda vinculados. Operadores inativos podem manter vínculos, mas continuam impedidos de entrar. Administradores gerenciam todos os departamentos.

A lista de membros é exclusiva do administrador e inclui operadores inativos para permitir organizar a equipe. Dados retornados não contêm senhas ou hashes. Cada escrita exige sessão administrativa ativa, origem exata e CSRF. IDs e paginação têm limites; campos extras e tipos JSON incorretos são recusados. Cadastro e limite são protegidos por unicidade e transação no banco; associação e remoção são idempotentes.

## API

| Método e rota | Permissão e resultado |
|---|---|
| `GET /api/team/departments` | Equipe; lista paginada autorizada |
| `GET /api/team/departments/:id` | Equipe; departamento autorizado ou 404 |
| `POST /api/team/departments` | Administrador; `{name}` cria departamento |
| `PATCH /api/team/departments/:id` | Administrador; `{name?, active?}`, ao menos um campo |
| `GET /api/team/departments/:id/members` | Administrador; operadores vinculados, paginados |
| `PUT /api/team/departments/:id/members/:userId` | Administrador; `{member: boolean}` adiciona ou remove vínculo |

Listas recebem `page` (1 a 10.000, padrão 1) e `limit` (1 a 50, padrão 20). Nomes são aparados e normalizados, com 2 a 100 caracteres e sem controles. Duplicidade ou limite de departamentos retorna 409; IDs inexistentes retornam 404. Papel e estado do ator são revalidados na persistência, sem depender da interface.

## Atualização do schema

Esta entrega adiciona `cl_departments` e `cl_department_members` no schema v2. A aplicação v0.4 aceita schema v1: login, senha e operadores continuam funcionando, enquanto `/api/auth/me` informa `capabilities.departments: false` e apenas as APIs de departamentos retornam 503. `/health` indica código implementado; não comprova migração ou saúde do banco.

Publique e confira a aplicação compatível antes de migrar. Faça backup privado do banco e preserve uma cópia dessa release compatível com v1/v2 para recuperação. Execute manualmente `scripts/migrate-database.js` com a configuração privada, conforme [instalação](INSTALACAO-ACESSO.md). O cron nunca executa DDL. O migrador valida estrutura, índices, chaves estrangeiras, defaults, collation e engine; só marca v2 após concluir. Uma interrupção mantém v1 e permite retomar a criação das tabelas; alterações incompatíveis são recusadas para revisão, sem tentar sobrescrever dados.

Reversão após a migração precisa de código compatível com schema v2. As versões v0.3 e anteriores recusam v2; apontar `current` para elas não recupera o acesso. Não reduzir o marcador nem apagar as tabelas para contornar isso. Uma recuperação de dados exige backup validado e procedimento específico; DDL MySQL não é desfeito por rollback de transação.

## Verificação e limites

`scripts/verify-departments-database.js` executa explicitamente os fluxos com usuários e departamentos sintéticos, dentro de uma transação revertida. Não migra, não modifica contas reais e não deixa vínculos de teste. Usa somente o banco exclusivo configurado; não deve rodar automaticamente no cron ou CI. Exemplo com o ambiente Node ativo e a raiz privada definida:

```sh
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-departments-database.js"
```

Testes locais cobrem autorização, tipos, paginação, limite e conflitos com atores modificados. O verificador SQL usa uma conexão com savepoints; não prova concorrência entre processos nem testa o limite de 50 no banco real. Registre hash servido, Actions e verificações efetivamente executadas em [andamento](ANDAMENTO.md). Revisão visual autenticada permanece pendente até uma sessão/preview autorizado disponível.

Este módulo prepara a separação do atendimento; ainda não há chat ou mensagens. Quando forem implementados, autorização do departamento e gravação da mensagem precisarão compartilhar a transação para impedir envio após remoção concorrente do vínculo.
