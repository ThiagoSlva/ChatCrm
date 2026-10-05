# Ensaio manual de campanhas por HTTPS

Este procedimento é exclusivo de uma instalação **de testes descartável**, schema9, com 21 tabelas, uma empresa e um administrador ativo. Nenhum atendimento, operador adicional, contato, visitante, conta do portal, sessão, inscrição ou campanha pode existir. Os limites compartilhados de autenticação podem existir e são preservados integralmente. Não execute numa instalação em uso, no cron, no startup ou na CI.

O ensaio cria 53 clientes fictícios, um operador temporário e sessões temporárias da equipe/portal. A senha do administrador original e suas permissões permanecem iguais. As sessões são preparadas diretamente no banco: o procedimento verifica autorização das APIs por HTTPS, **não comprova login, emissão dos cookies pelo navegador ou entrega a pessoas reais**. Nenhum serviço de mensagens externo é usado.

## Preparação

Confira `/health`, o hash publicado, os testes da release e o diagnóstico schema9. Reserve o ambiente durante o ensaio. Use a configuração privada da instalação e o Node suportado. Não coloque senhas, tokens ou parâmetros reais nos documentos, argumentos ou Git.

Crie um backup novo das 21 tabelas, num diretório privado fora do checkout e da área pública, com diretório700/arquivo600 em Linux. O arquivo não pode existir; a fotografia deve ter menos de 30 minutos e os mesmos registros da origem.

```sh
node --env-file=/CAMINHO_PRIVADO/.env scripts/backup-database.js --create /DIRETORIO_PRIVADO/backup-campanhas-novo.json
node scripts/backup-database.js --verify /DIRETORIO_PRIVADO/backup-campanhas-novo.json
node --env-file=/CAMINHO_PRIVADO/.env scripts/verify-campaigns-https.js \
  --origin=https://chat.example.test \
  --backup=/DIRETORIO_PRIVADO/backup-campanhas-novo.json \
  --journal=/DIRETORIO_PRIVADO/journal-campanhas-novo.json \
  --commit=HASH_DE_40_CARACTERES_DA_RELEASE \
  --allow-temporary-fixtures
```

Substitua os parâmetros genéricos. O origin deve ser exatamente `APP_URL`, HTTPS e sem caminho/credenciais. Execute a partir da release, sem extrair arquivos sobre a instalação existente. O journal também deve ser novo, privado e fora do checkout. No Windows, mantenha ACL privada; a verificação POSIX de modos não se aplica.

## Critérios do ensaio

- Acesso anônimo, operador, origem estrangeira, CSRF inválido e destinatário injetado são recusados.
- O consentimento parte de desativado. A criação congela o público e sua versão; a chave repetida não cria outra campanha e conteúdo alterado conflita.
- Retirar e renovar o consentimento não autoriza a campanha antiga. Uma conta desativada também é ignorada. O lote de 50 verifica 48 entregas fictícias, dois ignorados e três pendentes; repetir sua chave não avança a fila.
- Somente o destinatário autenticado lê sua própria novidade entregue. Marcar como lida é idempotente. Descadastro preserva histórico entregue. Cancelar preserva entregas e impede novos lotes; a segunda campanha é cancelada antes de qualquer entrega.
- Logout revoga somente a sessão temporária do administrador. A limpeza identifica todos os registros próprios antes do primeiro DELETE, usa transação e compara os registros e DDL lógicos das 21 tabelas antes/depois. Não apaga quotas, não restaura o backup, não altera schema ou credenciais e não reinicia contadores AUTO_INCREMENT consumidos pelo ensaio.

O journal registra intenções antes das requisições e hashes das sessões, sem tokens em texto. Não publique, baixe ou compartilhe o journal/backup. O checksum do backup verifica integridade, sem promessa de assinatura ou criptografia. Sessões preparadas expiram em uma hora.

## Interrupção e recuperação

Não repita o ensaio completo com o mesmo journal. Uma resposta perdida pode esconder um COMMIT aplicado. Preserve os arquivos e faça diagnóstico; a retomada é **somente limpeza**, com os mesmos argumentos e hash original:

```sh
node --env-file=/CAMINHO_PRIVADO/.env scripts/verify-campaigns-https.js \
  --origin=https://chat.example.test \
  --backup=/DIRETORIO_PRIVADO/backup-campanhas-novo.json \
  --journal=/DIRETORIO_PRIVADO/journal-campanhas-novo.json \
  --commit=HASH_DE_40_CARACTERES_DA_RELEASE \
  --allow-temporary-fixtures --cleanup-only
```

Essa opção não faz chamadas HTTP, não processa campanhas e não cria fixtures. O backup original pode estar antigo. Dados já iguais à origem produzem `alreadyClean`; linhas desconhecidas, alterações no administrador/quotas ou divergências de propriedade interrompem a operação antes de apagar qualquer registro. Não use `--force`, não apague journals `.next` interrompidos automaticamente e não diminua schema. Se a limpeza não for confirmada, preserve o estado e investigue antes de liberar o ambiente.

Os testes automatizados cobrem rotas Fastify/modelos SQL, guardas de propriedade, rollback da limpeza, confirmação perdida, leitura limitada e CLI offline. A homologação HTTPS real precisa ser registrada separadamente com hash servido, resultado e preservação. O ensaio não comprova concorrência entre conexões de campanhas, carga, frontend autenticado, retenção ou homologação em todos os provedores. Os verificadores antigos exclusivos de schema7/8 não servem para esta instalação.
