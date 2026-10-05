# Instalação no cPanel: implementação e próximas etapas

A preparação protegida pelo terminal está implementada em v0.11.1. Siga o [guia atual com comandos executáveis](INSTALADOR-CPANEL.md), [configuração e primeiro acesso](INSTALACAO-ACESSO.md) e [fluxo de releases](DEPLOY-CPANEL.md).

O pacote atual usa app.js, src/ e public/, JavaScript/CommonJS e assets prontos. Não exige build TypeScript/React, Redis, Docker, PM2 ou WebSocket. Chat usa polling; widget abre a página de chat em nova aba. Banco, configuração, backups e aplicação ficam privados, fora de public_html.

Ainda planejado: ZIP público reproduzível, assistente sem terminal, variantes ilustradas de gerenciadores Node, fuso configurável, restauração demonstrada e ensaio por pessoa sem conhecimento de Node. Não existe o antigo comando conceitual cli.js tick, SMTP obrigatório ou envio automático de campanhas. O primeiro módulo usa lotes manuais e consentimento explícito no portal.

Aceite final: instalar banco novo, criar dois operadores/departamento, integrar página de teste, conversar, cadastrar lead/oportunidade, retornar pelo portal e restaurar backup isolado compatível. Node22/24 e MariaDB de testes não demonstram todas as variantes do cPanel. Resultados verificados ficam no [andamento](ANDAMENTO.md).
