# Migração Vercel → VPS Hostinger

Alvo: `https://crm.ascentstudio.com.br`, contêiner `wacrm` na rede `evolution_default`,
atrás do Caddy que já atende `evolution.ascentstudio.com.br`. Banco continua no Supabase.

Arquivos deste diretório e da raiz:

| Arquivo | Para quê |
|---|---|
| `Dockerfile` | Build multi-stage, Node 22 Alpine, saída `standalone`, roda como usuário `node` |
| `.dockerignore` | Mantém `.env*`, `.git`, `node_modules`, `mcp-server` fora da imagem |
| `compose.yaml` | Serviço `wacrm` + serviço `cron`, rede externa `evolution_default`, healthcheck, rotação de logs |
| `.env.production.example` | Todas as variáveis, marcadas [BUILD]/[RUN] |
| `deploy/Caddyfile.crm` | Bloco a **acrescentar** ao Caddyfile existente |
| `deploy/evolution-set-webhook.mjs` | Re-aponta o webhook das instâncias existentes (dry-run por padrão) |
| `src/app/api/health/route.ts` | `GET /api/health` → `{"ok":true}` para healthcheck |

---

## 1. ENCRYPTION_KEY — decidir antes de subir

**O que ela protege** (AES-256-GCM, `src/lib/whatsapp/encryption.ts`):

| Tabela.coluna | Conteúdo |
|---|---|
| `ai_configs.api_key` | Chave OpenAI/Anthropic de cada conta |
| `ai_configs.embeddings_api_key` | Chave de embeddings (base de conhecimento) |
| `whatsapp_config.access_token`, `.verify_token` | Meta Cloud API (oficial) |
| `meta_capi_config.access_token` | Meta Conversions API |
| `webhook_endpoints.secret` | Segredo HMAC dos webhooks de saída (API v1) |

A Evolution **não** usa essa chave (`whatsapp_channels` não tem campo criptografado).

**Se a chave mudar:** nada é corrompido nem apagado. A descriptografia falha, e o app já trata isso:
a IA para de responder, e as telas pedem para "re-enter your key". Basta salvar as credenciais
de novo, e elas são regravadas com a chave nova.

**Recuperar a original:** não há cópia local (procurei em todos os projetos de `Desktop`,
`Documents` e `Downloads`). Variáveis "Sensitive" da Vercel não aparecem no painel nem no
`vercel env pull`. Caminhos legítimos:
1. Gerenciador de senhas ou anotação de quando ela foi gerada.
2. `vercel env ls` lista os ambientes onde ela existe. Se estiver em Development/Preview
   como **não** sensível, `vercel env pull --environment=development .env.vercel-dev` traz o valor.
   Apague o arquivo depois.
3. Não recomendo criar uma rota temporária na Vercel para "imprimir" a chave: ela ficaria exposta em URL e logs.

**Medir o impacto antes de decidir** (somente leitura, Supabase → SQL Editor):

```sql
select 'ai_configs.api_key' campo, count(*) from ai_configs where coalesce(api_key,'') <> ''
union all select 'ai_configs.embeddings_api_key', count(*) from ai_configs where embeddings_api_key is not null
union all select 'whatsapp_config.access_token', count(*) from whatsapp_config where access_token is not null
union all select 'meta_capi_config.access_token', count(*) from meta_capi_config where access_token is not null
union all select 'webhook_endpoints.secret', count(*) from webhook_endpoints;
```

**Trocar a chave (só se não recuperar):**
1. `openssl rand -hex 32` → `ENCRYPTION_KEY` no `/opt/wacrm/.env`.
2. Depois do deploy, por conta: Configurações → IA (chave do provedor e de embeddings).
   Se usar: Configurações → WhatsApp (Meta), Meta CAPI. Recrie os webhooks de saída: quem recebe ganha um segredo novo.
3. Na Vercel, sobrescreva `ENCRYPTION_KEY` com o **mesmo valor novo** (dá para sobrescrever, só não dá para ler).
   Assim o rollback continua possível.

> Atenção: Vercel e VPS usam o mesmo banco. Quando uma credencial for salva com a chave nova,
> a Vercel com a chave antiga deixa de conseguir lê-la, e vice-versa.

---

## 2. Credenciais a reunir

| Variável | Onde obter |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (mesmo projeto) |
| `ENCRYPTION_KEY` | Seção 1 |
| `EVOLUTION_API_KEY` | `AUTHENTICATION_API_KEY` do ambiente de `/opt/evolution` |
| `EVOLUTION_WEBHOOK_SECRET` | Pode ser novo: `openssl rand -hex 32` (o script do passo 9 reconfigura as instâncias) |
| `AUTOMATION_CRON_SECRET` | Novo: `openssl rand -hex 32` |
| `PONTE_URL`, `PONTE_API_KEY` | Valores atuais da Vercel / responsável pelo serviço da farmácia (sem eles a ferramenta `buscar_produto` da IA fica desligada) |
| `OPENAI_API_KEY` | Só se estiver definida hoje na Vercel (`vercel env ls production` mostra os nomes) |
| `META_*` | Só se usar a API oficial da Meta |

---

## 3. Passo a passo na VPS

Nada aqui reinicia Evolution, PostgreSQL, Redis ou Caddy. O único comando que mexe no Caddy é o
`caddy reload` do passo 7, que é gracioso (não derruba conexões). Rode-o só quando quiser.

```bash
# 0. Backups (nada é sobrescrito sem cópia)
cp -a /opt/evolution/Caddyfile /opt/evolution/Caddyfile.bak-$(date +%F-%H%M)
mkdir -p /opt/wacrm-manual-bak
cd /opt/wacrm && cp -a Dockerfile .dockerignore compose.yaml .env /opt/wacrm-manual-bak/ 2>/dev/null

# 1. DNS: registro A  crm → 179.236.77.61  (no painel do domínio)
dig +short crm.ascentstudio.com.br      # deve responder 179.236.77.61

# 2. Código: tirar os arquivos manuais do caminho (git recusa sobrescrever não rastreados)
cd /opt/wacrm
rm -f Dockerfile .dockerignore compose.yaml     # cópias estão em /opt/wacrm-manual-bak
git pull                                        # traz a versão com estes arquivos
# Comparar com o que você tinha feito à mão:
diff /opt/wacrm-manual-bak/Dockerfile Dockerfile
diff /opt/wacrm-manual-bak/compose.yaml compose.yaml

# 3. .env: comparar NOMES (não imprime valores)
diff <(grep -oE '^[A-Z_]+' .env.production.example | sort -u) <(grep -oE '^[A-Z_]+' .env | sort -u)
grep -c $'\r' .env          # tem que ser 0 (sem CRLF do Windows)
nano .env                   # completar o que faltar; sem aspas
chmod 600 .env

# 4. Descobrir como o Caddy roda
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Networks}}'
docker inspect <CONTAINER_CADDY> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
#   Caddy em contêiner na evolution_default → manter "wacrm:3000" no bloco
#   Caddy no host (systemd)                  → trocar por "127.0.0.1:3000"
# Webhook global da Evolution não pode duplicar eventos:
grep -hE '^WEBHOOK_GLOBAL_(ENABLED|URL)=' /opt/evolution/.env 2>/dev/null

# 5. Build (precisa de ~2 GB de RAM livre; se faltar, crie swap antes)
docker image inspect wacrm:latest >/dev/null 2>&1 && docker tag wacrm:latest wacrm:previous
docker compose build

# 6. Subir só o CRM
docker compose up -d
docker compose ps                           # wacrm "healthy", wacrm-cron "Up"
curl -s http://127.0.0.1:3000/api/health    # {"ok":true}

# 7. Caddy: ACRESCENTAR o bloco (>> preserva o arquivo/inode do bind mount)
cat deploy/Caddyfile.crm >> /opt/evolution/Caddyfile
docker exec <CONTAINER_CADDY> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec <CONTAINER_CADDY> caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile
#   (ajuste /etc/caddy/Caddyfile ao "Destination" visto no passo 4)
curl -sI https://crm.ascentstudio.com.br/login | head -1     # HTTP/2 200
curl -sI https://evolution.ascentstudio.com.br | head -1     # continua respondendo
```

**8. Supabase → Authentication → URL Configuration** (painel, sem SQL):
- Site URL: `https://crm.ascentstudio.com.br`
- Redirect URLs: acrescentar `https://crm.ascentstudio.com.br/**`. Mantenha a URL da Vercel até o fim do período de rollback.
- Se os templates de e-mail usam `{{ .SiteURL }}`, eles passam a apontar para o domínio novo automaticamente.

**9. Webhook das instâncias WhatsApp existentes.** O CRM só grava o webhook ao *criar* a instância, então as
atuais continuam enviando para a Vercel.

```bash
cd /opt/wacrm
RUN='docker compose run --rm --no-deps -v /opt/wacrm/deploy:/deploy:ro --entrypoint node wacrm /deploy/evolution-set-webhook.mjs'
$RUN            # dry-run: lista acct-*, status e URL atual
$RUN --apply    # grava https://crm.ascentstudio.com.br/api/whatsapp/evolution/webhook + header x-evolution-secret
$RUN            # confirmar
```

Sessões e instâncias ficam no Postgres/Redis/volumes da Evolution e não são tocadas.
O banco da Evolution não precisa de nenhuma alteração.

Opcional, depois que tudo estiver estável: `EVOLUTION_API_BASE_URL=http://<nome-do-contêiner-evolution>:8080`
evita a volta pela internet. Confira o nome e a porta com `docker ps`.

---

## 4. Testes

| O quê | Como | Esperado |
|---|---|---|
| HTTPS/certificado | `curl -sI https://crm.ascentstudio.com.br/login` | 200, sem erro de TLS |
| Login | Entrar com usuário existente | Vai para `/dashboard` e não volta para o login |
| Sessão | Recarregar `/inbox` e abrir outra aba | Continua logado |
| Supabase | Contatos, pipelines e inbox carregam | Dados de sempre |
| Convite | Criar um convite de membro | Link com `crm.ascentstudio.com.br` |
| Evolution (saída) | Enviar mensagem pelo inbox | Chega no celular |
| Webhook (entrada) | Mandar mensagem do celular para o número | Aparece no inbox; `docker logs wacrm --since 5m \| grep request.finish` com `httpStatus":200` |
| Webhook sem segredo | `curl -s -o /dev/null -w '%{http_code}' -X POST https://crm.ascentstudio.com.br/api/whatsapp/evolution/webhook -d '{}'` | `401` |
| IA | Configurações → IA → testar | Responde; "could not be decrypted" = seção 1 |
| Automações | Automação com etapa "aguardar" curta | Retoma em ~1 min; `docker logs wacrm-cron` sem "failed" |
| Cron protegido | `curl -s -o /dev/null -w '%{http_code}' https://crm.ascentstudio.com.br/api/automations/cron` | `401` |
| Cache da API | `curl -sI https://crm.ascentstudio.com.br/api/health \| grep -i cache-control` | `no-store` |

---

## 5. Rollback

A Vercel não é tocada por nada disto. Mantenha o projeto e as variáveis de lá até a VPS estar estável.

1. **WhatsApp de volta para a Vercel:** `$RUN --url https://<dominio-vercel>/api/whatsapp/evolution/webhook --apply`.
   A Vercel precisa ter o mesmo `EVOLUTION_WEBHOOK_SECRET` da VPS: sobrescreva lá e faça redeploy.
2. **Chave de criptografia:** se credenciais foram salvas com uma `ENCRYPTION_KEY` nova, a Vercel precisa do mesmo valor (seção 1, item 3).
3. **Parar o CRM na VPS:** `cd /opt/wacrm && docker compose down` (só derruba `wacrm` e `wacrm-cron`).
4. **Caddy:** `cp /opt/evolution/Caddyfile.bak-<data> /opt/evolution/Caddyfile` + `caddy reload` (passo 7).
5. **Voltar a versão anterior na VPS:** `docker tag wacrm:previous wacrm:latest && docker compose up -d --no-build`.
6. **Supabase Auth:** voltar o Site URL para o domínio da Vercel.

---

## 6. Pendências conhecidas do código (não alteradas)

- **Redefinição de senha não funciona hoje:** `forgot-password` redireciona para `/auth/callback?next=/reset-password`,
  e nenhuma das duas rotas existe. O problema já existia antes da migração.
- Schema: é o mesmo commit que roda na Vercel, então não há migration nova a aplicar para esta mudança.
- `/api/automations/cron` compara o segredo sem tempo constante (`/api/flows/cron` já usa). Risco baixo.
- `buscar-produto.ts` registra a consulta e a resposta completa da ponte da farmácia. Não há segredo, mas o log fica grande; o Compose limita os logs a 5×10 MB.
- CSP está em modo `Report-Only`.
