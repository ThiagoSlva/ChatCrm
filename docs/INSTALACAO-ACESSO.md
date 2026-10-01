# Instalação do primeiro administrador — v0.1.0

Esta entrega implementa a base de autenticação. Chat, operadores, recuperação de senha e CRM ainda estão em desenvolvimento. Os testes automatizados usam repositório em memória e conexão simulada; a operação com MySQL real precisa ser homologada no ambiente dedicado antes de declarar esta etapa concluída.

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

A migração v1 cria `cl_schema`, `cl_company`, `cl_users` e `cl_sessions`. Recusa tabelas de outro sistema e versões desconhecidas. DDL não é revertido por uma transação no MySQL: uma instalação interrompida preserva o marcador v0 e pode retomar. O marcador só muda para v1 após terminar a criação da estrutura. Não há comandos DROP, TRUNCATE ou migração automática no processo web.

No ambiente de releases deste projeto, o arquivo privado fica em `/home/xfxpanel/apps/chatcrm-test/.env`. O bootstrap já carrega esse arquivo, preservado entre deploys. Ative o ambiente Node e execute explicitamente com a configuração privada:

```sh
source /home/xfxpanel/nodevenv/apps/chatcrm-test/24/bin/activate
node --env-file=/home/xfxpanel/apps/chatcrm-test/.env /home/xfxpanel/apps/chatcrm-test/current/scripts/check-database.js
node --env-file=/home/xfxpanel/apps/chatcrm-test/.env /home/xfxpanel/apps/chatcrm-test/current/scripts/migrate-database.js
```

Depois reinicie somente `apps/chatcrm-test` pelo gerenciador Node. Não coloque `.env` dentro de `current`, `releases`, da pasta do domínio ou do clone Git. Não copie arquivos privados junto com o pacote público.

## Primeiro acesso

Abra `/acesso`. A tela informa se falta configuração ou migração. Quando o banco estiver pronto, informe empresa, nome, e-mail, senha de pelo menos 15 caracteres e segredo de instalação. Crie o administrador e entre com e-mail e senha. Remova `SETUP_TOKEN` da configuração e reinicie após concluir; o banco bloqueia uma segunda instalação mesmo que o segredo ainda esteja configurado.

O primeiro cadastro usa uma transação e trava na linha única do schema para impedir dois administradores iniciais em requisições concorrentes. A criação da empresa e do usuário acontece na mesma transação.

## Segurança e limites desta entrega

- Senhas usam scrypt com sal aleatório, N=32768, r=8 e p=3; não exigem addon nativo nem script npm de instalação. Parâmetros conforme [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) e API do [Node.js 22](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).
- Sessões de oito horas usam tokens aleatórios de 256 bits; somente seu hash fica no banco. Cookie HTTPS `__Host-cl_session`, HttpOnly, SameSite=Strict, Secure e Path=/; logout revoga a sessão no banco.
- POST exige origem idêntica a `APP_URL`. Logout também exige token CSRF derivado da sessão; senhas e segredos nunca aparecem na URL.
- Login e instalação têm limite de dez tentativas por endereço a cada quinze minutos, no processo, e no máximo dois cálculos de senha simultâneos. A memória do limitador é limitada. Não confia em `X-Forwarded-For` arbitrário.
- Atrás de Passenger/proxy, diferentes usuários podem compartilhar o endereço observado. O limitador reinicia com o processo e não é compartilhado entre instâncias. Homologar proxy confiável e limitação persistida antes de produção ou equipes maiores.
- Não existe senha pública de demonstração, recuperação de senha, MFA, administração de operadores ou auditoria de acessos nesta versão. O papel `operator` está reservado no schema, sem cadastro disponível.
- MySQL exige configuração privada explícita; falhas retornam mensagens genéricas. `/health` confirma o servidor e a versão do código, sem afirmar que o banco está configurado. `/api/installation` retorna somente o estado da instalação.

Referências operacionais: [commits implícitos no MySQL](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html), [travas de migração](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html). Migração não substitui backup e restauração testada.
