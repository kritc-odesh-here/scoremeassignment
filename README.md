# DecisionFlow: Configurable Workflow Decision Platform

DecisionFlow is a configurable, resilient workflow decision platform capable of ingesting business requests, evaluating dynamic composite rules, executing multi-stage workflows, maintaining state machines, recording tamper-evident audit trails, and recovering from failures with stage checkpoints and idempotency.

The demonstration use case is a **Retail Loan Underwriting Platform** resolving to `APPROVED`, `REJECTED`, or `MANUAL_REVIEW`. **The core engine contains zero loan-specific code or hardcoding**; all rules, stages, thresholds, and routing policies are defined via versioned configuration schemas.

---

## 🚀 Key Architectural Capabilities

1. **Modular Monolith**: Clean hexagonal separation of transport, idempotency, orchestration, domain, and persistence layers.
2. **Generic AST Rules Engine**: Pure, stateless in-memory interpreter evaluating composite `AND`, `OR`, single-child `NOT`, and threshold operators (`GTE`, `LTE`, `IN`, `CONTAINS`, `EXISTS`, `IS_NULL`). Zero business hardcoding.
3. **Deterministic Rule Semantics**: Integer `priority` ordering, ASCII lexicographical tie-breaking, configurable mandatory rule outcomes, and full trace tree generation with `status: 'NOT_EVALUATED'` for short-circuited rules.
4. **Finite State Machine (FSM)**: Strict lifecycle transitions (`RECEIVED` $\to$ `ENRICHING` $\to$ `EVALUATING` $\to$ `APPROVED` / `REJECTED` / `MANUAL_REVIEW` / `FAILED`) with terminal state guards.
5. **Two-Phase Idempotency with Lease Management**: Atomic `insertOne` idempotency lock, 60s lease expiration, safe reclamation of zombie leases, stale worker overwrite protection, and cached response replay (`X-Cache-Lookup: HIT`).
6. **Fault Tolerance & Stage Checkpoints**: Each workflow stage records a persistent checkpoint (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`). On failure, the `/retry` endpoint resumes from the failed stage without repeating already completed external side-effects.
7. **External Idempotency Store**: The simulated Credit Bureau gateway caches responses by `hash(applicationId + stageId)`. If the application crashes before checkpointing, the retry uses the same token, preventing duplicate charges.
8. **Cryptographic Audit Trail (SHA-256 Hash Chain)**: Every event is canonicalized (RFC 8785) and linked to its predecessor (`previousHash` $\to$ `eventHash`), verifiable via a dedicated REST endpoint.
9. **Configuration Immutability & Atomic Activation**: Published workflows (`isPublished: true`) cannot be modified. MongoDB partial unique indexes enforce strictly one active version per workflow.
10. **Zero-Setup Testing**: Integration and E2E tests run on an in-memory replica set (`MongoMemoryReplSet`), enabling 100% native multi-document ACID transactions without Docker or local MongoDB prerequisites.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js (v18+)
- **Framework**: Express.js
- **Database & ODM**: MongoDB & Mongoose
- **Validation**: Zod
- **Testing**: Jest & Supertest
- **In-Memory Testing Server**: `mongodb-memory-server` (`MongoMemoryReplSet`)

---

## 📦 Quick Start

### 1. Installation
```bash
git clone <repo-url>
cd scoreme
npm install
```

### 2. Run Automated Test Suite
DecisionFlow includes 36 comprehensive tests covering unit logic, state machines, hash-chain integrity, idempotency conflicts, version immutability, and full end-to-end loan lifecycles:

```bash
npm test
```

### 3. Start the Server Locally
Ensure MongoDB is running locally (e.g., `mongodb://localhost:27017/decisionflow`), or set `MONGODB_URI`:

```bash
# Seed the default loan approval workflow
npm run seed

# Start the server on port 3000
npm start
```

---

## 📖 REST API Reference & Examples

### 1. Ingest Application & Execute Decision
`POST /api/v1/applications`
- **Header**: `Idempotency-Key: <unique-uuid>` (Mandatory)

```bash
curl -X POST http://localhost:3000/api/v1/applications \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 11111111-2222-3333-4444-555555555555" \
  -d '{
    "workflowId": "loan_approval",
    "applicant": {
      "firstName": "John",
      "lastName": "Doe",
      "nationalId": "SSN-PRIME-123",
      "email": "john.doe@example.com",
      "annualIncome": 120000,
      "requestedAmount": 25000,
      "loanPurpose": "DEBT_CONSOLIDATION"
    }
  }'
```

**Response (`201 Created` - Prime Auto-Approval)**:
```json
{
  "trackingNumber": "APP-MRE6X0L-8B1C3F",
  "workflowId": "loan_approval",
  "workflowVersion": "1.0.0",
  "currentState": "APPROVED",
  "stateVersion": 5,
  "decision": {
    "outcome": "APPROVED",
    "reasonCode": "PRIME_UNDERWRITING_PASS",
    "summary": "Exceptional credit score (>=720), low debt-to-income (<=35%), and zero bankruptcies.",
    "matchingRuleId": "RULE_PRIME_AUTO_APPROVAL",
    "tags": ["AUTO_APPROVED", "PRIME_TIER"],
    "finalizedAt": "2026-11-13T18:45:00.000Z"
  },
  "stages": {
    "bureau_enrichment": {
      "stageId": "bureau_enrichment",
      "name": "Credit Bureau History Lookup",
      "type": "ENRICHMENT",
      "status": "COMPLETED",
      "attempts": 1
    },
    "rule_evaluation": {
      "stageId": "rule_evaluation",
      "status": "COMPLETED"
    }
  }
}
```

---

### 2. Idempotent Replay
Sending the exact same request with the same `Idempotency-Key`:
```bash
curl -i -X POST http://localhost:3000/api/v1/applications \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 11111111-2222-3333-4444-555555555555" \
  -d '{ ...same payload... }'
```
**Response**:
`HTTP/1.1 201 Created`
`X-Cache-Lookup: HIT`
*(Replays original response without re-executing credit bureau lookups or re-evaluating rules).*

---

### 3. Decision Explainability Report
`GET /api/v1/applications/:trackingNumber/explain`

```bash
curl http://localhost:3000/api/v1/applications/APP-MRE6X0L-8B1C3F/explain
```

**Response**:
```json
{
  "trackingNumber": "APP-MRE6X0L-8B1C3F",
  "workflowId": "loan_approval",
  "workflowVersion": "1.0.0",
  "currentState": "APPROVED",
  "decision": {
    "outcome": "APPROVED",
    "reasonCode": "PRIME_UNDERWRITING_PASS",
    "summary": "Exceptional credit score (>=720), low debt-to-income (<=35%), and zero bankruptcies."
  },
  "evaluationSummary": {
    "matchingRuleId": "RULE_PRIME_AUTO_APPROVAL",
    "reasonCode": "PRIME_UNDERWRITING_PASS"
  },
  "ruleTraces": [
    {
      "ruleId": "SANCTIONS_CLEARANCE",
      "name": "OFAC Sanctions & Watchlist Check",
      "priority": 1,
      "isMandatory": true,
      "status": "MANDATORY_PASSED",
      "conditionTrace": {
        "field": "isSanctioned",
        "operator": "NOT_EQUALS",
        "expected": true,
        "actual": false,
        "passed": true
      }
    },
    {
      "ruleId": "RULE_PRIME_AUTO_APPROVAL",
      "name": "Prime Borrower Automated Approval",
      "priority": 10,
      "isMandatory": false,
      "status": "MATCHED",
      "conditionTrace": {
        "combinator": "AND",
        "passed": true,
        "children": [
          { "field": "credit.creditScore", "operator": "GREATER_THAN_OR_EQUAL", "expected": 720, "actual": 740, "passed": true },
          { "field": "credit.debtToIncome", "operator": "LESS_THAN_OR_EQUAL", "expected": 0.35, "actual": 0.32, "passed": true },
          { "field": "credit.bankruptcies", "operator": "EQUALS", "expected": 0, "actual": 0, "passed": true }
        ]
      }
    },
    {
      "ruleId": "RULE_HIGH_RISK_REJECTION",
      "name": "High Risk Automated Rejection",
      "priority": 20,
      "status": "NOT_EVALUATED",
      "reason": "Short-circuited by higher-priority match [RULE_PRIME_AUTO_APPROVAL]"
    },
    {
      "ruleId": "RULE_NEAR_PRIME_REVIEW",
      "name": "Near Prime Underwriter Review",
      "priority": 30,
      "status": "NOT_EVALUATED",
      "reason": "Short-circuited by higher-priority match [RULE_PRIME_AUTO_APPROVAL]"
    }
  ]
}
```

---

### 4. Cryptographic Audit Trail Verification
`GET /api/v1/applications/:trackingNumber/audit/verify`

```bash
curl http://localhost:3000/api/v1/applications/APP-MRE6X0L-8B1C3F/audit/verify
```

**Response (`200 OK`)**:
```json
{
  "valid": true,
  "trackingNumber": "APP-MRE6X0L-8B1C3F",
  "totalEvents": 5,
  "genesisHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "latestHash": "d8a1c97ef...",
  "verifiedAt": "2026-11-13T18:45:05.120Z"
}
```

---

### 5. Manual Review Resolution
When an applicant is in `MANUAL_REVIEW`, an underwriter resolves it via:
`POST /api/v1/applications/:trackingNumber/review`

```bash
curl -X POST http://localhost:3000/api/v1/applications/APP-MRE6X0L-8B1C3F/review \
  -H "Content-Type: application/json" \
  -d '{
    "action": "APPROVE",
    "reviewerId": "UW-OFFICER-42",
    "notes": "Verified secondary assets and confirmed steady 5-year employment history."
  }'
```

---

### 6. Fault Simulation & Recovery Resumption
To simulate external dependency outages (such as Credit Bureau 503s), pass the `x-simulate-fault` header:

```bash
curl -X POST http://localhost:3000/api/v1/applications \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: fault-key-999" \
  -H 'x-simulate-fault: {"failureMode": "ALWAYS_FAIL"}' \
  -d '{ ...applicant payload... }'
```

The application transitions to `FAILED` and records `stages.bureau_enrichment.status = "FAILED"`.

**Resume execution from failed stage**:
`POST /api/v1/applications/:trackingNumber/retry`
```bash
curl -X POST http://localhost:3000/api/v1/applications/APP-FAULT-999/retry \
  -H "Content-Type: application/json" \
  -d '{"faultConfig": {"failureMode": "NONE"}}'
```
*(The workflow engine resumes directly at the failed bureau stage, fetches the credit report, evaluates rules, and finishes in `APPROVED` without repeating intake steps).*

---

### 7. Workflow Versioning & Dynamic Rule Testing
`POST /api/v1/workflows/:workflowId/test-rules`
Evaluate arbitrary JSON payloads against any published workflow version without database writes:

```bash
curl -X POST http://localhost:3000/api/v1/workflows/loan_approval/test-rules \
  -H "Content-Type: application/json" \
  -d '{
    "contextData": {
      "isSanctioned": false,
      "credit": {
        "creditScore": 750,
        "debtToIncome": 0.25,
        "bankruptcies": 0
      }
    }
  }'
```

---

## 🧪 Test Suite Coverage

```
Test Suites: 6 passed, 6 total
Tests:       36 passed, 36 total

✓ test/unit/rules-engine.test.js        (AST evaluation, short-circuit, priority, ties, safe nulls)
✓ test/unit/state-machine.test.js       (Legal vs illegal transitions, terminal states)
✓ test/unit/audit-hash-chain.test.js    (RFC 8785 canonicalization, hash calculation, tampering detection)
✓ test/integration/idempotency.test.js  (Cache replay, 422 payload mismatch, 409 concurrency lock)
✓ test/integration/workflow-versioning.test.js (Immutability, partial unique active constraint, atomic activation)
✓ test/e2e/loan-application.test.js    (Technical validation 400, Prime APPROVE, Subprime REJECT, Near Prime REVIEW, 503 retry recovery)
```

---

## 🏛️ Architecture & Trade-Offs

For a detailed analysis of component boundaries, failure scenarios, concurrency patterns, and trade-off justifications, refer to [ARCHITECTURE.md](ARCHITECTURE.md).




