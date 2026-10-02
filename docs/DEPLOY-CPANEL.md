# Deploy de testes pelo GitHub

Ambiente autorizado de testes: `https://testeschat.cloudyx.xyz`, repositório público `ThiagoSlva/ChatCrm`, branch `main`. Este guia e `.cpanel.yml` usam parâmetros genéricos; os valores reais são privados e devem ser definidos por quem instala.

## Funcionamento

O cPanel mantém o clone em `<REPO_ROOT>`. A aplicação Node 24 usa a pasta privada `<APP_ROOT>` e o arquivo de entrada `passenger.cjs`.

Um cron verifica `main` a cada dois minutos. Quando o commit muda, o script exporta uma cópia numa pasta nova, instala as dependências do lockfile sem executar scripts de instalação e roda os testes. Só depois troca o link `current` para ativar a release e solicita reinício do Passenger. Não é um webhook instantâneo: a atualização depende do próximo cron e da duração da instalação e dos testes.

O GitHub não recebe chave SSH, senha ou token do cPanel. O clone usa HTTPS de um repositório público. Somente alterações incorporadas a `main` são consideradas; PRs de colaboradores precisam ser revisados antes do merge.

## Configuração desta hospedagem

Clone pelo **Git Version Control**, com origem `https://github.com/ThiagoSlva/ChatCrm.git`, em uma pasta privada escolhida para o projeto. Crie a aplicação no **Setup Node.js App**, em outra pasta privada, com Node 24, modo Production e o domínio definido para a instalação.

Copie `passenger.cjs` do clone para a raiz da aplicação e escolha esse arquivo como entrada no gerenciador. Esse bootstrap permanece fora das releases; mudanças nele precisam de revisão e atualização manual.

Exemplo de cron a cada dois minutos. Defina `CHATCRM_NODE_ENV` com o arquivo de ativação mostrado pelo gerenciador, `CHATCRM_REPO_ROOT` com o clone e `CHATCRM_APP_ROOT` com a aplicação, usando caminhos absolutos privados. O cron precisa ter esses valores explicitamente disponíveis; não pressupõe que herde variáveis da aplicação:

```sh
/bin/bash -lc 'test -n "$CHATCRM_NODE_ENV" && test -n "$CHATCRM_REPO_ROOT" && test -n "$CHATCRM_APP_ROOT" && source "$CHATCRM_NODE_ENV" && /usr/bin/flock -n "$CHATCRM_APP_ROOT/.deploy.lock" node "$CHATCRM_REPO_ROOT/scripts/deploy-cpanel.js" "$CHATCRM_REPO_ROOT" "$CHATCRM_APP_ROOT"'
```

O mesmo comando executa o primeiro deploy manualmente; configure o redirecionamento do log em um caminho privado da aplicação. `.cpanel.yml` usa as mesmas três variáveis e recusa a execução se faltarem. O deploy pelo botão **Deploy HEAD Commit**, após **Update from Remote**, só funciona com esses parâmetros disponíveis ao processo do cPanel. O cron de testes existente mantém seus valores privados e não foi alterado. Não edite o clone no servidor: alterações locais interrompem o script para preservar o trabalho.

## Dados e recuperação

Variáveis privadas ficam no gerenciador Node ou no `.env` da raiz da aplicação, fora das releases. Nunca versione esse arquivo. A pasta do domínio permanece separada; não publique o clone ou as releases diretamente como arquivos estáticos.

`.deployed.json` registra commit, caminho da release atual e anterior. `/health` mostra somente o hash do commit, sem caminhos privados. Releases anteriores permanecem disponíveis. Se o processo de instalação ou testes falhar, o link atual não muda. Uma falha na inicialização depois da troca exige recuperação: pause o cron, verifique `.deployed.json`, aponte `current` para a release anterior e reinicie apenas esta aplicação. Teste a recuperação antes de usar este modelo em produção.

Este fluxo serve ao ambiente de testes. Ainda não inclui migrações de banco, verificação automática pós-deploy, rotação de logs nem limpeza de releases. Monitore espaço e logs; planeje esses recursos antes de hospedar atendimento real. Não apague releases automaticamente enquanto uma recuperação estiver em andamento.

Desde v0.1.0, os testes da release são descobertos somente em `test/*.test.js` por `scripts/run-tests.js`, incluindo autenticação e migração; o runner remove as credenciais DB do ambiente de testes para impedir conexão acidental ao banco real. A migração MySQL é uma operação privada e explícita, conforme [instalação e acesso](INSTALACAO-ACESSO.md). O cron não cria tabelas nem administradores. `.env` continua fora das releases e já é carregado por `passenger.cjs`; este marco não exige alterar o bootstrap.

Os arquivos de teste são executados sequencialmente para limitar processos/memória simultâneos em hospedagem compartilhada. Os cenários que exercitam operações concorrentes continuam usando essa concorrência dentro do próprio teste. Nenhum teste é removido e falhas continuam impedindo a ativação da release.

Os documentos HTML referenciam assets em `/assets/<hash-do-conteudo>/<arquivo>`. No teste, `/styles.css` antigo foi servido diretamente pelo LiteSpeed e pelo cache da Cloudflare, ignorando a release nova. URLs com hash evitam colisão com esses arquivos e distinguem versões sem precisar purgar cache ou alterar outros sites. Verifique CSS/JS pelo endereço incluído no HTML da release, não apenas pelas rotas antigas de compatibilidade.

v0.2.0 mantém o schema v1 e não exige migração nem alteração do bootstrap. Para verificar a gestão de operadores em MariaDB sem deixar contas, execute explicitamente `node --env-file="$CHATCRM_APP_ROOT/.env" "$CHATCRM_APP_ROOT/current/scripts/verify-team-database.js"` com o ambiente Node ativo e `CHATCRM_APP_ROOT` definido. O comando reverte a transação de teste e não imprime credenciais. Depois, repita a verificação HTTPS do guia de acesso e confira o hash em `/health`.

v0.3.0 também mantém o schema v1. O mesmo verificador SQL cobre troca de senha somente de usuários sintéticos não commitados, revogação de todas as sessões e recusa a hash verificado antes da troca. Não execute uma troca na conta real para validar o deploy: preserve `.first-access.json`, `.env` e senhas existentes. A verificação HTTPS testa a recusa do novo endpoint a visitantes sem modificar credenciais.

Referências: [deploy Git do cPanel](https://docs.cpanel.net/knowledge-base/web-services/guide-to-git-deployment/), [reinício Passenger](https://www.phusionpassenger.com/library/admin/apache/restart_app.html).

v0.4.0 introduz departamentos e schema v2. Publique primeiro a aplicação e valide acesso com v1; o módulo informa preparação pendente enquanto o restante funciona. Faça backup privado e mantenha a release v0.4 compatível como opção de recuperação antes de executar a migração explícita. Depois verifique os dados anteriores, o verificador de departamentos, equipe/acesso e o hash servido. Código v0.3 ou anterior não aceita v2: não use essas releases como recuperação depois de migrar nem diminua o marcador manualmente. Guia completo: [departamentos](DEPARTAMENTOS.md).

v0.5.0 prepara atendimento e schema v3. Primeiro publique a aplicação compatível e confira equipe/departamentos em v2; apenas chat deve aguardar preparação. Faça backup privado de todas as tabelas, preserve uma release v0.5 compatível, migre explicitamente e confirme que usuários, hashes, sessões e vínculos foram preservados e canais anteriores permaneceram privados. Depois execute `verify-chat-database.js` com dados sintéticos revertidos, verificadores existentes e HTTPS; confira o hash. v0.4 não aceita v3. Não reutilize o backup pré-v2 como se tivesse dados mais recentes; não reduzir o marcador ou apagar tabelas para voltar. Leia [o recorte e seus limites](CHAT-MVP.md).
