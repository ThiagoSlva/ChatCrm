# Instalação e acesso — v0.11.1

A base inclui instalação protegida, equipe, departamentos, chat, contatos/leads, oportunidades, portal e primeiras campanhas no canal próprio. O [instalador simples](INSTALADOR-CPANEL.md) prepara somente banco vazio; atualizações continuam explícitas. Restauração, instalação sem terminal e carga seguem pendentes. Consulte o andamento para distinguir código, fixtures, SQL real e HTTPS.

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

Os campos vazios acima são intencionais. Use uma senha exclusiva do banco e um segredo aleatório de instalação com 32 a 256 caracteres. Um gerenciador de senhas pode gerar ambos. Nunca publique esses valores nem os envie pela conversa. Também é possível configurar variáveis pelo gerenciador Node; o terminal e o cron podem não herdar essas variáveis.

`APP_URL` deve ser a origem HTTPS exata do sistema, sem subcaminho, credenciais, parâmetros ou fragmentos. Para desenvolvimento local, fora de produção, aceita `http://127.0.0.1:3000` ou `http://localhost:3000`. HTTPS é obrigatório em produção.

## Preparar a estrutura

Na instalação simples, no diretório do projeto:

```sh
npm ci --omit=dev --ignore-scripts
npm run install:prepare
npm run install:prepare -- --prepare-empty
npm start
```

A preparação inicial aplica schema1–9: equipe/sessões, departamentos, chat, contatos, oportunidades, associações, portal, inscrições e campanhas. Recusa qualquer banco não vazio sob a trava de migração. DDL MySQL não é revertido por transação: se interromper, preserve a estrutura e siga o guia de retomada com backup e migrador explícito. Não há DROP/TRUNCATE ou migração automática no processo web/cron. Não recupere schema9 com código que aceita somente versões anteriores.

No ambiente de releases deste projeto, o arquivo privado fica em `<APP_ROOT>/.env`. O bootstrap já carrega esse arquivo, preservado entre deploys. Ative o ambiente Node e execute explicitamente com a configuração privada:

```sh
source "$CHATCRM_NODE_ENV"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/check-installation.js"
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
- Login e instalação têm limite persistido de dez tentativas por endereço a cada quinze minutos no schema de chat, além do limite de cálculos de senha simultâneos. Não confia em X-Forwarded-For arbitrário. Diferentes usuários atrás de Passenger podem compartilhar o endereço observado; carga e proxy confiável ainda precisam de homologação.
- Não existe senha pública de demonstração, recuperação de senha esquecida da equipe, MFA ou auditoria completa de acessos nesta versão. O portal tem recuperação própria por código privado. A [troca da própria senha](SENHA.md) e a [gestão de operadores](OPERADORES.md) estão implementadas.
- MySQL exige configuração privada explícita; falhas retornam mensagens genéricas. `/health` confirma o servidor e a versão do código, sem afirmar que o banco está configurado. `/api/installation` retorna somente o estado da instalação.

Referências operacionais: [commits implícitos no MySQL](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html), [travas de migração](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html). Migração não substitui backup e restauração testada.


O [diagnóstico manual de instalação](DIAGNOSTICO-INSTALACAO.md) verifica configuração, estrutura registrada, empresa/administrador e módulos pendentes sem criar ou alterar dados. Use-o antes do primeiro acesso ou de uma atualização; conexão válida por si só não comprova instalação pronta.
