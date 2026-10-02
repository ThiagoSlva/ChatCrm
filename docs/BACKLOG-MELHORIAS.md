# Melhorias contínuas

Em 02/10/2026, o usuário reiterou autorização para identificar funções úteis de outros aplicativos, aprimorá-las e implementá-las autonomamente neste projeto. Cada retomada deve escolher benefício concreto, conferir dependências e entregar código testado e publicado, registrando evidências. Ideias não equivalem a funcionalidades prontas. A ordem pode mudar diante de falha real ou nova necessidade do usuário.

| Prioridade | Entrega | Benefício e critério verificável |
| --- | --- | --- |
| Entregue v0.5.1 | Busca/filtros da fila, detalhe preservado e atalhos | Localizar conversas e seguir respondendo após assumir fora do filtro; acesso atualizado, paginação coerente, reenvio sem duplicar |
| Entregue v0.6 | Cadastros de contatos/leads | Área ativa, busca literal, classificação, reenvio seguro e edição com versão; homologação registrada no andamento |
| Entregue v0.7 | Oportunidades e etapas com histórico | Contato separado, BRL, reenvio seguro, versões e snapshots atômicos; homologação registrada no andamento |
| Verificado v0.7 | Concorrência SQL de oportunidades | Duas conexões, mesmo ator, replay/CAS e histórico; fixtures próprias removidas e treze tabelas preservadas. Carga/contatos/múltiplos processos continuam pendentes |
| Entregue v0.8 | Associação entre atendimento e contato | Escolha manual autorizada em área ativa, histórico e versões; sem fundir visitantes por nome/e-mail ou ampliar acesso ao histórico |
| Próxima base | Portal do cliente | Identidade verificada e recuperação segura; nunca recuperar histórico apenas por nome/e-mail informado |
| Próxima base | Campanhas consentidas no canal próprio | Consentimento registrado, descadastro, fila limitada e auditoria; somente destinatários sintéticos na homologação |
| Próxima base | Instalador cPanel e recuperação | Diagnóstico claro, instalação repetível, backup e restauração ensaiada, preservação da configuração privada |
| Produtividade | Respostas rápidas com variáveis limitadas | Inserção editável de textos autorizados, sem envio automático; versões, escopo e tratamento seguro de variáveis |
| Produtividade | Notas internas e etiquetas | Contexto entre operadores; notas nunca chegam à API do visitante ou campanha |
| Produtividade | Transferência e distribuição | Destino ativo/vinculado, transferência transacional e aviso claro; histórico e autorias preservados |
| CRM | Tarefas, lembretes e visão de atividade | Dono, vencimento, histórico e conclusão; lembretes não enviam contatos sem autorização |
| Evolução | Chatbot e editor de fluxos | Regras validadas, limite de passos, simulação com dados de teste, versão e transferência para humano |
| Qualidade | Acessibilidade, carga, proxy e retenção | Teclado/leitor de tela, duas partes HTTPS, conexões SQL concorrentes, limite de recursos e limpeza recuperável |

Verificar segurança, custo de recursos e simplicidade de auto-hospedagem em cada entrega. Manter MIT, interface própria e canal independente. Não copiar marcas/código incompatível nem usar integrações não oficiais do WhatsApp. Não criar mudanças artificiais quando o backlog útil estiver concluído.

Referências iniciais de padrões: [Chatwoot — painel](https://www.chatwoot.com/hc/user-guide/articles/1677231493-lesson-2-dashboard-basics), [filtros](https://www.chatwoot.com/hc/user-guide/articles/1677698771-group-chats-with-filters-save-as-folders) e [recursos de atendimento](https://www.chatwoot.com/hc/user-guide/articles/1677235281-lesson-3-a-mastering-core-features). Referências orientam problemas e comportamento; o código permanece original.
