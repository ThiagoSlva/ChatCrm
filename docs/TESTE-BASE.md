# Testar a base executável (fase 0)

Esta fase comprova que o servidor inicia e entrega a página. Não comprova o funcionamento de um CRM ou chat, que ainda não existem.

## Na máquina local

1. Instale Node.js 22 ou 24 de fonte oficial.
2. Na pasta do projeto, execute `npm ci` e `npm test`.
3. Execute `npm start` e abra `http://127.0.0.1:3000`.
4. A página deve mostrar o servidor operacional. `/health` deve retornar HTTP 200 e informar `crmImplemented: false` e `chatImplemented: false`.
5. Para encerrar, use Ctrl+C.

## No cPanel de testes

1. Verifique se existe **Setup Node.js App** (CloudLinux) ou **Application Manager** (Passenger), com Node.js 22 ou 24. Os nomes e controles dependem do provedor.
2. Use um subdomínio de testes com HTTPS e uma pasta exclusiva fora de `public_html`. Não sobreponha arquivos de outros sites.
3. Envie `app.js`, `src/`, `public/`, `scripts/`, `package.json` e `package-lock.json`. Não envie `node_modules`, `.git` ou as referências do Telegram. Para testar a suíte no servidor, envie também `test/`.
4. Registre a aplicação na pasta exclusiva, com `app.js` como arquivo de inicialização e ambiente `production`.
5. Instale dependências pelo controle npm do painel, se disponível, ou pelo ambiente de terminal indicado pelo próprio gerenciador. Com terminal, prefira `npm ci --omit=dev`.
6. Preserve a porta/socket estabelecido pelo gerenciador. Não imponha `PORT=3000` no Passenger. A integração entre Fastify e o Passenger precisa ser verificada neste provedor.
7. Inicie/reinicie a aplicação no painel e abra o subdomínio. Confira a página e `/health`.

Esta base espera publicação na raiz de um subdomínio. Hospedagem em subpastas ainda não foi validada.

## Testar MySQL

Use um banco dedicado de testes e um usuário com acesso apenas a esse banco. Informe `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD` nas variáveis privadas do aplicativo ou no arquivo `.env` dentro da pasta privada. O cPanel normalmente acrescenta um prefixo aos nomes do banco e do usuário; use os nomes completos exibidos pelo painel.

No ambiente Node da aplicação, execute `npm run check:database`. Sucesso indica que `SELECT 1` foi executado. Essa verificação não cria schema e não mede concorrência ou desempenho.

Se não houver terminal nem execução de scripts no gerenciador, registre essa limitação: o diagnóstico MySQL pelo navegador e o instalador ainda precisam ser implementados. Não coloque senhas em URLs ou arquivos dentro de `public_html`.

## O que registrar na homologação

- Versão Node disponível e gerenciador usado.
- Instalação de dependências, inicialização e reinicialização.
- Página em HTTPS, assets e resposta de `/health`.
- Conexão MySQL pelo comando privado.
- Disponibilidade de cron e limites do plano para a próxima fase.

WebSocket, polling, filas, campanhas e backup serão verificados quando esses recursos forem implementados. A resposta de `/health` atual não testa o banco nem esses recursos.
