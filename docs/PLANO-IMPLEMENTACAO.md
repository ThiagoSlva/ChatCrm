# Plano de implementação — CRM e chat aberto para cPanel

**Definição de produto de 01/10/2026.** Este documento descreve o sistema a construir; não representa funcionalidades já implementadas.

## 1. Objetivo

Entregar gratuitamente um código-fonte aberto e um pacote instalável para que qualquer pequena empresa tenha seu próprio atendimento web, cadastro de leads, funil comercial, operadores, comunicação interna e campanhas para inscritos. A empresa instala no seu domínio, usando uma hospedagem cPanel com Node.js e MySQL homologados, e integra ao site existente, inclusive sites feitos em PHP.

Proposta de nome provisório: **Conversa Livre**. Nome e disponibilidade de marca ainda não foram verificados; não são uma decisão de publicação.

Promessa do produto: **“Seu atendimento, seus leads e suas conversas, no seu próprio site.”**

A melhoria central da ideia é unir a facilidade de um chat com a continuidade de um CRM: cada conversa pode se tornar uma oportunidade, tarefa ou acompanhamento, sem exigir que a empresa use um aplicativo externo para atender.

A identidade visual usa o Telegram como referência de leveza, organização e legibilidade, com componentes e marca próprios. Paleta, navegação e critérios estão em [DIRECAO-VISUAL.md](DIRECAO-VISUAL.md).

## 2. Princípios do projeto

- Uma instalação por empresa; vários operadores e departamentos na mesma instalação.
- Código e pacote completos disponíveis, sem edição paga, licença de ativação, planos comerciais ou conta obrigatória em serviço do autor.
- Dados, anexos e configurações permanecem na hospedagem da empresa. Nenhuma coleta de conversas ou telemetria externa por padrão.
- Instalação guiada pelo navegador e arquivos prontos para envio pelo Gerenciador de Arquivos do cPanel.
- Node.js com TypeScript e MySQL como base proposta; Redis, Docker, PM2 e WebSocket não são requisitos da instalação em cPanel. A disponibilidade de Node precisa ser confirmada no plano do provedor.
- Português brasileiro como idioma inicial; interface responsiva, utilizável por teclado e em celular.
- Integração básica por um trecho de HTML; API autenticada para integrações mais completas.
- Exportação e restauração dos dados como recursos essenciais do produto.

Gratuidade se refere ao software. A empresa utiliza sua própria hospedagem e os serviços opcionais que configurar, como SMTP. Não há necessidade de criar um negócio de SaaS para distribuir esta solução.

## 3. Experiência do cliente e da equipe

### Cliente

Pode abrir um botão flutuante no site, uma página direta de atendimento ou um QR code. Escolhe um departamento, envia a dúvida e vê as respostas sem recarregar a página. Começa como visitante; o formulário de identificação é curto e pode ser configurado para aparecer antes ou durante o atendimento.

Nome, telefone e e-mail informados são dados de cadastro, não prova de identidade. Para retornar ao histórico em outro dispositivo, o cliente verifica o e-mail, entra com uma conta do portal ou usa uma identidade assinada pelo backend do site já existente.

Um portal em `suporte.empresa.com.br` reúne conversas, solicitações e novidades. Isso dá ao cliente um lugar para voltar e aumenta a utilidade do canal além da primeira conversa.

### Operador

Recebe as conversas permitidas, assume o atendimento, usa respostas salvas, registra notas internas, transfere para outro departamento e cria uma oportunidade comercial. A conversa e o negócio mantêm vínculo, mas podem ter responsáveis diferentes.

### Administrador

Cadastra operadores, define permissões, departamentos, horários, identidade visual, domínio do widget e etapas do funil. Vê diagnóstico de instalação, tarefas agendadas, SMTP, consumo de espaço e falhas de envio.

## 4. Escopo de produto

| Módulo | Primeira entrega | Evolução planejada |
|---|---|---|
| Atendimento | Texto, histórico, responsável, estados, transferência, departamentos e notas privadas | Anexos, respostas salvas, avaliação e indicadores |
| CRM | Leads/contatos, origem, tags, pesquisa, funil e oportunidades | Importação CSV com prévia, tarefas, campos personalizados e deduplicação assistida |
| Equipe | Administrador, supervisor e operador; convites e recuperação de acesso | Salas internas por departamento e mensagens diretas |
| Portal do cliente | Chat direto, identidade verificada e consulta do próprio histórico | PWA e central de solicitações |
| Integração | Widget e API de contatos/conversas | Identificação assinada, webhooks e exemplos para plataformas de site |
| Campanhas | Segmentação, inscrição, descadastro e caixa de novidades no portal | Agendamento, Web Push e relatórios por canal |
| Operação | Instalador, diagnóstico, exportação e pacote de atualização | Backup completo guiado e política de retenção |

Leads e contatos pertencem à mesma entidade de pessoa/organização, com classificação e status; oportunidades são entidades separadas. Um contato pode ter várias oportunidades. Isso evita duplicar uma pessoa a cada venda.

O chat interno deve ser um módulo separado das notas de atendimento. Mensagem da equipe nunca deve ser enviada ao cliente por engano: editor, destino e permissões são distintos.

Recursos como telefonia, chamadas de vídeo, sincronização entre empresas e integrações com mensageiros ficam para depois da versão 1.0. Eles ampliariam muito a complexidade sem resolver a instalação simples solicitada.

## 5. Base técnica recomendada

**Monólito modular em Node.js com TypeScript, Fastify, MySQL e interface web React/Vite distribuída já compilada.** Node é o ambiente de execução; TypeScript é a linguagem proposta para organizar backend, interface e contratos da API. A mesma aplicação serve a API, o painel e o widget, evitando dois serviços obrigatórios na hospedagem.

Node é o candidato principal, condicionado à prova de implantação no provedor. PHP continua sendo uma alternativa se o objetivo exigir hospedagens que não disponibilizam Node; não planejar duas implementações simultâneas. A análise e as fontes estão em [ANALISE-NODEJS-CPANEL.md](ANALISE-NODEJS-CPANEL.md).

Requisitos propostos para homologação:

- Node 24 LTS preferencial quando disponível; Node 22 LTS como alvo adicional, sempre nas versões corrigidas e dentro do suporte oficial.
- MySQL 8.4 como ambiente principal de teste; testar também MariaDB 10.11 e 11.4 antes de declarar suporte.
- InnoDB e `utf8mb4`, com datas persistidas em UTC e exibição no fuso da instalação.
- HTTPS, gerenciador de aplicação Node no painel, variáveis de ambiente e instalação das dependências de produção.
- Permissão de escrita somente nas pastas necessárias de armazenamento e cache.
- Cron para campanhas, notificações e manutenção automática; o chat básico não depende dele.
- Node CLI correspondente à versão da aplicação para executar o cron. Se o provedor não oferecer CLI, avaliar um acionador HTTP restrito como recurso futuro, sem anunciá-lo como disponível.

As versões disponíveis e a forma de iniciar o processo variam entre Application Manager/Passenger, Node.js Selector e outros gerenciadores. O instalador verifica runtime, banco e permissões; um teste no ambiente real verifica comportamento do proxy e reinícios. Fontes: [Application Manager](https://docs.cpanel.net/cpanel/software/application-manager/), [Node.js Selector](https://docs.cloudlinux.com/cloudlinuxos/command-line_tools/) e [versões Node](https://nodejs.org/en/about/previous-releases).

O usuário recebe backend JavaScript, frontend estático e arquivos de configuração preparados. TypeScript e Vite não são compilados no cPanel. Dependências de produção são instaladas pelo botão do gerenciador ou por um pacote compatível homologado. Priorizar dependências sem compilação nativa, um driver MySQL e migrações que não exijam outro serviço. A distribuição inclui lockfile, manifesto de dependências, avisos de licença e checksums. Não prometer instalação sem SSH em um gerenciador que não ofereça o fluxo necessário.

### Organização do código

```text
src/modules/
  Installation/   # Assistente e diagnóstico
  Identity/       # Equipe, visitantes e clientes verificados
  Conversations/  # Atendimento e mensagens
  Contacts/       # Cadastro, tags e importação
  Sales/          # Funil, oportunidades e tarefas
  TeamChat/       # Salas e mensagens internas
  Campaigns/      # Segmentos, inscrições e envios
  Integrations/   # Widget, API e webhooks
  Operations/     # Diagnóstico, exportação e retenção
src/database/migrations/
frontend/
widget/
dist/server/      # Backend compilado
dist/public/      # Interface pronta
app.js            # Adaptador para o gerenciador de hospedagem
docs/
tests/
```

Cada módulo expõe serviços; regras de acesso não ficam apenas no frontend. A API e o painel chamam as mesmas regras de negócio, evitando dois comportamentos diferentes para a mesma ação.

## 6. Como o chat funciona em hospedagem compartilhada

O envio é uma requisição curta: o servidor valida o participante e salva a mensagem imediatamente no MySQL. As telas consultam um endpoint incremental de novidades, inicialmente a cada **3 segundos** quando ativas. Respostas chegam com pequeno atraso, conforme a consulta e o servidor.

Proposta de ajustes: reduzir a frequência após inatividade, desacelerar abas ocultas, adicionar variação aos intervalos, impedir requisições sobrepostas e sincronizar abas para evitar consultas duplicadas. Atualizações de presença e “digitando” são eventos leves e limitados, não escritas a cada tecla.

Um cursor de eventos deve incluir novas mensagens, alterações, leitura e atribuição. A ordem de publicação deve respeitar commits concluídos; apenas usar `id > último_id` pode perder eventos quando transações terminam fora de ordem. Implementar revisões transacionais ordenadas e ressincronização quando o cursor expirar.

O modo compatível usa respostas rápidas e índices para histórico e eventos. WebSocket pode substituir as consultas do navegador quando a hospedagem permitir, com detecção e retorno ao modo HTTP quando necessário. Persistência e autorização são iguais nos dois modos.

Isso melhora a compatibilidade, mas consome requisições: **30 telas ativas consultando a cada 3 segundos representam cerca de 10 consultas por segundo**, antes das demais ações. É um cálculo de dimensionamento, não a capacidade de uma hospedagem. Medir limites reais de CPU, I/O e processos simultâneos durante a homologação.

Se o gerenciador iniciar mais de um processo, publicar apenas em memória não entrega o evento às conexões dos outros processos. No modo básico, todos leem eventos duráveis do banco; o modo WebSocket precisa de estratégia explícita de distribuição entre processos ou homologação de instância única. Uma opção futura de broker em VPS pode acelerar essa distribuição sem virar edição paga.

## 7. Campanhas no próprio canal

Uma campanha pode gerar mensagens persistentes na caixa de novidades de clientes inscritos. Essa caixa é distinta dos atendimentos e das salas internas; a resposta a uma novidade pode abrir uma conversa de suporte vinculada à campanha.

O cron prepara e processa pequenos lotes da fila no banco. Cada destinatário e cada canal tem um registro de envio e uma chave única que evita duplicar mensagens locais. O processo pode parar e retomar sem reiniciar a campanha inteira.

Planejar lotes com tempo e quantidade máximos, trava contra execuções sobrepostas, retentativa com atraso e painel de falhas. Cada tarefa de integração terá timeout próprio: uma operação externa lenta não pode ocupar indefinidamente o cron. O comando Node de processamento termina após o lote; tarefas e reservas ficam no banco, com expiração para retomada. Não depender de um timer em memória do processo web: ele pode reiniciar ou ficar ocioso. Fonte operacional: [cron no cPanel](https://docs.cpanel.net/cpanel/advanced/cron-jobs/).

Destinatários elegíveis são revalidados durante o envio: inscrição ativa, preferência de canal e conta válida. Importar um CSV não inscreve automaticamente os contatos. Mensagem persistida no portal, notificação encaminhada e mensagem lida são estados distintos.

Web Push será opcional. Exige adesão do dispositivo e suporte do navegador; sua entrega normalmente passa pelo serviço de push do navegador. O conteúdo das conversas permanece no servidor da empresa e a notificação deve carregar o mínimo necessário. Fonte: [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API).

E-mail pode avisar sobre respostas quando SMTP estiver configurado, respeitando limites do provedor. Falha na notificação não apaga nem impede a mensagem do chat. Envios externos são tratados como potencialmente repetidos: sem idempotência do provedor, não prometer envio exatamente uma vez após falha entre entrega e confirmação.

## 8. Banco de dados proposto

| Grupo | Entidades principais |
|---|---|
| Instalação | settings, schema_migrations, installation_state |
| Equipe e acesso | users, roles, departments, department_members, invitations, access_tokens |
| Clientes | contacts, contact_identities, visitor_sessions, customer_accounts, tags, contact_tags |
| Atendimento | conversations, conversation_participants, messages, attachments, conversation_events, read_positions |
| Comercial | pipelines, stages, opportunities, tasks, contact_notes |
| Chat interno | team_rooms, team_room_members, team_messages, team_read_positions |
| Campanhas | campaigns, campaign_recipients, campaign_messages, channel_subscriptions, notification_deliveries |
| Integração e operação | site_integrations, webhook_deliveries, jobs, failed_jobs, audit_events |

Usar chaves estrangeiras, paginação e índices coerentes com consultas reais. Mensagens precisam de índice por conversa e sequência; tarefas por status e vencimento; destinatários de campanha por campanha e contato, com unicidade.

Uma instalação representa uma empresa: não acrescentar uma plataforma de revenda/multiempresa ao MVP. Departamentos, permissões e separação entre atendimento e equipe continuam obrigatórios.

## 9. Integração fácil, com identidade confiável

O painel gera um trecho de HTML para colocar no site, com URL do script e identificador público do widget. O script cria uma interface isolada, preferencialmente em iframe, para não interferir no CSS do site.

O identificador público permite abrir um atendimento, não consultar o CRM nem cadastrar operadores. Domínios permitidos ajudam a limitar a incorporação, mas não substituem autorização ou controle de abuso.

Para sites com login, o backend assina uma identificação temporária. O chat valida assinatura e validade e só então associa ao cliente existente. O JavaScript do site não pode alegar uma identidade apenas passando nome/e-mail.

Se o navegador restringir cookies ou armazenamento de terceiros, o widget oferece abrir a página de atendimento no domínio da empresa. O retorno ao histórico precisa funcionar também por identidade verificada, sem depender exclusivamente do armazenamento dentro do iframe.

API administrativa usa tokens revogáveis com escopos e validade, somente no backend do site ou integração autorizada. Cadastro de operadores exige permissão específica. Contrato detalhado em [API-PROPOSTA.md](API-PROPOSTA.md).

## 10. Instalação e atualização como parte do produto

A versão publicada terá ZIP pronto, código-fonte reproduzível, assistente de instalação e tutorial com imagens. O fluxo preferencial registra uma aplicação Node no gerenciador do painel e a associa a um subdomínio. A raiz da aplicação fica em diretório privado; apenas arquivos de interface autorizados são servidos pelo aplicativo, sem expor configuração ou anexos privados.

O pacote inclui um `app.js` de entrada compatível com o gerenciador homologado e respeita a forma de ligação de porta/socket dele. Não exigir porta pública 3000, acesso root ou PM2. No modo Passenger, o gerenciador intermedeia a porta da aplicação. Fonte: [portas de aplicações Node no cPanel](https://support.cpanel.net/hc/en-us/articles/4420354935703-Do-cPanel-s-NodeJS-apps-all-run-on-the-same-port-3000).

O instalador verifica requisitos, pede banco/usuário/senha e dados do administrador, testa a conexão, gera a chave da aplicação, cria as tabelas e encerra a instalação. Não sobrescreve um banco em uso: banco vazio ou prefixo explicitamente escolhido; tentativas interrompidas usam estado persistido e retomada controlada.

Para impedir que um visitante assuma uma instalação nova, exigir um segredo de instalação criado por arquivo privado no cPanel antes de abrir o assistente. Nenhum segredo padrão compartilhado entre downloads. Após concluir, marcar a instalação como finalizada e bloquear o instalador; reabrir exige acesso ao painel e ação local explícita.

Atualização inicial por pacote enviado manualmente: modo de manutenção, verificação de versão e pacote, backup, migrações e validação. Migrações estruturais precisam de registro passo a passo; não presumir que DDL do MySQL possa ser todo revertido por uma transação. Reversão exige pacote anterior e backup compatível. Atualização automática fica para uma etapa posterior.

O backup completo inclui banco, anexos, configuração e chave da aplicação; sua exportação deve ser autenticada, protegida e removida da área temporária ao terminar. Não deixar ZIPs acessíveis por URL pública. Tutorial proposto em [INSTALACAO-CPANEL-PROPOSTA.md](INSTALACAO-CPANEL-PROPOSTA.md).

## 11. Qualidade e proteção dos dados

Critérios funcionais do produto, desde a primeira versão:

- Verificar acesso a cada conversa, contato, sala e arquivo; trocar um ID na URL não dá acesso a outro histórico.
- Cliente não vê notas privadas nem chat interno; operador acessa apenas departamentos autorizados.
- Consultas parametrizadas, validação e saída escapada; texto e anexos não executam código no servidor ou no navegador.
- Sessões com configuração segura, proteção CSRF nas ações do painel, limitação de login e recuperação de acesso sem revelar senhas.
- Anexos com nomes internos aleatórios, limites configuráveis, tipos permitidos e download autorizado; sem arquivos executáveis publicados.
- Segredos fora do frontend e logs; tokens de API armazenados de forma adequada e revogáveis.
- Papéis claros para arquivar, exportar e excluir dados; preferências de comunicação e retenção configuráveis.
- Diagnosticador informa como corrigir requisitos sem expor credenciais ou dados de clientes.
- Navegação por teclado, foco visível, estados de envio/erro acessíveis e layout testado em celular.

Não anunciar criptografia de ponta a ponta: o servidor precisa processar o histórico para o atendimento compartilhado e CRM. A proposta utiliza HTTPS, permissões e armazenamento protegido.

## 12. Fases com entregas verificáveis

| Fase | Entrega concreta | Condição para avançar |
|---|---|---|
| 0 — prova de hospedagem | Pacote Node mínimo, banco, cron e gerenciamento de processo em cPanel de teste | Instalação pelo painel; proxy, reinícios e modo HTTP verificados; WebSocket classificado separadamente |
| 1 — fundação | Instalador, autenticação, operadores, departamentos e permissões | Instalador não reabre após concluir; equipe e clientes têm identidades separadas |
| 2 — atendimento | Chat direto, widget, consulta incremental, histórico, transferência e notas | Cliente e operador conversam; histórico persiste; acesso indevido falha |
| 3 — CRM | Cadastro, tags, origem, funil, oportunidades, tarefas e importação | Uma conversa vira lead e oportunidade; importação apresenta prévia e erros |
| 4 — retorno e colaboração | Portal verificado, recuperação de acesso, anexos, respostas salvas e chat interno | Cliente retoma só seu histórico; salas internas nunca aparecem no widget |
| 5 — API e campanhas | Tokens com escopos, identidade assinada, webhooks, inscrições, fila e descadastro | Retentativa não duplica mensagem local; descadastro impede campanha pendente |
| 6 — versão pública 1.0 | ZIP, release notes, licença, tutorial, backup e guia de atualização | Instalação limpa e atualização homologadas; restauração demonstrada |

Planejamento inicial: **12–18 semanas para a versão 1.0 descrita**, com um desenvolvedor experiente dedicado e escopo estável. É uma estimativa de engenharia, não prazo garantido. Uma versão de demonstração com chat e leads pode existir antes; não deve ser anunciada como pacote pronto para produção.

Prioridade: validar o cPanel na fase 0. Se a hospedagem-alvo não permitir Node suportado, implantação segura ou cron, resolver o requisito antes de construir os módulos comerciais.

## 13. Homologação e distribuição aberta

Testar a matriz de Node/bancos declarada e ao menos um cPanel real. Sem acesso a um cPanel, a compatibilidade permanece planejada, não comprovada. Testes locais não substituem limites e configurações do provedor. Verificar também reinício do processo, conexão expirada, múltiplos processos e aplicação montada em subcaminho.

Casos essenciais: duas respostas simultâneas, duas abas, reconexão, envio repetido, transações fora de ordem, cron concorrente, instalação interrompida, migração interrompida, falha de SMTP, arquivo não autorizado, contato duplicado e identidade falsa enviada pelo widget.

Começar o ensaio de carga com 10 atendentes e 20 visitantes simultâneos em uma configuração registrada. Medir latência, taxa de erro, requisições, tempo de banco e consumo da hospedagem; é um cenário de teste, não promessa de capacidade. Publicar resultados e intervalos de consulta utilizados.

Recomendo **MIT para o código original**, preservando licenças de todas as dependências. Ela facilita uso, adaptação e redistribuição, inclusive por quem presta serviços, sem exigir comercialização pelo autor. O texto de licença final será incluído quando começar a implementação; revisar a composição das dependências na preparação do pacote.

As cópias Telegram ficam como referências de estudo, separadas do pacote. Não incorporar seus componentes GPL como se fossem MIT. Se algum trecho for reutilizado, reavaliar a licença do trabalho derivado antes de publicar.

O repositório público deverá incluir guia de contribuição, política de relato de falhas, documentação da API, migrações, testes e instruções para reproduzir o ZIP. Publicação em GitHub e nome definitivo são ações futuras, não realizadas por este plano.

## 14. Definição de sucesso

Uma pessoa com conhecimento básico de cPanel consegue instalar o pacote, cadastrar dois operadores, colocar o botão no site e concluir um atendimento real. Depois consegue localizar o contato no CRM, registrar uma oportunidade e permitir que o cliente retome a conversa com identidade verificada.

A empresa consegue exportar seus dados e mover a instalação para outra hospedagem compatível. O sistema continua funcionando sem conta, licença remota ou servidor obrigatório do autor. Esse é o resultado que deve orientar todas as decisões de implementação.
