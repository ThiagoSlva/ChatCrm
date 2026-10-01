# Conversa Livre — chat e CRM aberto

**Estado atual: v0.2.0, fase 1 em andamento. Conversa Livre é um nome provisório.** A base inclui diagnóstico, migração MySQL v1, criação protegida do primeiro administrador, login, logout e gestão de operadores com permissões. Instalação e autenticação já foram testadas por HTTPS com persistência real em MariaDB 11.8.6; a homologação da nova gestão de equipe está registrada no andamento. Outras instalações precisam configurar seu banco exclusivo e variáveis privadas. Chat, leads, campanhas e o instalador completo ainda estão em desenvolvimento. Não use esta versão para atendimento real.

## Executar a base

Requisitos: Node.js 22 ou 24 e npm. MySQL é opcional para abrir a página.

```sh
npm ci
npm test
npm start
```

Abra `http://127.0.0.1:3000`. O servidor usa `HOST` e `PORT` do ambiente, com esses valores como padrão. Para testar MySQL, copie `.env.example` para `.env`, preencha as variáveis privadas e execute `npm run check:database`. O comando executa somente `SELECT 1`, sem criar tabelas ou alterar dados.

Veja [como testar a base no cPanel](docs/TESTE-BASE.md). O provedor precisa oferecer Node.js compatível e gerenciador de aplicações. A entrada atual é `app.js` em CommonJS. Compatibilidade com Passenger, instalação sem SSH e recursos de chat ainda precisam de homologação.

Para preparar o banco e criar o primeiro administrador, siga o [guia de instalação e acesso](docs/INSTALACAO-ACESSO.md). Abra `/acesso` após configurar o ambiente. Não existem credenciais padrão.

Administradores podem [cadastrar, desativar e reativar operadores](docs/OPERADORES.md) em `/acesso`. Desativar revoga as sessões; operadores não acessam a gestão da equipe.

O ambiente dedicado `testeschat.cloudyx.xyz` usa um [fluxo de deploy com releases](docs/DEPLOY-CPANEL.md). A configuração `.cpanel.yml` contém caminhos específicos dessa hospedagem e deve ser adaptada para outras instalações.

Para retomar o desenvolvimento, leia a [memória do projeto](docs/MEMORIA-PROJETO.md), o [andamento](docs/ANDAMENTO.md) e as [orientações de contribuição](AGENTS.md).

O código original e os documentos usam [licença MIT](LICENSE). As dependências mantêm suas licenças. Os clientes GPL do Telegram baixados para pesquisa não integram o código publicado.

O canal será independente: não envia mensagens para números de WhatsApp. Visitantes e clientes precisam acessar o widget ou portal da empresa. O código será gratuito; hospedagem, domínio e serviços opcionais podem ter custos.

Projeto planejado para um CRM e chat de código aberto, gratuito e auto-hospedado, com MySQL e instalação pelo cPanel. Node.js com TypeScript é o candidato principal após a revisão de hospedagem; a compatibilidade com um provedor real ainda precisa ser homologada. Cada empresa opera sua própria instalação e mantém os dados na sua hospedagem.

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
