# Memória do projeto

Atualizada em 01/10/2026. Não incluir credenciais ou URLs de sessão neste arquivo.

## Intenção do usuário

Sistema aberto e gratuito para cada empresa hospedar seu próprio atendimento e CRM. Node.js moderno, MySQL e cPanel; integração com sites existentes por widget e API; cadastro de operadores, leads, conversas, portal e campanhas no canal próprio. Aparência com a clareza do Telegram, mantendo marca e código originais. Nome provisório: **Conversa Livre**. Não existe serviço comercial obrigatório.

O usuário autorizou evolução contínua sem precisar repetir “continue”, inclusive propor e implementar melhorias coerentes como chatbot e editor de fluxos. Prioridade: entregar funções reais, qualidade, segurança e instalação acessível. A automação não remove limites de uso e não garante perfeição.

## Pesquisa e arquitetura

Foram analisados e baixados localmente os clientes oficiais Telegram Web A e K. São GPL, dependem da rede Telegram e não incluem servidor independente. Não foram incorporados ao nosso código MIT. `referencias/manifesto.json` registra origens e commits; os clones ficam ignorados no Git.

Plano principal: Node.js/TypeScript, Fastify, MySQL, interface React/Vite, uma instalação por empresa, sessões seguras, widget, CRM, eventos persistidos, polling como alternativa a WebSocket e filas/cron sem exigir Redis. A base inicial usa JavaScript/CommonJS e HTML/CSS para homologar infraestrutura. Leia as especificações: `PLANO-IMPLEMENTACAO.md`, `API-PROPOSTA.md`, `ANALISE-NODEJS-CPANEL.md` e `DIRECAO-VISUAL.md`.

## Estado funcional

Versão 0.0.1, fase 0. Servidor Fastify, página de diagnóstico, `/health`, comando privado `npm run check:database` que executa somente `SELECT 1`, headers de segurança e três testes automatizados. Chat, operadores, autenticação, leads, campanhas, chatbot e instalador ainda não existem. Não apresentar a base como CRM completo.

## GitHub e hospedagem

- Repositório público autorizado: `ThiagoSlva/ChatCrm`, branch `main`, MIT. GitHub conectado no Codex. `gh` não estava instalado; os tools do conector GitHub foram usados para criar árvores, commits e atualizar refs. A leitura/fetch do Git local funciona por HTTPS público.
- Workspace local: `D:\venda de softwares\AlternativaWhatsapp`. Remoto `origin` configurado; evitar reinitializar ou sobrescrever alterações.
- Domínio definido pelo usuário: `https://testeschat.cloudyx.xyz`. O usuário informou que apontou o DNS na Cloudflare. Domínio criado no cPanel, com raiz separada `/home/xfxpanel/testeschat.cloudyx.xyz`.
- cPanel oferece Git Version Control, Terminal, Cron Jobs e CloudLinux Setup Node.js App. Aplicação dedicada: `/home/xfxpanel/apps/chatcrm-test`, Node 24.21.0, Production, domínio na raiz e entrada `passenger.cjs`.
- Clone cPanel: `/home/xfxpanel/repositories/chatcrm`, origem pública HTTPS do GitHub, branch `main`. Não contém segredos.
- Ambiente Node: `/home/xfxpanel/nodevenv/apps/chatcrm-test/24/bin/activate`.

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
- MySQL real, WebSocket/polling e funções do CRM ainda não foram homologados.

## Próximas prioridades

1. Manter a memória e o acompanhamento atualizados; o ciclo de deploy automático já foi validado.
2. Implementar instalação/configuração MySQL e schema com migrações; criar somente banco dedicado deste projeto.
3. Autenticação, primeiro administrador, operadores, permissões e sessões seguras.
4. Chat atendente/visitante, widget de site, identidades e persistência de mensagens.
5. Leads, funil e histórico; depois portal, campanhas consentidas e filas.
6. Instalador cPanel, backup/restauração, limites de recursos, acessibilidade e testes de fluxos completos.
7. Chatbot com regras e editor de fluxos, transferência para humano e extensões úteis, com critérios e testes.
