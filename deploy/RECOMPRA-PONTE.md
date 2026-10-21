# Recompra automática — o que falta na PONTE (computador da farmácia)

O lado do CRM está pronto e **desligado por padrão**. Para funcionar com vendas reais, a PONTE precisa expor um endpoint novo de leitura das vendas do Inova Farma.

## 1. Endpoint `GET /vendas`

```
GET {PONTE_URL}/vendas?desde=<ISO-8601>&limite=<n>[&cursor=<opaco>]
x-api-key: {PONTE_API_KEY}        ← mesma chave do /produtos/buscar
```

Resposta `200`:

```json
{
  "vendas": [
    {
      "id": "123456",
      "data": "2026-10-20T14:32:00-03:00",
      "cancelada": false,
      "cliente": { "nome": "Maria Souza", "telefone": "(55) 99976-5693", "aceita_whatsapp": true },
      "itens": [
        { "produto_id": "7891234", "nome": "FRALDA PAMPERS G 30UN", "quantidade": 2 }
      ]
    }
  ],
  "proximo_cursor": null
}
```

Regras:

| Campo | Obrigatório | Observação |
|---|---|---|
| `id` | sim | Identificador **único e estável** da venda no Inova. É a chave anti-duplicidade. |
| `data` | sim | Data/hora da venda, ISO-8601 com fuso. |
| `cancelada` | não | `true` → a venda é ignorada. Melhor ainda: não retornar canceladas. |
| `cliente.telefone` | sim, para lembrar | Celular com DDD, em qualquer formato. Fixo ou vazio → a venda é ignorada (contada como "telefone inválido"). |
| `cliente.aceita_whatsapp` | não | Só envie `true` se o cliente **autorizou** mensagens no cadastro do Inova. Ausente/`false` → precisa autorizar no CRM. |
| `itens[].produto_id` | sim | Mesmo código cadastrado na tela **Configurações → Recompra**. |
| `itens[].quantidade` | sim | Número > 0. |

- `desde`: vendas com data **≥** esse instante. O CRM relê os últimos 2 dias a cada sincronização (duplicatas são descartadas pelo `id`).
- Paginação: devolva no máximo `limite` vendas e um `proximo_cursor` opaco enquanto houver mais; `null` na última página. Sem paginação, retornar tudo com `proximo_cursor: null` também funciona.
- Erros: `401/403` chave inválida; `5xx` o CRM tenta de novo (2x) e registra a falha sem perder a janela.
- Só leitura (`SELECT`) no SQL Server, com um usuário sem permissão de escrita.

### Consulta no Inova Farma (a descobrir)

Precisamos dos nomes reais das tabelas/colunas de: venda (id, data, status/cancelamento, cliente), itens da venda (produto, quantidade) e cadastro de clientes (nome, celular, consentimento). Para listar:

```sql
SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ORDER BY 1;
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME IN ('<venda>', '<item_venda>', '<cliente>') ORDER BY 1, ORDINAL_POSITION;
```

## 2. Ligar no CRM (nesta ordem, depois de autorizado)

1. Aplicar `supabase/migrations/045_refill_reminders.sql` no Supabase.
2. Cadastrar os produtos em **Configurações → Recompra** (código do Inova + dias por unidade).
3. No `.env` da VPS: `REFILL_PONTE_ACCOUNT_ID=<accounts.id da farmácia>` (o `PONTE_URL`/`PONTE_API_KEY` já existem). `REFILL_SENDING_ENABLED` continua ausente/`false`.
4. Incluir `refill` no laço do serviço `cron` do `compose.yaml` (`for p in automations flows refill`) e `docker compose up -d`.
5. Ativar **"Ativar recompra"** e usar **"Sincronizar agora"**. Conferir o resumo e o histórico: os lembretes ficam *Pendentes* (simulação).
6. Só para envios reais: `REFILL_SENDING_ENABLED=true` no `.env` **e** o switch **"Envio real de mensagens"** na tela.

## 3. Garantias implementadas

- Uma venda/produto gera **uma** compra e **um** lembrete (`UNIQUE` no banco); re-sincronizar ou rodar o cron de novo não duplica.
- Envio: reserva atômica `pending → sending` antes de mandar; falha vira `failed` e **não** é reenviada automaticamente.
- Sem autorização do cliente → lembrete *cancelado (sem autorização)*. Resposta "SAIR"/"PARAR" → descadastro + cancelamento dos pendentes.
- Produto marcado como sensível (padrão) usa a mensagem genérica, sem o nome, até o cliente permitir no painel do contato.
- Nova compra do mesmo produto cancela o lembrete anterior; lembretes com mais de 7 dias após a data prevista expiram em vez de sair atrasados.
- Nenhuma IA: só os textos da tela de configurações.
