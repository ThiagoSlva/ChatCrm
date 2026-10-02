# Memória do projeto

Atualizada em 02/10/2026. Não incluir credenciais ou URLs de sessão neste arquivo.

Parâmetros reais da hospedagem foram preservados em `storage/operations/MEMORIA-CPANEL-PRIVADA.md`, local e ignorado. Leia-o quando disponível para operações neste ambiente; não publique seu conteúdo. Os placeholders deste documento são exemplos, não caminhos para executar literalmente. A revisão automática recusou publicação de metadados internos em 02/10/2026; os guias públicos foram sanitizados para permitir publicação segura do código.

## Intenção do usuário

Sistema aberto e gratuito para cada empresa hospedar seu próprio atendimento e CRM. Node.js moderno, MySQL e cPanel; integração com sites existentes por widget e API; cadastro de operadores, leads, conversas, portal e campanhas no canal próprio. Aparência com a clareza do Telegram, mantendo marca e código originais. Nome provisório: **Conversa Livre**. Não existe serviço comercial obrigatório.

O usuário autorizou evolução contínua sem precisar repetir “continue”, inclusive propor e implementar melhorias coerentes como chatbot e editor de fluxos. Prioridade: entregar funções reais, qualidade, segurança e instalação acessível. A automação não remove limites de uso e não garante perfeição.

## Pesquisa e arquitetura

Foram analisados e baixados localmente os clientes oficiais Telegram Web A e K. São GPL, dependem da rede Telegram e não incluem servidor independente. Não foram incorporados ao nosso código MIT. `referencias/manifesto.json` registra origens e commits; os clones ficam ignorados no Git.

Plano principal: Node.js/TypeScript, Fastify, MySQL, interface React/Vite, uma instalação por empresa, sessões seguras, widget, CRM, eventos persistidos, polling como alternativa a WebSocket e filas/cron sem exigir Redis. A base inicial usa JavaScript/CommonJS e HTML/CSS para homologar infraestrutura. Leia as especificações: `PLANO-IMPLEMENTACAO.md`, `API-PROPOSTA.md`, `ANALISE-NODEJS-CPANEL.md` e `DIRECAO-VISUAL.md`.

## Estado funcional

Versão 0.3.0 em publicação, fase 1 em andamento. Inclui instalação, autenticação, gestão administrativa de operadores e troca da própria senha em `/acesso`, com senha atual, confirmação e revogação de todas as sessões. Schema v1 preservado, sem DDL ou mudança no bootstrap. Troca e login revalidam hash/estado/sessão sob trava, para impedir acesso baseado em senha antiga. Trinta e um testes locais passaram, incluindo entrelaçamentos de operações com persistência simulada. Instalação, autenticação e operadores já homologados em MariaDB 11.8.6, Node 24.21.0 e HTTPS; registrar homologação v0.3.0 após deploy. Chat, departamentos, leads, campanhas, chatbot e instalador completo ainda não existem. Não apresentar a base como CRM completo.

Leia `INSTALACAO-ACESSO.md` para configuração e limites. `APP_URL`, `SETUP_TOKEN` e variáveis DB precisam estar no ambiente privado; a aplicação fica bloqueada para instalação sem configuração válida. Segredo sem valor padrão e banco exclusivo. Migração recusa tabelas de outros sistemas, mantém marcador v0 em interrupção e só marca v1 ao concluir; executada explicitamente, nunca no cron de deploy. O primeiro administrador usa transação/trava; não cadastrar credenciais conhecidas. O runner agora descobre toda a suíte em `test/` e remove credenciais DB dos testes.

## GitHub e hospedagem

- Repositório público autorizado: `ThiagoSlva/ChatCrm`, branch `main`, MIT. GitHub conectado no Codex. `gh` não estava instalado; os tools do conector GitHub foram usados para criar árvores, commits e atualizar refs. A leitura/fetch do Git local funciona por HTTPS público.
- Workspace local: `<WORKSPACE>`. Remoto `origin` configurado; evitar reinitializar ou sobrescrever alterações.
- Domínio definido pelo usuário: `https://testeschat.cloudyx.xyz`. O usuário informou que apontou o DNS na Cloudflare. Domínio criado no cPanel, com raiz separada `<DOMAIN_ROOT>`.
- cPanel oferece Git Version Control, Terminal, Cron Jobs e CloudLinux Setup Node.js App. Aplicação dedicada: `<APP_ROOT>`, Node 24.21.0, Production, domínio na raiz e entrada `passenger.cjs`.
- Clone cPanel: `<REPO_ROOT>`, origem pública HTTPS do GitHub, branch `main`. Não contém segredos.
- Ambiente Node: `<NODE_ENV_ACTIVATE>`.
- Banco exclusivo `<DATABASE_NAME>`, usuário `<DATABASE_USER>`, MariaDB 11.8.6. Concedidos somente SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER e REFERENCES nesse banco; nenhuma permissão global ou DROP. Configuração privada `.env` e schema v1 concluídos. Não usar bancos de outros sites.

## Deploy e recuperação

Leia `DEPLOY-CPANEL.md` antes de qualquer operação. Cron criado a cada dois minutos com `flock` para impedir concorrência. Ele executa `scripts/deploy-cpanel.js`, busca `origin/main`, exige árvore limpa e avanço linear, prepara release isolada, roda `npm ci --omit=dev --ignore-scripts` e os testes e troca atomicamente o link `current`. O bootstrap `passenger.cjs` carrega a release e preserva `.env` privado na raiz da aplicação. `tmp/restart.txt` solicita reinício ao Passenger.

`.deployed.json` e `deploy.log` são privados no servidor. `/health` mostra o hash da release em `commit`, sem dados privados. `.cpanel.yml` permite deploy manual pelo painel e contém caminhos desta conta de testes; usuários de outras instalações devem adaptá-los. Não conectar Actions com credenciais amplas de cPanel: o fluxo atual não precisa disso.

Releases anteriores permanecem em `releases/`. Antes de recuperar, suspenda apenas o cron deste projeto, consulte o registro privado e restaure o link da release anterior; reinicie somente esta aplicação. Falhas de instalação/testes não mudam o link atual. Falhas posteriores de inicialização ainda exigem recuperação manual. Bootstrap, migrações, limpeza de releases, rotação de logs e saúde pós-deploy precisam de evolução antes de produção.

## Verificações já observadas

- `npm test`: três testes passaram em Node 22 local e Node 24 no cPanel.
- Auditoria das dependências da base: zero vulnerabilidades relatadas na verificação inicial.
- GitHub Actions, matriz Node 22 e 24: execução `36892950361` concluída com sucesso.
- Página em HTTPS abriu no navegador e confirmou o servidor conectado.
- Deploy de release manual executado com sucesso; `/health` retornou HTTP 200 e commit `64cbca94cb0b4aecf6dadcbcdef7ebab6c063708`.
- Cron registrado e atualização automática verificada: o commit de memória `f319441224a8834515e67ff9510b1f3d7a0ae040` apareceu em `/health` sem deploy manual, às 13h42 de 01/10/2026 (America/Sao_Paulo).
- MySQL/MariaDB real e base de acesso verificados nesta hospedagem; WebSocket/polling e funções do CRM ainda não foram homologados.
- v0.1.0: 16 testes locais, auditoria npm sem vulnerabilidades e Actions `36906333782` em Node 22/24 passaram. O cron ativou o commit funcional `fede32493f4e2e98c1befba86fa1a40eee26c96f`; `/health` confirmou v0.1.0/hash e `/api/installation` confirmou configuração pendente. Base de autenticação publicada; não confundir esse resultado com primeiro acesso testado em MySQL real.
- Autorização recebida em 01/10/2026, como resposta à solicitação concreta de acesso dedicado: “está autorizado a fazer qualquer mudança necessária ok”. Registrar também em AGENTS. O usuário MySQL dedicado, sua configuração privada, migração e instalação inicial foram concluídos; não repetir a confirmação para esse mesmo acesso. O escopo continua somente este projeto/domínio, sem divulgar segredos, alterar outros sites ou comprar serviços.
- Atenção a assets: `/styles.css` antigo foi servido diretamente por LiteSpeed e cache Cloudflare. O HTML agora usa URLs `/assets/<hash-do-conteudo>/<arquivo>` para CSS/JS da release, evitando colisões e atualizações parciais. Não confiar em respostas das rotas antigas como prova de versão do frontend. Correção funcional `5ec2f60afa2d86174463bff0f0ea573080490422`: 17 testes locais e Actions `36907205663` em Node 22/24 passaram; `/health` confirmou o commit servido e os assets do HTML responderam HTTP 200/hash correspondente/headers corretos após o cron.
- MySQL real: conexão e quatro tabelas v1 verificadas. Administrador de testes `admin@example.test` criado pelo endpoint HTTPS; senha aleatória somente em `<APP_ROOT>/.first-access.json`, modo 600. Não copiar esse arquivo ou `.env` para Git/docs/conversa. Login, perfil, cookie seguro, CSRF no logout, revogação e bloqueio de instalação duplicada passaram. `SETUP_TOKEN` removido do arquivo privado e reinício solicitado. Relatórios sem credenciais em `.mysql-verification.json` e `.auth-verification.json`, na raiz privada.
- Verificação de escopo/armazenamento passou: arquivos privados em modo 600, segredo de instalação ausente, SHOW GRANTS sem acesso a outros bancos nem GRANT OPTION, um administrador e zero sessões remanescentes. HTTP bloqueou `.env` (403) e credencial/relatórios (404). Não imprimir SHOW GRANTS inteiro: algumas versões podem incluir hash de autenticação do banco.
- UAPI CLI está limitada pelo CageFS: `/usr/local/cpanel/bin/uapi` existe, mas depende de `/usr/local/cpanel/cpanel`, ausente no ambiente. Não insistir nem mudar a proteção. O Database Wizard criou usuário e concedeu os privilégios; configuração foi enviada por entrada sem eco ao terminal e salva em arquivo privado. Nenhuma senha existente foi alterada.
- Verificador repetível implementado em `scripts/verify-access.js`, comando `verify:access`: usa arquivo privado de credenciais e APP_URL HTTPS, abre/encerra somente uma sessão, testa recusas/autenticação e não imprime segredos. Não integrar automaticamente ao cron/CI. Executado na hospedagem em 01/10/2026 às 16h02 (America/Sao_Paulo), com nove verificações aprovadas. `/health` confirmou commit `4cd34513221be4fa72356b298285fdb509a81696`; Actions `36910908905` passou em Node 22/24. A página `/acesso` apresentou login no navegador, com evidência local ignorada em `storage/verificacoes/acesso-mysql-pronto.jpg`. Instalação e autenticação reais concluídas; não recriar banco, usuário ou administrador.
- v0.2.0 homologada em 01/10/2026: commit `9eb24035be240cb2cd5bb8708c4371cd5e17537a` servido; Actions `36913535830` em Node 22/24 passou; oito verificações SQL em MariaDB com transação revertida e onze verificações HTTPS passaram. Cadastro/controle de operadores, restrição da visão do operador e layout móvel conferidos com dados fictícios. Evidências locais em `storage/verificacoes/*v020.jpg`, ignoradas no Git. Nenhum usuário temporário persistiu. Na retomada de 02/10/2026, esse hash permaneceu saudável. Registro final completado após a interrupção.
- v0.3.0: 31 testes locais e revisão independente aprovados. Verificador SQL ampliado para trocar somente senhas de usuários sintéticos não commitados. Login exige hash verificado ainda atual; troca exige sessão ainda válida dentro da transação. Verificação HTTPS recusa troca anônima sem alterar conta real. O navegador bloqueou a abertura da aba do preview local pela política de URL; não contornar com outro navegador, protocolo ou execução indireta. Revisão visual do novo formulário continua pendente; testes e validação do domínio autorizado seguem possíveis. Pasta não rastreada `%SystemDrive%/` apareceu após falha de inicialização do sandbox Windows; preservada e excluída da publicação explícita.

## Próximas prioridades

1. Manter a memória e o acompanhamento atualizados; o ciclo de deploy automático já foi validado.
2. Manter a configuração MySQL privada e verificar acesso após alterações relevantes com o comando explícito; conexão/schema/primeiro administrador/login/logout já foram testados com banco real.
3. Concluir troca de senha pelo próprio usuário (v0.3.0 em implementação, sem mudar contas reais); depois departamentos/permissões de atendimento, recuperação de senha e limitação de login persistida. Homologar IP/proxy cPanel sem confiar em headers arbitrários.
4. Chat atendente/visitante, widget de site, identidades e persistência de mensagens.
5. Leads, funil e histórico; depois portal, campanhas consentidas e filas.
6. Instalador cPanel, backup/restauração, limites de recursos, acessibilidade e testes de fluxos completos.
7. Chatbot com regras e editor de fluxos, transferência para humano e extensões úteis, com critérios e testes.
