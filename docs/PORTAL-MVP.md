# Portal do cliente — recorte v0.9

**Ativado em schema7 no ambiente de testes em03/10/2026; verificador transacional do portal em MariaDB real aprovado.** Consulte [o andamento](ANDAMENTO.md) para backup, preservação e regressões. O código passou220 testes locais na entrega mais recente, além de oito fluxos em navegador real com dados sintéticos. Cliente/operador juntos por HTTPS, concorrência do portal, carga e restauração continuam pendentes; isso não comprova atendimento de produção.

## O que o portal oferece

Em /portal, o cliente cria um acesso ligado ao visitante atual e volta ao histórico em outro dispositivo com identificador e senha. Pode consultar conversas encerradas, iniciar um novo atendimento em área pública ativa e enviar texto. O autor da mensagem permanece o visitante original; chave, sequência, quotas e idempotência são compartilhadas com o chat.

Uma conta fica ligada a um único visitante, de forma imutável. Nome, e-mail, telefone e associação manual no CRM não identificam contas nem recuperam outros históricos. Este acesso comprova a posse da credencial; não verifica e-mail ou identidade civil. SMTP não é requisito e nenhum e-mail é enviado neste recorte.

## Cadastro, senha e recuperação

1. Comece como visitante em /chat e mantenha essa sessão atual.
2. Em Criar acesso, escolha uma senha de 15 a 128 caracteres. Ela não é normalizada nem aparada.
3. O navegador prepara um identificador aleatório de 96 bits e um código de recuperação de 256 bits antes do envio. Guarde o pacote privado, confirme que o guardou e crie o acesso.
4. O cadastro expira a credencial de visitante, inclusive nas outras abas. Entre explicitamente pelo portal com identificador e senha; ele não abre uma sessão automaticamente.

Senhas usam o scrypt existente. O banco guarda apenas hashes do código de recuperação e dos tokens de sessão. Identificador é um dado de acesso, não um segredo de recuperação. Cookies do portal têm nome próprio, HttpOnly, SameSite=Strict, Secure em HTTPS, prazo de oito horas e CSRF próprio. Não compartilham autenticação com operadores ou visitante.

Recuperar exige identificador e código atual, além de uma senha diferente da existente. O navegador prepara o novo código antes do pedido. A operação troca senha e código, incrementa a versão e revoga todas as sessões da conta na mesma transação; o código antigo não pode ser reutilizado. Sem senha e sem código, esta versão não recupera o histórico. Não há resgate por nome, e-mail ou ação informal de um operador.

Os dados preparados ficam só na memória desta aba e no arquivo privado que o cliente escolhe baixar. Nunca vão em URL, logs, localStorage ou sessionStorage; o arquivo não inclui a senha. Guarde-o antes de enviar. Reload/fechamento descartam a preparação local.

Se a resposta do cadastro ou recuperação se perder, a tela preserva o pacote e bloqueia repetição automática. O cliente verifica o resultado entrando com o identificador e a senha preparados. Cadastro não é refeito com uma nova identidade; recuperação não gera outro código às cegas. Uma sessão anteriormente aberta não confirma a recuperação: o pacote novo permanece até confirmar a operação ou um login efetivo com a nova senha. Preparações diferentes são limpas individualmente. A perda de resposta de uma mensagem conserva texto e chave, e o reenvio explícito confirma sem duplicar.

## Permissões e limites

Cada operação revalida conta ativa, sessão atual e visitante ligado. Autorização precede replay. Portal não retorna responsáveis, IDs de usuários/visitantes, contatos ou contexto do CRM. Nomes de áreas privadas ou inativas aparecem como Atendimento anterior; o histórico próprio continua legível, mas envio em área inativa é recusado. Desligar o canal público impede novas conversas; não bloqueia uma conversa já existente em área ativa.

São mantidos os limites do chat: uma conversa ativa e 20 no histórico por visitante; 500 mensagens por conversa, 50 por página, 10 novas mensagens por minuto para o cliente, 5.000 conversas e 50.000 mensagens globais. Portal acrescenta máximo de 5.000 contas, cinco sessões ativas por conta e 10.000 sessões globais. Limpeza de sessões e limites expirados é limitada por execução.

Tentativas de autenticação são contadas antes do scrypt em transação independente, inclusive recusas: até dez por janela de quinze minutos, por IP observado e identificador; o armazenamento de limites tem orçamento de 10.000 chaves e falha fechado. Um gate limita a duas tarefas de senha simultâneas por processo, compartilhado com autenticação da equipe. Não confiar em X-Forwarded-For arbitrário; comportamento de proxy/carga permanece pendente antes de produção.

## Contrato HTTP

As rotas exigem consultas/corpos sem campos extras, tipos originais antes de coerção, JSON e origem exata nas escritas. IDs de acesso têm 24 dígitos hexadecimais minúsculos; códigos e tokens têm 64.

| Rota | Entrada / saída |
|---|---|
| GET /api/portal/me | account com accessId/name e csrfToken; 401 sem sessão |
| POST /api/portal/register | accessId/password/confirmation/recoveryCode; CSRF do visitante atual; 201 created/account; expira visitante |
| POST /api/portal/login | accessId/password; 200 authenticated e cookie; CAS de hash/versão após scrypt |
| POST /api/portal/recover | accessId/recoveryCode/newPassword/confirmation/newRecoveryCode; 200 recovered/authenticated:false |
| POST /api/portal/logout | corpo vazio e CSRF portal; revoga somente a sessão atual |
| GET /api/portal/conversations | lista própria de id/departmentName/status/updatedAt |
| POST /api/portal/conversations | departmentId e CSRF portal; 200 replay ou 201 nova |
| GET /api/portal/conversations/:id/messages | after e limit; mensagens, cursor e hasMore; 404 fora do escopo |
| POST /api/portal/conversations/:id/messages | text/clientKey e CSRF portal; 200 replay ou 201 nova |

## Migração e verificação

Schema7 acrescenta somente cl_portal_accounts e cl_portal_sessions, com visitor_id único/imutável, identificador único, sessões separadas e FKs locais RESTRICT. Datas são explícitas, segredos ASCII binários; o migrador valida colunas/defaults/índices/FKs e só então marca7. Target6 explícito continua disponível antes do upgrade e não modifica preparações parciais. Não reduzir o marcador ou apagar tabelas.

Ordem obrigatória no ambiente de teste: terminar revisão visual, publicar aplicação compatível com schema6, confirmar CI/cron/hash, verificar regressão com portal503, criar backup privado atualizado das quinze tabelas e manter uma release v0.9 compatível. Só então executar migração explícita, comparar preservação e testar SQL/HTTPS. v0.8 não aceita schema7.

Com APP_ROOT definido de forma privada e Node ativo, comandos explícitos após backup/release compatível:

~~~sh
node --env-file="$APP_ROOT/.env" "$APP_ROOT/current/scripts/migrate-database.js"
node --env-file="$APP_ROOT/.env" "$APP_ROOT/current/scripts/verify-portal-database.js"
~~~

O verificador do portal usa uma transação externa não confirmada, savepoints para os repositórios e rollback ao final. Confere os registros e o DDL lógico de dezessete tabelas antes/depois; não imprime credenciais, não envia mensagens a pessoas reais e não deixa contas/canais sintéticos. AUTO_INCREMENT pode avançar mesmo com rollback. É operação manual: nunca incluída no cron ou CI.

Execute também os verificadores anteriores compatíveis e a verificação HTTPS. O verificador de concorrência de oportunidades continua exclusivo de schema5: não executá-lo após7. SQL entre conexões do portal, saturação global, duas partes HTTPS, carga, retenção e restauração ainda não foram demonstrados. A aplicação continua com crmImplemented:false.


Revisão local do verificador: as operações transacionais na única conexão externa são sequenciais. O adaptador recusa uma segunda transação sobreposta antes de criar savepoint; rollback remove o savepoint e preserva a transação externa. Três ensaios modelados cobrem sobreposição, falha de revogação e fingerprint de dezessete tabelas. A suíte integrada local passou197/197 em35.4460725s; isso ainda não confirma execução em MariaDB/cPanel.


Ativação hospedada concluída em03/10/2026: backup15 privado atualizado com checksum precedeu migração7; diagnóstico installed sem módulos pendentes, verificador SQL17 do portal e seis regressões anteriores passaram com rollback. A preservação privada foi reconferida depois das regressões. verify-access.js validou login/perfil/permissões/logout da equipe e negação do portal anônimo por HTTPS. APIs do portal passaram de503 para401 sem sessão; login público carregou. Isto não é ensaio de duas partes autenticadas por HTTPS. Não repetir DDL em cada retomada nem publicar backup/credenciais.


[Ensaio cliente/operador por HTTPS](VERIFICACAO-HTTPS-PORTAL.md) disponível como operação manual separada, com opt-in, backup17, base vazia, journal e limpeza por propriedade. Usa sessões previamente preparadas e não comprova login/cadastro/recuperação HTTP. Veja ANDAMENTO.md para distinguir ferramenta revisada de execução hospedada.
