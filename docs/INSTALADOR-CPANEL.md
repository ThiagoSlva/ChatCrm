# Instalação simples no cPanel

v0.12.1 oferece pacote ZIP reproduzível, preparação protegida pelo terminal e primeiro cadastro pelo navegador. Código MIT, gratuito e independente de conta do autor. Hospedagem e domínio são fornecidos por quem instala. Siga [o guia ilustrado do pacote](PACOTE-INSTALACAO.md) para baixar/extrair sem Git na hospedagem. Assistente sem terminal e homologação ampla de recuperação/provedores continuam pendentes.

## Preparar o ambiente

Você precisa de domínio com HTTPS, Node.js 22 ou 24, npm, MySQL/MariaDB e terminal da aplicação. Node24/MariaDB foram executados no ambiente de testes; isso não comprova todos os provedores. O cPanel deve oferecer gerenciador Node; nomes e campos variam. Não exponha a porta Node à internet nem use permissões 777.

1. Crie um banco **novo, exclusivo e vazio**. Não use banco de WordPress ou outro sistema.
2. Associe um usuário exclusivo ao banco. Aplicação: SELECT, INSERT, UPDATE, DELETE. Preparação: CREATE, ALTER, INDEX, REFERENCES. Não exige DROP, privilégios globais ou acesso remoto. Registre nomes completos com prefixo da conta.
3. Extraia o [pacote verificado](PACOTE-INSTALACAO.md) numa pasta privada, ou use Git como alternativa abaixo. Obtenha o código numa pasta privada, fora de `public_html` e da pasta pública do domínio:

   ```sh
   git clone https://github.com/ThiagoSlva/ChatCrm.git conversa-livre
   cd conversa-livre
   npm ci --omit=dev --ignore-scripts
   ```

4. Registre esta aplicação no gerenciador Node: pasta privada, produção, domínio escolhido e `app.js` como entrada quando permitido. Ative no terminal o ambiente Node indicado pelo painel. Se exigir bootstrap Passenger diferente, use os parâmetros do seu provedor; consulte o [fluxo de releases](DEPLOY-CPANEL.md). Não altere outras aplicações.

## Configuração privada

Na instalação direta, copie `.env.example` para `.env` somente se ainda não existir. No terminal Linux do cPanel:

```sh
test ! -e .env && cp .env.example .env
chmod 600 .env
```

Preencha pelo gerenciador de arquivos: APP_URL, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD e SETUP_TOKEN. Use senha exclusiva e segredo de instalação aleatório de **32 a 256 caracteres**, gerado pelo seu gerenciador de senhas. Nunca coloque valores em comandos, URLs, Git, capturas ou mensagens. O arquivo fica fora da pasta pública.

APP_URL deve ser a origem HTTPS exata, sem subcaminho, credenciais, parâmetros ou fragmento. Exemplo público: `https://suporte.suaempresa.com.br`. Domínio e HTTPS precisam estar prontos antes do primeiro acesso.

Variáveis somente do processo web podem não estar disponíveis no terminal. Em releases, preserve `<APP_ROOT>/.env` fora do clone/current/releases e use a variante abaixo. O instalador não grava nem substitui configuração.

## Conferir e preparar

Este comando **só lê**:

```sh
npm run install:prepare
```

Em banco vazio, `database-unprepared` e saída 1 são esperados: a preparação está pendente. Corrija erros de configuração antes de continuar. Relatórios nunca apresentam credenciais.

Para autorizar somente a preparação inicial de banco vazio:

```sh
npm run install:prepare -- --prepare-empty
```

O comando diagnostica, exige segredo privado, obtém a trava de migração e **confere novamente se o banco está vazio sob a trava**. Outra instalação iniciada após o diagnóstico provoca recusa antes do primeiro DDL. Qualquer tabela impede preparação inicial, inclusive estrutura antiga do próprio projeto.

Em banco vazio, reutiliza as nove etapas e validadores do migrador. O marcador avança após validar colunas, índices, engines e relações. Não cria empresa, contas ou campanhas, não publica departamentos nem reinicia a aplicação. Conexão, cada comando e encerramento têm prazo de15 segundos; leituras diagnósticas têm5 segundos por operação. Timeout fecha a conexão própria e deixa o estado sem confirmação: DDL aplicado pode permanecer.

`setup-ready`, schema9 e `preparation: completed` confirmam a estrutura após o diagnóstico final. JSON e ajuda:

```sh
npm run install:prepare -- --json
npm run install:prepare -- --prepare-empty --json
npm run install:prepare -- --help
```

Ajuda não carrega configuração. Argumentos desconhecidos/duplicados são recusados; não existe argumento para credenciais. Saídas: 0 pronto/confirmado, 1 pendência/falha, 2 uso inválido. Não roda no cron, CI ou startup. `npm test` usa fixtures sem banco hospedado.

### Variante com releases

Defina os caminhos privados conforme o guia de deploy:

```sh
source "$CHATCRM_NODE_ENV"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/prepare-installation.js"
```

Somente em instalação nova com banco vazio, acrescente `--prepare-empty` ao último comando. Ele recusa ambientes existentes; não autoriza atualização. Depois inicie/reinicie somente esta aplicação pelo painel.

## Primeiro acesso e teste

1. Abra `/acesso`. Informe empresa, nome, e-mail, senha de pelo menos15 caracteres e segredo privado. Nenhum valor vai na URL.
2. Crie o administrador e entre. Empresa/administrador são criados juntos numa transação com trava contra dois primeiros cadastros concorrentes.
3. Remova SETUP_TOKEN da configuração e reinicie esta aplicação. O banco impede outro primeiro cadastro mesmo se o segredo continuar configurado.
4. Cadastre dois operadores e departamento, vincule os operadores e habilite entrada pública somente na área escolhida. Ela começa desligada.
5. Copie o trecho HTML do widget para uma página de teste. Ele abre `/chat` em nova aba. Use dados fictícios e responda em `/atendimento` com operadores autorizados.
6. Cadastre contato/lead e oportunidade; confira escopo/histórico. Teste conta fictícia do portal. Novidades começam desligadas; campanhas usam inscrição explícita no canal próprio.
7. Execute `npm run check:installation`. `installed`/schema9 confirma registros essenciais e módulos, não recuperação ou qualidade do atendimento. Não há senha padrão, licença ou ativação externa.

## Interrupções e atualizações

| Resultado | Próximo passo |
| --- | --- |
| Runtime/URL/configuração inválidos | Corrigir ambiente privado e repetir diagnóstico |
| Banco inacessível/timeout | Conferir disponibilidade/permissões e repetir diagnóstico |
| `database-not-exclusive` | Usar banco dedicado; não apagar tabelas existentes |
| `setup-secret-required` | Configurar segredo privado aceito pelo primeiro formulário |
| `database-not-empty` | Conferir `check:installation`; `setup-ready` permite seguir no navegador, `installed` indica instalação existente |
| `preparation-interrupted`, `preparation-timeout`, `preparation-unconfirmed` | Preservar estrutura, diagnosticar, obter backup privado e revisar retomada explícita |
| Schema incompleto/incompatível | Conferir etapa/release; não reduzir marcador ou remover tabelas |

DDL MySQL confirma implicitamente. Repetir `--prepare-empty` **não retoma instalação parcial**: recusa tabelas existentes. `migrate:database` é a ferramenta de retomada, após conferir exclusividade, versão, estrutura e backup. Valida etapas existentes e recusa incompatibilidades; não faz DROP/TRUNCATE. Não apague o banco para corrigir falhas.

Atualizações exigem backup atual e release compatível antes de migração explícita, conforme [instalação e acesso](INSTALACAO-ACESSO.md). Preparação inicial nunca autoriza upgrade, recuperação de senha ou alteração de contas. Preserve configuração/backups entre deploys.

## Limites verificados

Instalação limpa9/21 e restauração foram ensaiadas em MariaDB11.4.13 local isolado com dados sintéticos. DDL parcial e mudança entre diagnóstico/trava também são exercitadas em modelo SQL. Prazos também são ensaiados com conexão de protocolo isolada. A recusa no MariaDB hospedado é registrada no andamento. Não declarar banco novo em outro provedor, assistente sem terminal ou restauração homologados sem demonstração. O pacote é extraído, verificado e testado na CI; a ilustração é um guia, não captura de outro provedor. Próximos marcos: instalação por pessoa iniciante e recuperação completa da configuração/arquivos. Checksum de dump não comprova restauração.
