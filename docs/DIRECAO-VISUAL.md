# Direção visual — referência Telegram, identidade própria

Orientação autorizada em **01/10/2026**: usar o Telegram como referência, sem copiá-lo. Esta é uma especificação; não existe protótipo visual implementado.

## Personalidade

Sistema calmo, claro e rápido de entender. Conversas são o centro; informações comerciais aparecem quando ajudam o atendimento. Deve atender uma pessoa ou uma pequena equipe.

Aproveitar como referência legibilidade, espaçamento, lista de conversas, hierarquia de mensagens, identificação de não lidas e uso moderado de azul. Criar marca, ícones, componentes, ilustrações e composição próprios. Não incorporar capturas, logotipo de avião, ícones ou CSS dos projetos Telegram baixados como assets do produto.

## Paleta inicial

| Uso | Cor |
|---|---|
| Primária: ações e seleção | `#175CD3` |
| Acento informativo | `#087E8B` |
| Texto principal | `#172B4D` |
| Texto secundário | `#52647A` |
| Fundo geral | `#F4F7FB` |
| Superfícies e mensagens recebidas | `#FFFFFF` |
| Mensagens enviadas | `#E8F0FE` |
| Sucesso | `#16734A` |
| Erro | `#B42318` |

Tokens propostos para o produto, sem extração de cores do Telegram. Avaliar contraste das combinações e evitar informação só por cor. Tema escuro após estabilizar componentes claros.

Fonte inicial: família do sistema, sem serviço externo de fontes. Se uma fonte for acrescentada, distribuí-la localmente com licença.

## Organização

- Navegação própria: Atendimento, Contatos, Vendas, Equipe, Campanhas e Configurações.
- Atendimento com fila, conversa ativa e painel contextual do contato.
- Contexto recolhível: responsável, tags, oportunidade e próxima tarefa.
- Fila com filtros de departamento, estado e responsável.
- Funil em cartões por etapa, com alternativa em lista para celular e teclado.
- Chat interno em área própria, com destino explicitamente identificado.

No celular, uma área de cada vez: fila, conversa ou contexto. Preservar retorno à lista e campo de envio visível com teclado aberto.

## Conversas

Bolhas de cantos suaves, largura confortável, horários discretos e separadores de data. Mensagens de sistema têm tratamento próprio. Anexos mostram nome, tamanho e ação acessível.

O editor informa quem receberá a mensagem. Notas internas têm modo identificado por texto e aparência distinta. Estados de envio: enviando, salva no servidor, falha com retentativa e leitura quando comprovada. Não mostrar leitura em canais sem confirmação.

## Marca e personalização

Marca original a definir; uma possibilidade é símbolo abstrato de conversa e conexão. Nenhum logotipo foi criado neste documento.

Cada empresa configura logotipo, nome e destaque do widget/portal. O painel preserva legibilidade e alerta sobre combinações com contraste inadequado. A instalação não exige marca ou domínio do autor.

## Ordem e aceite

Desenhar primeiro tokens e componentes, depois atendimento desktop/móvel, widget e portal, contatos e funil, equipe e campanhas, instalador e diagnóstico. Tema escuro após revisão do conjunto.

Verificar celular, desktop, textos longos, zoom, teclado, foco, falhas de envio e estados vazios. Testar o widget em site com CSS próprio. A interface deve transmitir a simplicidade de um mensageiro e a organização de um CRM com personalidade própria.
