# Verificação HTTPS do portal

Verificador manual em scripts/verify-portal-https.js. Exercita cliente e operador através do servidor HTTPS publicado, com sessões sintéticas preparadas no banco. Não altera rotas, schema, configuração, administrador ou canais existentes. Não faz parte de npm test, CI, cron ou startup.

Requisitos: ambiente de testes explicitamente escolhido, APP_URL como origem HTTPS exata, schema7 dedicado/InnoDB, uma empresa e somente um administrador ativo; todas as tabelas operacionais vazias, inclusive sessões e limites. Recusa dados operacionais, tabelas extras e schema diferente. Consulte ANDAMENTO.md para evidências reais; os testes modelados não substituem execução hospedada.

## Backup e consentimento

Antes de confirmar fixtures, crie backup privado fresco das dezessete tabelas. O manifesto privado precisa conter schemaVersion:7, databaseFingerprint (preservationFingerprint de scripts/verify-portal-database.js), backup (caminho absoluto do dump), backupBytes e backupSha256. Dump/manifesto devem ser arquivos regulares600 no mesmo diretório privado700, com caminhos resolvidos sem aliases. O checksum é recalculado e o fingerprint atual deve corresponder antes de inserir dados. Isto não comprova restauração.

Defina APP_ROOT, PRIVATE_BACKUP_MANIFEST e TEST_ORIGIN com parâmetros da sua instalação, fora dos documentos públicos. O arquivo de ambiente e o backup permanecem na hospedagem:

~~~sh
node --env-file="$APP_ROOT/.env" "$APP_ROOT/current/scripts/verify-portal-https.js" --allow-temporary-fixtures --origin="$TEST_ORIGIN" --backup-manifest="$PRIVATE_BACKUP_MANIFEST"
~~~

Opt-in obrigatório porque HTTPS e SQL precisam enxergar fixtures temporariamente confirmadas. O script cria um operador de teste, uma área privada, dois visitantes expirados, duas contas/sessões de portal e duas conversas. Uma conta tem duas sessões para representar dispositivos diferentes. Tokens/senha aleatórios ficam somente na memória; nunca são impressos. A área sintética mantém public_chat:0; não há abertura de canal ou envio a destinatário real.

## Fluxo coberto

- Perfil da equipe e do cliente com cookies separados; visitante original expirado.
- Histórico próprio e DTO mínimo; outra conta não lê nem responde na conversa.
- Origem estrangeira e escrita sem CSRF recusadas.
- Mensagem do cliente chega à fila/histórico do operador; replay não duplica e conteúdo divergente com a mesma chave é recusado.
- Operador assume e responde; cliente vê paginação e uma segunda sessão da mesma conta consulta/responde.
- Encerramento conserva histórico, recusa nova mensagem e mantém replay; área privada não admite nova conversa.
- Logout revoga somente uma sessão do cliente; outro dispositivo e a outra conta continuam válidos.

## Limpeza e recuperação

Um journal privado600 é criado junto ao manifesto antes do primeiro COMMIT. Guarda somente referências e hashes das fixtures, nunca tokens/senha em texto claro ou registros do administrador. Guarde esse journal para conferir uma interrupção. Ele impede repetir o ensaio completo às cegas; use um novo backup/manifesto para um novo ensaio deliberado.

Preparação e limpeza usam a trava da linha do schema; a execução também mantém a trava consultiva do migrador. A limpeza valida todos os sentinelas, dependências, mensagens planejadas, autoria, sequências, sessões e chaves de quota antes do primeiro DELETE. Só remove IDs/chaves próprios; registros estranhos fazem a limpeza falhar fechada. Depois compara registros e DDL lógico das dezessete tabelas com o baseline antes do COMMIT. Divergência reverte a limpeza inteira. AUTO_INCREMENT pode avançar com fixtures removidas.

Após interrupção, com os mesmos parâmetros privados:

~~~sh
node --env-file="$APP_ROOT/.env" "$APP_ROOT/current/scripts/verify-portal-https.js" --allow-temporary-fixtures --origin="$TEST_ORIGIN" --backup-manifest="$PRIVATE_BACKUP_MANIFEST" --cleanup-only
~~~

cleanup-only revalida backup, journal e origem. Se os dados já correspondem ao baseline, não executa DELETE. Não apagar tabelas, diminuir marcador, limpar dados gerais ou substituir o journal/backup para forçar aprovação. Uma falha exige inspeção privada antes de repetir.

Requisições têm prazo de15s e recusam redirects. Comandos SQL próprios usam prazo de8s; timeout encerra somente a conexão do verificador. Limpeza reacquire conexão/trava quando possível, e o journal preserva o ponto seguro se não puder confirmar. Cada escritor do atendimento revalida sua sessão dentro da transação; depois da limpeza, tokens das fixtures não autorizam mensagens tardias.

## Limites

Sessões são previamente preparadas: este ensaio não verifica formulário/login com senha, cadastro ou recuperação por HTTPS, nem políticas do Set-Cookie nesses fluxos. Esses contratos continuam cobertos por testes locais/SQL; homologação HTTPS específica ainda é necessária. Não é teste de navegador, carga, proxy, concorrência SQL do portal, saturação, retenção ou restauração. Nenhum arquivo privado deve ir ao Git ou ser enviado para suporte.


Complemento manual de cadastro/login/recuperação por HTTPS: [procedimento de credenciais](VERIFICACAO-HTTPS-CREDENCIAIS-PORTAL.md). Preserva todos os limites compartilhados e compara dados das outras dezesseis tabelas mais DDL17; não confundir com fingerprint completo17 pós-ensaio.
