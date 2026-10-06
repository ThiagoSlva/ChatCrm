# Ensaiar a recuperação da aplicação

Um checksum válido não garante que a empresa poderá entrar e continuar atendendo. Este procedimento reúne a cópia da configuração, restauração do banco em destino vazio e verificações funcionais antes de liberar o destino. É uma operação manual do proprietário; não executa recuperação automática na instalação ativa.

## Preparar o conjunto

1. Registre a revisão do código, versão e schema. Guarde um [pacote verificado](PACOTE-INSTALACAO.md) compatível, sem configuração ou dados dentro do ZIP público.
2. Reserve uma janela de manutenção da **instalação de origem**. Suspenda seus atendimentos e rotinas que escrevem no banco ou editam a configuração; preserve os parâmetros para retomá-las. O backup do banco oferece fotografia transacional, mas configuração e banco são arquivos separados. Não existe fotografia conjunta automática.
3. Crie os dois backups com nomes novos em diretório privado: [banco](BACKUP-RESTAURACAO.md) e [configuração](BACKUP-CONFIGURACAO.md). Confira ambos offline e registre a data, schema e revisão associada. Mantenha esse conjunto privado; base64 e SHA256 não cifram nem autenticam o material.
4. Retome a origem após confirmar suas cópias. Ela é preservada durante o ensaio: nunca restaure sobre seu banco ou substitua sua configuração para testar.

## Restaurar em um destino isolado

1. Prepare uma aplicação de destino parada, código compatível e banco exclusivo **novo**. Não crie empresa/administrador pelo navegador: os registros virão do backup. Prepare apenas a estrutura9, seguindo o [instalador](INSTALADOR-CPANEL.md). Banco com registros é recusado pelo restaurador.
2. Confira a configuração offline e use `backup:configuration -- --restore-new` para uma pasta privada **inexistente** de revisão. Ela conserva os parâmetros da origem; não a ative diretamente.
3. Revise no gerenciador privado o banco, usuário, porta, origem HTTPS e caminhos do bootstrap de **destino**. A cópia antiga não autoriza mudar credenciais existentes ou apontar um ensaio para a origem. Revise também variáveis configuradas exclusivamente no gerenciador Node, que não são incluídas no arquivo. Remova `SETUP_TOKEN` da configuração final do destino. Guarde a cópia original; não exponha senhas em terminal, argumentos ou documentação.
4. Transfira somente a configuração revisada para a raiz privada do destino, sem sobrescrever uma instalação em uso. Mantenha os processos de destino parados. Execute `backup:database -- --restore-empty` com o banco vazio de destino explicitamente configurado. Confirme `database-restored`, depois `check:installation`/installed/schema9. Falha ou resposta perdida exige diagnóstico; não apague tabelas ou tente replay em banco ocupado.
5. Inicie apenas o destino e faça as verificações abaixo com suas identidades autorizadas. Use um ensaio com dados fictícios para escritas e campanhas; dados de clientes nunca são fixtures descartáveis. Não configure envios a pessoas reais.

## Critérios para liberar o destino

| Verificação | Resultado esperado |
|---|---|
| Revisão e diagnóstico | Código compatível, hash confirmado quando disponível e installed/schema9 |
| Sessões anteriores da equipe/portal | Não autenticam no destino; exige novo login |
| Novo login | Senhas preservadas funcionam para administrador, operador e cliente do portal |
| Permissões | Operador mantém o acesso permitido e não ganha gerenciamento da equipe/campanhas |
| Dados e histórico | Contatos, oportunidades, vínculos, mensagens, etapas, Unicode, consentimento e novidades correspondem ao snapshot |
| Continuidade do atendimento | Mensagem fictícia nova no destino aparece na sequência correta, sem substituir o histórico |
| Origem | Configuração e registros continuam iguais à fotografia; nenhuma exclusão ou restauração foi feita nela |
| Repetição acidental | Arquivos/pastas existentes e destino SQL ocupado são recusados sem sobrescrita |
| Armazenamento e HTTP | Backups/configuração continuam privados e inacessíveis pela web |

`npm run verify:access -- /ARQUIVO_PRIVADO/credenciais-de-teste.json` confere o acesso da equipe por HTTPS, módulos compatíveis1–9, permissões, CSRF e logout. O arquivo contém apenas `email` e `password`, permanece privado e não é enviado ao Git. A ferramenta abre e encerra uma sessão e faz tentativas de autenticação limitadas; não altera senhas, contatos ou campanhas. Ela **não cobre sozinha o portal nem a recuperação inteira**. Depois do ensaio, encerre sessões temporárias e processos de teste; preserve backups e evidências privadas.

## Evidência e limites atuais

Em06/10/2026UTC, o conjunto foi ensaiado com dois bancos locais novos em containers próprios MariaDB, conexões SQL físicas, configuração e credenciais exclusivamente fictícias. CLI criou/verificou os dois backups, preparou configuração em pasta nova e restaurou somente o destino vazio. As três sessões capturadas foram descartadas e recusadas pela API; novos logins, CRM, histórico, preferências, novidades e mensagem posterior funcionaram. A origem permaneceu igual nas21 tabelas e nos arquivos copiados; replay em destino ocupado foi recusado. A versão revisada do verificador passou42 critérios de acesso administrativo.

As requisições desse ensaio usaram **HTTP em127.0.0.1**, com Origin/cookies explícitos para testar a API configurada. Isso não comprova TLS, comportamento dos cookies no navegador, DNS, Passenger ou instalação por pessoa iniciante. O bootstrap copiado não foi executado; o servidor recebeu a configuração revisada e o código público testado. Consulte [andamento](ANDAMENTO.md) para versões, evidências e distinção entre testes locais e hospedados.

Ainda faltam recuperação completa em outra hospedagem, ensaio HTTPS do destino, anexos quando existirem, cópia externa protegida, retenção e tempo medido de indisponibilidade. Não declare recuperação de desastre completa ou produção homologada apenas porque este ensaio passou.
