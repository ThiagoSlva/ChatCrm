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

A v0.5.1 mantém schema v3 e bootstrap existente. Não executar migração nem alterar configuração. Depois do cron, conferir hash e versão em /health e executar os verificadores explícitos de chat e HTTPS. A consulta de detalhe e os filtros revalidam autorização no banco; os verificadores usam transação revertida e leitura HTTPS, preservando canais e dados existentes.


v0.6.0 adiciona contatos e schema v4. Publique e valide compatibilidade de acesso/departamentos/chat em v3 antes de executar DDL; contatos deve informar preparação pendente. Crie backup privado atualizado das dez tabelas e preserve release v0.6 compatível. Migre explicitamente, confirme preservação e execute verify-contacts-database.js, chat e HTTPS, conferindo o hash. Depois de v4, v0.5 não aceita o schema: não diminuir marcador nem apagar tabelas. [Recorte, contrato e comandos de contatos](CONTATOS-MVP.md). O cron e o bootstrap não mudam.


v0.7.0 adiciona oportunidades e histórico no schema v5. Publique a aplicação compatível e valide acesso/contatos/chat em v4; apenas vendas deve aguardar preparação. Faça backup privado atualizado das onze tabelas e preserve release v0.7 compatível antes de migrar explicitamente. Confirme preservação dos registros e canais e execute verificadores SQL/HTTPS. v0.6 não aceita5: não reduzir marcador, apagar tabelas ou recuperar código anterior incompatível. Cron e bootstrap permanecem iguais. [Contrato e procedimento](OPORTUNIDADES-MVP.md).


Concorrência CRM em schema5 tem um procedimento manual separado: [verificação entre conexões](VERIFICACAO-CONCORRENCIA-CRM.md). Ele exige banco de testes vazio, backup privado atual e `--allow-temporary-fixtures`, pois duas conexões precisam enxergar registros sintéticos temporariamente confirmados. Não executar no cron, em CI ou com dados operacionais existentes. A limpeza valida propriedade e dependências antes de apagar somente fixtures; uma divergência interrompe a operação. Não altera schema, configuração, canais ou credenciais existentes. Registre resultados e preservação, além do hash servido.


v0.8.0 adiciona associação manual atendimento/contato e histórico no schema6. Primeiro publique a aplicação compatível com5; valide acesso/atendimento/contatos/vendas enquanto o contexto informa preparação pendente. Faça backup privado atualizado das treze tabelas e preserve release v0.8 compatível; só então migre explicitamente e compare dados/canais anteriores. Execute o verificador transacional novo, verificadores existentes e HTTPS, conferindo o hash servido. v0.7 não aceita6: recuperar somente código compatível, sem diminuir marcador ou apagar tabelas. Cron e bootstrap permanecem iguais. [Contrato e verificação](ASSOCIACAO-ATENDIMENTO.md). O verificador de concorrência anterior é exclusivo de schema5 e não deve ser executado após essa migração.


v0.9.0 implementa o portal do cliente e suporta schema7; frontend revisado localmente em navegador real. Para ativar o portal em uma nova instalação, publicar/validar release compatível6 com portal503, criar backup privado fresco das quinze tabelas e só então executar DDL7/verificador transacional/HTTPS. v0.8 não aceita7; não diminuir marcador nem apagar tabelas. Cron/bootstrap/configuração permanecem iguais. [Contrato e sequência](PORTAL-MVP.md).


Ambiente de testes atualizado em03/10/2026: regressão autenticada em6, backup15 privado fresco com integridade, DDL7, verificação SQL do portal/preservação17, regressões anteriores e HTTPS da equipe concluídos. Diagnóstico real installed/schema7 sem módulos pendentes; portal anônimo401, /portal200 e assets conferidos. Não repetir a migração nas retomadas. Fluxo cliente/operador juntos por HTTPS e restauração ainda pendentes. Consulte ANDAMENTO.md para commit e evidências. Cron e bootstrap permanecem iguais.


O [verificador HTTPS do portal](VERIFICACAO-HTTPS-PORTAL.md) é manual, exige backup17/schema7/base operacional vazia e opt-in para fixtures temporárias. Não incluir no cron ou startup; não repetir migração. Journal e dump permanecem privados. Execute após conferir a release, e registre preservação/resultado.


Complemento manual de cadastro/login/recuperação por HTTPS: [procedimento de credenciais](VERIFICACAO-HTTPS-CREDENCIAIS-PORTAL.md). Preserva todos os limites compartilhados e compara dados das outras dezesseis tabelas mais DDL17; não confundir com fingerprint completo17 pós-ensaio.


v0.10 prepara inscrições explícitas no portal/schema8, sem envio de campanhas. Publicar/validar compatibilidade7, fazer backup17 fresco incluindo limites, preservar release0.10, migrar explicitamente e conferir dados anteriores/SQL18/diagnóstico/HTTPS. Não voltar0.9 após8 ou executar fixtures HTTPS7. [Contrato](INSCRICOES-PORTAL.md). Cron/bootstrap permanecem iguais.


v0.11 prepara campanhas/caixa de novidades e suporta schema9. Primeiro publicar e confirmar compatibilidade8 (apenas campanhas aguarda preparação), CI/hash e backup privado fresco18. Migrar explicitamente, comparar dados/DDL18 normalizando somente marcador, validar três tabelas novas vazias, diagnóstico e verificador SQL21 em transação revertida; conferir HTTPS/assets/hash. v0.10 não aceita9. Não reexecutar fixtures HTTPS7/8 ou apagar tabelas/marcador. Cron/bootstrap permanecem iguais. [Contrato e limites](CAMPANHAS-MVP.md).


Ambiente autorizado em05/10/2026: v0.11/schema9 ativo, backup18 fresco verificado, DDL9/preservação21/SQL campanhas/regressões gerais e HTTPS/assets aprovados conforme ANDAMENTO.md. Não repetir a migração. Verificadores gerais de chat/contatos/vendas/associação reconhecem9; ferramentas exclusivas7/8 continuam exclusivas. Para próximas fixtures confirmadas, novo backup21 e journal próprio; backup pré-v9 não representa dados posteriores. Recuperação somente com código compatível9.


Preparação inicial v0.11.1: [guia executável](INSTALADOR-CPANEL.md). install:prepare somente lê por padrão; --prepare-empty nunca autoriza atualizar o banco existente. Não muda bootstrap, cron ou configuração. Schema continua9; esta release não exige DDL. Preparação explícita não faz parte dos testes de deploy.

Fechamento v0.11.1: c55edc0195443c85b9d2bc22724bdbd52dbf51a4 ativo15:08:44.244Z, CI37330200809 Node22/24 e275 testes cPanel aprovados. HTTPS/hash15:10:32.122Z confirmado. Recusa do preparador e guarda sob trava em MariaDB15:09:56.038Z preservaram21 registros/DDL; sem DDL/configuração/cron. Instalação limpa real/restauração ainda pendentes.


v0.12 mantém schema9 e não exige DDL. [Backup/restauração](BACKUP-RESTAURACAO.md) são comandos privados e explícitos, fora do cron/startup/CI. Nunca restaurar o banco instalado do domínio para testar; use destino isolado preparado/vazio e configuração própria. Arquivos privados ficam fora de releases e do Git.


Fechamento verificado em05/10/2026 — v0.12.0: main68f019939901945c09b058f0a8ad52fb0bef575b, árvoref07d230c7d1d68075f6976ca458d226e00898cde. CI37340562365 concluída/sucesso nos jobs Node22 e24 para esse hash. Cron ativou16:26:45.786Z, recibo600/current correspondente; cPanel288/288 testes, zero falhas,41.063320875s. Local288/288, zero falhas,47.0503671s. Health HTTPS200/v0.12.0/hash exato em16:30:24.131Z. Schema permanece9; nenhum upgrade aplicado.

Backup privado novo das21 tabelas criado pelo CLI público e verificado offline:6 registros,3.614bytes, arquivo600/diretório700. Verificação hospedada16:30:52.637Z confirmou a fotografia igual à fonte e recusou restauração sobre a instalação existente antes de qualquer DDL/DML; fingerprint21 idêntico antes/depois. Nenhum dado, campanha, credencial, configuração, bootstrap ou cron alterado. Artefato permaneceu somente na hospedagem; caminhos/nomes operacionais no arquivo de memória privado ignorado.

Instalação limpa e restauração foram ensaiadas num MariaDB11.4.13 local isolado, com dados sintéticos e conexões físicas; os cenários incluem rollback de DML, nova tentativa em destino vazio, concorrência e COMMIT aplicado com resposta perdida. Os dois containers próprios foram parados após conferir suas identidades, preservando volumes/configuração privados; Docker Desktop continuou disponível. Isto não comprova restauração da configuração/arquivos da hospedagem, recuperação de desastre completa ou compatibilidade com todo provedor. Frontend não mudou nesta entrega.

Próxima entrega coesa: distribuição/pacote instalável reproduzível e guia ilustrado; ensaio autenticado de campanhas por HTTPS precisa snapshot21 fresco e journal próprio. Não reutilizar os antigos journals7/8, restaurar o banco instalado ou sobrescrever backups. Novas funções úteis continuam autorizadas, priorizando base funcional antes de chatbot/fluxos. Este fechamento documental fica local para a próxima entrega, evitando deploy só para atualizar referências ao próprio hash.


v0.12.1 mantém schema9/cron/bootstrap; não exige DDL. Gerador e guia de [distribuição](PACOTE-INSTALACAO.md) são para pasta nova. Não extrair sobre current/.env/release existente; fontes do ZIP e configuração são etapas distintas. CI passa a conferir pacote extraído antes de publicar artefato temporário, com permissões read preservadas.


Fechamento05/10/2026 — v0.12.1 publicada em mainf9788fe4099ca3a88595545abb73014ce566cc5d, árvoreb199fd5fb54a314cd7d7e1e4448dfe15ffdc6302. CI37346141788 completou com sucesso os jobs Node22, Node24 e package (dupla geração, unzip real, manifesto, instalação lockfile, testes extraídos e upload). Artefato11360980658 criado17:09:41Z, expira04/11/2026; envelope418.022bytes. ZIP interno1.679.889bytes,131 fontes mais manifesto, SHA256 e32e50e6e6fb82478185f684abd2b58bc025115c48e3ba58cc8eb0f1f815648b. Download pelo conector, digest do envelope conferido, extração de somente2 arquivos esperados e comparação byte a byte com a geração Windows confirmados17:11:57.726Z: Windows/Linux idênticos e SHA256SUMS correspondente. Nenhum dado da hospedagem entrou no artefato.

Validação local299/299/zero falhas48.0717159s; cópia ZIP de pré-publicação extraída pelo tar Windows e npmci próprio aprovou299/299/53.6520635s. Cron ativou17:10:46.050Z, recibo600/current correspondente, cPanel299/299/zero falhas41.244211715s. Health HTTPS200/v0.12.1/hash exato17:12:35.611Z; CI final success/exactsha. Schema continua9; nenhuma migração, configuração, credencial, campanha ou alteração de bootstrap/cron. Ferramentas de distribuição não leem configuração nem conectam ao banco.

Pacote final local ignorado storage/releases/conversa-livre-0.12.1-f9788fe.zip e cópia baixada de CI preservados para revisão, junto com evidências package-final-bytes.json, package-cross-platform-proof.json, package-health-final.json e logs. Prévia local de ilustração encerrada e servidor próprio parado; abas do usuário preservadas. Frontend do aplicativo não alterado. O guia distingue imagem ilustrativa, integridade sem assinatura, necessidade de terminal/npm e download Actions autenticado/temporário. Não chamar o sistema de pronto para produção.

Próximo passo: ensaio autenticado HTTPS das campanhas com backup21 fresco e journal novo, seguido de distribuição permanente e instalação por pessoa iniciante; ampliar recuperação da configuração/arquivos e limites operacionais antes de chatbot/fluxos. Fechamento documental local para próxima entrega coesa, sem redeploy só para seguir referências ao próprio hash.


v0.12.2 mantém schema9/configuração/cron/bootstrap. [Ensaio HTTPS de campanhas](VERIFICACAO-HTTPS-CAMPANHAS.md) é manual e exige snapshot21 fresco, journal novo e opt-in em base operacional vazia. Sessões são preparadas, sem provar login. Não rodar no deploy/CI/startup ou reaproveitar journals7/8.
