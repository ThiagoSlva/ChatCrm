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

## Próximas verificações

Desde v0.13.3, cada agendamento automático de chat, caixa de atendimento e portal soma uma variação aleatória positiva de150 a750 ms. O chat mantém a base de3 s após concluir a leitura; o portal mantém5 s, ou15 s no caminho de falha já existente. A caixa conserva os prazos mínimos de5 s para fila e3 s para histórico, acrescentando a variação à próxima espera calculada. Ao retornar a uma aba, o agendamento antes imediato passa a esperar150 a750 ms. Ações manuais continuam imediatas; o mecanismo não repete gravações nem muda o limite do pool.

Quatro testes do agendador verificam trinta contextos distintos, prazos, apenas um timer, pausa quando a aba está oculta/ocupada/encerrada e preservação de envios pendentes. São testes determinísticos de scripts, não medição de carga. Revisão no navegador com persistência fictícia conferiu desktop/390px, teclado e rascunhos em chat/atendimento, reenvio incerto sem duplicação e portal vazio. A distribuição das chamadas é probabilística: não garante separação entre todas as abas, elimina saturação ou comprova maior capacidade do provedor. O benchmark acima continua sendo o ensaio da v0.13.2; carga prolongada com o novo agendador ainda precisa ser medida.

- Ensaiar a carga prolongada com históricos preenchidos e o padrão real de navegação, registrando consumo e latência do banco.
- Homologar concorrência entre processos, restart/proxy, limite real do provedor e recuperação após desconexão.
- Planejar retenção de dados, logs e releases com recuperação preservada, antes de qualquer limpeza automática.
- Se forem necessárias mais conexões, medir e verificar o limite do provedor antes de mudar a configuração; aumentar filas sem medir pode apenas prolongar a espera.

Instalação por pessoa iniciante e recuperação conjunta em destino HTTPS isolado continuam pendentes. Consulte o [andamento](ANDAMENTO.md) para publicação e resultado da CI/deploy.
