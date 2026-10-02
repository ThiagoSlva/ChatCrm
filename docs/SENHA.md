# Troca da própria senha — v0.3.0

Entre em `/acesso` e use o formulário **Sua senha**, disponível a administradores e operadores. Informe senha atual, nova senha e confirmação. A nova senha precisa ter de 15 a 256 caracteres e ser diferente da atual. Não há alteração de senha de outra pessoa por este formulário.

Ao concluir, todas as sessões daquele usuário, inclusive a atual, são revogadas no banco e o cookie é apagado. Entre novamente com a nova senha. A recuperação de senha esquecida ainda será implementada.

`POST /api/auth/password` recebe somente `currentPassword`, `newPassword` e `confirmation`. Exige sessão ativa, origem exata e CSRF. Campos extras, como ID, e-mail ou papel, são recusados. Senha atual incorreta retorna 400 sem alterar o acesso; conflito de estado retorna 409 para novo login. Não retorna senhas ou hashes.

A verificação scrypt e o cálculo do novo hash ocorrem fora da transação, com o limite atual de tentativas e de dois trabalhos de senha simultâneos. A transação trava o usuário, confere ativo/hash verificado e sessão ainda válida e atualiza a senha/revoga sessões atomicamente. Login também revalida o hash sob trava antes de criar uma sessão: um login iniciado com a senha antiga não pode reabrir acesso após a troca.

Este módulo mantém o schema v1 e não exige migração. A homologação SQL de `scripts/verify-team-database.js` testa apenas credenciais aleatórias de usuários sintéticos dentro de uma transação revertida. Nunca troca a senha do administrador existente ou das contas da hospedagem. A verificação HTTPS existente confirma recusa a visitantes, sem alterar senhas reais. Testes locais de entrelaçamento cobrem conflitos; o verificador SQL de conexão única não é ensaio de concorrência entre processos.

Homologação funcional em 02/10/2026: 31 testes locais, Actions em Node 22/24, doze verificações em MariaDB 11.8.6 e doze por HTTPS passaram na release `848fe4c2e19729b96df955740c524e654c0b48a8`, com Node 24.21.0 na hospedagem. Nenhum usuário de teste persistiu e nenhuma senha real foi alterada. A página pública v0.3.0 foi conferida; revisão visual do formulário autenticado permanece pendente.
