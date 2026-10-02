# Atendimento de texto — recorte v0.5

v0.5 publicado e verificado funcionalmente no ambiente de testes. Este documento define o contrato desta entrega, separado da API futura de CRM. Consulte o andamento para as evidências e limites das verificações; não apresentar como CRM completo.

Uma página `/chat` abre no domínio da instalação; o widget inicial é um botão que abre essa página em nova aba. Não depende de cookies de terceiros nem incorpora o painel em iframe. Um visitante recebe identidade própria por cookie HTTPS/HttpOnly, validade de oito horas e token armazenado somente como hash. Nome informado não comprova identidade nem recupera histórico de outro navegador. Não coletar e-mail nesta etapa.

Cada departamento mantém a entrada pública desabilitada por padrão. Administrador habilita explicitamente o canal; estar ativo não publica um departamento. Desabilitar entrada impede novas conversas; conversas existentes podem continuar enquanto o departamento estiver ativo. Desativar o departamento impede novas mensagens, preservando histórico/vínculos. Visitante ainda consulta seu próprio histórico; operador precisa de departamento ativo e vínculo atual (administrador acessa áreas ativas).

Visitante pode manter uma conversa aberta por vez, até 20 no histórico. Operador consulta fila autorizada, assume, responde, devolve à fila e encerra. Assumir simultaneamente tem um vencedor. Apenas responsável envia como equipe; administrador pode devolver/encerrar para recuperar atendimentos de operador desativado. Mensagens de texto têm 1–2.000 caracteres; anexos, notas privadas, transferência direta, campanhas e retomada verificada ficam para depois.

## Como habilitar e usar

Depois de configurar o banco privado, publicar a aplicação compatível e executar a migração explícita v3, entre em `/acesso` como administrador. Crie ou selecione um departamento, vincule os operadores e marque **Receber novos atendimentos pelo site**. Salve a entrada pública. Áreas internas continuam privadas até essa escolha.

Copie o trecho do botão mostrado nessa tela para o HTML do site. O `src` usa o domínio HTTPS da sua instalação, por exemplo:

```html
<script src="https://chat.suaempresa.example/widget.js" defer></script>
```

O site precisa permitir esse domínio em sua política de scripts. O botão usa estilo próprio; se a política do site bloquear estilos inline, use um link comum para `https://chat.suaempresa.example/chat`. O script não recebe nomes, tokens ou IDs de visitantes do site hospedeiro.

Visitantes escolhem uma área em `/chat`, informam o nome e iniciam a conversa. A equipe entra em `/atendimento`, seleciona o atendimento e clica **Assumir** antes de responder. Pode devolver à fila ou encerrar. Para reabrir atendimento, o visitante inicia outra conversa; o histórico encerrado continua disponível durante sua sessão. O cookie expira em oito horas: ainda não há login de cliente ou recuperação entre dispositivos.

## Contrato HTTP

Todas as escritas exigem origem igual a APP_URL. Após iniciar sessão, visitante usa `X-CSRF-Token`; equipe mantém cookie/CSRF existente. Campos extras e tipos JSON incorretos são recusados. IDs inteiros positivos até UINT32; mensagens consultadas por sequência da conversa, nunca por ID global. Histórico recebe `after` (padrão 0), `limit` (1–50, padrão 50), retornando `{messages, cursor, hasMore}`; cursor só avança pelas mensagens retornadas.

| Rota | Resultado |
|---|---|
| GET `/api/chat/public/departments` | `{departments:[{id,name}]}` apenas ativos/publicados |
| POST `/api/chat/visitor/session` `{name}` | 201 `{visitor:{id,name},csrfToken}`, cookie próprio |
| GET `/api/chat/visitor/me` | `{visitor:{id,name},csrfToken}` ou 401 |
| POST `/api/chat/visitor/logout` `{}` | `{authenticated:false}`, revoga só visitante |
| GET `/api/chat/visitor/conversations` | `{conversations}` próprias, até 20 |
| POST `/api/chat/visitor/conversations` `{departmentId}` | 201/200 `{conversation}`; repetição na mesma área reutiliza aberta |
| GET `/api/chat/visitor/conversations/:id/messages` | Histórico próprio |
| POST `/api/chat/visitor/conversations/:id/messages` `{text,clientKey}` | 201/200 `{message}` |
| GET `/api/chat/team/channels/:id` | Administrador: `{enabled:boolean}` |
| PUT `/api/chat/team/channels/:id` `{enabled}` | Administrador: `{enabled:boolean}` |
| GET `/api/chat/team/conversations?page=1&limit=20` | `{conversations,total,page,limit}` autorizadas, recentes primeiro |
| GET `/api/chat/team/conversations/:id/messages` | Histórico autorizado |
| POST `/api/chat/team/conversations/:id/messages` `{text,clientKey}` | Responsável: 201/200 `{message}` |
| POST `/api/chat/team/conversations/:id/claim` `{}` | `{conversation}` |
| POST `/api/chat/team/conversations/:id/release` `{}` | Responsável/administrador: `{conversation}` |
| POST `/api/chat/team/conversations/:id/close` `{}` | Responsável/administrador: `{conversation}` |

Mensagem segura: `{sequence,text,sender:'visitor'|'team',createdAt}`. Conversa: `{id,departmentId,departmentName,visitorName,status:'waiting'|'open'|'closed',assignedTo:number|null,updatedAt}`. Autoria e identidade vêm da sessão, nunca do corpo. `clientKey` é 32 caracteres hexadecimais aleatórios; repetição idêntica retorna mensagem existente, conteúdo diferente retorna 409. Após validar sessão/acesso atual, um reenvio já persistido pode ser confirmado mesmo se a conversa encerrou ou mudou de responsável; não insere mensagem nova nem consome outro limite. Sessão revogada, vínculo removido ou departamento inacessível continuam negados.

## Persistência e orçamento inicial

Schema v3 explícito/retomável, compatível com acesso e departamentos v1/v2 enquanto não migrado; chat exige v3. Novas tabelas: visitantes, conversas, mensagens e limites persistidos; opção pública no departamento com default false. Não migrar pelo cron. Fazer backup privado e preservar release v0.5 compatível antes do DDL; v0.4 não aceita v3.

Revalidar sessão, estado, vínculo, responsável e inserção sob a mesma transação. Todas as escritas de chat e de departamentos obtêm a trava permanente de schema antes das demais leituras/travas, coordenando criação, alteração de vínculos e mensagens. Sequência local incrementada sob trava da conversa; idempotência vinculada a conversa/autor/chave. Consultas limitadas e índices próprios.

Orçamento de homologação: 10.000 visitantes, 5.000 conversas, 50.000 mensagens no total, 500 por conversa. Sessões de visitante só são criadas após concluir a instalação. Limites persistidos em janelas fixas: cinco novas sessões por endereço observado a cada 15 minutos; dez mensagens de visitante e trinta de equipe por minuto, por identidade. Reenvio idêntico não consome outra mensagem. Limites vencidos podem ser removidos; histórico e visitantes expirados não são apagados automaticamente e continuam contando no orçamento de armazenamento. Não confiar em X-Forwarded-For arbitrário. Proxy/IP, retenção e carga ainda precisam de homologação antes de produção; limites globais e transações serializadas priorizam operação previsível nesta base inicial.

Polling sem requisições sobrepostas, a cada três segundos no chat aberto e cinco na fila, pausado quando a página fica oculta. Recuperar mensagens por sequência e deduplicar reenvios. UI usa textContent, navegação por teclado, foco/estado de envio, layouts móveis e recuperação de falha sem perder rascunho/chave idempotente.

## Critérios de entrega

Isolar dois visitantes e operadores de áreas diferentes; remoção de vínculo/sessão impede escrita; duas assunções têm um vencedor; reenvio não duplica; mensagens concorrentes preservam sequência/histórico; encerramento impede novos envios; desativação preserva registros; reinício não perde histórico. Confirmar capacidades/SQL real, HTTP e hash servido; registrar limites de revisão visual, concorrência e carga efetivamente ensaiados.

## Verificações realizadas e pendências

Em 02/10/2026, 85 testes passaram localmente, em Actions Node 22/24 e na release isolada do cPanel. Compatibilidade com v2 confirmada antes da migração explícita para v3; backup e comparação privada preservaram registros anteriores e canais privados. Treze checks SQL de chat, nove de departamentos e doze de equipe/senha passaram em MariaDB com dados sintéticos revertidos. Dezoito checks HTTPS passaram, incluindo canais públicos seguros, recusa de visitante anônimo/origem estrangeira e fila administrativa. Não foi criada conversa de visitante pelo proxy HTTPS nessa verificação.

Mock de DOM/fetch verificou recuperação de resposta perdida, reenvio após encerramento/mudança de responsável, 400/413, sessão já criada, BFCache, identidade alterada, escopo revogado e máximo de uma requisição em andamento. Rascunhos/chaves ficam na memória da página; recarregar completamente ou fechar a aba não os recupera. Não há localStorage com mensagens ou segredos.

Página pública real com nenhum canal habilitado foi conferida em desktop e 390 px, sem overflow horizontal; caixa de atendimento anônima exige login. Revisão visual autenticada, conversa entre dois navegadores pelo proxy HTTPS, concorrência SQL entre conexões, carga, retenção, proxy/IP e restauração permanecem pendentes. O verificador SQL usa uma conexão/savepoints; novo objeto de repositório comprova leitura persistida, sem afirmar ensaio de reinício do servidor ou corrida real entre processos.
