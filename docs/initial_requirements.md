Below is a complete, implementation-ready **Product Requirements Document (PRD) & Technical Specification** formatted specifically for an AI Coding Agent (e.g., Claude Code, Cursor, or Copilot Workspace). You can feed this document directly to your code agent to generate, wire, and verify the entire PoC repository in one go.

---

# PRD: Headless Underwriting Engine PoC (Legacy Java Migration to GoRules TS + AI Copilot)

## 1. Executive Summary & Objective

Build a working monorepo Proof of Concept (PoC) demonstrating the modernization of an insurance underwriting system:

1. **Legacy Baseline:** A Spring Boot (Java 17) service containing hardcoded `if-else` underwriting logic (`CLEAN`, `DECLINE`, `UNCLEAN`).
2. **Migration & Parity Tooling:** Automated CLI tools to convert legacy Java logic into GoRules JDM (JSON Decision Model) format and run a **Parity Check (Shadow Mode)** against test cases to prove 100% behavioral equivalence.
3. **Headless GoRules Engine (TypeScript):** A Node.js/TypeScript backend powered by `@gorules/zen-engine` that executes configurable JDM JSON rules and exposes a seamless **Phase 2 AI Copilot extension** for `UNCLEAN` (Referral) cases using execution traces.
4. **Admin UI & Rule Onboarding:** A React + TypeScript web application embedding `@gorules/jdm-editor` with a live simulator, trace highlighter, and 1-click onboarding for new underwriting rules.

---

## 2. Monorepo Directory Structure

The coding agent MUST scaffold the repository using the following layout:

```text
uw-gorules-poc/
├── package.json                     # Root workspace scripts (concurrently run all)
├── README.md                        # Quickstart & Demo walkthrough
├── shared/
│   ├── test-cases.json              # 10 canonical applicant payloads (Clean, Decline, Unclean)
│   └── rules/
│       ├── v1-migrated-rules.json   # JDM JSON migrated from Legacy Java
│       └── v2-onboarded-rules.json  # JDM JSON showcasing newly onboarded rules (e.g., Occupation/Smoker)
├── legacy-java-service/             # Requirement 1: Legacy Hardcoded Java Service
│   ├── pom.xml                      # Java 17, Spring Boot 3.x Web
│   └── src/main/java/com/poc/uw/
│       ├── LegacyUwApplication.java
│       ├── model/
│       │   ├── ApplicantRequest.java
│       │   └── UnderwritingResponse.java
│       └── service/
│           └── HardcodedUnderwritingService.java
├── gorules-ts-engine/               # Requirement 2, 3, 6: Headless TS Engine + Migration Tools + AI Hook
│   ├── package.json                 # @gorules/zen-engine, fastify (or express), zod, tsx
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts                # Headless REST API (:3001)
│       ├── engine/
│       │   └── uwEngine.ts          # ZenEngine wrapper with trace extraction
│       ├── ai/
│       │   └── uncleanCaseCopilot.ts # Requirement 6: LLM extension for UNCLEAN cases
│       └── tools/
│           ├── astToJdmMigrator.ts  # Requirement 3a: Helper tool to parse/convert Java rules to JDM
│           └── parityVerifier.ts    # Requirement 3b: Shadow-mode diff tool (Java :8080 vs TS :3001)
└── gorules-admin-ui/                # Requirement 4 & 5: React Admin UI with @gorules/jdm-editor
    ├── package.json                 # react, vite, @gorules/jdm-editor
    ├── index.html
    └── src/
        ├── App.tsx                  # Rule selector, Simulator panel, AI Copilot Drawer, Onboard Rule Modal
        └── main.tsx

```

---

## 3. Canonical Data Contracts (Shared Across Java & TypeScript)

### 3.1 Input Payload (`ApplicantRequest`)

```json
{
  "applicantId": "APP-1002",
  "age": 45,
  "bmi": 29.5,
  "smoker": true,
  "systolicBp": 145,
  "sumAssured": 1200000,
  "medicalConditions": ["FATTY_LIVER", "HYPERTENSION_STAGE_1"],
  "occupationClass": 2
}

```

### 3.2 Output Payload (`UnderwritingResponse`)

```json
{
  "decision": "UNCLEAN",
  "basePremiumLoadingPct": 25,
  "triggeredRules": [
    {
      "ruleId": "RULE_BMI_COMORBIDITY",
      "category": "MEDICAL",
      "reason": "BMI >= 28 combined with Fatty Liver requires manual medical review"
    },
    {
      "ruleId": "RULE_HIGH_SUM_ASSURED",
      "category": "FINANCIAL",
      "reason": "Sum assured > 1,000,000 with elevated BP requires senior underwriter sign-off"
    }
  ],
  "executionTimeMs": 0.42,
  "trace": {},
  "aiCopilotBrief": {
    "riskSummary": "...",
    "recommendedAction": "...",
    "requiredEvidence": ["Liver ultrasound within 6 months", "HbA1c lab report"],
    "manualGuidelineRef": "Reinsurance Medical Manual Sec 4.2 - Metabolic Syndrome"
  }
}

```

*Note: `decision` enum values MUST be strictly `"CLEAN"`, `"UNCLEAN"`, or `"DECLINE"`. Aggregation precedence: if any rule outputs `DECLINE` $\rightarrow$ final is `DECLINE`; else if any rule outputs `UNCLEAN` $\rightarrow$ final is `UNCLEAN`; else `CLEAN`.*

---

## 4. Detailed Component Specifications

### Component 1: Legacy Hardcoded Java Service (`legacy-java-service`)

* **Port:** `8080`
* **Endpoint:** `POST /api/legacy/underwrite`
* **Hardcoded Business Logic in `HardcodedUnderwritingService.java`:**
Implement explicit, rigid `if-else` blocks representing typical legacy technical debt:
1. **Knock-out (DECLINE) Rules:**
* `age < 18 || age > 65` $\rightarrow$ `DECLINE` (`RULE_AGE_KNOCKOUT`: "Applicant age outside insurable range 18-65")
* `bmi >= 38.0` $\rightarrow$ `DECLINE` (`RULE_EXTREME_BMI`: "Severe obesity BMI >= 38")
* `systolicBp >= 180` $\rightarrow$ `DECLINE` (`RULE_HYPERTENSIVE_CRISIS`: "Systolic BP >= 180 uninsurable")


2. **Referral (UNCLEAN) Rules (Collect All):**
* `bmi >= 28.0 && medicalConditions.contains("FATTY_LIVER")` $\rightarrow$ `UNCLEAN`, loading `+25%` (`RULE_BMI_COMORBIDITY`: "BMI >= 28 combined with Fatty Liver requires medical review")
* `systolicBp >= 140 && systolicBp < 180 && smoker == true` $\rightarrow$ `UNCLEAN`, loading `+50%` (`RULE_BP_SMOKER_SYNERGY`: "Elevated BP with smoking history requires cardiovascular assessment")
* `sumAssured > 1000000 && (bmi >= 28.0 || systolicBp >= 140)` $\rightarrow$ `UNCLEAN`, loading `+0%` (`RULE_HIGH_SUM_ASSURED`: "High sum assured > 1M with sub-standard vitals requires senior referral")


3. **Auto-Accept (CLEAN) Rules:**
* `bmi >= 25.0 && bmi < 28.0 && !smoker` $\rightarrow$ `CLEAN`, loading `+10%` (`RULE_MILD_OVERWEIGHT_CLEAN`: "Mild overweight standard auto-loading")
* Default when no Decline/Unclean triggered $\rightarrow$ `CLEAN`, loading `0%` (`RULE_STANDARD_CLEAN`: "Standard clean acceptance")





---

### Component 2: Headless GoRules Engine in TypeScript (`gorules-ts-engine`)

* **Port:** `3001`
* **Dependencies:** `@gorules/zen-engine`, `fastify` (with `@fastify/cors`), `zod`.
* **JDM Graph Architecture (`shared/rules/v1-migrated-rules.json`):**
Construct a valid GoRules JDM JSON graph containing:
1. `inputNode` ("Request")
2. `decisionTableNode` ("Underwriting Rules Table"):
* **Hit Policy:** `"collect"` (Crucial for underwriting so *all* Unclean reasons are captured in a single pass, not just the first match).
* **Inputs:** `age`, `bmi`, `smoker`, `systolicBp`, `sumAssured`, `medicalConditions`.
* **Outputs:** `ruleDecision` (`"DECLINE" | "UNCLEAN" | "CLEAN"`), `ruleId`, `category`, `reason`, `loadingPct`.


3. `functionNode` ("Aggregate Decision"):
* Standard GoRules JS Function node that takes the collected array of matched rows from the Decision Table, resolves the highest severity (`DECLINE` > `UNCLEAN` > `CLEAN`), sums up `loadingPct`, and filters `triggeredRules`.


4. `outputNode` ("Response")


* **API Endpoints:**
* `GET /api/rules` — List available rule versions (`v1-migrated-rules.json`, `v2-onboarded-rules.json`) and active rule ID.
* `GET /api/rules/:id` — Fetch raw JDM JSON for the Admin UI.
* `PUT /api/rules/:id` — Save updated JDM JSON from the Admin UI to disk/memory and hot-reload `ZenEngine`.
* `POST /api/rules/onboard` — Create a new rule version or append a new rule row via API.
* `POST /api/underwrite` — Headless evaluation endpoint (`?aiAssist=true|false`). Runs `decision.evaluate(payload, { trace: true })`.



---

### Component 3: Migration & Parity Verification Tools (`gorules-ts-engine/src/tools/`)

To satisfy **Requirement 3 (Showcasing Migration with Tooling)**, implement two executable CLI scripts (`npm run migrate` and `npm run verify-parity`):

1. **`astToJdmMigrator.ts` (`npm run migrate`):**
* Reads `HardcodedUnderwritingService.java` source code.
* Includes a Dual-Mode Extractor:
* **Deterministic Regex/AST Parser (Default, zero API key required):** Extracts `if (...)` conditions and rule metadata comments/strings from the Java file and compiles them into a valid GoRules `decisionTableNode` inside `shared/rules/v1-migrated-rules.json`.
* **LLM-Assisted Migrator Prompt Generator:** Outputs a structured prompt + JSON Schema payload showing how an LLM converts legacy Java classes into GoRules JDM JSON automatically.




2. **`parityVerifier.ts` (`npm run verify-parity`):**
* Loads all 10 test applicants from `shared/test-cases.json`.
* Sends each applicant concurrently to **Legacy Java (`http://localhost:8080/api/legacy/underwrite`)** and **GoRules TS (`http://localhost:3001/api/underwrite`)**.
* Prints a formatted terminal comparison table verifying `decision`, `basePremiumLoadingPct`, and `triggeredRules` IDs match **100%**. Fails with exit code 1 if any discrepancy exists.



---

### Component 4: Admin UI & Rule Onboarding (`gorules-admin-ui`)

* **Port:** `5173` (Vite + React 18 + TypeScript)
* **Dependencies:** `@gorules/jdm-editor`, `lucide-react` (or minimal CSS styling).
* **Core Features (Requirement 4 & 5):**
1. **Embedded JDM Visual Editor:**
* Wraps `<JdmConfigProvider>` and `<DecisionGraph onChange="{setJdm}" simulate="{traceResult}" value="{jdm}"/>`.
* Allows business users to visually inspect the graph, click into the "Underwriting Rules Table" node, and edit cells (e.g., changing BMI thresholds or sum assured limits) just like Excel.


2. **1-Click Rule Onboarding Showcase (Requirement 5):**
* Include a prominent toolbar button: **`+ Onboard New Rule (Occupation Class 4 & Smoker Surcharge)`** (or toggle between `v1-migrated` and `v2-onboarded`).
* Clicking this dynamically injects two new configurable business rules into the Decision Table without touching any backend code:
* `occupationClass == 4 && sumAssured > 500000` $\rightarrow$ `UNCLEAN` (`RULE_HIGH_RISK_OCCUPATION`: "Class 4 hazardous occupation with Sum Assured > 500k requires occupational questionnaire")
* `age > 55 && len(medicalConditions) >= 2` $\rightarrow$ `UNCLEAN` (`RULE_SENIOR_MULTI_MORBIDITY`: "Senior applicant with multiple conditions requires attending physician statement (APS)")


* User clicks **"Save & Hot-Deploy"** to persist the updated JDM JSON to the TS Engine immediately.


3. **Live Simulator & Trace Highlighter:**
* Right-hand collapsible drawer containing a dropdown of preset applicants from `test-cases.json` (e.g., *"Case 1: Healthy Clean"*, *"Case 4: Unclean Metabolic Comorbidity"*, *"Case 9: Class 4 Occupation (Tests Onboarded Rule)"*).
* Clicking **"Run Simulation"** calls `POST /api/underwrite?aiAssist=true`, passes the returned `trace` object directly into `<DecisionGraph simulate="{trace}"/>` (highlighting matched nodes and table rows in green), and renders the **AI Copilot Assessment Card** below when `decision === "UNCLEAN"`.





---

### Component 5: Future-Proof AI Extension for Unclean Cases (`uncleanCaseCopilot.ts`)

To satisfy **Requirement 6**, implement a clean, pluggable module `src/ai/uncleanCaseCopilot.ts` inside `gorules-ts-engine`:

* **Trigger Condition:** Invoked **ONLY** when `ZenEngine` evaluates a case as `decision === "UNCLEAN"`. (`CLEAN` and `DECLINE` cases bypass the LLM completely for zero latency and 100% deterministic compliance).
* **Trace Context Extraction:**
Write a helper `extractMatchedNodesFromTrace(trace)` that parses the raw GoRules `trace` JSON object to extract the exact matched rows, input field snapshots, and rule expressions that caused the `UNCLEAN` referral.
* **Provider Abstraction (Live LLM + Deterministic Fallback):**
* **Interface:** `UnderwritingAiCopilot.analyzeUncleanCase(applicant, triggeredRules, traceSnapshot): Promise<AiCopilotBrief>`
* **Live Mode:** If `process.env.OPENAI_API_KEY` or `process.env.ANTHROPIC_API_KEY` is present, makes a real structured-output LLM call using the extracted GoRules trace and a mini embedded medical underwriting manual snippet.
* **Mock/Demo Mode (Default when no API key is set):** Uses a deterministic template generator that inspects the `traceSnapshot` and `triggeredRules` to return a realistic, context-aware `AiCopilotBrief` (synthesizing how the combined rules—e.g., `RULE_BMI_COMORBIDITY` + `RULE_HIGH_SUM_ASSURED`—interact, recommending specific medical labs, and citing manual sections).



---

## 5. Implementation Reference Snippets for the Coding Agent

### 5.1 GoRules JDM JSON Schema Template (`shared/rules/v1-migrated-rules.json`)

Ensure the generated JDM JSON adheres strictly to `@gorules/zen-engine` v0.20+ schema:

```json
{
  "contentType": "application/vnd.gorules.decision",
  "nodes": [
    {
      "id": "node-input",
      "name": "Applicant Input",
      "type": "inputNode",
      "position": { "x": 60, "y": 200 }
    },
    {
      "id": "node-uw-table",
      "name": "Underwriting Decision Table",
      "type": "decisionTableNode",
      "position": { "x": 320, "y": 200 },
      "content": {
        "hitPolicy": "collect",
        "inputs": [
          { "id": "in-age", "name": "Age", "field": "age" },
          { "id": "in-bmi", "name": "BMI", "field": "bmi" },
          { "id": "in-bp", "name": "Systolic BP", "field": "systolicBp" },
          { "id": "in-smoker", "name": "Smoker", "field": "smoker" },
          { "id": "in-sa", "name": "Sum Assured", "field": "sumAssured" },
          { "id": "in-med", "name": "Medical Conditions", "field": "medicalConditions" },
          { "id": "in-occ", "name": "Occupation Class", "field": "occupationClass" }
        ],
        "outputs": [
          { "id": "out-dec", "name": "Decision", "field": "ruleDecision" },
          { "id": "out-id", "name": "Rule ID", "field": "ruleId" },
          { "id": "out-cat", "name": "Category", "field": "category" },
          { "id": "out-load", "name": "Loading %", "field": "loadingPct" },
          { "id": "out-reason", "name": "Reason", "field": "reason" }
        ],
        "rules": [
          {
            "_id": "r1",
            "in-age": "< 18 or > 65",
            "in-bmi": "",
            "in-bp": "",
            "in-smoker": "",
            "in-sa": "",
            "in-med": "",
            "in-occ": "",
            "out-dec": "\"DECLINE\"",
            "out-id": "\"RULE_AGE_KNOCKOUT\"",
            "out-cat": "\"ELIGIBILITY\"",
            "out-load": "0",
            "out-reason": "\"Applicant age outside insurable range 18-65\""
          },
          {
            "_id": "r2",
            "in-age": "",
            "in-bmi": ">= 38",
            "in-bp": "",
            "in-smoker": "",
            "in-sa": "",
            "in-med": "",
            "in-occ": "",
            "out-dec": "\"DECLINE\"",
            "out-id": "\"RULE_EXTREME_BMI\"",
            "out-cat": "\"MEDICAL\"",
            "out-load": "0",
            "out-reason": "\"Severe obesity BMI >= 38\""
          },
          {
            "_id": "r3",
            "in-age": "",
            "in-bmi": "",
            "in-bp": ">= 180",
            "in-smoker": "",
            "in-sa": "",
            "in-med": "",
            "in-occ": "",
            "out-dec": "\"DECLINE\"",
            "out-id": "\"RULE_HYPERTENSIVE_CRISIS\"",
            "out-cat": "\"MEDICAL\"",
            "out-load": "0",
            "out-reason": "\"Systolic BP >= 180 uninsurable\""
          },
          {
            "_id": "r4",
            "in-age": "",
            "in-bmi": ">= 28",
            "in-bp": "",
            "in-smoker": "",
            "in-sa": "",
            "in-med": "contains($, \"FATTY_LIVER\")",
            "in-occ": "",
            "out-dec": "\"UNCLEAN\"",
            "out-id": "\"RULE_BMI_COMORBIDITY\"",
            "out-cat": "\"MEDICAL\"",
            "out-load": "25",
            "out-reason": "\"BMI >= 28 combined with Fatty Liver requires medical review\""
          },
          {
            "_id": "r5",
            "in-age": "",
            "in-bmi": "",
            "in-bp": "[140..179]",
            "in-smoker": "true",
            "in-sa": "",
            "in-med": "",
            "in-occ": "",
            "out-dec": "\"UNCLEAN\"",
            "out-id": "\"RULE_BP_SMOKER_SYNERGY\"",
            "out-cat": "\"MEDICAL\"",
            "out-load": "50",
            "out-reason": "\"Elevated BP with smoking history requires cardiovascular assessment\""
          },
          {
            "_id": "r6",
            "in-age": "",
            "in-bmi": ">= 28",
            "in-bp": "",
            "in-smoker": "",
            "in-sa": "> 1000000",
            "in-med": "",
            "in-occ": "",
            "out-dec": "\"UNCLEAN\"",
            "out-id": "\"RULE_HIGH_SUM_ASSURED\"",
            "out-cat": "\"FINANCIAL\"",
            "out-load": "0",
            "out-reason": "\"High sum assured > 1M with sub-standard vitals requires senior referral\""
          },
          {
            "_id": "r7",
            "in-age": "",
            "in-bmi": "",
            "in-bp": ">= 140",
            "in-smoker": "",
            "in-sa": "> 1000000",
            "in-med": "",
            "in-occ": "",
            "out-dec": "\"UNCLEAN\"",
            "out-id": "\"RULE_HIGH_SUM_ASSURED\"",
            "out-cat": "\"FINANCIAL\"",
            "out-load": "0",
            "out-reason": "\"High sum assured > 1M with sub-standard vitals requires senior referral\""
          },
          {
            "_id": "r8",
            "in-age": "",
            "in-bmi": "[25..28)",
            "in-bp": "",
            "in-smoker": "false",
            "in-sa": "",
            "in-med": "",
            "in-occ": "",
            "out-dec": "\"CLEAN\"",
            "out-id": "\"RULE_MILD_OVERWEIGHT_CLEAN\"",
            "out-cat": "\"STANDARD\"",
            "out-load": "10",
            "out-reason": "\"Mild overweight standard auto-loading\""
          }
        ]
      }
    },
    {
      "id": "node-aggregator",
      "name": "Decision Aggregator",
      "type": "functionNode",
      "position": { "x": 620, "y": 200 },
      "content": "export const handler = async (input) => {\n  const matches = input.matches || [];\n  const uniqueRules = new Map();\n  for (const m of matches) {\n    if (!uniqueRules.has(m.ruleId)) uniqueRules.set(m.ruleId, m);\n  }\n  const rules = Array.from(uniqueRules.values());\n  const hasDecline = rules.some(r => r.ruleDecision === 'DECLINE');\n  const hasUnclean = rules.some(r => r.ruleDecision === 'UNCLEAN');\n  let decision = 'CLEAN';\n  if (hasDecline) decision = 'DECLINE';\n  else if (hasUnclean) decision = 'UNCLEAN';\n  const basePremiumLoadingPct = decision === 'DECLINE' ? 0 : rules.reduce((acc, r) => acc + (r.loadingPct || 0), 0);\n  const triggeredRules = rules.length > 0 ? rules.map(r => ({\n    ruleId: r.ruleId,\n    category: r.category,\n    reason: r.reason\n  })) : [{ ruleId: 'RULE_STANDARD_CLEAN', category: 'STANDARD', reason: 'Standard clean acceptance' }];\n  return { decision, basePremiumLoadingPct, triggeredRules };\n};"
    },
    {
      "id": "node-output",
      "name": "Final Response",
      "type": "outputNode",
      "position": { "x": 900, "y": 200 }
    }
  ],
  "edges": [
    { "id": "e1", "sourceId": "node-input", "targetId": "node-uw-table" },
    { "id": "e2", "sourceId": "node-uw-table", "targetId": "node-aggregator" },
    { "id": "e3", "sourceId": "node-aggregator", "targetId": "node-output" }
  ]
}

```

*(Note to Agent: Verify whether the installed `@gorules/zen-engine` version outputs decision table results directly on the root object or under a field key, and adjust `node-aggregator` input binding accordingly during unit testing).*

---

## 6. Acceptance Criteria & Verification Steps for the Code Agent

Before completing the task, the Code Agent MUST execute the following verification checklist:

1. **Unit & Engine Self-Test (`gorules-ts-engine`):**
* Run a test script verifying `ZenEngine` loads `v1-migrated-rules.json` without schema errors and evaluates all 10 cases in `shared/test-cases.json` in `< 5ms` per case.


2. **Migration & Parity Verification:**
* Start `legacy-java-service` on `:8080` and `gorules-ts-engine` on `:3001` (or allow `parityVerifier.ts` to run against both).
* Execute `npm run verify-parity` and confirm **10/10 test cases pass with 100% parity** on `decision`, `basePremiumLoadingPct`, and `triggeredRules`.


3. **Rule Onboarding Verification:**
* Trigger the onboarding flow (switching to or injecting the `Occupation Class == 4` rule).
* Evaluate a test applicant with `occupationClass: 4, sumAssured: 600000` and verify the engine transitions that applicant from `CLEAN` to `UNCLEAN` with `RULE_HIGH_RISK_OCCUPATION`.


4. **AI Assist Extension Verification:**
* Call `POST /api/underwrite?aiAssist=true` with an `UNCLEAN` applicant payload.
* Confirm the response includes both the GoRules `trace` object and a populated `aiCopilotBrief` referencing the specific triggered rules from the trace.


5. **Admin UI Build Check:**
* Run `npm run build` in `gorules-admin-ui` to ensure zero TypeScript compilation or Vite bundling errors with `@gorules/jdm-editor`.