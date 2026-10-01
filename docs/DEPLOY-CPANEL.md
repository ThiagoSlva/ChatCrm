# Deploy de testes pelo GitHub

Ambiente: `https://testeschat.cloudyx.xyz`, repositório público `ThiagoSlva/ChatCrm`, branch `main`. A configuração `.cpanel.yml` é específica desta conta de testes; outros usuários devem ajustar caminhos e origem antes de usar.

## Funcionamento

O cPanel mantém o clone em `/home/xfxpanel/repositories/chatcrm`. A aplicação Node 24 usa a pasta privada `/home/xfxpanel/apps/chatcrm-test` e o arquivo de entrada `passenger.cjs`.

Um cron verifica `main` a cada dois minutos. Quando o commit muda, o script exporta uma cópia numa pasta nova, instala as dependências do lockfile sem executar scripts de instalação e roda os testes. Só depois troca o link `current` para ativar a release e solicita reinício do Passenger. Não é um webhook instantâneo: a atualização depende do próximo cron e da duração da instalação e dos testes.

O GitHub não recebe chave SSH, senha ou token do cPanel. O clone usa HTTPS de um repositório público. Somente alterações incorporadas a `main` são consideradas; PRs de colaboradores precisam ser revisados antes do merge.

## Configuração desta hospedagem

Clone pelo **Git Version Control**, com origem `https://github.com/ThiagoSlva/ChatCrm.git` e pasta `repositories/chatcrm`. Crie a aplicação no **Setup Node.js App**, em `apps/chatcrm-test`, com Node 24, modo Production e o domínio de testes.

Copie `passenger.cjs` do clone para a raiz da aplicação e escolha esse arquivo como entrada no gerenciador. Esse bootstrap permanece fora das releases; mudanças nele precisam de revisão e atualização manual.

Cron a cada dois minutos:

```sh
/bin/bash -lc 'source /home/xfxpanel/nodevenv/apps/chatcrm-test/24/bin/activate && /usr/bin/flock -n /home/xfxpanel/apps/chatcrm-test/.deploy.lock node /home/xfxpanel/repositories/chatcrm/scripts/deploy-cpanel.js /home/xfxpanel/repositories/chatcrm /home/xfxpanel/apps/chatcrm-test' >> /home/xfxpanel/apps/chatcrm-test/deploy.log 2>&1
```

O mesmo comando, sem o redirecionamento, executa o primeiro deploy manualmente. O `.cpanel.yml` também permite executar o deploy pelo botão **Deploy HEAD Commit** após **Update from Remote**. Não edite o clone no servidor: alterações locais interrompem o script para preservar o trabalho.

## Dados e recuperação

Variáveis privadas ficam no gerenciador Node ou no `.env` da raiz da aplicação, fora das releases. Nunca versione esse arquivo. A pasta do domínio permanece separada; não publique o clone ou as releases diretamente como arquivos estáticos.

`.deployed.json` registra commit, caminho da release atual e anterior. `/health` mostra somente o hash do commit, sem caminhos privados. Releases anteriores permanecem disponíveis. Se o processo de instalação ou testes falhar, o link atual não muda. Uma falha na inicialização depois da troca exige recuperação: pause o cron, verifique `.deployed.json`, aponte `current` para a release anterior e reinicie apenas esta aplicação. Teste a recuperação antes de usar este modelo em produção.

Este fluxo serve ao ambiente de testes. Ainda não inclui migrações de banco, verificação automática pós-deploy, rotação de logs nem limpeza de releases. Monitore espaço e logs; planeje esses recursos antes de hospedar atendimento real. Não apague releases automaticamente enquanto uma recuperação estiver em andamento.

Referências: [deploy Git do cPanel](https://docs.cpanel.net/knowledge-base/web-services/guide-to-git-deployment/), [reinício Passenger](https://www.phusionpassenger.com/library/admin/apache/restart_app.html).
