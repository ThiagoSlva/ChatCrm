---
name: chatcrm-frontend-quality
description: Aprimorar e revisar o frontend próprio do ChatCrm em HTML/CSS/JavaScript, preservando o atendimento, permissões e reenvios.
---

# Frontend do ChatCrm

Leia docs/DIRECAO-VISUAL.md antes de uma mudança visual ampla. Preserve marca própria, clareza, contraste e componentes existentes. O projeto usa public/*.html, styles.css e scripts externos sob CSP restrita; não introduza dependências, fontes remotas ou scripts inline apenas para aparência.

Ao editar a caixa de atendimento, mantenha fila e conversa com hierarquia clara: identidade, filtros, lista, estado, histórico e resposta. Diferencie a conversa que saiu do filtro e o estado ainda não confirmado. Seleção não autoriza uma ação; a confirmação da API e as permissões continuam necessárias. Não perca rascunhos, foco de edição ou a chave idempotente ao atualizar lista.

Revisão concreta:
- Conferir desktop e largura 390 px. Verificar overflow real, textos longos, filtros, formulário, botões e navegação. Navegação entre páginas deve permanecer acessível no celular.
- Usar labels, foco visível, alvos de toque pelo menos 44 px nos fluxos editados, feedback de erro/status e caminho de teclado. Cor não deve ser a única indicação de estado.
- Ensaiar vazio, carregamento, sem sessão, acesso revogado, erro de rede e reenvio. Atalho de envio deve usar o formulário existente e respeitar composição e bloqueios.
- Revisar a tela real com as ferramentas de navegador disponíveis; guardar screenshot local sem dados privados. Uma captura pública não comprova a área autenticada; distinguir evidências reais, DOM simulado e pendências.
- Testar o comportamento alterado antes de publicar. Conferir a versão e os assets com hash no domínio autorizado após deploy, conforme docs/DEPLOY-CPANEL.md.

Esta skill orienta qualidade, sem prometer perfeição. Registre correções e limites em docs/ANDAMENTO.md. Ela não amplia autorização para instalar ferramentas, expor credenciais, habilitar canais ou alterar outros ambientes.
