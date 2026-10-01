# Fluxo proposto de instalação Node.js no cPanel

**Tutorial planejado. O pacote, o assistente e os comandos próprios ainda precisam ser implementados.** A tela pode ser Application Manager, Setup Node.js App/CloudLinux ou outro gerenciador; o guia final terá variantes homologadas.

## Resultado esperado

Instalação em `suporte.empresa.com.br`, com Node suportado, banco MySQL, administrador e trecho HTML para ativar o chat. O site existente pode continuar usando PHP, WordPress ou outra tecnologia.

## Fluxo de instalação

1. Verificar versão Node, gerenciador, instalação npm, MySQL/MariaDB homologado, HTTPS, armazenamento e cron. WebSocket será testado separadamente.
2. Criar banco e usuário pelo cPanel, associar privilégios necessários e registrar nomes completos com prefixo da conta.
3. Criar subdomínio e ativar HTTPS conforme os recursos do provedor.
4. Enviar e extrair o ZIP em diretório privado, fora de `public_html`. Backend e frontend chegam compilados.
5. Registrar a aplicação Node: runtime suportado, produção, raiz privada, subdomínio e entrada `app.js` quando o gerenciador oferecer esses campos. Os padrões do Application Manager podem diferir do Selector.
6. Usar a ação equivalente a Run NPM Install ou Enable Dependencies. O bootstrap deverá permitir a verificação do gerenciador antes de configurar banco/empresa. Não exigir build TypeScript/Vite no servidor.
7. Configurar um segredo exclusivo de instalação por variável ou arquivo privado. Protege o primeiro acesso; não é licença de ativação.
8. Iniciar/reiniciar pelo painel e abrir o assistente: banco, URL, empresa, fuso e administrador. Criar estrutura sem sobrescrever banco existente e bloquear o instalador ao terminar.
9. Cadastrar departamentos/operadores e testar uma conversa.
10. Copiar o trecho HTML do painel para o site.
11. Configurar cron e SMTP para as funções automáticas. Chat básico funciona sem ambos; documentar convites e recuperação manuais quando SMTP não existir.

## Organização privada

```text
/home/CONTA/conversa-livre/             raiz da aplicação
/home/CONTA/conversa-livre/app.js       entrada do gerenciador
/home/CONTA/conversa-livre/dist/server/ backend pronto
/home/CONTA/conversa-livre/dist/public/ frontend pronto
/home/CONTA/conversa-livre/storage/     anexos privados e logs
```

Publicar somente assets autorizados de `dist/public`. Configuração, backups e anexos privados não são arquivos públicos. Não exigir permissões 777, PM2 ou porta 3000 exposta.

## Tarefas automáticas

Comando conceitual, ainda inexistente:

```text
CAMINHO_DO_NODE /home/CONTA/conversa-livre/dist/server/cli.js tick
```

O programa processará lote limitado, com trava no banco, retomada em falhas e encerramento. O cron precisa ler a configuração privada; não presumir que herda as variáveis do processo web.

Configurar a cada minuto se permitido pelo provedor, ou intervalo maior com atraso indicado. Painel mostra última execução e pendências. Sem cron, chat direto funciona; campanhas/notificações automáticas ficam visivelmente desabilitadas ou pendentes.

## Aceite

Guia final com imagens de implantação real, diagnóstico, erros comuns, recuperação sem SMTP, backup e atualização. Homologar extração ZIP, inodes, npm, Node CLI, HTTPS, subcaminhos, reinícios e retorno após ociosidade.

Confirmar também operação sem WebSocket. Uma pessoa sem conhecimento de Node deve concluir atendimento com dois operadores e restaurar backup em instalação compatível. Compatibilidade cPanel será declarada verificada somente após essa demonstração.
