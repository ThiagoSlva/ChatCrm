# Operadores e permissões — v0.2.0

Entre em `/acesso` como administrador. O painel mostra a lista paginada e o formulário de cadastro de operadores. Informe nome, e-mail e senha exclusiva de pelo menos 15 caracteres. Compartilhe esse acesso diretamente com a pessoa por um canal privado; esta versão não envia convites por e-mail.

Um administrador gerencia a equipe; um operador acessa seu perfil e terá acesso ao atendimento quando o chat for implementado. Operadores não listam, criam, ativam nem desativam outros usuários. A API verifica o papel a cada requisição, além de exigir origem exata e CSRF para as escritas. Não há promoção para administrador por este módulo. O administrador inicial não pode ser desativado por uma rota de operadores.

Desativar mantém o cadastro e revoga todas as sessões desse operador na mesma transação. Um login concorrente verifica o estado ativo com trava antes de salvar a sessão. Reativar permite novo login com a senha existente; cookies revogados continuam inválidos. Não existe exclusão permanente, alteração de senha pelo administrador ou recuperação automática nesta entrega.

O cadastro usa scrypt, e-mail único sem diferenciar maiúsculas e minúsculas e papel fixo `operator`. Nenhum hash ou senha aparece nas respostas da API. Campos extras, inclusive `role`, são recusados. Há limite inicial de 200 operadores por instalação, contando desativados, e paginação com até 50 registros. Criação de operador compartilha com login o limite atual de tentativas por IP e de dois cálculos de senha simultâneos. A limitação ainda reside no processo; departamentos, permissões por conversa, auditoria e limitação persistida são próximos passos.

## API implementada

| Método e caminho | Entrada | Resultado |
|---|---|---|
| `GET /api/team/operators?page=1&limit=20` | Cookie do administrador | `users`, `total`, `page`, `limit` |
| `POST /api/team/operators` | `name`, `email`, `password`; cookie, origem e CSRF | 201 com `user`; 409 para e-mail existente ou limite de operadores |
| `PATCH /api/team/operators/:id` | `active` booleano; cookie, origem e CSRF | 200 com `user`; 404 para ID inexistente ou administrador |

Uma instalação continua representando uma empresa. Não existem permissões administrativas no widget ou API pública de integração nesta versão.

## Verificação no banco real

Os testes automatizados locais cobrem autorização, CSRF, cadastro, paginação, desativação, reativação e login concorrente com persistência simulada. O comando explícito abaixo verifica SQL e rotas da aplicação com MySQL/MariaDB real:

```sh
node --env-file=/CAMINHO_PRIVADO/.env scripts/verify-team-database.js
```

O verificador usa uma única conexão e uma transação externa revertida, com savepoints para as transações do repositório. Contas, senhas aleatórias e sessões de teste não são commitadas e não ficam acessíveis aos usuários da aplicação. Ao terminar, verifica que as contas não persistiram. Nenhuma senha é exibida. Podem ocorrer lacunas normais no contador de IDs; a verificação não executa DDL. Não roda automaticamente em CI ou no cron, nem substitui backup, teste de concorrência entre conexões ou ensaio de carga.

O comando `verify:access` também confere a leitura da equipe pelo administrador e a recusa de desativá-lo por HTTPS, usando somente a conta de teste existente. Veja [instalação e acesso](INSTALACAO-ACESSO.md).
