# Recuperar a configuração privada

O backup do banco não contém a senha de conexão nem o bootstrap da hospedagem. `backup:configuration` guarda **somente `.env` e, se existir, `passenger.cjs`**, sem executá-los, carregar variáveis, conectar ao banco ou enviar dados para serviços. A restauração prepara uma pasta nova para revisão; não modifica a instalação ativa.

Este artefato **contém segredos**, preservados byte a byte, em base64 (não é criptografia). Mantenha-o privado e proteja qualquer cópia externa. Não envie ao GitHub, ao diretório público, aos documentos ou à conversa. SHA256 detecta corrupção; não comprova autoria. Use apenas backups próprios confiáveis: o bootstrap é código executável quando posteriormente ativado por você.

## Criar e verificar na própria hospedagem

1. Escolha uma pasta de backup privada fora do código, `current`, `releases` e áreas públicas. Ela deve existir e ter modo700; arquivos de backup são criados como600. No Windows, restrinja a ACL ao proprietário; o programa não administra ACLs.
2. A pasta de origem deve conter `.env` regular, não vazio, com modo600 no Linux. O bootstrap opcional pode ter modo644, mas não escrita para grupo/outros. Links simbólicos, hardlinks de arquivos e redirecionamentos nos pais são recusados. A origem não pode ficar em área pública, `current` ou `releases`.
3. Suspenda edições desses dois arquivos durante a captura. O comando confere os bytes novamente, mas não oferece uma fotografia atômica do sistema de arquivos nem coordena alterações externas.
4. Use caminhos absolutos e um nome novo:

   ```sh
   npm run backup:configuration -- --create /PASTA_PRIVADA/configuracao-unica.json /RAIZ_PRIVADA_DA_APLICACAO
   npm run backup:configuration -- --verify /PASTA_PRIVADA/configuracao-unica.json
   ```

   No fluxo de releases, execute o script da release atual, passando como origem a raiz privada que contém `.env` e `passenger.cjs`:

   ```sh
   node "$CHATCRM_APP_ROOT/current/scripts/backup-configuration.js" --create "$CHATCRM_CONFIGURATION_BACKUP" "$CHATCRM_APP_ROOT"
   node "$CHATCRM_APP_ROOT/current/scripts/backup-configuration.js" --verify "$CHATCRM_CONFIGURATION_BACKUP"
   ```

Não use `--env-file`: esta ferramenta copia arquivos, não precisa carregar suas variáveis. Senhas não são argumentos. Só retorna código de resultado, quantidade, bytes, data e versão da ferramenta. A versão registrada identifica o programa que criou a cópia; registre separadamente a revisão do código da aplicação e o snapshot correspondente do banco.

Limites: até64KiB por arquivo e192KiB no JSON. Somente os dois nomes fixos são aceitos; `.first-access.json`, logs, recibos, sessões, dados, arquivos de outros sites e anexos não são incluídos. O arquivo original nunca é substituído ou apagado. Falha de escrita pode deixar um artefato incompleto: preserve-o, diagnostique com `--verify` e use outro nome.

## Preparar uma recuperação sem ativar segredos antigos

1. Verifique offline o backup. Preserve a origem e o arquivo original.
2. Escolha uma pasta **ainda inexistente**, sob um diretório privado700, fora do checkout e das áreas públicas/release. Não extraia sobre a instalação em uso:

   ```sh
   npm run backup:configuration -- --restore-new /PASTA_PRIVADA/configuracao-unica.json /PASTA_PRIVADA/revisao-nova
   ```

3. `configuration-staged` confirma a cópia conferida; a pasta nova tem modo700 e os arquivos600 no Linux. Pasta existente, backup inválido ou nome inesperado são recusados antes de substituir qualquer arquivo. Interrupção pode deixar uma pasta parcial, que não será apagada nem reutilizada automaticamente; diagnostique e escolha outro nome.
4. **Revise os arquivos pelo gerenciador privado**, sem expor valores em logs. Para recuperar em outra hospedagem, confira banco/usuário/destino, origem HTTPS, caminhos do bootstrap e parâmetros específicos do provedor. A cópia preserva inclusive eventual `SETUP_TOKEN`; remova-o antes de restaurar o banco conforme o procedimento. A ferramenta não gera, troca ou revoga credenciais.
5. Prepare código compatível em uma aplicação de destino isolada e parada. Transfira a configuração revisada apenas para a raiz privada desse destino, seguindo as instruções do provedor. Nunca aponte um ensaio de recuperação para o banco instalado da origem.
6. Siga [restauração do banco](BACKUP-RESTAURACAO.md), confirme `check:installation` e faça verificações de acesso/atendimento/CRM/portal com identidades de teste antes de liberar o destino. Não execute `passenger.cjs` de uma cópia desconhecida só porque o checksum passou.

Esta ferramenta cobre a cópia e a preparação da configuração em pasta nova. Não é backup completo da hospedagem, configuração de DNS/cPanel, migração entre provedores, ativação automática, cifragem, retenção ou recuperação de anexos. Banco e configuração são cópias separadas: registre uma janela de manutenção e não prometa consistência conjunta sem o ensaio correspondente. A revisão humana dos parâmetros e a recuperação completa da aplicação continuam necessárias.
