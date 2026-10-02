# Instalação e acesso — v0.4.0

Esta entrega inclui instalação, autenticação, gestão de operadores, troca da própria senha e departamentos. Chat, recuperação de senha esquecida e CRM ainda estão em desenvolvimento. Os testes automatizados usam persistência simulada; os verificadores explícitos homologam os fluxos com MariaDB real e HTTPS na hospedagem de testes. Essa evidência cobre os módulos registrados no andamento, sem homologar o CRM completo ou outros provedores.

## Configuração privada

Crie um banco **exclusivo e vazio** e um usuário MySQL com acesso somente a esse banco. Não reutilize bancos de WordPress ou outros sites. O usuário de migração precisa criar tabelas e índices; o aplicativo precisa consultar, inserir, atualizar e excluir suas próprias linhas. Não conceda privilégios globais nem habilite acesso remoto para instalar este sistema.

Na instalação simples, copie `.env.example` para `.env` fora da pasta pública, com leitura restrita ao dono da aplicação. Preencha os nomes completos fornecidos pelo cPanel, incluindo o prefixo da conta:

```dotenv
NODE_ENV=production
APP_URL=https://suporte.suaempresa.com.br
DB_HOST=localhost
DB_PORT=3306
DB_NAME=CONTA_banco_exclusivo
DB_USER=CONTA_usuario_exclusivo
DB_PASSWORD=
SETUP_TOKEN=
```

Os campos vazios acima são intencionais. Use uma senha exclusiva do banco e um segredo aleatório de instalação com pelo menos 32 caracteres. Um gerenciador de senhas pode gerar ambos. Nunca publique esses valores nem os envie pela conversa. Também é possível configurar variáveis pelo gerenciador Node; o terminal e o cron podem não herdar essas variáveis.

`APP_URL` deve ser a origem HTTPS exata do sistema, sem subcaminho, credenciais, parâmetros ou fragmentos. Para desenvolvimento local, fora de produção, aceita `http://127.0.0.1:3000` ou `http://localhost:3000`. HTTPS é obrigatório em produção.

## Preparar a estrutura

Na instalação simples, no diretório do projeto:

```sh
npm ci --omit=dev --ignore-scripts
npm run check:database
npm run migrate:database
npm start
```

A migração cria a base v1 (`cl_schema`, `cl_company`, `cl_users` e `cl_sessions`) e acrescenta `cl_departments` e `cl_department_members` para v2. Recusa tabelas de outro sistema e versões desconhecidas. DDL não é revertido por uma transação no MySQL: uma instalação interrompida preserva o marcador v0 ou v1 conforme a etapa e pode retomar. O marcador só muda após terminar e verificar a estrutura correspondente. Não há comandos DROP, TRUNCATE ou migração automática no processo web. Instalações existentes precisam de backup privado e aplicação compatível antes de executar; leia [departamentos e atualização v2](DEPARTAMENTOS.md). A versão v0.4 funciona também em v1, mantendo somente departamentos bloqueados até a migração.

No ambiente de releases deste projeto, o arquivo privado fica em `<APP_ROOT>/.env`. O bootstrap já carrega esse arquivo, preservado entre deploys. Ative o ambiente Node e execute explicitamente com a configuração privada:

```sh
source "$CHATCRM_NODE_ENV"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/check-database.js"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/migrate-database.js"
```

Defina antes `CHATCRM_NODE_ENV` e `CHATCRM_APP_ROOT` com os caminhos privados mostrados pelo seu gerenciador, conforme o guia de deploy. Depois reinicie somente a aplicação deste projeto pelo gerenciador Node. Não coloque `.env` dentro de `current`, `releases`, da pasta do domínio ou do clone Git. Não copie arquivos privados junto com o pacote público.

## Primeiro acesso

Abra `/acesso`. A tela informa se falta configuração ou migração. Quando o banco estiver pronto, informe empresa, nome, e-mail, senha de pelo menos 15 caracteres e segredo de instalação. Crie o administrador e entre com e-mail e senha. Remova `SETUP_TOKEN` da configuração e reinicie após concluir; o banco bloqueia uma segunda instalação mesmo que o segredo ainda esteja configurado.

O primeiro cadastro usa uma transação e trava na linha única do schema para impedir dois administradores iniciais em requisições concorrentes. A criação da empresa e do usuário acontece na mesma transação.

## Verificação repetível de acesso

O comando `npm run verify:access -- CAMINHO_PRIVADO` verifica uma instalação já configurada por HTTPS: acesso anônimo, origem estrangeira, senha incorreta, login, cookie seguro, perfil, CSRF, logout e revogação. O arquivo privado contém o e-mail e a senha do usuário usado no teste; mantenha-o fora do Git e da pasta pública, com acesso restrito ao dono. O comando não cria administradores nem altera senhas e não imprime credenciais ou tokens. Ele abre e encerra uma sessão de verificação.

Este comando é explícito: não roda em CI, `npm test` ou no cron de deploy. Esses processos continuam isolados do banco real. Para esta hospedagem:

```sh
source "$CHATCRM_NODE_ENV"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-access.js" "$CHATCRM_APP_ROOT/.first-access.json"
```

No ambiente de testes, o administrador inicial é `admin@example.test`, com empresa/nome de teste. Sua senha aleatória fica somente em `<APP_ROOT>/.first-access.json`, modo 600, acessível ao dono pelo gerenciador de arquivos do cPanel; não é uma senha padrão do pacote. `.env`, `.mysql-verification.json` e `.auth-verification.json` também ficam privados, fora de releases e do domínio. `SETUP_TOKEN` foi removido após instalar e testar o bloqueio do instalador.

## Segurança e limites desta entrega

- Senhas usam scrypt com sal aleatório, N=32768, r=8 e p=3; não exigem addon nativo nem script npm de instalação. Parâmetros conforme [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) e API do [Node.js 22](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).
- Sessões de oito horas usam tokens aleatórios de 256 bits; somente seu hash fica no banco. Cookie HTTPS `__Host-cl_session`, HttpOnly, SameSite=Strict, Secure e Path=/; logout revoga a sessão no banco.
- POST exige origem idêntica a `APP_URL`. Logout também exige token CSRF derivado da sessão; senhas e segredos nunca aparecem na URL.
- Login e instalação têm limite de dez tentativas por endereço a cada quinze minutos, no processo, e no máximo dois cálculos de senha simultâneos. A memória do limitador é limitada. Não confia em `X-Forwarded-For` arbitrário.
- Atrás de Passenger/proxy, diferentes usuários podem compartilhar o endereço observado. O limitador reinicia com o processo e não é compartilhado entre instâncias. Homologar proxy confiável e limitação persistida antes de produção ou equipes maiores.
- Não existe senha pública de demonstração, recuperação de senha esquecida, MFA ou auditoria de acessos nesta versão. A [troca da própria senha](SENHA.md) e a [gestão de operadores](OPERADORES.md) estão implementadas.
- MySQL exige configuração privada explícita; falhas retornam mensagens genéricas. `/health` confirma o servidor e a versão do código, sem afirmar que o banco está configurado. `/api/installation` retorna somente o estado da instalação.

Referências operacionais: [commits implícitos no MySQL](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html), [travas de migração](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html). Migração não substitui backup e restauração testada.
