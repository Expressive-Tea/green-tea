# green-tea — Architecture

> The request and boot are an explicit **dependency graph**, not a mutable middleware chain.
> You declare *what* you need; the framework computes the order. The graph can extend in
> **time** (streams) and across **machines** (mesh).

## The four layers

```mermaid
flowchart TB
    subgraph L3["#3 MESH — the graph crosses machines"]
        direction LR
        teacup["teacup (consumer)"] -- "WS RPC" --> teapot["teapot (host)"]
    end
    subgraph L2["#2 STREAMS — the graph emits over time"]
        sse["SSE / ndjson"]:::n
        ws["WebSocket duplex"]:::n
    end
    subgraph L15["#1.5 ARG DECORATORS — the handler declares its deps"]
        sig["handler signature = dependency declaration"]:::n
    end
    subgraph L1["#1 CORE — graph DI + boot + router + pipeline + flow"]
        core["Providers · Steps · Routes · Transformers · Container · Bus"]:::n
    end
    L3 --> L2 --> L15 --> L1
    classDef n fill:#f6f8fa,stroke:#aaa;
```

## Building blocks

```mermaid
flowchart LR
    Provider["@Provider\n(app scope · singleton)"]:::p
    Step["@Step\n(request scope · per call)"]:::s
    Route["@Route + @Get/@Post/@Sse/@Ws/@Stream"]:::r
    Transformer["@Transformer\nvalue → ResponseShape"]:::t
    Container["Container.resolve()\nasync · transport-agnostic"]:::c
    Bus["Bus\nlifecycle events"]:::b

    Provider --> Container
    Step --> Container
    Route --> Transformer
    Container -. "remote binding (mesh)" .-> Provider
    classDef p fill:#e7f5ff,stroke:#4dabf7;
    classDef s fill:#fff3bf,stroke:#f59f00;
    classDef r fill:#ebfbee,stroke:#40c057;
    classDef t fill:#f3f0ff,stroke:#7950f2;
    classDef c fill:#fff0f6,stroke:#e64980;
    classDef b fill:#f1f3f5,stroke:#868e96;
```

## Request lifecycle

```mermaid
sequenceDiagram
    participant C as Client
    participant H as http.ts (transport)
    participant P as Pipeline
    participant G as Graph (providers/steps)
    participant T as Transformer

    C->>H: HTTP request
    H->>H: matchRoute(method, path)
    H->>P: runPipeline(seed = req envelope)
    P->>G: providers (cached) + steps (topo order)
    Note over G: each step merges into ctx;<br/>throw = short-circuit, return = continue
    P->>P: handler(args resolved from ctx)
    alt returns a value
        P->>T: transformer → {status, headers, body}
        T-->>C: buffered response
    else returns an AsyncIterable
        P-->>C: stream (SSE / ndjson / WS), backpressure + cleanup
    else @needs a remote token
        G-->>C: RPC to teapot, value spliced into ctx
    end
```

## The unifying rule

```mermaid
flowchart TD
    Q{"what does the handler return /\nwhere does a token live?"}
    Q -->|"a value"| A["buffered (transformer → JSON)"]
    Q -->|"an AsyncIterable"| B["stream (SSE / WS)"]
    Q -->|"a token with no local provider"| D["RPC to a teapot (mesh)"]
```

One question — *"what produces this token and where does it live?"* — answers local DI,
streaming, and distribution. That single seam is why green-tea isn't "Express with decorators":
**the graph is the product.**

## Mesh walking skeleton (spec #3)

```mermaid
flowchart LR
    subgraph A["Node A — teapot"]
        ea["@Provider({export:true})\n@Step({export:true})\n@Get('/x',{export:true})"]
        mc["control channel\n/__mesh__/control\n(secret-gated)"]
    end
    subgraph B["Node B — teacup"]
        bn["@needs('auth') with\nno local provider"]
        lk["link: handshake → manifest\n→ synthetic graph nodes\nwith RPC runners"]
    end
    bn --> lk
    lk -- "hello + secret" --> mc
    mc -- "manifest {scopes, routes}" --> lk
    lk -- "rpc-req {id, kind, name, ctx}" --> mc
    mc -- "rpc-res {id, ok, result}" --> lk
```

- **Provider exported → app scope** (resolved once via RPC, cached).
- **Step exported → request scope** (RPC per request, carries the request envelope).
- **Route exported → proxy** (teacup forwards the request, teapot runs the full pipeline).

Deferred to mesh sub-specs: discovery/auto-registration, 2-way load-balancing, failover/health.
