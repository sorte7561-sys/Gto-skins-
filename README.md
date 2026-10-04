# GTO Skins — versão para upload pelo celular

Esta versão foi organizada para não depender de pastas no GitHub. Todos os arquivos ficam na raiz do repositório.

## Arquivos
- `server.js` — servidor + loja + painel
- `package.json` — dependências e comando de inicialização
- `.env.example` — modelo das variáveis
- `.gitignore`

## Render
Build Command: `npm install`
Start Command: `npm start`

Variáveis no Render:
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `APP_URL`

Não coloque chaves reais no GitHub. A `SUPABASE_SECRET_KEY` deve ficar somente nas variáveis de ambiente do Render.

## Rotas
- `/` loja
- `/admin` painel administrativo
