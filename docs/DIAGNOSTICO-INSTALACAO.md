# Diagnóstico de instalação

O teste de conexão confirma somente SELECT 1. O novo diagnóstico distingue configuração incompleta, banco vazio, migração interrompida, primeiro acesso e módulos que ainda aguardam preparação.

```sh
npm run check:installation
npm run check:installation -- --json
```

No cPanel, defina os caminhos privados conforme [o procedimento de deploy](DEPLOY-CPANEL.md):

```sh
source "$CHATCRM_NODE_ENV"
node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/check-installation.js"
```

## O que é conferido

- Node.js 22/24 e APP_URL com a regra de origem da autenticação: HTTPS sem caminho, credenciais, parâmetros ou fragmento. HTTP em localhost/127.0.0.1 somente fora de production.
- Configuração completa do banco, inclusive senha e porta, usando databaseOptions da aplicação.
- Banco exclusivo, marcador entre 1 e 9, tabelas correspondentes e engines InnoDB. Projeções vazias da base e validadores de colunas, índices e relacionamentos dos módulos da versão registrada.
- Presença de empresa e administrador ativo, sem retornar nomes, e-mails, senhas ou hashes. Uma instalação nova exige SETUP_TOKEN privado de pelo menos 32 caracteres.
- Alteração observada do marcador durante a leitura. Isso não garante uma fotografia atômica durante DDL concorrente; repita após a migração terminar.

As consultas são SELECT/SHOW. A abertura, incluindo autenticação, cada leitura e o encerramento têm prazo de cinco segundos. O driver recebe o mesmo prazo de abertura; uma expiração nativa ETIMEDOUT nessa fase informa database-timeout. Se um conector devolver uma conexão depois do prazo, ela é fechada sem iniciar consultas. Um conector que nunca retorna não pode atrasar o relatório, mas seu recurso interno não é acessível ao diagnóstico; a CLI encerra o próprio processo depois de gravar a saída. Nas leituras/encerramento, a conexão conhecida é destruída ao expirar o prazo, sem aguardar QUIT atrás de uma consulta sem resposta. O prazo é por operação, não cinco segundos para o diagnóstico inteiro. As projeções que mencionam password_hash usam LIMIT 0 e não recuperam hashes. O adaptador recusa escrita e leituras com trava/exportação de arquivo. Não chama o migrador nem cria ou repara contas.

## Como interpretar

O relatório padrão orienta a próxima ação. --json gera um objeto com códigos estáveis:

| Código | Próximo passo |
| --- | --- |
| runtime-unsupported / url-invalid | Corrigir Node ou origem pública |
| database-config-missing / database-config-invalid | Completar configuração privada |
| database-timeout | Conferir disponibilidade e repetir; nenhuma consulta nova é iniciada após o prazo |
| database-unreachable | Conferir conexão, permissões de leitura e disponibilidade |
| database-unprepared | Seguir preparação explícita do banco |
| database-not-exclusive | Usar banco dedicado; não apagar tabelas de outro sistema |
| schema-incomplete / schema-invalid | Conferir estrutura, permissões e última migração |
| migration-incomplete | Conferir e retomar migração com backup e release compatível |
| schema-incompatible | Usar código compatível; não diminuir marcador |
| schema-changed | Aguardar migração e repetir |
| installation-inconsistent | Conferir recuperação privada de empresa/administrador |
| setup-secret-required | Preparar segredo privado antes do primeiro acesso |
| setup-ready | Criar empresa e administrador em /acesso |
| installed | Conferir módulos pendentes e homologação |

Saída 0 significa que as verificações de leitura passaram (setup-ready ou installed); saída 1 indica pendência; saída 2 indica argumentos inválidos. Somente --json é aceito como argumento. Valores privados e mensagens brutas do driver não são impressos.

Em schema6, installed pode coexistir com modulesPending: ["portal"]: os módulos anteriores estão registrados, mas o portal exige migração7. SETUP_TOKEN presente após instalar produz remove-setup-token; remova esse segredo conforme o guia de primeiro acesso, sem alterar a senha do administrador.

Este é um passo do instalador simples. Não configura o gerenciador e não roda automaticamente no cron ou na inicialização. Não comprova HTTPS/cookies, proxy, carga, backup ou restauração. Não testa privilégios CREATE/ALTER fazendo DDL. Os testes locais usam conexão modelada; execução manual em MariaDB real deve ser registrada separadamente. Não publique configuração privada para solicitar ajuda.


A regressão de timeout usa o driver mysql2 real com servidor de protocolo sintético em loopback, incluindo preparação sem resposta e execução da CLI. Isso comprova o controle de prazo do cliente; não é uma instalação ou homologação do MariaDB real.

Desde v0.13.4, o prazo do diagnóstico também abrange a promessa de abertura. O driver fixado já encerrava uma autenticação sem resposta após seu connectTimeout de5 s; antes, um prazo menor passado ao diagnóstico não era aplicado nessa fase e ETIMEDOUT virava database-unreachable. A regressão de autenticação sintética agora exige retorno em prazo menor e fechamento do socket, sem executar SELECT/SHOW. Conectores pendentes, retorno tardio, rejeição tardia e conexão recusada também são exercitados. A alteração não modifica conexões da aplicação web, migrações ou credenciais.

Os ensaios de leitura/preparação abrem a conexão antes de iniciar sua medição de100 ms. A abertura é medida separadamente com autenticação travada e prazo de500 ms. Isso evita confundir um atraso de handshake no ambiente de teste com timeout de consulta; os limites padrão de5 s da ferramenta permanecem iguais.


Execução hospedada registrada em03/10/2026: antes da migração, installed/schema6 com portal pendente; depois, installed/schema7 com todos os módulos disponíveis e sem avisos. Isso comprova este diagnóstico na instalação de testes, não privilégios globais, carga ou restauração. A verificação de HTTPS e os ensaios transacionais foram executados separadamente; veja ANDAMENTO.md.
