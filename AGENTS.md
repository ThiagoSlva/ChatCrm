# Orientações do projeto

Leia `docs/MEMORIA-PROJETO.md`, `docs/ANDAMENTO.md` e `docs/DEPLOY-CPANEL.md` no início de cada retomada. Consulte `docs/PLANO-IMPLEMENTACAO.md` para arquitetura e fases. Atualize a memória e o andamento depois de cada entrega verificada.

Quando existir, leia também `storage/operations/MEMORIA-CPANEL-PRIVADA.md` para os parâmetros reais do ambiente autorizado. Esse arquivo é local e ignorado no Git: nunca publique seu conteúdo. Documentação e exemplos públicos devem usar parâmetros genéricos de conta, banco, usuário e caminhos internos. Segredos continuam somente na hospedagem.

## Objetivo e preferências do usuário

Criar um chat e CRM independente, gratuito, de código aberto e auto-hospedado, com Node.js, MySQL, instalação simples em cPanel, operadores, leads, widget/API para sites e campanhas no canal próprio. Interface original inspirada na clareza do Telegram. O usuário não deseja vender o sistema. Não copiar marca, ícones, código GPL ou rede do Telegram. Não usar integrações não oficiais para disparar mensagens no WhatsApp.

O usuário autorizou continuar implementando e melhorando o projeto com autonomia, incluindo ideias úteis como fluxos de chatbot, publicar o código no GitHub e fazer deploys no ambiente de testes. Transforme “perfeito” em melhorias concretas, critérios verificáveis e prioridades. Desenvolva a base funcional antes de módulos opcionais. Respeite pedidos posteriores e evite trabalho repetitivo sem benefício.

Em 02/10/2026, o usuário reiterou que devemos identificar pontos de melhoria e implementar recursos úteis presentes em outros aplicativos e ausentes aqui. Essa orientação deve permanecer na memória: avaliar benefício e dependências, escolher uma entrega coesa, implementar e validar com autonomia no escopo autorizado. Priorizar atendimento/CRM funcional; registrar novas ideias no backlog sem copiar código, marca ou prometer que todo recurso será implementado imediatamente.

Em 01/10/2026, após a solicitação concreta para criar `<DATABASE_USER>` com acesso somente a `<DATABASE_NAME>`, o usuário respondeu: “está autorizado a fazer qualquer mudança necessária ok”. Isso autoriza concluir esse acesso dedicado, gerar/guardar sua configuração privada, executar migrações e instalar/testar o sistema no ambiente deste projeto, além das melhorias necessárias ao projeto. Não interpretar como autorização para modificar outros sites, divulgar segredos, comprar serviços ou contornar limites/regras de segurança. Não repetir a confirmação já recebida para esse mesmo acesso e escopo.

## Execução

- Confira Git, memória, pendências e saúde do ambiente. Não descarte trabalho local.
- Escolha uma entrega útil e completa; implemente, valide, documente e publique quando estiver pronta.
- Execute testes apropriados à alteração. As verificações atuais usam `npm test`; o deploy executa os testes na release nova antes de ativá-la.
- O repositório autorizado é `https://github.com/ThiagoSlva/ChatCrm`, branch `main`. O único ambiente de publicação autorizado neste projeto é `https://testeschat.cloudyx.xyz`.
- Não modifique outras aplicações, domínios ou crons da conta. Não altere credenciais, compre serviços, amplie permissões ou faça exclusões irreversíveis sem autorização específica.
- Nunca grave senhas, tokens, sessão do cPanel, dados de clientes ou backups no Git ou nos documentos. Variáveis ficam privadas na hospedagem.
- Não configure envios para pessoas reais durante desenvolvimento; use dados e destinatários de teste. Campanhas futuras precisam de consentimento e descadastro.
- Se algum acesso estiver indisponível, preserve o progresso e continue com trabalho independente possível. Registre o impedimento e solicite somente a informação realmente necessária. A sessão do navegador pode expirar; não contorne autenticação ou certificados.

## Retomadas automáticas

Prossiga da última entrega registrada, sem recomeçar o projeto. Respeite os limites da conta; não compre créditos nem use redefinições de limites automaticamente. Se uma execução for interrompida, a próxima deve examinar os arquivos e o Git para continuar com segurança. Relate entregas relevantes e bloqueios acionáveis, sem mensagens repetidas de estado inalterado.

Para alterações de frontend, aplicar a skill do projeto `docs/skills/chatcrm-frontend-quality/SKILL.md`, conforme pedido reiterado em 02/10/2026. Revisar interface real, teclado e largura móvel, distinguindo resultados verificados de pendências; não chamar perfeição de garantia.
