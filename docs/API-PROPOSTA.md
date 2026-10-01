# Contrato proposto de integração

**Especificação, ainda não implementada.** Exemplos ilustram o comportamento que deverá ser entregue, não uma API disponível hoje.

## Integração básica no site

O administrador cadastra os domínios onde o botão poderá aparecer. O painel gera um trecho como:

```html
<script
  src="https://suporte.empresa.com.br/widget.js"
  data-widget="IDENTIFICADOR_PUBLICO"
  defer>
</script>
```

Esse identificador é público e só permite iniciar um atendimento. Nunca fornece acesso a leads, históricos de terceiros, operadores ou configurações. Recursos de login/CRM usam credenciais separadas.

O widget oferece abrir o portal em uma página própria se o navegador impedir a continuidade dentro do iframe. Eventos entre página e iframe validam `origin`, formato e identificador da integração; não usar `postMessage('*')` para dados de identidade.

## API do backend da empresa

Base proposta: `/api/v1`. Autenticação por `Authorization: Bearer TOKEN_PRIVADO`. Tokens têm validade, escopos, responsável e revogação. O painel exibe o valor apenas na criação; não incluir em HTML, JavaScript público ou exemplos reais no repositório.

| Método e rota propostos | Ação | Permissão |
|---|---|---|
| POST `/contacts` | Criar contato/lead | `contacts:write` |
| GET `/contacts` | Consultar contatos, com paginação | `contacts:read` |
| PATCH `/contacts/{id}` | Alterar contato permitido | `contacts:write` |
| POST `/conversations` | Abrir atendimento de contato | `conversations:write` |
| POST `/conversations/{id}/messages` | Enviar mensagem como identidade autorizada | `messages:write` |
| GET `/conversations/{id}/messages` | Consultar histórico permitido | `messages:read` |
| POST `/operators` | Criar convite de operador | `operators:invite` e autorização administrativa |
| POST `/customer-identifications` | Emitir identificação temporária para cliente do site | `customers:identify` |

Exemplo conceitual de cadastro:

```json
{
  "external_id": "cliente-123",
  "name": "Maria",
  "email": "maria@example.com",
  "phone": "+5511999999999",
  "source": "site",
  "tags": ["orcamento"]
}
```

`external_id` é único por integração e pode ser usado para relacionar cadastros. Sem prova de identidade, coincidência de telefone ou e-mail não autoriza unir históricos. Importação e fusão de contatos precisam de política explícita e confirmação em conflitos.

Chamadas de criação aceitam `Idempotency-Key`. A chave é vinculada à integração e operação: repetição com o mesmo conteúdo retorna o resultado anterior; conteúdo diferente gera conflito. Aplicar autorização no servidor a cada recurso, além de verificar o escopo do token.

Operadores são convidados por e-mail quando SMTP existir; no modo sem SMTP, o administrador gera um convite de uso único para entrega manual. Não enviar senha fixa nem aceitar registro público de operador.

## Identificação de quem já está logado no site

O backend do site identifica seu próprio usuário e solicita um código temporário para incorporá-lo ao chat. Outra opção futura é um SDK PHP que assina os mesmos atributos, com chave específica da integração.

O código deve validar integração, cliente externo, domínio/audiência, finalidade, validade curta e uso único. O navegador recebe apenas esse código, nunca a chave que o assina. O chat troca o código por uma sessão restrita do cliente e impede repetição.

Transferir o código ao iframe por canal com origens verificadas. Não colocar tokens administrativos ou credenciais duradouras em URLs. A verificação do e-mail oferecida pelo portal funciona como alternativa para sites sem backend integrado.

## API pública do widget

Rotas públicas propostas em namespace separado `/widget/v1`: abrir sessão de visitante, iniciar conversa, enviar mensagem própria, consultar eventos próprios e encerrar sessão. Credenciais restritas à sessão e conversa autorizadas; sem acesso ao namespace administrativo.

Aplicar limites de criação, envio e anexos. Permissão CORS ou domínio permitido não autentica um visitante. Toda operação valida a credencial da sessão e o vínculo com a conversa.

## Webhooks

Eventos iniciais: `contact.created`, `conversation.created`, `message.created`, `conversation.assigned` e `conversation.closed`. Dados mínimos, assinatura HMAC do corpo exato, identificador de evento, timestamp e verificação de repetição no consumidor.

Entrega ao menos uma vez, com fila, retentativa e registro de falhas; consumidores deduplicam por ID. URLs de destino só podem ser cadastradas por administrador, exigem HTTPS e devem bloquear loopback, redes privadas, endereços de metadados e redirecionamentos para esses destinos, inclusive após resolução de DNS.

Definir esquema JSON, códigos de erro estáveis, paginação, limites e versão no OpenAPI durante a implementação. Rotas acima são uma proposta; não são um compromisso de compatibilidade anterior à primeira versão publicada.
