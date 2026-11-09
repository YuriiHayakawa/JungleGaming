# Interpretações adotadas

Decisões que complementam docs/enunciado.md onde ele é omisso ou ambíguo. Não podem contradizer o enunciado nem a constitution. Cada item tem um id estável (I-xx) para ser citado em specs, plans e testes.

## 1. Dinheiro
- I-01: `amount` só é aceito como string JSON (número JSON → payload inválido). Formato `^(0|[1-9]\d*)(\.\d{1,2})?$`: aceita 0 a 2 casas e normaliza para 2 ("25" → "25.00"). Rejeita mais de 2 casas, sinal, espaços, notação científica, NaN, Infinity e string vazia.
- I-02: Em transações, `amount` deve ser > 0 (zero → payload inválido, VALIDATION_ERROR), exceto em LOSS, que aceita "0.00" porque não move saldo nem gera lançamento. BET, WIN, REFUND e ROLLBACK com valor zero → 400 (VALIDATION_ERROR). Saldo inicial de wallet pode ser "0.00".
- I-03: Valor máximo 9999999999999999.99 (limite de NUMERIC(18,2)); acima → payload inválido.
- I-04: O driver devolve NUMERIC como string. Nunca converter para number; o mapper usa `Money.from`.
- I-05: `currency` segue `^[A-Z]{3}$`. O modelo é multi-moeda; a wallet é única por (playerId, currency). Testes de fluxo usam BRL; o conflito de moeda é testado com BRL vs USD.

## 2. Wallet e OPENING
- I-06: Wallet nasce com version 1. O OPENING não incrementa a version: gera lançamento CREDIT com balanceBefore 0.00. Saldo inicial 0.00 não gera OPENING nem lançamento.
- I-07: Identidade do OPENING: providerId "system" (reservado; rejeitado em entradas externas), externalTransactionId `opening:{walletId}`, idempotencyKey `system:opening:{walletId}`, roundId "opening", gameId "system". Nasce PENDING e vira PROCESSED na mesma transação SQL.
- I-08: `kind` OPENING na API ou na fila → payload inválido (OPENING_NOT_ALLOWED).
- I-09: O OPENING emite WalletBalanceChanged, mas não WagerTransactionProcessed (é interno).
- I-10: Criar wallet duplicada (playerId + currency) → 409, inclusive sob concorrência (garantido pelo UNIQUE). Não é replay.

## 3. Regras de transação
- I-11: Transições: PENDING → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED; PENDING_REFERENCE → PROCESSED | REJECTED | FAILED. Estados terminais não mudam. Novas tentativas de uma PENDING_REFERENCE só atualizam attempts e next_attempt_at, sem mudar o status.
- I-12: Efeitos: BET debita; WIN credita; LOSS não move saldo; REFUND credita; ROLLBACK inverte a referência (BET → crédito, WIN → débito, REFUND → débito).
- I-13: BET não aceita referência (informada → payload inválido). REFUND e ROLLBACK exigem referenceExternalTransactionId (ausente → payload inválido). WIN e LOSS aceitam referência opcional, apenas a BET.
- I-14: A referência é resolvida por (providerId, referenceExternalTransactionId) e deve ter o mesmo player, wallet, moeda e rodada; senão REJECTED (REFERENCE_MISMATCH). REFUND referenciando não-BET, ou ROLLBACK referenciando LOSS, ROLLBACK ou OPENING → REJECTED (INVALID_REFERENCE_KIND).
- I-15: Estado da referência: inexistente → PENDING_REFERENCE; PENDING ou PENDING_REFERENCE → continua PENDING_REFERENCE; REJECTED ou FAILED → REJECTED (REFERENCE_REJECTED); PROCESSED → aplica as regras.
- I-16: Uma reversão por transação no total: REFUND e ROLLBACK compartilham a unicidade. Índice único parcial em reference_transaction_id WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'. A segunda tentativa → REJECTED (ALREADY_REVERSED).
- I-17: O valor de REFUND e ROLLBACK deve ser igual ao da referência, senão REJECTED (AMOUNT_MISMATCH).
- I-18: BET sem saldo → REJECTED (INSUFFICIENT_FUNDS). Reversão que deixaria saldo negativo → REJECTED (REVERSAL_WOULD_OVERDRAW), código distinto.
- I-19: Wallet com moeda diferente da operação → REJECTED (CURRENCY_MISMATCH). playerId diferente do dono da wallet → REJECTED (WALLET_PLAYER_MISMATCH). Transação REJECTED é persistida, não altera saldo, não gera ledger e emite WagerTransactionRejected.
- I-20: Wallet inexistente: não há como persistir a transação (FK). HTTP → 404 (WALLET_NOT_FOUND); na fila é erro permanente → DLQ.
- I-21: PENDING_REFERENCE: worker agendado com backoff exponencial (base 5s, fator 2, teto 60s, com jitter). Limite: 10 tentativas ou TTL de 10 min, o que ocorrer primeiro, configurável por env. Esgotado → REJECTED (REFERENCE_NOT_FOUND) + evento. Otimização: ao processar qualquer transação, as pendentes que a referenciam são reprocessadas na hora. Limitação: depois de REJECTED por esgotamento, o estado é terminal e a referência que chegar tarde não reabre a transação. **Ajustado em 2026-11-08 por I-64:** o limite efetivo são as 10 tentativas (cerca de 7 min); o TTL de 10 min passa a ser teto de segurança contado de `created_at`, e a ordem das pendentes antecipadas segue o I-63.
- I-22: FAILED é reservado para erro permanente inesperado (não-negócio, não-transitório) em transação já identificável. É gravado em transação separada, porque a principal sofre rollback. Na fila a mensagem vai para a DLQ. **Ajustado em 2026-11-08 por I-61:** FAILED só é gravado pelo worker de PENDING_REFERENCE; o consumidor da fila nunca grava FAILED, e o registro do erro permanente na fila é a DLQ. O replay de FAILED segue o I-62.

## 4. Idempotência
- I-23: O header `Idempotency-Key` é obrigatório (ausente → 400). O default é `{providerId}:{externalTransactionId}`; qualquer outra chave de 1 a 255 caracteres é aceita.
- I-24: UNIQUE(provider_id, idempotency_key) (idempotência escopada por provedor, I-56) e UNIQUE(provider_id, external_transaction_id). Mesma chave do mesmo provedor com payload diferente → 409. Mesma (provider, externalId) com chave diferente → 409. A mesma chave usada por provedores diferentes não conflita (I-56).
- I-25: payloadHash = SHA-256 hex do JSON canônico (chaves ordenadas recursivamente, sem espaços, UTF-8) de {providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money {amount normalizado, currency}, referenceExternalTransactionId (omitido se ausente)}. Ficam fora do hash: header, idempotencyKey, messageId, occurredAt e metadados. O cálculo é o mesmo no HTTP e no SQS.
- I-26: Todo resultado grava `observed_balance`. Replay devolve o mesmo transactionId, status e saldo observado, com `idempotentReplay: true`, e o mesmo status HTTP do original, exceto 201, que vira 200 no replay (I-39, FR-033).
- I-27: Concorrência: INSERT simples com tratamento da violação de unicidade (SQLSTATE 23505) pelo nome da constraint, com releitura depois do rollback. Quem perde espera o commit de quem ganhou (o PostgreSQL só reporta a violação depois que a transação concorrente decide), relê fora da transação desfeita e compara o hash (igual = replay, diferente = conflito). Redação ajustada em 2026-11-07; antes: "INSERT ... ON CONFLICT". O ajuste evita que um ON CONFLICT DO NOTHING sem alvo engula a violação do índice de reversão única (I-16).
- I-28: Inbox com PK (consumer_name, message_id). Redelivery de mensagem já processada → ack. Mesmo messageId com payloadHash diferente → mensagem venenosa → DLQ. HTTP e fila compartilham o mesmo use case e as mesmas tabelas, então um replay cruzado é reconhecido.

## 5. Mensageria
- I-29: Filas: wager-transactions.fifo (+ DLQ) na entrada e wager-events.fifo na saída da outbox. MessageGroupId = walletId; MessageDeduplicationId = messageId (entrada) ou eventId (saída).
- I-30: Erros: negócio → REJECTED, commit, ack; transitório (PG fora, timeout, deadlock) → sem ack, backoff via ChangeMessageVisibility, DLQ após maxReceiveCount = 5; permanente (mensagem malformada, OPENING, wallet inexistente, hash de inbox divergente) → DLQ direto. **Complementado em 2026-11-08 por I-66 e I-68:** envelope válido com tipo diferente de WagerTransactionRequested (I-66) e conflito de idempotência (I-68) também são permanentes (DLQ direta).
- I-31: Outbox: claim com lease (transação curta com FOR UPDATE SKIP LOCKED que avança next_attempt_at); a publicação acontece fora da transação. Falha → attempts + 1 e backoff. Crash depois de publicar e antes de marcar → republica; duplicata é segura via eventId. **Complementado em 2026-11-08 por I-65:** lote de até 10, lease de 30 s, backoff de 1 a 60 s e polling de cerca de 1 s.
- I-32: Sem garantia de ordem entre eventos com publishers concorrentes; consumidores usam walletVersion e eventId. Em FIFO, uma mensagem em retry bloqueia o grupo (a wallet) até sair. Ambos documentados como limitações.
- I-33: Eventos: WagerTransactionProcessed (qualquer aplicada, inclusive LOSS), WagerTransactionRejected (inclusive por esgotamento de referência), WalletBalanceChanged (só quando o saldo muda, inclusive OPENING), WagerTransactionPendingReference (ao entrar no estado). aggregateId = walletId.
- I-34: PG fora → HTTP 503 com Retry-After, e a fila não dá ack. SQS fora → o POST continua funcionando e a outbox acumula; o /health/ready falha. SIGTERM: para de receber, conclui o que está em andamento (timeout configurável) e devolve a visibilidade do restante.

## 6. Schema e API
- I-35: IDs em UUIDv7 (Bun.randomUUIDv7) atrás da porta IdGenerator.
- I-36: Ledger com `seq` (identity) para o cursor. Ordem crescente por seq, cursor = base64url do seq, limit padrão 50 e máximo 200. CHECKs: amount > 0, balance_after = balance_before ± amount conforme direction, balance_after >= 0. UNIQUE(wallet_id, transaction_id). Trigger bloqueia UPDATE, DELETE e TRUNCATE.
- I-37: Reconciliação em transação REPEATABLE READ, READ ONLY: lê saldo e soma do ledger (créditos − débitos) no mesmo snapshot e verifica a cadeia (before[n] == after[n-1], primeiro before == 0). Divergência: log de erro, métrica e consistent=false, sem correção. A resposta é 200.
- I-38: Erro em formato único: { error: { code, message, retryable, correlationId, details? } }.
- I-39: Status HTTP: 201 processada (200 em replay), 202 PENDING_REFERENCE, 400 payload inválido, 404 não encontrado, 409 conflito (idempotência ou wallet duplicada), 422 rejeição de negócio, 503 transitório com Retry-After, 500 inesperado.

## 7. Taxonomia de failureCode
Em transações REJECTED o provedor não deve reenviar a mesma requisição (o resultado é terminal); `retryable` indica se o reenvio pode dar resultado diferente.

| Código | Quando | retryable | Ação |
|---|---|---|---|
| INSUFFICIENT_FUNDS | BET sem saldo | false | GIVE_UP |
| REVERSAL_WOULD_OVERDRAW | reversão deixaria saldo negativo | false | GIVE_UP |
| BALANCE_LIMIT_EXCEEDED | crédito deixaria o saldo acima de 9999999999999999.99 (I-54) | false | GIVE_UP |
| REFERENCE_NOT_FOUND | referência não chegou no limite | false | FIX_PAYLOAD |
| REFERENCE_REJECTED | referência foi rejeitada | false | GIVE_UP |
| REFERENCE_MISMATCH | provider, player, wallet, moeda ou rodada diferentes | false | FIX_PAYLOAD |
| INVALID_REFERENCE_KIND | tipo de referência inválido | false | FIX_PAYLOAD |
| ALREADY_REVERSED | referência já revertida | false | GIVE_UP |
| AMOUNT_MISMATCH | valor diferente da referência | false | FIX_PAYLOAD |
| CURRENCY_MISMATCH | moeda diferente da wallet | false | FIX_PAYLOAD |
| WALLET_PLAYER_MISMATCH | player não é dono da wallet | false | FIX_PAYLOAD |
| VALIDATION_ERROR / OPENING_NOT_ALLOWED / IDEMPOTENCY_KEY_REQUIRED | payload inválido | false | FIX_PAYLOAD |
| IDEMPOTENCY_CONFLICT | mesma chave com payload diferente | false | FIX_PAYLOAD |
| WALLET_NOT_FOUND / WALLET_ALREADY_EXISTS | wallet inexistente ou duplicada | false | FIX_PAYLOAD |
| TRANSACTION_NOT_FOUND | transação inexistente nas consultas (I-55) | false | FIX_PAYLOAD |
| ROUTE_NOT_FOUND | rota ou método HTTP inexistente (I-59) | false | FIX_PAYLOAD |
| SERVICE_UNAVAILABLE | PG ou SQS indisponível | true | RESEND |
| INTERNAL_ERROR | falha inesperada | true | RESEND |
| INTERNAL_ERROR (replay de transação FAILED) | reenvio de uma transação gravada como FAILED pelo worker (I-61); exceção à linha acima, ajustada em 2026-11-08 por I-62 | false | GIVE_UP |

## 8. Testabilidade e entrega
- I-40: Failpoints por env (ex.: FAILPOINT=after_commit_before_ack), desativados quando NODE_ENV=production, usados nos testes de crash.
- I-41: Autenticação: AuthGuard no-op + ProviderIdentityPort; desenho com Keycloak no ARCHITECTURE.md.
- I-42: Scripts: `bun test`, `bun run test:load`, `bun run test:chaos`.
- I-43: LocalStack: validar no spike se a imagem sobe sem token; senão, MiniStack.

## 9. Validação, ordem de avaliação e contrato HTTP
- I-44: Ordem de avaliação da submissão; a primeira regra violada define o resultado: (1) header `Idempotency-Key`; (2) validação do payload (formatos, kind, OPENING, providerId "system", regras de referência por kind de I-13); (3) idempotência: replay ou conflito; (4) existência da wallet (404); (5) regras de negócio: WALLET_PLAYER_MISMATCH, CURRENCY_MISMATCH; se a transação tem referência e ela existe (em qualquer estado): REFERENCE_MISMATCH, INVALID_REFERENCE_KIND, AMOUNT_MISMATCH (só REFUND/ROLLBACK); depois o estado da referência (REJECTED ou FAILED → REFERENCE_REJECTED; ausente, PENDING ou PENDING_REFERENCE → PENDING_REFERENCE); depois ALREADY_REVERSED (só REFUND/ROLLBACK); por fim INSUFFICIENT_FUNDS / REVERSAL_WOULD_OVERDRAW (débitos) ou BALANCE_LIMIT_EXCEEDED (créditos, I-54). Consequência: uma referência existente porém pendente e inconsistente é rejeitada na hora (ex.: REFERENCE_MISMATCH), sem passar por PENDING_REFERENCE.
- I-45: Rejeição de negócio (422) responde com o corpo de resultado de transação (`transactionId`, `status` REJECTED, `balance` observado, `idempotentReplay`, `failureCode`, `retryable`), porque a transação existe e é consultável. O envelope `{ error }` de I-38 vale para 400, 404, 409, 500 e 503.
- I-46: As regras de I-14, I-15 e I-44 valem também para WIN e LOSS com referência. WIN ou LOSS referenciando algo que não é BET → REJECTED (INVALID_REFERENCE_KIND). Várias WIN/LOSS podem referenciar a mesma BET; só reversões têm unicidade (I-16).
- I-47: Paginação inválida: cursor que não decodifica para uma posição válida, ou `limit` não inteiro, menor que 1 ou maior que 200 → 400 (VALIDATION_ERROR), sem truncar silenciosamente.
- I-48: Header `Idempotency-Key` ausente ou vazio → 400 (IDEMPOTENCY_KEY_REQUIRED); mais de 255 caracteres → 400 (VALIDATION_ERROR).
- I-49: Na entrada HTTP, erro inesperado desfaz toda a transação SQL e responde 500 (INTERNAL_ERROR, `retryable` true), sem gravar FAILED; reenviar é seguro. FAILED (I-22) fica restrito ao consumidor da fila, o que mantém o `retryable` true da taxonomia coerente com o replay. **Ajustado em 2026-11-08 por I-61 e I-62:** FAILED não é gravado pela fila, e sim só pelo worker de PENDING_REFERENCE; o replay de uma transação FAILED responde 500 com `retryable` false (I-62), porque reenviar a mesma requisição nunca muda um estado terminal. O 500 de erro inesperado na entrada HTTP, sem FAILED, continua com `retryable` true.
- I-50: Identificadores: walletId e transactionId são UUID gerados pelo serviço (I-35), no corpo ou na rota; malformado → 400 (VALIDATION_ERROR). playerId, providerId, externalTransactionId, roundId, gameId e referenceExternalTransactionId são strings de 1 a 255 caracteres. POST /wallets não exige Idempotency-Key (duplicata é 409, I-10).
- I-51: Espera por lock de wallet limitada por `WALLET_LOCK_TIMEOUT_MS` (env, padrão 5000), aplicada como `lock_timeout` na transação SQL. Ao estourar: rollback sem efeito e 503 (SERVICE_UNAVAILABLE, `retryable` true) com Retry-After. O timeout de aquisição de conexão do pool e o timeout HTTP do servidor DEVEM ser maiores que o lock timeout, para que o provedor sempre receba o 503 padronizado e nunca um corte de conexão.
- I-52: O 409 WALLET_ALREADY_EXISTS traz apenas `error.details.walletId` (sem saldo, version ou outros dados da wallet existente). O id é lido numa consulta nova, fora da transação que falhou, depois da violação de UNIQUE(player_id, currency). Como o PostgreSQL só reporta a violação depois que a transação concorrente decide, a wallet vencedora já está confirmada quando a leitura acontece; em criações simultâneas, todas as perdedoras recebem o mesmo walletId. Continua sem replay (I-10): nenhum efeito e nenhum evento.
- I-53: correlationId: aceita o header `X-Correlation-Id` com 1 a 128 caracteres em `[A-Za-z0-9._:-]`; ausente ou inválido → o serviço gera um UUIDv7 e segue, NUNCA 400 (é observabilidade e não pode derrubar uma operação financeira). O mesmo valor aparece no header `X-Correlation-Id` da resposta, em `error.correlationId`, nos logs da requisição e nos eventos que ela registrar. A transação guarda o correlationId com que foi processada; em replay, a resposta usa o correlationId da requisição atual, a transação original mantém o seu e nenhum evento é registrado (FR-047).
- I-54: Crédito (WIN, REFUND ou ROLLBACK de BET) cujo saldo resultante excederia 9999999999999999.99 (limite de NUMERIC(18,2), I-03) → REJECTED (BALANCE_LIMIT_EXCEEDED): 422, `retryable` false, ação GIVE_UP. Avaliado no último passo da ordem do I-44, junto da checagem de saldo. Como toda REJECTED, é persistida, não altera saldo, não gera lançamento e emite WagerTransactionRejected (I-19).
- I-55: Transação inexistente em GET /wagering/transactions/:transactionId ou em GET /providers/:providerId/wagering/transactions/:externalTransactionId → 404 (TRANSACTION_NOT_FOUND, `retryable` false) no envelope de I-38. É código apenas de resposta HTTP, nunca failureCode persistido.
- I-56: Idempotência escopada por provedor. A unicidade da chave é UNIQUE(provider_id, idempotency_key) (constraint `wager_tx_provider_idempotency_uq`), no lugar de UNIQUE(idempotency_key). O caminho rápido e a releitura sob lock buscam por (provider_id, idempotency_key), e a violação 23505 é identificada pelo nome dessa constraint (I-27). Dois provedores com a mesma Idempotency-Key e ids externos diferentes são processados de forma independente, sem conflito. Dentro do mesmo provedor, valem I-24 e I-26 sem mudança.
- I-57: Campos desconhecidos no corpo, tanto no HTTP quanto na mensagem da fila, são descartados: não geram 400 e não entram no payloadHash (I-25). Os campos conhecidos continuam estritos (tipo, formato e obrigatoriedade de I-01 a I-13 e I-50).
- I-58: `walletId` e `transactionId` (UUIDs gerados pelo serviço) são normalizados para minúsculas antes da validação, do payloadHash e das buscas; maiúsculas e minúsculas representam o mesmo id. `playerId`, `providerId`, `externalTransactionId`, `roundId`, `gameId` e `referenceExternalTransactionId` são case-sensitive e não são normalizados: "Player-1" e "player-1" são ids diferentes.
- I-59: Rota ou método HTTP inexistente → 404 (ROUTE_NOT_FOUND, `retryable` false, ação FIX_PAYLOAD) no envelope de I-38. É código apenas de resposta HTTP, nunca failureCode persistido. Corpo JSON malformado, `Content-Type` não suportado ou corpo acima do limite do servidor → 400 (VALIDATION_ERROR), também no envelope de I-38 e sem ecoar o corpo (FR-058). Registrado em 2026-11-07; substitui o 400 provisório que o filtro global devolvia para rota inexistente.
- I-60: Autorreferência: `referenceExternalTransactionId` igual ao `externalTransactionId` da própria transação → payload inválido, 400 (VALIDATION_ERROR), com o issue no campo `referenceExternalTransactionId`. É validação estrutural da borda (passo 2 do I-44, schema Zod), feita antes da idempotência e da busca da wallet, e vale para todo kind que aceita referência (WIN, LOSS, REFUND, ROLLBACK); BET já recusa qualquer referência (I-13). A comparação é exata, com caixa (I-58): "Tx-1" e "tx-1" não são autorreferência. Vale igualmente para a mensagem da fila, que reusa o mesmo schema e, por ser payload inválido, vai para a DLQ como erro permanente (I-30). Motivo: como a referência é resolvida pelo mesmo `providerId` da requisição (I-14), uma transação que referencia a si mesma nunca encontraria uma referência diferente dela; sem esta regra ficaria PENDING_REFERENCE até esgotar o limite do I-21, ou, num replay, se encontraria a si mesma. Nada é registrado. Registrado em 2026-11-08.
## 10. Mensageria, worker de PENDING_REFERENCE e outbox
Registradas em 2026-11-08 para a feature 002-messaging-reliability.

- I-61: FAILED só é gravado pelo worker de PENDING_REFERENCE, em transação separada (a principal sofre rollback), quando um erro permanente inesperado impede concluir uma transação já gravada. O consumidor da fila NUNCA grava FAILED: o registro do erro permanente é a DLQ, porque um estado terminal na transação travaria o redrive da mensagem depois de corrigido o bug. Ajusta I-22 e I-49.
- I-62: Replay de transação FAILED, por HTTP ou pela fila, responde 500 (INTERNAL_ERROR) com `retryable` false: exceção documentada à taxonomia §7, onde INTERNAL_ERROR é `retryable` true, porque reenviar a mesma requisição nunca muda um estado terminal. Na fila, a mensagem recebe ack.
- I-63: Pendentes da mesma referência são processadas por `created_at` crescente, cada uma em transação própria, sob o lock da wallet.
- I-64: O limite efetivo de PENDING_REFERENCE são as 10 tentativas (5 + 10 + 20 + 40 + 60 × 6 = 435 s, cerca de 7 min, antes do jitter); o TTL de 10 min é teto de segurança, contado de `created_at`. Ajusta I-21.
- I-65: Publisher da outbox: lote de até 10 mensagens, lease de 30 s via `next_attempt_at` com `FOR UPDATE SKIP LOCKED`, backoff de 1 a 60 s entre tentativas de publicação, polling de cerca de 1 s. Complementa I-31.
- I-66: Mensagem com envelope válido e `type` diferente de WagerTransactionRequested é erro permanente: DLQ direta, sem retries. Complementa I-30.
- I-67: Replay de transação que estava PENDING_REFERENCE e foi concluída pelo worker devolve o estado atual gravado: PROCESSED → 200, REJECTED → 422 (com `failureCode`), ainda pendente → 202, FAILED → I-62. O saldo observado é o da conclusão. A resolução reescreve `observed_balance` e `reference_transaction_id`; `correlation_id` nunca muda. Fecha o ponto deixado em aberto pela spec da feature 001 (replay depois da resolução).
- I-68: Conflito de idempotência pela fila (mesma chave com conteúdo diferente, ou mesmo id externo com outra chave) é erro permanente: DLQ direta, sem retries e sem linha de inbox. A mensagem na DLQ leva `errorCode` e `errorClass` como atributos. Complementa I-30.
- I-69: Na fila, o `correlationId` e o `causationId` dos eventos e da transação são o `messageId`. O `messageId` é validado no envelope (1 a 128 caracteres em `[A-Za-z0-9._:-]`, o mesmo conjunto do I-53); inválido → mensagem malformada (permanente, DLQ). Eventos gerados pelo worker de PENDING_REFERENCE usam o `correlation_id` gravado na própria pendente, sem `causationId`.
