# Verificação HTTPS de cadastro e recuperação

scripts/verify-portal-credentials-https.js é uma operação manual para a instalação dedicada de testes. Complementa o ensaio cliente–operador: efetua cadastro, login com senha, recuperação e logout nas rotas HTTPS publicadas. Não faz parte do cron, CI, startup ou npm test e não modifica frontend, schema, configuração ou credenciais operacionais.

Exige --allow-temporary-fixtures, APP_URL igual à origem HTTPS, schema7/InnoDB com as dezessete tabelas esperadas, uma empresa, um administrador ativo e tabelas operacionais vazias. Somente cl_chat_limits pode conter contadores existentes. Não habilita departamentos públicos: prepara uma área privada e dois visitantes/conversas próprios. Cadastro cria as contas por HTTP; senhas, códigos e tokens aleatórios permanecem apenas na memória.

## Preparação e execução

Crie backup privado fresco das dezessete tabelas e manifesto novo, sem substituir backups ou journals anteriores. O mesmo contrato de bytes/SHA-256/fingerprint/arquivos600/diretório700 do [ensaio cliente–operador](VERIFICACAO-HTTPS-PORTAL.md) se aplica. O fingerprint completo deve coincidir antes das fixtures. Integridade do dump não demonstra restauração.

Use parâmetros privados da sua instalação, jamais os publique:

~~~sh
node --env-file="$APP_ROOT/.env" "$APP_ROOT/current/scripts/verify-portal-credentials-https.js" --allow-temporary-fixtures --origin="$TEST_ORIGIN" --backup-manifest="$PRIVATE_BACKUP_MANIFEST"
~~~

O fluxo usa dez tentativas de credenciais, dentro do orçamento normal de autenticação. Não há repetição automática, alteração de IP/proxy, reinício do servidor ou limpeza de quotas para obter novas tentativas. Se receber429, encerra o ensaio e limpa somente as fixtures; aguarde a janela normal antes de planejar outro ensaio com backup/journal próprios.

## Evidências que o fluxo produz

- Cadastro dos dois visitantes por HTTPS, Origem/CSRF, expiração do visitante original e ausência de login automático.
- Login com senha, cookie __Host- com Secure/HttpOnly/Path=/, SameSite e validade corretos; duas sessões do mesmo cliente e histórico isolado da outra conta.
- Senha incorreta recusada.
- Recuperação troca senha/código somente da conta sintética, revoga os dois dispositivos, mantém a outra conta acessível e exige novo login.
- Senha anterior e código de recuperação usado recusados; hashes/versionamento no banco conferidos.
- Logout das sessões efetivamente criadas por login.

Requisições são limitadas a15s, respostas em stream a32KiB, sem redirects; SQL próprio a8s. São verificações de API por HTTPS, não de formulários em navegador, concorrência, carga, saturação ou restauração.

## Limpeza, preservação e limites compartilhados

Journal privado600 precede o primeiro COMMIT. Registra sentinelas, IDs, hashes dos tokens/códigos e fingerprint; nunca senhas, códigos/tokens em texto claro ou dados do administrador. Não o apague ou sobrescreva para repetir testes.

Antes de qualquer DELETE, a limpeza trava a linha do schema e valida área privada, visitantes imutáveis, conversas, contas/versionamento/rotação previstos, sessões vinculadas e ausência de dependências estrangeiras. Remove somente os IDs próprios. Uma resposta de login perdida pode criar sessão cujo token não chegou ao verificador; o vínculo validado à conta sintética permite removê-la sem tocar outra conta. Escritas tardias não podem recriar conta/sessão após a remoção da identidade original.

**Nenhuma linha de cl_chat_limits é apagada ou zerada pelo verificador**, inclusive as chaves de acesso sintéticas. Quotas de IP são compartilhadas e não devem ser tratadas como propriedade do ensaio. Podem permanecer até a expiração normal e a coleta habitual feita pelo aplicativo. Uma requisição tardia pode incrementar um contador, mas não recriar uma identidade removida.

A preservação pós-limpeza compara registros das outras dezesseis tabelas e DDL lógico das dezessete; AUTO_INCREMENT pode avançar. O fingerprint completo de dezessete tabelas antes do ensaio comprova correspondência do backup. **Não afirmar igualdade de todos os registros das dezessete tabelas depois deste fluxo**: os contadores de autenticação mudam por desenho. O verificador não atribui outras mudanças de quotas ao ensaio nem as remove. Divergência em identidade/dados/DDL reverte a limpeza e exige inspeção privada.

Para retomar somente a limpeza após interrupção:

~~~sh
node --env-file="$APP_ROOT/.env" "$APP_ROOT/current/scripts/verify-portal-credentials-https.js" --allow-temporary-fixtures --origin="$TEST_ORIGIN" --backup-manifest="$PRIVATE_BACKUP_MANIFEST" --cleanup-only
~~~

O journal é <manifesto>.portal-credentials-run.json. cleanup-only revalida backup e origem, não faz login e não altera quotas. Se a base de dados já estiver preservada, termina sem DELETE. Restos de .next ou uma divergência exigem inspeção, não remoção geral.

Testes modelados verificam recusa a dependências estrangeiras, limites da limpeza, rollback por fingerprint alterado, cadastro parcial/COMMIT ambíguo, cookies, transporte e fingerprint seletivo. Somente o resultado observado na hospedagem pode confirmar homologação real; consultar ANDAMENTO.md.
