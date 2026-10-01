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

Publicação GitHub, CI Node 22/24 e hash no cPanel: verificar e registrar após publicar esta entrega. Banco dedicado `xfxpanel_chatcrm` criado e confirmado pelo Database Wizard; ainda sem usuário associado ou tabelas. Configuração privada e primeiro administrador real ainda pendentes. Próximo passo: autorizar/criar usuário MySQL com acesso exclusivo ao banco deste projeto, preparar configuração privada e homologar o fluxo real; depois implementar operadores. A aba Database Wizard está no passo 2, aguardando autorização para criar esse acesso. Guia: `INSTALACAO-ACESSO.md`.
