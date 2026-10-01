# Análise de Node.js para o projeto

Pesquisa em **01/10/2026**. Análise documental; nenhuma hospedagem do usuário foi acessada ou homologada.

## Parecer

**Node.js com TypeScript é um bom candidato principal para este CRM e chat**, mantendo MySQL e instalação pelo painel. A vantagem é trabalhar com comunicação assíncrona e compartilhar contratos entre frontend, widget e backend. A decisão não precisa depender da percepção de modernidade: PHP atual também permite construir um bom sistema.

Node reduz a compatibilidade com hospedagens que oferecem somente PHP, mas atende às que oferecem aplicação Node gerenciada com runtime suportado. Não planejar dois backends antes de validar o primeiro.

## O que o cPanel oferece

Existem diferentes caminhos:

- **Application Manager:** gerencia aplicações usando Passenger e oferece ação para instalar dependências npm. O provedor precisa habilitar o recurso. Fonte: [cPanel](https://docs.cpanel.net/cpanel/software/application-manager/).
- **CloudLinux Node.js Selector:** configura versão, raiz da aplicação, arquivo inicial e variáveis, além de instalar módulos. Fonte: [CloudLinux](https://docs.cloudlinux.com/cloudlinuxos/command-line_tools/).
- **Outros gerenciadores, incluindo Meridian:** têm fluxos de implantação próprios. Fonte: [Node no Meridian](https://docs.cpanel.net/cpanel/meridian/websites/manage-a-nodejs-app/).

Ter o ícone Node não confirma todas as conexões, dependências e capacidades necessárias.

## Comparação para este produto

São avaliações de arquitetura, não benchmarks.

| Critério | PHP convencional | Node gerenciado |
|---|---|---|
| Hospedagens compatíveis | Maior alcance potencial | Depende da oferta no plano |
| Interface moderna e CRM | Viável | Viável |
| Uma linguagem no cliente e servidor | Normalmente PHP + JS | JS/TypeScript nos dois lados |
| Comunicação persistente | Estrutura específica | Bom encaixe, condicionado ao proxy |
| Instalação | Arquivos, banco e configuração web | Aplicação, arquivos, banco e dependências |
| Reinícios | Servidor PHP | Gerenciador Node |
| Campanhas | Cron ou worker | Cron ou worker |
| MySQL | Adequado | Adequado |

Node não garante menor custo ou maior velocidade sozinho. Banco, anexos, configuração e limites da conta influenciam o resultado.

## WebSocket é uma capacidade separada

**Suporte a Node não confirma suporte a WebSocket.** O proxy pode influenciar upgrade HTTP, duração da conexão, reconexão e roteamento entre processos.

O Passenger recomenda modos Nginx ou Standalone para WebSocket e registra limitações da integração Apache. É preciso testar a combinação do provedor. Fonte: [modos de integração](https://www.phusionpassenger.com/docs/advanced_guides/in_depth/ruby/integration_modes.html).

O modo básico usa HTTP com consulta incremental curta. WebSocket será ativado quando homologado, com retorno ao modo HTTP se indisponível. SSE também depende de conexão prolongada e comportamento do proxy.

Se for usado Socket.IO com transporte de polling e vários processos, afinidade de sessão pode ser necessária; distribuição de eventos entre processos é outro requisito. Fonte: [configuração Passenger](https://www.phusionpassenger.com/docs/references/config_reference/).

## Stack proposta

- **Runtime:** Node 24 LTS quando oferecido; homologar também Node 22 LTS atualizado. Na data da pesquisa, 22 e 24 são LTS e 20 chegou ao fim de suporte. Fonte: [versões oficiais](https://nodejs.org/en/about/previous-releases).
- **Código:** TypeScript compilado para JavaScript antes da distribuição.
- **Backend:** Fastify 5, validação por esquema e módulos. Fonte de compatibilidade: [política Fastify](https://github.com/fastify/fastify/blob/main/docs/Reference/LTS.md).
- **Banco:** MySQL, com driver e migrações que evitem ferramentas/binários adicionais obrigatórios.
- **Frontend:** React/Vite gerando arquivos estáticos; a mesma aplicação Node serve interface e API.
- **Widget:** pacote JavaScript pequeno, independente do painel.
- **Chat:** persistência no banco; HTTP básico e WebSocket opcional.
- **Campanhas:** fila no MySQL, comando Node finito por cron.
- **Pacote:** código, frontend/backend compilados, app.js, lockfile, tutorial e assistente.

Passenger pode esperar `app.js` e intermediar a porta. Homologar adaptador de entrada CommonJS e bootstrap compilado; não exigir execução de TypeScript, porta pública manual ou configuração root. Fontes: [entrada Node](https://support.cpanel.net/hc/en-us/articles/360063461753-Node-js-applications-won-t-start-in-cPanel-403-Forbidden-AH01276-Cannot-serve-directory-No-matching-DirectoryIndex), [portas cPanel](https://support.cpanel.net/hc/en-us/articles/4420354935703-Do-cPanel-s-NodeJS-apps-all-run-on-the-same-port-3000).

## Operação independente

Processos web podem reiniciar ou encerrar quando ociosos. Tarefas, sessões, inscrições e progresso de campanhas ficam no banco, não somente em memória.

Cron processa um lote limitado e termina. Não depender de `setInterval` do processo web para campanhas. Redis e PM2 não serão requisitos básicos. O pool MySQL considera o total de processos e o orçamento de conexões da conta.

## Prova de hospedagem

1. Instalar aplicação mínima pelo painel e abrir por HTTPS.
2. Instalar dependências pelo fluxo disponível, sem acesso root.
3. Confirmar runtime, diretório privado e variáveis.
4. Gravar/ler mensagem no MySQL e verificar migrações.
5. Testar API, frontend e montagem em subcaminho, caso oferecida.
6. Testar cron, reinício e retorno após ociosidade.
7. Verificar WebSocket, reconexão e múltiplas sessões; repetir pelo modo HTTP.
8. Medir memória, processos, banco e tempo de resposta.

O provedor de referência ainda não foi informado. A pesquisa confirma a viabilidade geral; compatibilidade e capacidade reais seguem pendentes de teste.

## Decisão

**Node.js + TypeScript + MySQL como proposta principal**, com distribuição gratuita e integração simples. A primeira entrega técnica comprova implantação no cPanel antes do CRM completo. PHP permanece alternativa se o alcance a hospedagens sem Node virar requisito prioritário.
