# Andamento e ponto de retomada

## 01/10/2026 — Base publicada e primeiro deploy

Concluído: pesquisa do Telegram; plano de produto e arquitetura; direção visual; base Node 0.0.1; testes; MIT; publicação em `ThiagoSlva/ChatCrm`; domínio de testes; app CloudLinux Node 24; clone do GitHub no cPanel; primeiro deploy com releases; endpoint HTTP 200 com hash; cron de atualização a cada dois minutos.

Verificado: três testes locais e no cPanel; Actions em Node 22/24 passou; página HTTPS e assets carregaram; health confirmou commit `64cbca94cb0b4aecf6dadcbcdef7ebab6c063708` depois de configurar `passenger.cjs`.

Automação de continuidade criada e ativa nesta conversa: **Evoluir Conversa Livre — ChatCrm**, a cada 60 minutos. Identificador: `evoluir-conversa-livre-chatcrm`. Cada execução deve ler a memória, verificar o andamento, implementar a próxima entrega útil, testar e documentar. Inclui evolução futura como fluxos de chatbot. Depende do aplicativo/computador disponíveis e dos limites de uso da conta.

Deploy automático confirmado: o commit `f319441224a8834515e67ff9510b1f3d7a0ae040`, que publicou a memória, apareceu em `/health` após o cron, sem atualização manual do clone ou da aplicação. Verificação em 01/10/2026, às 13h42 (America/Sao_Paulo). O ambiente respondeu com `status: ok`. O ciclo GitHub → cron → testes → release → reinício está validado para esta base.

Próxima entrega funcional: instalação e schema MySQL, autenticação/primeiro administrador e operadores, conforme fase 1 do plano. Chat e CRM ainda não implementados. Não cadastrar credenciais de demonstração públicas.

Pendências de infraestrutura: MySQL dedicado e conexão real; teste de recuperação; limites de retenção de releases e logs; verificação de saúde pós-deploy. Sem bloqueio conhecido para desenvolver localmente.

Atualize esta página a cada entrega com resultado, validação, pendência e próximo passo. Não registre apenas intenções como trabalho concluído.

## 01/10/2026 — v0.1.0: primeiro acesso implementado

Código concluído: migração privada MySQL v1, configuração fechada sem banco/URL/segredo, tela `/acesso`, criação única do primeiro administrador e empresa, login, perfil e logout. Senhas scrypt com sal, cookies HTTPS seguros, sessões com hash e expiração no banco, origem explícita, CSRF no logout e limite de tentativas. Interface informa claramente quando a instalação está pendente.

Validação local: 16 testes passaram em Node 22, incluindo segredo/origem inválidos, dupla instalação concorrente, autenticação, revogação, entradas fracas, limite de tentativas e migração que recusa banco de outro site. Esses testes simulam persistência e conexão; não são homologação MySQL real. O deploy passa a executar toda a suíte, isolando as credenciais DB dos testes.

Publicação verificada: commit funcional `fede32493f4e2e98c1befba86fa1a40eee26c96f` em `main`; [Actions 36906333782](https://github.com/ThiagoSlva/ChatCrm/actions/runs/36906333782) passou em Node 22/24. O cron ativou essa release, e `/health` retornou HTTP 200, v0.1.0, o mesmo hash e `authenticationImplemented: true`, mantendo chat/CRM como não implementados. `/api/installation` confirmou `configuration-required` sem expor credenciais.

Banco dedicado `xfxpanel_chatcrm` criado e confirmado pelo Database Wizard; ainda sem usuário associado ou tabelas. Configuração privada e primeiro administrador real ainda pendentes. Solicitada autorização para criar `xfxpanel_clchat`, guardar senha aleatória somente na hospedagem e conceder acesso apenas ao banco do projeto. Nenhuma resposta/autorização recebida até este registro; não criar acesso com base na opção preselecionada. A aba Database Wizard está no passo 2. Próximo passo: após autorização específica, preparar acesso e configuração privada, migrar e homologar o fluxo com banco real; depois implementar operadores. Guia: `INSTALACAO-ACESSO.md`.

Revisão visual encontrou `/styles.css` antigo servido com cache Cloudflare e origem estática LiteSpeed. Correção publicada em `5ec2f60afa2d86174463bff0f0ea573080490422`: HTML referencia CSS/JS em `/assets/<hash-do-conteudo>/<arquivo>`, servido pela release ativa. Novo teste verifica que URLs e conteúdos têm o mesmo hash. Total: 17 testes locais passaram; [Actions 36907205663](https://github.com/ThiagoSlva/ChatCrm/actions/runs/36907205663) passou em Node 22/24. `/health` confirmou esse commit após o cron; CSS e JS identificados no HTML responderam HTTP 200, hash conferente, `Cache-Control: no-store` e `nosniff`. Memória atualizada com o ponto de retomada e autorização MySQL pendente.

## 01/10/2026 — MySQL e primeiro acesso reais concluídos

O usuário respondeu à solicitação de acesso dedicado: “está autorizado a fazer qualquer mudança necessária ok”. Usuário `xfxpanel_clchat` criado pelo Database Wizard e associado somente a `xfxpanel_chatcrm`, com SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER e REFERENCES. Configuração privada `.env` criada fora das releases; conexão e schema v1 com quatro tabelas verificados em MariaDB 11.8.6 e Node 24.21.0. UAPI CLI estava limitada pelo CageFS; o assistente do cPanel funcionou, sem mudar essa proteção ou credenciais existentes.

Administrador de testes criado pelo endpoint HTTPS, com senha aleatória em arquivo privado de modo 600. Instalação retornou 201; login/perfil 200; acesso anônimo e sessão revogada 401; logout sem CSRF 403; logout correto 200; tentativa de instalar novamente 409. `SETUP_TOKEN` foi removido após a verificação e reinício solicitado. `/api/installation` retornou `installed`. Arquivos privados testados por HTTP: `.env` 403; credencial inicial e relatórios 404, sem conteúdo exposto.

Verificação privada adicional passou: arquivos `.env`, credencial inicial e relatórios com modo 600; segredo de instalação ausente; SHOW GRANTS confirmado sem acesso a outros bancos nem GRANT OPTION; um administrador e nenhuma sessão remanescente após o logout. Nenhuma senha ou hash de credencial foi impresso no diagnóstico.

Verificador HTTPS repetível publicado em `scripts/verify-access.js`/`npm run verify:access`, usando credenciais em arquivo privado, sem criar contas ou alterar senhas. Os 17 testes locais passaram novamente. Commit `4cd34513221be4fa72356b298285fdb509a81696` servido em `/health`; [Actions 36910908905](https://github.com/ThiagoSlva/ChatCrm/actions/runs/36910908905) passou em Node 22/24. O comando foi executado na hospedagem às 16h02 de 01/10/2026 (America/Sao_Paulo), com nove verificações HTTPS aprovadas, incluindo origem estrangeira e senha incorreta recusadas, cookie seguro, CSRF e revogação. A tela `/acesso` foi conferida no navegador e agora apresenta login; evidência local ignorada: `storage/verificacoes/acesso-mysql-pronto.jpg`. Marco de instalação/autenticação real concluído; o CRM completo ainda não está pronto. Próxima implementação funcional: operadores/permissões e troca de senha pelo próprio usuário; depois chat e widget.

## 01/10/2026 — v0.2.0: operadores e permissões

Implementados cadastro, lista paginada, desativação e reativação de operadores em `/acesso` e `/api/team/operators`, exclusivos do administrador. Papel fixo `operator`, e-mail único, senha scrypt, origem/CSRF nas escritas, recusa de campos extras e limite de 200 operadores. Administradores não são alterados por este módulo. Desativação atualiza o estado e revoga sessões na mesma transação; login verifica usuário ativo com trava antes de persistir sessão. Schema v1 preservado, sem migração ou atualização do bootstrap.

Validação local: 23 testes aprovados, incluindo recusa a operadores/anônimos, origem/CSRF, papel administrativo injetado, normalização, revogação, reativação, paginação e corrida de login/desativação. Preparado `scripts/verify-team-database.js` para homologação SQL dentro de transação revertida; não deixa contas ou sessões de teste. `verify:access` foi ampliado com leitura administrativa da equipe e proteção do administrador por HTTPS. A revisão visual e homologação da release devem ser registradas abaixo após execução. Guia: `OPERADORES.md`. Próximo passo depois desta entrega: departamentos/permissões de atendimento e troca de senha pelo próprio usuário; depois chat/widget.
