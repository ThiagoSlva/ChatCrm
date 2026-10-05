# Conversa Livre — chat e CRM aberto

**v0.10.0 publicada no ambiente de testes, com portal e inscrições explícitas em schema8. Conversa Livre é um nome provisório.** A base inclui instalação protegida, equipe, operadores, senha, departamentos, atendimento de texto e o primeiro cadastro do CRM. O widget abre o chat em nova aba. Portal e preferências passaram por verificações SQL e HTTPS com identidades fictícias descartáveis. O módulo de [campanhas e caixa de novidades](docs/CAMPANHAS-MVP.md) está preparado na v0.11, com ativação explícita após backup e schema9; instalador completo e restauração seguem pendentes; o projeto ainda não está homologado para atendimento real.

A fila agora inclui [busca, filtros e atalhos](docs/PRODUTIVIDADE-ATENDIMENTO.md). O [backlog de melhorias](docs/BACKLOG-MELHORIAS.md) registra prioridades e critérios para as próximas entregas. Consulte o andamento para confirmar a homologação da versão.


[Contatos e leads](docs/CONTATOS-MVP.md) ficam em /contatos, com busca, filtros e edição que detecta alterações concorrentes. Exigem migração explícita v4 depois de backup privado e release compatível.

[Oportunidades e histórico](docs/OPORTUNIDADES-MVP.md) ficam em /vendas, com contato autorizado, valor BRL e etapas manuais. Exigem schema5 após backup atualizado e release compatível. Consulte o andamento para confirmar publicação e verificações.

O [contexto do contato no atendimento](docs/ASSOCIACAO-ATENDIMENTO.md) permite vincular manualmente um cadastro existente da mesma área, com responsável, confirmação, versões e histórico. Exige schema6 após backup privado e release compatível; não verifica a identidade do visitante nem concede acesso a outras conversas. Consulte o andamento para evidências de homologação.

A [verificação manual de concorrência SQL](docs/VERIFICACAO-CONCORRENCIA-CRM.md) cobre oportunidades em duas conexões físicas. Exige banco de testes vazio, backup privado atual e opção explícita para fixtures temporariamente confirmadas; não faz parte do cron ou de npm test. Consulte o andamento para evidências.

O [portal](docs/PORTAL-MVP.md) oferece contas/sessões próprias, retomada de histórico e recuperação de acesso. As [preferências de novidades](docs/INSCRICOES-PORTAL.md) acrescentam inscrição e descadastro explícitos, desligados por padrão, com auditoria e proteção contra reenvio antigo. Foram homologadas no ambiente de testes em schema8; campanhas e caixa de novidades ainda estão pendentes. Consulte o andamento para evidências e limitações.

## Executar a base

Requisitos: Node.js 22 ou 24 e npm. MySQL é opcional para abrir a página.

```sh
npm ci
npm test
npm start
```

Abra `http://127.0.0.1:3000`. O servidor usa `HOST` e `PORT` do ambiente, com esses valores como padrão. Para testar MySQL, copie `.env.example` para `.env`, preencha as variáveis privadas e execute `npm run check:database`. O comando executa somente `SELECT 1`, sem criar tabelas ou alterar dados.

Para conferir configuração, estrutura e módulos pendentes, execute `npm run check:installation`. O [diagnóstico de instalação](docs/DIAGNOSTICO-INSTALACAO.md) usa somente leitura, não migra nem cria administradores e não exibe credenciais.

Veja [como testar a base no cPanel](docs/TESTE-BASE.md). O provedor precisa oferecer Node.js compatível e gerenciador de aplicações. A entrada local é `app.js` em CommonJS; o ambiente de testes usa `passenger.cjs`, releases isoladas e migração explícita. Instalação sem terminal e carga de atendimento ainda precisam de homologação.

Para preparar o banco e criar o primeiro administrador, siga o [guia de instalação e acesso](docs/INSTALACAO-ACESSO.md). Abra `/acesso` após configurar o ambiente. Não existem credenciais padrão.

Administradores podem [cadastrar, desativar e reativar operadores](docs/OPERADORES.md) em `/acesso`. Desativar revoga as sessões; operadores não acessam a gestão da equipe.

Administradores e operadores podem [trocar a própria senha](docs/SENHA.md), informando a atual. A troca encerra todas as sessões e exige novo login.

Administradores podem [organizar departamentos e vínculos](docs/DEPARTAMENTOS.md). Operadores veem somente suas áreas ativas. O módulo exige migração explícita v2; a aplicação mantém acesso/equipe em v1 enquanto a atualização é preparada.

O [atendimento de texto](docs/CHAT-MVP.md) exige schema v3. Após migração, em `/acesso` crie um departamento, vincule os operadores e habilite sua entrada pública. A equipe abre `/atendimento`; visitantes abrem `/chat`. Copie o trecho do botão para o seu site. Departamentos internos permanecem privados por padrão. Não existe recuperação de histórico por nome ou e-mail; o visitante mantém o acesso somente enquanto seu cookie está válido.

O ambiente dedicado `testeschat.cloudyx.xyz` usa um [fluxo de deploy com releases](docs/DEPLOY-CPANEL.md). A configuração `.cpanel.yml` exige parâmetros privados definidos para cada instalação; os exemplos publicados não expõem a conta ou os caminhos internos da hospedagem.

Para retomar o desenvolvimento, leia a [memória do projeto](docs/MEMORIA-PROJETO.md), o [andamento](docs/ANDAMENTO.md) e as [orientações de contribuição](AGENTS.md).

O código original e os documentos usam [licença MIT](LICENSE). As dependências mantêm suas licenças. Os clientes GPL do Telegram baixados para pesquisa não integram o código publicado.

O canal será independente: não envia mensagens para números de WhatsApp. Visitantes e clientes precisam acessar o widget ou portal da empresa. O código será gratuito; hospedagem, domínio e serviços opcionais podem ter custos.

Projeto para um CRM e chat de código aberto, gratuito e auto-hospedado, com Node.js, MySQL e instalação pelo cPanel. A base atual usa JavaScript/CommonJS e foi testada em hospedagem com Node 24/MariaDB. Cada empresa opera sua própria instalação e mantém os dados na sua hospedagem.

## Plano atual

- [Plano de implementação](docs/PLANO-IMPLEMENTACAO.md): produto, arquitetura, módulos, fases e critérios de entrega.
- [Análise de Node.js no cPanel](docs/ANALISE-NODEJS-CPANEL.md): vantagens, limites e proposta técnica revisada.
- [Direção visual](docs/DIRECAO-VISUAL.md): referência na clareza do Telegram, com marca e interface próprias.
- [Contrato proposto de integração](docs/API-PROPOSTA.md): widget e API para sites existentes.
- [Fluxo proposto de instalação no cPanel](docs/INSTALACAO-CPANEL-PROPOSTA.md): experiência que o pacote final deverá oferecer.

Estes documentos são especificações. TypeScript e React estão previstos no plano; a base inicial usa JavaScript e HTML/CSS. O primeiro cadastro e a autenticação foram implementados, mas o instalador completo, a API de integração e o CRM continuam pendentes. O objetivo é distribuir código e pacote instalável, sem serviço comercial obrigatório, ativação externa ou dependência de conta do autor.

A [análise inicial do Telegram](docs/VIABILIDADE-CRM.md) permanece como referência histórica; o plano atual prioriza Node.js/TypeScript, MySQL e auto-hospedagem simples, conforme a orientação posterior do usuário. PHP é uma alternativa de compatibilidade, sem compromisso de desenvolver duas versões.

## Código baixado

- `referencias/telegram-web-a`: https://github.com/Ajaxy/telegram-tt — indicado pelo site oficial do Telegram.
- `referencias/telegram-web-k`: https://github.com/morethanwords/tweb — indicado pelo site oficial do Telegram, com os dois submódulos inicializados.
- `referencias/manifesto.json`: origens, commits e verificação dos downloads.

As cópias locais usam histórico reduzido para estudo. Os códigos e suas licenças foram preservados. Os clientes do Telegram não foram compilados ou autenticados. Somente o manifesto das referências é publicado neste repositório; as cópias GPL ficam excluídas pelo `.gitignore`.

Os aplicativos baixados são clientes da rede Telegram. Não incluem o servidor do Telegram nem permitem, por si só, criar uma rede de mensagens independente.


[Verificação manual cliente/operador por HTTPS](docs/VERIFICACAO-HTTPS-PORTAL.md): ferramenta com sessões sintéticas preparadas, backup17 obrigatório e limpeza por propriedade. Não faz parte do deploy; consulte o andamento para execução e limites.
