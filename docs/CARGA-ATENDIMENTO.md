# Concorrência e limite de conexões

O servidor mantém até três conexões MySQL e até vinte aquisições esperando por processo Node. Esses limites evitam uma fila ilimitada na hospedagem compartilhada. Vários processos somam seus próprios limites; isto não define a capacidade contratada do provedor.

Desde v0.13.2, quando essa fila já está cheia, a aquisição recusada retorna HTTP 429 com `Retry-After: 1`. A resposta continua genérica, sem consulta, caminho, credencial ou erro interno. Clientes devem aguardar antes de tentar de novo. O servidor não aumenta a fila, ignora permissões ou repete comandos SQL automaticamente.

A classificação ocorre somente na aquisição de uma conexão, antes do próximo comando SQL. Uma requisição pode já ter feito leituras anteriores. Erros de consulta, desconexão, fechamento do pool ou resultado incerto de uma gravação não são transformados em uma recusa de fila. Reenvios de mensagens continuam usando a mesma chave idempotente e o texto original; uma chave nova pode criar outra mensagem.

## Ensaio local em 06/10/2026 UTC

Ambiente: Windows, Node 22.15.0, MariaDB 11.4.13 em container próprio, HTTP em loopback. Banco novo, schema9, dez operadores, vinte visitantes e vinte conversas exclusivamente fictícias. Sessões foram preparadas para concentrar a medição nas consultas, sem medir login ou hashing de senhas. Cada operador consultou a fila; cada visitante consultou seu histórico incremental vazio. Não houve tráfego de carga na hospedagem.

| Cenário | Antes | Depois |
|---|---|---|
| Cinco ondas de 30 leituras disparadas juntas | 115 respostas200, 35 respostas500 | 115 respostas200, 35 respostas429 |
| Três conexões deliberadamente ocupadas por 300 ms, mais 30 leituras | 20 respostas200, 10 respostas500 | 20 respostas200, 10 respostas429 |
| Cinco ciclos de 30 leituras distribuídas, período2 s, separação20 ms | Não medido | 150 respostas200, nenhuma recusa; p50 13,64 ms, p95 16,42 ms, máximo21,19 ms |

O primeiro ensaio completo anterior teve180 leituras, sem erros de transporte, p95 404,84 ms. O primeiro ensaio após a correção confirmou também vinte pares de envios simultâneos com a mesma chave: vinte mensagens novas, vinte replays, vinte sequências finais iguais a1. Uma leitura de conversa por outro visitante retornou404. O relatório posterior com consultas distribuídas teve401 requisições:348 respostas200,52 recusas429 e uma negativa404 esperada; nenhum500 ou erro de transporte. Os reenvios desse relatório usaram as mesmas chaves, preservando as vinte mensagens anteriores.

Esses números comprovam tratamento da saturação e comportamento de um cenário curto. A correção não aumenta a capacidade nem elimina recusas sob uma rajada de30. O tráfego distribuído é um experimento; o frontend não foi alterado para reproduzi-lo. A interface atual consulta fila a cada5 s e histórico a cada3 s, com ações adicionais conforme navegação. Não extrapole esse ensaio para TLS, navegador, Passenger, Cloudflare, servidor compartilhado, histórico grande, carga prolongada ou garantia de dez operadores e vinte visitantes na hospedagem.

Os scripts do ensaio e sessões fictícias ficaram privados e fora do pacote. Para reproduzir, use um banco local novo e exclusivo com schema compatível, instâncias de sessão fictícias separadas, pool configurado como acima e um servidor restrito a loopback. Registre revisões, versões, tamanho dos dados, cadência, contagens por status, latência e erro de transporte. Preserve artefatos e não use o banco instalado do domínio para forçar saturação. Os quatro testes de regressão públicos em `test/database-pool.test.js` exercitam a classificação, liberação, ausência de repetição e recuperação HTTP; não são um benchmark.

## Agendamento desde v0.13.3

Desde v0.13.3, cada agendamento automático de chat, caixa de atendimento e portal soma uma variação aleatória positiva de150 a750 ms. O chat mantém a base de3 s após concluir a leitura; o portal mantém5 s, ou15 s no caminho de falha já existente. A caixa conserva os prazos mínimos de5 s para fila e3 s para histórico, acrescentando a variação à próxima espera calculada. Ao retornar a uma aba, o agendamento antes imediato passa a esperar150 a750 ms. Ações manuais continuam imediatas; o mecanismo não repete gravações nem muda o limite do pool.

Quatro testes do agendador verificam trinta contextos distintos, prazos, apenas um timer, pausa quando a aba está oculta/ocupada/encerrada e preservação de envios pendentes. São testes determinísticos de scripts, não medição de carga. Revisão no navegador com persistência fictícia conferiu desktop/390px, teclado e rascunhos em chat/atendimento, reenvio incerto sem duplicação e portal vazio. A distribuição das chamadas é probabilística: não garante separação entre todas as abas, elimina saturação ou comprova maior capacidade do provedor. O primeiro benchmark acima continua sendo o ensaio da v0.13.2; a medição seguinte usa a cadência atual.

## Ensaio sustentado com históricos — 06/10/2026 UTC

Revisão medida: `4ec7f65cf7c123a8cc95fc772b651ce871fd6739`, v0.13.4/schema9, Windows/Node 22.15.0 e MariaDB 11.4.13. Foram 180.074 ms (cerca de três minutos), em banco local novo e exclusivo: dez operadores, vinte visitantes, vinte conversas e 8.000 mensagens fictícias, quatrocentas por conversa. Não houve carga ou dados de ensaio na hospedagem.

Clientes HTTP Node modelaram as rotas e cadências atuais: visitantes aguardam pelo menos três segundos depois da leitura; atendimento mantém mínimos de cinco segundos para fila e três para mensagens, somando a variação de150 a750 ms do agendador compartilhado. Operadores alternaram entre duas conversas próprias a cada trinta segundos. Históricos foram lidos em páginas de cinquenta mensagens, até dez páginas por leitura, verificando cursores e sequências. Sessões já estavam preparadas. A primeira espera também foi distribuída; essa inicialização e o tratamento de erros modelados não reproduzem integralmente os scripts da interface no navegador.

| Medida | Resultado observado |
|---|---|
| Requisições HTTP | 3.789 |
| Status | 3.686 respostas200, 90 respostas201, 13 recusas429 |
| Erros500 ou de transporte | Nenhum |
| Latência total p50 / p95 / p99 / máxima | 13,61 / 156,80 / 227,32 / 259,28 ms |
| Leituras de histórico | 1.851; p95 203,68 ms |
| Pares de envios simultâneos com a mesma chave | 90 pares; cada par retornou um201 e um200, com a mesma sequência |
| Mensagens finais no banco | 8.090; exatamente90 novas, sem duplicação, sequências finais conferidas |
| Conexões simultâneas do pool | Máximo3; limite de vinte esperas preservado |
| Aquisição de conexão p95 / máxima | 22,01 / 122,14 ms |

As treze recusas apareceram na primeira amostra de trinta segundos. Depois dela, houve mais2.889 requisições, todas200/201, sem novas recusas. A variação de espera não elimina o pico ao carregar históricos; não houve motivo demonstrado para aumentar o pool. Ao concluir, nenhuma aquisição ou conexão de requisição permanecia pendente.

O RSS amostrado passou de79,51 a100,50 MiB. CPU Node acumulada:11,453 s de usuário e3,906 s de sistema. Esses valores incluem servidor, clientes de carga e coleta no mesmo processo; não medem o consumo isolado da aplicação em produção nem CPU do MariaDB. Contadores globais do banco isolado registraram39.819 comandos `Questions`,125.167 pedidos de leitura do buffer InnoDB e nenhuma nova leitura física nessa janela. O buffer já estava aquecido pela preparação dos dados; as consultas da própria observação também entram nesses contadores.

O ensaio exercita consultas com históricos preenchidos, navegação, paginação e idempotência concorrente em um cenário curto. Não executa DOM, TLS, login/hashing, Passenger, proxy, portal, múltiplos processos ou a carga do provedor. Três minutos e amostras de memória não comprovam estabilidade durante horas, ausência de vazamento ou capacidade contratada. Scripts, sessões e relatórios ficam privados, fora do Git e do ZIP; o banco fictício foi preservado e o contêiner local voltou ao estado parado. Produto e limites de conexão não foram alterados nesta entrega.

## Próximas verificações

- Ampliar a duração para horas e separar consumo do servidor e dos clientes, com histórico/CRM maiores e navegação real de navegador; comparar aquecimento e operação com buffer frio.
- Homologar concorrência entre processos, restart/proxy, limite real do provedor e recuperação após desconexão.
- Planejar retenção de dados, logs e releases com recuperação preservada, antes de qualquer limpeza automática.
- Se forem necessárias mais conexões, medir e verificar o limite do provedor antes de mudar a configuração; aumentar filas sem medir pode apenas prolongar a espera.

Instalação por pessoa iniciante e recuperação conjunta em destino HTTPS isolado continuam pendentes. Consulte o [andamento](ANDAMENTO.md) para publicação e resultado da CI/deploy.
