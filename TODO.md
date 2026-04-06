# Magic MCP v2.0 — Refactor Completo

> Spec de refatoração profissional do Magic MCP. Bun-only, seguro, estável, performático.

## Decisões de Contexto

- **Caminho A**: compatibilidade total com 21st.dev (sem token no callback — eles não suportam)
- **Runtime**: Bun only (build, test, runtime)
- **Escopo**: refactor completo — reestruturação por domínio, DI, zero código morto

---

## 1. Princípios de Arquitetura

1. **Single Responsibility** — cada módulo faz uma coisa, com fronteira clara
2. **Dependency Injection** — componentes recebem dependências no constructor, não importam singletons
3. **Fail-fast** — validar na fronteira do sistema (config, inputs externos). Confiar internamente
4. **Immutable Config** — parsed 1x no boot, `Object.freeze()`, distribuída por injeção
5. **Zero código morto** — se não é usado, não existe no codebase
6. **Graceful degradation** — callback falha → API fallback. Browser não abre → URL manual

---

## 2. Stack

| Componente | Atual | Novo |
|------------|-------|------|
| Runtime | Node.js 22 + Bun 1.1 | **Bun only (>=1.2.0)** |
| Package manager | npm + bun | **Bun** |
| Bundler | esbuild + bun build | **bun build** |
| Test runner | bun test + fast-check | **bun:test** + fast-check (property-based) |
| TypeScript | 6.0.2 | 6.0.2 |
| MCP SDK | ^1.28.0 | **^1.29.0** |
| Zod | ^4.3.6 | ^4.3.6 |
| open | ^11.0.0 | **remover** (BrowserDetector usa spawn direto) |

### Dependências removidas

| Pacote | Motivo |
|--------|--------|
| `esbuild` | Substituído por `bun build` |
| `shx` | Não necessário com Bun |
| `@types/node` | `@types/bun` inclui tipos Node.js |
| `open` | BrowserDetector já faz spawn de browser; pacote redundante |

### package.json engines

```json
{
  "engines": {
    "bun": ">=1.2.0"
  }
}
```

---

## 3. Estrutura de Diretórios

```
src/
├── index.ts                     # Entry point: boot, wire dependencies, start
├── server.ts                    # McpServer lifecycle (create, register, connect, shutdown)
├── config.ts                    # Config parsing + validation + freeze (executado 1x)
│
├── tools/
│   ├── base-tool.ts             # BaseTool<TSchema> com generics
│   ├── create-ui.tool.ts        # magic_component_builder
│   ├── fetch-ui.tool.ts         # magic_component_inspiration
│   ├── refine-ui.tool.ts        # magic_component_refiner
│   ├── logo-search.tool.ts      # magic_logo_search
│   ├── health-check.tool.ts     # magic_health_check
│   └── canvas-ui.tool.ts        # magic_component_canvas
│
├── http/
│   ├── client.ts                # HttpClient class (DI, retry per-attempt, timeout per-attempt)
│   └── svg-sanitizer.ts         # Remove <script>, event handlers, <foreignObject> de SVGs
│
├── callback/
│   ├── callback-server.ts       # Single-use, porta efêmera (0), sem singleton
│   └── cors.ts                  # CORS allowlist (21st.dev + localhost)
│
├── security/
│   ├── rate-limiter.ts          # Sliding window per-IP
│   ├── path-validator.ts        # Directory traversal prevention
│   ├── shell-sanitizer.ts       # URL/arg sanitization para spawn
│   └── log-sanitizer.ts         # Redação de secrets em logs
│
├── browser/
│   └── detector.ts              # Display env detection + browser launch (imports estáticos)
│
├── logger.ts                    # Logger com níveis + sanitização automática
│
└── __tests__/                   # Testes espelham src/
    ├── tools/
    ├── http/
    ├── callback/
    ├── security/
    ├── browser/
    └── *.test.ts
```

### Convenções

- **Sufixo `.tool.ts`** nos tools — distingue de utilitários
- **Testes em `__tests__/`** espelhando `src/` — separação clara prod vs test
- **Sem barrel files** (sem `index.ts` re-exportando) — imports explícitos, tree-shaking limpo
- **Um arquivo = uma responsabilidade**

### Arquivos removidos

| Arquivo | Motivo |
|---------|--------|
| `src/utils/session-token.ts` | Código morto — 21st.dev não suporta token |
| `src/utils/console.ts` | Substituído por logger nativo |
| `src/utils/get-content-of-file.ts` | Absorvido por `path-validator` + `Bun.file()` |
| `src/utils/` (diretório inteiro) | Reorganizado em módulos por domínio |
| `Dockerfile` | Recriar depois para Bun runtime se necessário |

---

## 4. Config Imutável

### Interface

```typescript
// config.ts
interface Config {
  readonly apiKey: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly timeout: number;        // ms, default: 30000
  readonly maxFileSize: number;    // bytes, default: 1MB
  readonly maxBodySize: number;    // bytes, default: 1MB
  readonly debug: boolean;
  readonly canvas: boolean;
  readonly github: boolean;
}
```

### Comportamento

1. `parseConfig()` chamado **uma vez** no `index.ts` durante o boot
2. Validado com Zod schema — throw se `apiKey` vazio
3. Retorna `Object.freeze(config)` — imutável em runtime
4. Prioridade: **CLI args > env vars > defaults**
5. Objeto `Config` passado por **injeção** para HttpClient, Logger, etc.

### Wiring no boot

```typescript
// index.ts
const config = parseConfig();         // throws se inválido
const logger = new Logger(config.logLevel);
const httpClient = new HttpClient({ ...config, logger });
const server = createMcpServer({ config, httpClient, logger });
await server.start();
```

### Mudanças vs. hoje

- `getEffectiveConfig()` global desaparece — sem re-parse, sem import circular
- `process.env` não é lido fora de `config.ts`
- Se API key não fornecida → servidor **não inicia** (fail-fast)

---

## 5. HttpClient

### Interface

```typescript
// http/client.ts
interface HttpClientConfig {
  baseUrl: string;           // https://magic.21st.dev ou localhost:3005
  apiKey: string;
  timeout: number;           // per-attempt timeout
  retry: RetryConfig;
}

interface RetryConfig {
  maxRetries: number;        // default: 3
  baseDelay: number;         // default: 1000ms
  maxDelay: number;          // default: 8000ms
  jitterMax: number;         // default: 500ms
}

class HttpClient {
  constructor(config: HttpClientConfig)

  get<T>(endpoint: string): Promise<HttpResponse<T>>
  post<T>(endpoint: string, body?: unknown): Promise<HttpResponse<T>>
  put<T>(endpoint: string, body?: unknown): Promise<HttpResponse<T>>
  delete<T>(endpoint: string, body?: unknown): Promise<HttpResponse<T>>
  patch<T>(endpoint: string, body?: unknown): Promise<HttpResponse<T>>
}

interface HttpResponse<T> {
  status: number;
  data: T;
  ok: boolean;              // status 200-299
}
```

### Correções sobre o código atual

| Problema | Solução |
|----------|---------|
| Timeout compartilhado entre retries | **AbortController novo por tentativa** |
| `response.json()` sem try-catch | **Parse seguro** — JSON inválido retorna erro tipado |
| API key capturada no import | **Recebida via constructor** (DI) |
| `BASE_URL` condicional por env | **Recebido via config** |

### Retry por tentativa

```
Tentativa 1: [AbortController, 30s] → 500 → backoff 1s + jitter
Tentativa 2: [AbortController, 30s] → 500 → backoff 2s + jitter
Tentativa 3: [AbortController, 30s] → 500 → backoff 4s + jitter
Tentativa 4: [AbortController, 30s] → falha → retorna erro
```

### Retry policy

- Retry em **5xx** e **network errors**
- **Não** retry em 4xx (client error)
- **Não** retry em timeout (evita acumular requests em servidor sobrecarregado)
- Backoff: `min(baseDelay × 2^attempt + random(0, jitterMax), maxDelay)`

---

## 6. CallbackServer

Hoje usa singleton com state machine (IDLE/BUSY/SHUTDOWN), instâncias temporárias, e complexidade desnecessária. O 21st.dev faz exatamente 1 POST por sessão.

### Novo design: Single-Use Server

```typescript
// callback/callback-server.ts
interface CallbackServerConfig {
  maxBodySize: number;
  cors: CorsHandler;
  rateLimiter: RateLimiter;
  logger: Logger;
}

class CallbackServer {
  constructor(config: CallbackServerConfig)

  // Inicia server em porta efêmera, retorna porta atribuída pelo kernel
  async start(): Promise<number>

  // Espera exatamente 1 callback, depois fecha o server
  async waitForCallback(timeoutMs: number): Promise<CallbackResult>

  // Cancela e fecha
  cancel(): void
}

type CallbackResult =
  | { ok: true; data: string }
  | { ok: false; reason: "timeout" | "cancelled" | "error"; message?: string }
```

### Mudanças vs. hoje

| Aspecto | Atual | Novo |
|---------|-------|------|
| Padrão | Singleton + temp instances | **Instância descartável** (cria, usa, descarta) |
| Porta | 9221 fixa + scan | **Porta 0** (kernel-assigned, imprevisível) |
| Callbacks aceitos | N (resolve no primeiro) | **Exatamente 1** → shutdown automático |
| State machine | IDLE/BUSY/SHUTDOWN | **Não precisa** — lifecycle linear: start → wait → done |
| Token validation | Gerado mas nunca validado | **Removido** (21st.dev não suporta) |
| Inactivity timer | 5 min | **Não precisa** — server fecha após callback ou timeout |

### Fluxo

```
1. Tool cria new CallbackServer(config)
2. const port = await server.start()          // porta efêmera
3. Abre browser com port na URL
4. const result = await server.waitForCallback(120_000)
5. Server fecha automaticamente (1 callback ou timeout)
6. Tool processa result
```

### Segurança mantida (sem token)

- **Porta efêmera**: atacante precisaria adivinhar porta entre ~32768-60999
- **Single-use**: aceita 1 POST, depois fecha — sem replay
- **CORS restritivo**: só 21st.dev + localhost
- **Rate limiting**: proteção contra brute force
- **Body size limit**: 1MB

---

## 7. BaseTool com Generics

### Atual (tipagem fraca)

```typescript
abstract class BaseTool {
  abstract schema: z.ZodObject<any>;           // any perde type safety
  abstract execute(args: z.infer<typeof this.schema>): Promise<ToolResponse>;
}
```

### Novo

```typescript
// tools/base-tool.ts
abstract class BaseTool<TSchema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly schema: TSchema;

  abstract execute(args: z.infer<TSchema>): Promise<ToolResponse>;

  register(server: McpServer): void {
    server.tool(this.name, this.description, this.schema.shape, this.execute.bind(this));
  }

  protected formatError(message: string, code: string, details?: Record<string, unknown>): ToolResponse;
  protected errorCode(errorType: string): string;
}
```

### Mudanças

- `z.ZodObject<any>` → `z.ZodObject<z.ZodRawShape>` — type safety real
- `generateErrorCode()` → `errorCode()` — nome mais curto
- Propriedades `readonly` — tools são imutáveis após criação
- Cada tool declara `TSchema` explicitamente para inferência automática dos args

---

## 8. BrowserDetector (imports estáticos)

### Problemas atuais

- Dynamic imports (`await import("fs")`, `await import("child_process")`) em cada chamada
- `fs` e `child_process` são built-ins, não há razão para lazy loading
- Cache manual frágil com null checks

### Novo design

```typescript
// browser/detector.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";

interface DisplayEnvironment {
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  XDG_SESSION_TYPE?: string;
  XDG_RUNTIME_DIR?: string;
  DBUS_SESSION_BUS_ADDRESS?: string;
  HOME?: string;
}

class BrowserDetector {
  private displayEnv: DisplayEnvironment | null = null;
  private defaultBrowser: string | null = null;
  private logger: Logger;

  constructor(logger: Logger) { ... }

  // Detecta ambiente gráfico (cached após primeira chamada)
  getDisplayEnv(): DisplayEnvironment

  // Detecta browser padrão via xdg-settings (cached)
  getDefaultBrowser(): string | null

  // Abre URL no browser — retorna true se conseguiu
  async openUrl(url: string): Promise<boolean>
}
```

### Mudanças

- **Imports estáticos** no topo — sem overhead de dynamic import
- **Métodos sync** para `getDisplayEnv()` e `getDefaultBrowser()` — já lêem de /proc e execSync
- **Instância ao invés de static** — recebe Logger via DI, cache por instância
- **Sem `open` package** — `Bun.spawn` ou `spawn` nativo direto
- Mapa de browsers mantido (firefox, chrome, brave, etc.)
- Fallback chain: systemd-run → xdg-open → Bun.spawn direto

---

## 9. SVG Sanitizer

### Problema

`LogoSearchTool` busca SVGs de `api.svgl.app` e retorna o conteúdo sem nenhuma sanitização. SVGs podem conter `<script>`, event handlers, `<foreignObject>` com HTML arbitrário.

### Novo módulo

```typescript
// http/svg-sanitizer.ts

function sanitizeSvg(raw: string): string
```

### Regras de sanitização

1. **Remover `<script>` tags** — `<script>...</script>` e `<script .../>`
2. **Remover event handlers** — `onload=`, `onerror=`, `onclick=`, etc. (padrão: `on\w+=`)
3. **Remover `<foreignObject>`** — pode conter HTML/JS arbitrário
4. **Remover `javascript:` URIs** — em `href`, `xlink:href`
5. **Remover `<iframe>`, `<embed>`, `<object>`** — elementos que carregam conteúdo externo
6. **Remover `data:` URIs com scripts** — `data:text/html`, `data:application/javascript`

### Uso no LogoSearchTool

```typescript
const rawSvg = await this.fetchSvgContent(url);
const safeSvg = sanitizeSvg(rawSvg);
return this.convertToFormat(safeSvg, format, name);
```

---

## 10. Logger

### Mudanças

- **Recebe nível via constructor** (injetado da config), não lê `process.env` direto
- **Sanitização mantida** via `LogSanitizer`
- **Fix no LogSanitizer**: usar patterns diretamente ao invés de recriar `RegExp` a cada chamada (reset `lastIndex`)
- **stderr para logs** — MCP usa stdout para protocolo, logs devem ir para stderr

```typescript
class Logger {
  constructor(level: LogLevel, prefix?: string)

  debug(...args: unknown[]): void    // → stderr
  info(...args: unknown[]): void     // → stderr
  warn(...args: unknown[]): void     // → stderr
  error(...args: unknown[]): void    // → stderr
}
```

### Importante: stdout vs stderr

O MCP SDK usa **stdout** para comunicação do protocolo (JSON-RPC via stdio transport). Hoje o logger usa `console.log` / `console.warn` / `console.error`, onde `console.log` vai para **stdout** — isso pode **corromper a comunicação MCP**.

Todos os logs devem ir para **stderr** (`console.error` ou `process.stderr.write`).

---

## 11. Graceful Shutdown

### Problemas atuais

- `beforeExit` handler pode causar loop com `process.exit(0)`
- Sem `unhandledRejection` handler
- `process.exit(0)` no cleanup impede flushing de logs

### Novo design

```typescript
// server.ts
class MagicServer {
  async start(): Promise<void>

  async shutdown(): Promise<void> {
    // 1. Fechar transport MCP
    // 2. Fechar callback servers ativos
    // 3. Flush de logs pendentes
    // 4. process.exitCode = 0 (sem process.exit() forçado)
  }
}

// index.ts — signal handlers
process.on("SIGTERM", () => server.shutdown());
process.on("SIGINT", () => server.shutdown());
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
});
// ❌ Sem beforeExit handler
```

### Mudanças

| Aspecto | Atual | Novo |
|---------|-------|------|
| `beforeExit` | Registrado (risco de loop) | **Removido** |
| `process.exit(0)` | Chamado no cleanup | **`process.exitCode = 0`** (permite flush) |
| `unhandledRejection` | Não existe | **Adicionado** com logging |
| Shutdown do callback | Implícito no singleton | **Explícito** via `server.shutdown()` |

---

## 12. Security Modules (rate-limiter, path-validator, shell-sanitizer, log-sanitizer)

### Mudanças mínimas — esses módulos já estão bem implementados

**rate-limiter.ts:**
- Manter sliding window algorithm
- Receber config (maxRequests, windowMs) via constructor
- `unref()` no cleanup interval (já feito)

**path-validator.ts:**
- Manter lógica de traversal detection
- Usar `Bun.file()` ao invés de `fs.promises` para file reading
- Manter resolução de symlinks

**shell-sanitizer.ts:**
- Manter sanitização de URLs
- Manter escape de shell args
- Nenhuma mudança estrutural necessária

**log-sanitizer.ts:**
- **Fix**: parar de recriar `RegExp` a cada chamada
- Usar patterns diretamente com reset de `lastIndex`
- Manter patterns de redação (API keys, Bearer tokens, hex tokens, AWS keys)

---

## 13. Tools — Mudanças por Tool

### Todas as tools

- Recebem dependências via constructor: `HttpClient`, `Logger`, `Config` (o que precisarem)
- Usam `BaseTool<TSchema>` com generics
- Propriedades `readonly`

### create-ui.tool.ts

- Recebe `HttpClient`, `BrowserDetector`, `Logger` via constructor
- CallbackServer criado como instância descartável (não singleton)
- Porta efêmera (0)
- Remover referências a session token
- Manter fallback chain: browser → API

### fetch-ui.tool.ts

- Recebe `HttpClient`, `Logger`
- Sem mudança funcional — apenas DI e tipagem

### refine-ui.tool.ts

- Recebe `HttpClient`, `Logger`
- File reading via `Bun.file()` com path validation
- Sem mudança funcional

### logo-search.tool.ts

- Recebe `Logger`
- **SVG sanitization** antes de retornar conteúdo
- **Pool-based concurrency** ao invés de chunk-based:
  - Hoje: chunks de 5, espera chunk inteiro antes de iniciar próximo
  - Novo: semáforo com limite de 5 concurrent, preenche slots assim que liberam
- Usar `fetchWithTimeout` compartilhado

### health-check.tool.ts

- Recebe `HttpClient`, `Logger`
- Adicionar estado **"degraded"** (latency > 2000ms)
- Reportar versão do servidor

### canvas-ui.tool.ts

- Recebe `BrowserDetector`, `Logger`
- CallbackServer como instância descartável
- Remover referências a session token

---

## 14. Concurrency Pool (logo-search)

### Problema atual (chunk-based)

```
Chunk 1: [A=100ms, B=100ms, C=100ms, D=100ms, E=5000ms] → espera 5s
Chunk 2: [F=100ms, G=100ms] → só começa após 5s
Total: ~5.2s
```

### Novo (pool-based)

```
Pool (limit=5): A,B,C,D,E iniciam
  → A termina (100ms) → F inicia
  → B termina (100ms) → G inicia
  → C,D terminam → pool vazio
  → E termina (5000ms)
Total: ~5.0s (mas F e G iniciaram em ~100ms ao invés de ~5s)
```

```typescript
async function pool<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number
): Promise<PromiseSettledResult<R>[]> {
  const results: Promise<R>[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const p = fn(item);
    results.push(p);
    const e = p.then(() => { executing.delete(e); }, () => { executing.delete(e); });
    executing.add(e);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.allSettled(results);
}
```

---

## 15. File Reading (substituindo get-content-of-file.ts)

### Atual

`getContentOfFile()` usa `fs.promises.stat()` + `fs.promises.readFile()` com PathValidator.

### Novo

Usar `Bun.file()` que é mais performático e idiomático:

```typescript
// Dentro de cada tool que precisa ler arquivo
async function readFileContent(filePath: string, maxSize: number): Promise<string> {
  const validator = new PathValidator();
  const result = await validator.validate(filePath, process.cwd());
  if (!result.valid) {
    throw new Error(`Invalid path: ${result.error}`);
  }

  const file = Bun.file(result.normalizedPath!);
  if (file.size > maxSize) {
    throw new Error(`File too large: ${file.size} bytes (limit: ${maxSize})`);
  }

  return file.text();
}
```

Não precisa de módulo separado — é simples o suficiente para ser inline ou uma função utilitária dentro do tool que usa.

---

## 16. Testes

### Framework: bun:test + fast-check

- **Unit tests** para cada módulo (`__tests__/` espelhando `src/`)
- **Property-based tests** com fast-check para:
  - Log sanitization (nenhum secret sobrevive)
  - Path validation (nenhum traversal passa)
  - Rate limiter (determinístico por janela)
  - SVG sanitizer (nenhum script sobrevive)
  - Error format consistency (todas as tools retornam formato padronizado)

### Testabilidade via DI

Como todos os componentes recebem dependências via constructor, testar é trivial:

```typescript
// Criar HttpClient com mock server
const client = new HttpClient({
  baseUrl: "http://localhost:9999",
  apiKey: "test-key",
  timeout: 1000,
  retry: { maxRetries: 0, baseDelay: 0, maxDelay: 0, jitterMax: 0 },
});

// Criar tool com dependências injetadas
const tool = new CreateUiTool({ httpClient: client, logger: testLogger, ... });
```

---

## 17. Scripts (package.json)

```json
{
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun",
    "build:prod": "bun run build && bun test",
    "start": "bun dist/index.js",
    "dev": "bun --watch src/index.ts",
    "test": "bun test",
    "debug": "bun run build && bunx @modelcontextprotocol/inspector bun dist/index.js DEBUG=true",
    "prepare": "bun run build",
    "typecheck": "tsc --noEmit"
  }
}
```

### Removidos

- `build:bun` / `build:node` — só um target agora
- `start:bun` — não precisa de sufixo
- `shx chmod` — Bun build já gera executável

---

## 18. Ordem de Implementação

### Fase 1: Fundação (sem quebrar nada)
1. `config.ts` — novo módulo de config imutável
2. `logger.ts` — refatorar para stderr + DI
3. `security/*` — mover e ajustar (mínimo de mudança)

### Fase 2: Infraestrutura
4. `http/client.ts` — novo HttpClient com DI + fix timeout/retry
5. `http/svg-sanitizer.ts` — novo módulo
6. `callback/callback-server.ts` — rewrite simplificado (single-use, porta 0)
7. `callback/cors.ts` — mover e manter
8. `browser/detector.ts` — refatorar (imports estáticos, instância)

### Fase 3: Tools
9. `tools/base-tool.ts` — generics
10. `tools/*.tool.ts` — refatorar cada tool para DI
11. Pool-based concurrency no logo-search

### Fase 4: Wiring
12. `server.ts` — lifecycle do McpServer
13. `index.ts` — boot + DI wiring + signal handlers
14. Graceful shutdown

### Fase 5: Cleanup
15. Remover `src/utils/` inteiro
16. Remover `session-token.ts`, `console.ts`, `get-content-of-file.ts`
17. Atualizar `package.json` (deps, scripts, engines)
18. Atualizar tsconfig.json
19. Remover `Dockerfile` antigo

### Fase 6: Testes
20. Migrar e adaptar testes existentes para nova estrutura
21. Adicionar testes para SVG sanitizer
22. Adicionar property-based tests para novos módulos
23. Verificar cobertura

---

## 19. Riscos e Mitigações

| Risco | Probabilidade | Mitigação |
|-------|--------------|-----------|
| Bun incompatível com algum MCP client | Baixa | Bundle com `--target bun` também roda em Node.js como fallback |
| `Bun.file()` API muda | Baixa | API estável desde Bun 1.0 |
| 21st.dev muda endpoint/formato | Média | Não depende de nós — manter tratamento de erros robusto |
| Regressão em tools durante refactor | Média | Testes existentes + novos testes por fase |
| Porta efêmera bloqueada por firewall | Baixa | Range 32768-60999 raramente é bloqueado localmente |

---

## 20. Critérios de Conclusão

- [ ] Todos os 6 tools MCP funcionando (testados com MCP Inspector)
- [ ] Zero dependência de Node.js-only APIs
- [ ] Testes passando com `bun test`
- [ ] Build com `bun build` gerando bundle funcional
- [ ] Nenhum `console.log` para stdout (apenas stderr)
- [ ] Nenhum `process.env` lido fora de `config.ts`
- [ ] Nenhum singleton global (exceto o MCP server em si)
- [ ] Zero código morto (sem SessionTokenManager, sem console.ts)
- [ ] SVGs sanitizados no LogoSearchTool
- [ ] Graceful shutdown sem `process.exit()` forçado
