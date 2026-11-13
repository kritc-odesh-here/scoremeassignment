# DecisionFlow: Architecture & Technical Specification

## 1. Executive Summary

DecisionFlow is a configurable, resilient workflow decision platform built in **Node.js, Express, MongoDB, and Zod**. It executes multi-stage business workflows, evaluates pure in-memory dynamic AST rules, coordinates finite state transitions, isolates external dependencies with fault injection and external idempotency, and records tamper-evident, cryptographically chained audit trails.

The demonstration use case is a **Retail Loan Underwriting Platform** supporting `APPROVED`, `REJECTED`, and `MANUAL_REVIEW` outcomes. Crucially, the core engines contain **zero loan-specific terms or hardcoding**. All workflows, stages, rules, and decision policies are declared via versioned configuration schemas.

---

## 2. System Architecture & Component Boundaries

DecisionFlow follows a **Modular Monolith** architecture with strict hexagonal layer boundaries:

```mermaid
graph TD
    subgraph Ingestion ["Ingestion & Safety Layer"]
        Client["REST API Clients"] --> TechnicalValidator["Technical Schema Validator (Zod)"]
        TechnicalValidator -->|Schema Violation: 400 Bad Request| Client
        TechnicalValidator -->|Valid Schema| IdempotencyFilter["Idempotency Filter (Atomic Insert & Lease)"]
        IdempotencyFilter <--> IdempotencyStore["Idempotency Key Store (MongoDB TTL)"]
    end

    subgraph CoreEngine ["Workflow & Domain Core"]
        IdempotencyFilter --> WorkflowEngine["Workflow Execution Orchestrator"]
        WorkflowEngine <--> StateMachine["Finite State Machine Guard (FSM)"]
        WorkflowEngine <--> CheckpointMgr["Stage Checkpoint Manager"]
        WorkflowEngine <--> RulesEngine["Generic AST Rules Engine"]
        WorkflowEngine <--> ExternalGateway["Fault-Tolerant Bureau Gateway"]
    end

    subgraph Persistence ["Persistence & Data Trust"]
        WorkflowEngine --> MongoTransactions["MongoDB Transactions & OCC (stateVersion)"]
        MongoTransactions --> AppCollection["Applications Collection"]
        MongoTransactions --> WorkflowCollection["Workflow Definitions (Partial Unique Active Index)"]
        MongoTransactions --> AuditService["Audit Service & SHA-256 Hash Chain"]
        AuditService --> AuditCollection["Immutable Audit Logs Collection"]
    end
```

### Module Responsibilities

| Module | Responsibility | Isolation Guarantee |
| :--- | :--- | :--- |
| **TechnicalValidator** | Validates incoming JSON syntax and data types via Zod schemas. | Returns `HTTP 400 Bad Request` directly. Never evaluates business eligibility or writes to the database. |
| **IdempotencyManager** | Unique-key insertion, SHA-256 payload hashing, lease ownership (`ownerToken`), active lease protection (`HTTP 409`), expired lease reclamation, and cached response replay (`HTTP 200` with `X-Cache-Lookup: HIT`). | Stale workers whose lease expired cannot overwrite newer results. |
| **WorkflowEngine** | Coordinates execution across stages, checks persisted stage checkpoints, resumes after failures without repeating completed side-effects. | Pure orchestrator; delegates domain logic to RulesEngine and StateMachine. |
| **RulesEngine** | Evaluates recursive AST rules (`AND`, `OR`, single-child `NOT`, threshold comparisons) against arbitrary JSON. Computes deterministic priority, ties, and explainable trace trees. | **Pure, stateless in-memory function.** Zero DB dependencies, zero business-specific hardcoding. |
| **StateMachine** | Strictly guards lifecycle states (`RECEIVED`, `ENRICHING`, `EVALUATING`, `APPROVED`, `REJECTED`, `MANUAL_REVIEW`, `FAILED`) and terminal states (`APPROVED`, `REJECTED`). | Throws `InvalidStateTransitionError` (`HTTP 409`) on illegal transitions. |
| **CheckpointManager** | Tracks stage lifecycle (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`) and stores stage outputs and error details. | Enables resumption without re-calling completed external APIs. |
| **BureauGateway** | Simulates third-party Credit Bureau lookups with configurable latency, transient 503s, and exponential backoff with full jitter. | Features an in-memory/persisted external idempotency store to prevent duplicate billing on retry. |
| **AuditService** | Canonicalizes event records (RFC 8785) and builds a SHA-256 cryptographic hash-chain (`previousHash` $\to$ `eventHash`). | Provides `verifyAuditChain` endpoint to detect tampering or gaps. |

---

## 3. Request-to-Decision Data Flow

```mermaid
sequenceDiagram
    autonumber
    actor Client as API Client / Consumer
    participant TechVal as Technical Validator (Zod)
    participant Idemp as Idempotency Filter
    participant WF as Workflow Engine
    participant FSM as State Machine
    participant Ext as Bureau Gateway
    participant Rules as AST Rules Engine
    participant Audit as Audit Service
    participant DB as MongoDB (Replica Set)

    Client->>TechVal: POST /api/v1/applications (Idempotency-Key: K, Payload)
    alt Technical Schema Invalid (e.g. negative income, missing field)
        TechVal-->>Client: HTTP 400 Bad Request (ZERO DB writes, NO business rejection)
    end
    TechVal->>Idemp: Forward validated payload

    Idemp->>DB: insertOne({ _id: K, requestHash, status: 'PROCESSING', ownerToken, leaseExpiresAt })
    alt Key Exists & COMPLETED (Matching Hash)
        Idemp-->>Client: HTTP 201/200 Replay Cached Response (X-Cache-Lookup: HIT)
    else Key Exists & COMPLETED (Mismatched Hash)
        Idemp-->>Client: HTTP 422 Unprocessable Entity
    else Key Exists & PROCESSING (Active Lease)
        Idemp-->>Client: HTTP 409 Conflict (In-Flight)
    end

    Idemp->>WF: Execute Workflow (Owner: workerToken)
    WF->>DB: Fetch Active Workflow Definition (Partial Unique Index)
    WF->>DB: Transaction: Create Application (RECEIVED) + Audit Event (Seq 1, Genesis Hash)

    WF->>FSM: Assert Transition: RECEIVED -> ENRICHING
    WF->>DB: Transaction: State -> ENRICHING, Stage -> RUNNING, Audit Event (Seq 2)

    WF->>Ext: fetchCreditReport(applicant, idempotencyToken, faultConfig)
    alt External Transient 503 Failure Exceeds Retries
        Ext-->>WF: Service Unavailable
        WF->>DB: Transaction: State -> FAILED, Stage -> FAILED, Audit Event (Seq 3)
        WF-->>Client: HTTP 201 Created (State: FAILED, stage: FAILED, expose /retry)
    else External Call Succeeds
        Ext-->>WF: Credit Profile (Score, DTI, Bankruptcies)
        WF->>DB: Transaction: Stage -> COMPLETED, Context enriched, Audit Event (Seq 3)
    end

    WF->>FSM: Assert Transition: ENRICHING -> EVALUATING
    WF->>DB: Transaction: State -> EVALUATING, Audit Event (Seq 4)

    WF->>Rules: evaluateRuleset(ruleset, contextData)
    Note over Rules: Evaluates AST nodes recursively (Score >= 720 AND DTI <= 35%)
    Rules-->>WF: Decision { outcome: 'APPROVED', reasonCode: 'PRIME_UNDERWRITING_PASS', trace: [...] }

    WF->>FSM: Assert Transition: EVALUATING -> APPROVED
    WF->>DB: Transaction: State -> APPROVED, Decision & Trace persisted, Audit Event (Seq 5)

    WF-->>Idemp: Execution Complete
    Idemp->>DB: updateOne({ _id: K, ownerToken }, status: 'COMPLETED', responseBody)
    Idemp-->>Client: HTTP 201 Created (State: APPROVED, trackingNumber, decision, trace)
```

---

## 4. Finite State Machine (FSM)

```mermaid
stateDiagram-v2
    [*] --> RECEIVED: HTTP POST /applications (Valid Schema)
    RECEIVED --> ENRICHING: Stage 'bureau_enrichment' started
    RECEIVED --> FAILED: System failure during intake

    ENRICHING --> EVALUATING: Bureau lookup COMPLETED
    ENRICHING --> FAILED: Bureau 503 retry exhausted / timeout

    EVALUATING --> APPROVED: Rules evaluate to APPROVED
    EVALUATING --> REJECTED: Rules evaluate to REJECTED
    EVALUATING --> MANUAL_REVIEW: Borderline credit score (580 - 719)
    EVALUATING --> FAILED: Rule engine exception

    MANUAL_REVIEW --> APPROVED: POST /review { action: 'APPROVE' }
    MANUAL_REVIEW --> REJECTED: POST /review { action: 'REJECT' }

    FAILED --> ENRICHING: POST /retry (from failed enrichment)
    FAILED --> EVALUATING: POST /retry (from failed rules)

    APPROVED --> [*]
    REJECTED --> [*]
```

---

## 5. Generic AST Rules Engine Semantics

1. **Deterministic Ordering**: Rules specify integer `priority` (1 = highest priority). Equal-priority ties are resolved deterministically by lexicographical ASCII sort on `ruleId`.
2. **Configurable Mandatory Failure**: Mandatory rules (`isMandatory: true`) evaluate first. If a mandatory condition fails, the engine applies that rule's configured `failureOutcome` (e.g. `{ outcome: 'REJECTED', reasonCode: 'SANCTIONS_COMPLIANCE_BLOCK' }`), avoiding hardcoded rejections.
3. **Trace Tree Transparency**: The trace tree documents the disposition of **every rule in the ruleset**:
   - Evaluated before match: `status: 'EVALUATED_UNMET'` with condition tree breakdown.
   - Winning rule: `status: 'MATCHED'` with condition tree breakdown and action metadata.
   - Evaluated after match under `FIRST_MATCH`: `status: 'NOT_EVALUATED'` with `reason: 'Short-circuited by higher-priority match [RULE_ID]'`.
4. **NOT Condition Guard**: Schema strictly enforces that `combinator === 'NOT'` has **exactly 1 child condition**.
5. **ReDoS Elimination**: `MATCHES_REGEX` is deferred from the MVP to eliminate Regular Expression Denial of Service risks without native C++ compilation bindings.

---

## 6. Cryptographic Audit Trail (SHA-256 Hash Chain)

Every audit record in `audit_logs` is cryptographically chained to its predecessor:
- `sequenceNumber`: Monotonically increasing per application (1, 2, 3...)
- `previousHash`: Hash of the previous event (Genesis event uses 64 zeros)
- `canonicalData`: Deterministic JSON serialization according to RFC 8785 (keys sorted alphabetically)
- `eventHash`: `SHA256(previousHash + canonicalData)`

### Trust Boundary
- **Guaranteed**: Detects out-of-order execution, dropped events, payload tampering, and application-level bugs via `GET /api/v1/applications/:id/audit/verify`.
- **Known Limitation**: Because hashes reside in MongoDB, an administrator with direct root database write access could theoretically alter historical records and recompute downstream hashes. Anchoring block hashes to an external WORM ledger or HSM timestamp is deferred to future iterations.

---

## 7. Engineering Trade-offs & Scope Control (<24h Constraint)

| Dimension | MVP Implementation Choice | Production Enterprise Scale | Justification for Hackathon (<24h) |
| :--- | :--- | :--- | :--- |
| **Execution Model** | **Synchronous Request-Driven Pipeline** | Asynchronous Distributed Queue (BullMQ / Kafka) | Synchronous execution provides instant REST feedback without external queue dependencies (Redis). Steps are cleanly decoupled so they can be wrapped in a worker later. |
| **Rules Engine** | **Custom In-Memory AST Interpreter** | External Business Rules Engine (Drools / Goja) | Custom AST interpreter in pure JavaScript yields 100% test coverage, sub-millisecond execution, complete explainability trace trees, and zero external engine dependencies. |
| **Transactions & Testing** | **MongoDB Transactions + MongoMemoryReplSet** | Multi-Region Sharded Replica Sets | `MongoMemoryReplSet` runs a single-node replica set in memory during Jest test runs, enabling 100% native multi-document ACID transactions with zero local installation prerequisites. |
| **External Dependency** | **In-Process Gateway with Fault Injection** | Standalone WireMock Microservice | In-process mock gateway supports deterministic fault injection (503s, timeouts, rate limits) without port collisions or flaky network calls during automated test suites. |

