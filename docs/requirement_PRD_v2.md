Here is the updated, **implementation-ready Product Requirements Document (PRD) and complete GoRules JDM JSON specification** for your AI Coding Agent.

It explicitly models every stage of the **Underwriter** lane from your diagram—including **Formula Calculations (BMI & Financial Ratios)**, **Step 1.1 Request For Additional Information**, **Step 2 Risk Assessment (Debit/EM scoring & Comorbidities)**, **Step 3 Risk Classification (Actuarial Table Bucketing)**, and **Step 4 Underwriting Decision (the 5 terminal outcomes)**—plus **Excel (`.xlsx`) upload/import** in the Admin UI and **Phase 2 AI Copilot** assistance for complex/unclean cases.

---

# PRD v2.0: Multi-Stage Headless Underwriting Engine PoC (GoRules TS + Legacy Java Migration + AI Copilot)

## 1. System Architecture & Process Pipeline

The underwriting engine implements the end-to-end **Underwriter** workflow defined in the process diagram:

```text
[1. Proposal Form Received by Underwriter]
                    │
                    ▼
     [0. Derived Metrics & Formulas] 
     (GoRules Expression Node: Calculate BMI & Sum Assured-to-Income Multiple)
                    │
                    ▼
     <Sufficient Information Provided to Assess Risk?> (Gateway)
        ├── NO ──► [1.1. Request For Additional Information] ──► (AI Copilot drafts Evidence Request)
        │
        └── YES
             │
             ▼
     [2. Risk Assessment] (GoRules Collect Decision Table)
     (Evaluate Medical, Financial, Occupational risks; assign EM Debits, Exclusions, Postpone/Decline flags)
             │
             ▼
     [3. Risk Classification] (GoRules First-Hit Decision Table)
     (Bucket total EM Debits & flags into Standard, Sub-standard Table A/B/D, Restricted, Deferred, Uninsurable)
             │
             ▼
     [4. Underwriting Decision] (5 Terminal Dispositions + Unclean AI Trigger)
        ├──► Accept As Per Application
        ├──► Accept With Loading (+25% / +50% / +100%)
        ├──► Accept With Exclusions (e.g., Specific Organ Exclusion)
        ├──► Postpone (Temporary deferral)
        └──► Decline (Hard knock-out or EM >= 200)

```

---

## 2. Monorepo Directory Structure

The coding agent MUST scaffold the repository using this exact structure:

```text
uw-gorules-poc/
├── package.json                     # Root scripts: dev, migrate, verify-parity, test
├── README.md                        # Walkthrough of the 4-stage underwriting pipeline
├── shared/
│   ├── test-cases.json              # 12 canonical applicants covering all 5 decisions + Step 1.1
│   ├── sample-rules-upload.xlsx     # Sample Excel Decision Table for testing UI Excel Import
│   └── rules/
│       ├── v1-migrated-rules.json   # Complete 4-stage JDM Graph migrated from Legacy Java
│       └── v2-onboarded-rules.json  # JDM Graph with newly onboarded Occupation Class 4 & Avocation rules
├── legacy-java-service/             # Requirement 1: Legacy Hardcoded Java Service (:8080)
│   ├── pom.xml                      # Java 17, Spring Boot 3.2 Web
│   └── src/main/java/com/poc/uw/
│       ├── LegacyUwApplication.java
│       ├── model/
│       │   ├── ApplicantRequest.java
│       │   └── UnderwritingResponse.java
│       └── service/
│           └── HardcodedUnderwritingService.java
├── gorules-ts-engine/               # Requirement 2, 3, 6: Headless TS Engine (:3001)
│   ├── package.json                 # @gorules/zen-engine, fastify, xlsx, zod, tsx
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts                # Headless REST API + Excel-to-JDM Upload Endpoint
│       ├── engine/
│       │   └── uwEngine.ts          # ZenEngine runner with trace & stage extraction
│       ├── ai/
│       │   └── uncleanCaseCopilot.ts # Requirement 6: LLM extension for Unclean & Info Request cases
│       └── tools/
│           ├── astToJdmMigrator.ts  # Requirement 3a: Converts Java rules into 4-stage JDM JSON
│           └── parityVerifier.ts    # Requirement 3b: Verifies 100% parity (Java :8080 vs TS :3001)
└── gorules-admin-ui/                # Requirement 4 & 5: React Admin UI (:5173)
    ├── package.json                 # react, vite, @gorules/jdm-editor, xlsx
    └── src/
        ├── App.tsx                  # JDM Graph Editor, Excel Upload Button, 4-Stage Trace Inspector
        └── main.tsx

```

---

## 3. Canonical Data Contracts

### 3.1 Input Payload (`ApplicantRequest`)

Includes raw biometric and financial inputs so the engine's **Formula / Expression Node** computes derived ratios (`bmi` and `incomeMultiple`), alongside `submittedDocuments` to evaluate the **"Sufficient Information Provided to Assess Risk"** gateway:

```json
{
  "applicantId": "APP-2004",
  "age": 46,
  "heightCm": 172,
  "weightKg": 88,
  "smoker": true,
  "systolicBp": 148,
  "annualIncome": 80000,
  "sumAssured": 1200000,
  "occupationClass": 2,
  "recentSurgeryMonthsAgo": 0,
  "medicalConditions": ["FATTY_LIVER"],
  "submittedDocuments": ["PROPOSAL_FORM", "BLOOD_PROFILE"]
}

```

### 3.2 Output Payload (`UnderwritingResponse`)

Explicitly exposes the output of each stage in the diagram:

```json
{
  "applicantId": "APP-2004",
  "derivedMetrics": {
    "bmi": 29.7,
    "incomeMultiple": 15.0
  },
  "step1SufficientInfo": {
    "isSufficient": true,
    "missingDocuments": []
  },
  "step2RiskAssessment": {
    "totalEmDebits": 75,
    "exclusionCodes": [],
    "hasDeclineTrigger": false,
    "hasPostponeTrigger": false,
    "hasComorbidityUncleanTrigger": true,
    "matchedAssessmentRules": [
      { "ruleId": "RA_OBESITY_CLASS_1", "debits": 40, "reason": "Obesity (BMI 28.0 - 37.9)" },
      { "ruleId": "RA_HYPERTENSION_S1", "debits": 35, "reason": "Stage 1 Hypertension (Systolic 140-159)" },
      { "ruleId": "RA_METABOLIC_COMORBIDITY", "debits": 0, "reason": "BMI >= 28 combined with Fatty Liver requires manual medical review" }
    ]
  },
  "step3RiskClassification": {
    "riskClass": "SUBSTANDARD_TABLE_B",
    "actuarialTableRating": "Table B (+50% Extra Mortality)",
    "loadingPct": 50
  },
  "step4UnderwritingDecision": {
    "finalDecision": "ACCEPT_WITH_LOADING",
    "isUncleanReferral": true,
    "loadingPct": 50,
    "exclusions": [],
    "requestedAdditionalInfo": []
  },
  "executionTimeMs": 0.48,
  "trace": {},
  "aiCopilotBrief": {
    "caseType": "UNCLEAN_RISK_ASSESSMENT",
    "riskSummary": "Applicant classified into Sub-standard Table B (+50% EM) due to overlapping Obesity (BMI 29.7, +40 debits), Stage 1 Hypertension (148 mmHg, +35 debits), and Fatty Liver comorbidity.",
    "recommendedDisposition": "Confirm ACCEPT_WITH_LOADING (+50%) or request recent Liver Ultrasound & HbA1c to rule out steatohepatitis.",
    "manualGuidelineRef": "Swiss Re / Munich Re Life Manual Sec 4.2: Metabolic Syndrome & Hepatic Steatosis"
  }
}

```

* **`finalDecision` Enum Values:**
* `REQUEST_ADDITIONAL_INFO` (Maps to **1.1. Request For Additional Information** when gateway is `NO`)


* `ACCEPT_AS_PER_APPLICATION` (Maps to **Accept As Per Application**)


* `ACCEPT_WITH_LOADING` (Maps to **Accept With Loading**)


* `ACCEPT_WITH_EXCLUSIONS` (Maps to **Accept With Exclusions**)


* `POSTPONE` (Maps to **Postpone**)


* `DECLINE` (Maps to **Decline**)





---

## 4. Detailed Stage Logic (To Implement Identically in Legacy Java & GoRules JDM)

### Stage 0: Formula / Derived Metrics (`Expression Node`)

* `bmi = round(weightKg / pow(heightCm / 100, 2), 1)`
* `incomeMultiple = round(sumAssured / annualIncome, 1)`

### Stage 1: Information Completeness Check (`Sufficient Information Provided?` $\rightarrow$ `1.1 Request Additional Info`)

* **Rule `INFO_FIN_01`:** `sumAssured > 1500000` AND `not contains(submittedDocuments, "FINANCIAL_QUESTIONNAIRE")` $\rightarrow$ Missing `"FINANCIAL_QUESTIONNAIRE"` ("High sum assured > 1.5M requires signed Financial Questionnaire").
* **Rule `INFO_MED_01`:** `contains(medicalConditions, "FATTY_LIVER")` AND `bmi >= 32` AND `not contains(submittedDocuments, "LIVER_ULTRASOUND")` $\rightarrow$ Missing `"LIVER_ULTRASOUND"` ("Fatty liver with BMI >= 32 requires Liver Ultrasound report").
* **Rule `INFO_MED_02`:** `age >= 55` AND `sumAssured >= 1000000` AND `not contains(submittedDocuments, "RESTING_ECG")` $\rightarrow$ Missing `"RESTING_ECG"` ("Senior applicant >= 55 with SA >= 1M requires Resting ECG").
* *Gateway Resolution:* If `missingDocuments.length > 0`, `isSufficient = false`. The process short-circuits to `finalDecision = "REQUEST_ADDITIONAL_INFO"` and flags `isUncleanReferral = true` so the AI Copilot drafts the customer follow-up letter.



### Stage 2: Risk Assessment (`2. Risk Assessment` — Collect Mode)

Evaluates all risk factors and collects debits, exclusions, and flags:

1. **`RA_AGE_KNOCKOUT`:** `age < 18 or age > 65` $\rightarrow$ `outcome: "DECLINE"`, `debits: 999`, `reason: "Age outside insurable range 18-65"`
2. **`RA_BP_CRISIS`:** `systolicBp >= 180` $\rightarrow$ `outcome: "DECLINE"`, `debits: 999`, `reason: "Hypertensive crisis (Systolic BP >= 180)"`
3. **`RA_EXTREME_BMI`:** `bmi >= 38` $\rightarrow$ `outcome: "DECLINE"`, `debits: 999`, `reason: "Severe obesity BMI >= 38"`
4. **`RA_FINANCIAL_OVERINSURED`:** `incomeMultiple > 25` $\rightarrow$ `outcome: "DECLINE"`, `debits: 999`, `reason: "Sum assured exceeds 25x annual income"`
5. **`RA_RECENT_SURGERY`:** `recentSurgeryMonthsAgo > 0 and recentSurgeryMonthsAgo <= 6` $\rightarrow$ `outcome: "POSTPONE"`, `debits: 0`, `reason: "Major surgery within last 6 months; postpone until recovery"`
6. **`RA_BENIGN_THYROID`:** `contains(medicalConditions, "THYROID_NODULE_BENIGN")` $\rightarrow$ `outcome: "EXCLUSION"`, `debits: 0`, `exclusionCode: "EXCL_THYROID_GLAND"`, `reason: "TI-RADS 2/3 thyroid nodule requires thyroid exclusion rider"`
7. **`RA_MILD_OVERWEIGHT`:** `bmi >= 25 and bmi < 28` $\rightarrow$ `outcome: "DEBIT"`, `debits: 15`, `reason: "Mild overweight (BMI 25.0-27.9)"`
8. **`RA_OBESITY_CLASS_1`:** `bmi >= 28 and bmi < 38` $\rightarrow$ `outcome: "DEBIT"`, `debits: 40`, `reason: "Obesity Class I/II (BMI 28.0-37.9)"`
9. **`RA_HYPERTENSION_S1`:** `systolicBp >= 140 and systolicBp < 160` $\rightarrow$ `outcome: "DEBIT"`, `debits: 35`, `reason: "Stage 1 Hypertension (140-159 mmHg)"`
10. **`RA_HYPERTENSION_S2`:** `systolicBp >= 160 and systolicBp < 180` $\rightarrow$ `outcome: "DEBIT"`, `debits: 80`, `reason: "Stage 2 Hypertension (160-179 mmHg)"`
11. **`RA_SMOKER_BP_SYNERGY`:** `smoker == true and systolicBp >= 140 and systolicBp < 180` $\rightarrow$ `outcome: "UNCLEAN_DEBIT"`, `debits: 30`, `reason: "Synergistic cardiovascular risk: Smoker + Hypertension"`
12. **`RA_METABOLIC_COMORBIDITY`:** `bmi >= 28 and contains(medicalConditions, "FATTY_LIVER")` $\rightarrow$ `outcome: "UNCLEAN_DEBIT"`, `debits: 0`, `reason: "Metabolic comorbidity: BMI >= 28 with Fatty Liver requires underwriter review"`

### Stage 3 & 4: Risk Classification & Final Underwriting Decision (`First-Hit Mode`)

Maps aggregated Stage 1 & Stage 2 outputs into the Risk Class and the 5 terminal Underwriting Decisions:

| Priority | Condition | Step 3: `riskClass` | Step 4: `finalDecision` | `loadingPct` | `isUncleanReferral` |
| --- | --- | --- | --- | --- | --- |
| **1** | `isSufficient == false` | `INCOMPLETE_INFO` | `REQUEST_ADDITIONAL_INFO`<br> | `0` | `true` |
| **2** | `hasDeclineTrigger == true or totalEmDebits >= 200` | `UNINSURABLE` | `DECLINE`<br> | `0` | `false` |
| **3** | `hasPostponeTrigger == true` | `TEMPORARY_DEFERRED` | `POSTPONE`<br> | `0` | `true` |
| **4** | `len(exclusionCodes) > 0 and totalEmDebits <= 25` | `STANDARD_WITH_EXCLUSION` | `ACCEPT_WITH_EXCLUSIONS`<br> | `0` | `hasComorbidityUncleanTrigger` |
| **5** | `totalEmDebits > 25 and totalEmDebits <= 50` | `SUBSTANDARD_TABLE_A` | `ACCEPT_WITH_LOADING`<br> | `25` | `hasComorbidityUncleanTrigger` |
| **6** | `totalEmDebits > 50 and totalEmDebits <= 100` | `SUBSTANDARD_TABLE_B` | `ACCEPT_WITH_LOADING`<br> | `50` | `true` |
| **7** | `totalEmDebits > 100 and totalEmDebits < 200` | `SUBSTANDARD_TABLE_D` | `ACCEPT_WITH_LOADING`<br> | `100` | `true` |
| **8** | `totalEmDebits <= 25` | `STANDARD` | `ACCEPT_AS_PER_APPLICATION`<br> | `0` | `false` |

---

## 5. Complete GoRules JDM JSON (`shared/rules/v1-migrated-rules.json`)

The coding agent MUST write the following complete, valid GoRules JDM JSON graph to `shared/rules/v1-migrated-rules.json`:

```json
{
  "contentType": "application/vnd.gorules.decision",
  "nodes": [
    {
      "id": "node-input",
      "name": "1. Proposal Form Input",
      "type": "inputNode",
      "position": { "x": 40, "y": 240 }
    },
    {
      "id": "node-formulas",
      "name": "0. Formulas (BMI & Financials)",
      "type": "expressionNode",
      "position": { "x": 280, "y": 240 },
      "content": {
        "expressions": [
          {
            "id": "expr-bmi",
            "key": "derived.bmi",
            "value": "round(weightKg / pow(heightCm / 100, 2), 1)"
          },
          {
            "id": "expr-income-mult",
            "key": "derived.incomeMultiple",
            "value": "round(sumAssured / annualIncome, 1)"
          }
        ],
        "passThrough": true
      }
    },
    {
      "id": "node-step1-info-check",
      "name": "1.1 Sufficient Info & Evidence Check",
      "type": "decisionTableNode",
      "position": { "x": 560, "y": 100 },
      "content": {
        "hitPolicy": "collect",
        "inputField": null,
        "outputField": "missingInfoMatches",
        " passThrough": true,
        "inputs": [
          { "id": "inf-sa", "name": "Sum Assured", "field": "sumAssured" },
          { "id": "inf-age", "name": "Age", "field": "age" },
          { "id": "inf-bmi", "name": "Calculated BMI", "field": "derived.bmi" },
          { "id": "inf-med", "name": "Medical Conditions", "field": "medicalConditions" },
          { "id": "inf-docs", "name": "Submitted Docs", "field": "submittedDocuments" }
        ],
        "outputs": [
          { "id": "out-doc-code", "name": "Missing Doc Code", "field": "missingDoc" },
          { "id": "out-doc-reason", "name": "Reason", "field": "reason" }
        ],
        "rules": [
          {
            "_id": "info-r1",
            "inf-sa": "> 1500000",
            "inf-age": "",
            "inf-bmi": "",
            "inf-med": "",
            "inf-docs": "not(contains($, \"FINANCIAL_QUESTIONNAIRE\"))",
            "out-doc-code": "\"FINANCIAL_QUESTIONNAIRE\"",
            "out-doc-reason": "\"High sum assured > 1.5M requires signed Financial Questionnaire\""
          },
          {
            "_id": "info-r2",
            "inf-sa": "",
            "inf-age": "",
            "inf-bmi": ">= 32",
            "inf-med": "contains($, \"FATTY_LIVER\")",
            "inf-docs": "not(contains($, \"LIVER_ULTRASOUND\"))",
            "out-doc-code": "\"LIVER_ULTRASOUND\"",
            "out-doc-reason": "\"Fatty liver with BMI >= 32 requires Liver Ultrasound report\""
          },
          {
            "_id": "info-r3",
            "inf-sa": ">= 1000000",
            "inf-age": ">= 55",
            "inf-bmi": "",
            "inf-med": "",
            "inf-docs": "not(contains($, \"RESTING_ECG\"))",
            "out-doc-code": "\"RESTING_ECG\"",
            "out-doc-reason": "\"Senior applicant >= 55 with SA >= 1M requires Resting ECG\""
          }
        ]
      }
    },
    {
      "id": "node-step2-risk-assessment",
      "name": "2. Risk Assessment (Debits & Flags)",
      "type": "decisionTableNode",
      "position": { "x": 560, "y": 360 },
      "content": {
        "hitPolicy": "collect",
        "inputField": null,
        "outputField": "assessmentMatches",
        "passThrough": true,
        "inputs": [
          { "id": "ra-age", "name": "Age", "field": "age" },
          { "id": "ra-bmi", "name": "Calculated BMI", "field": "derived.bmi" },
          { "id": "ra-bp", "name": "Systolic BP", "field": "systolicBp" },
          { "id": "ra-smoker", "name": "Smoker", "field": "smoker" },
          { "id": "ra-inc-mult", "name": "Income Multiple", "field": "derived.incomeMultiple" },
          { "id": "ra-surg", "name": "Surgery Months Ago", "field": "recentSurgeryMonthsAgo" },
          { "id": "ra-med", "name": "Medical Conditions", "field": "medicalConditions" },
          { "id": "ra-occ", "name": "Occupation Class", "field": "occupationClass" }
        ],
        "outputs": [
          { "id": "ra-out-id", "name": "Rule ID", "field": "ruleId" },
          { "id": "ra-out-type", "name": "Assessment Outcome", "field": "outcome" },
          { "id": "ra-out-debits", "name": "EM Debits", "field": "debits" },
          { "id": "ra-out-excl", "name": "Exclusion Code", "field": "exclusionCode" },
          { "id": "ra-out-reason", "name": "Reason", "field": "reason" }
        ],
        "rules": [
          {
            "_id": "ra-1",
            "ra-age": "< 18 or > 65",
            "ra-bmi": "",
            "ra-bp": "",
            "ra-smoker": "",
            "ra-inc-mult": "",
            "ra-surg": "",
            "ra-med": "",
            "ra-occ": "",
            "ra-out-id": "\"RA_AGE_KNOCKOUT\"",
            "ra-out-type": "\"DECLINE\"",
            "ra-out-debits": "999",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Age outside insurable range 18-65\""
          },
          {
            "_id": "ra-2",
            "ra-age": "",
            "ra-bmi": "",
            "ra-bp": ">= 180",
            "ra-smoker": "",
            "ra-inc-mult": "",
            "ra-surg": "",
            "ra-med": "",
            "ra-occ": "",
            "ra-out-id": "\"RA_BP_CRISIS\"",
            "ra-out-type": "\"DECLINE\"",
            "ra-out-debits": "999",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Hypertensive crisis (Systolic BP >= 180)\""
          },
          {
            "_id": "ra-3",
            "ra-age": "",
            "ra-bmi": ">= 38",
            "ra-bp": "",
            "ra-smoker": "",
            "ra-inc-mult": "",
            "ra-surg": "",
            "ra-med": "",
            "ra-occ": "",
            "ra-out-id": "\"RA_EXTREME_BMI\"",
            "ra-out-type": "\"DECLINE\"",
            "ra-out-debits": "999",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Severe obesity BMI >= 38\""
          },
          {
            "_id": "ra-4",
            "ra-age": "",
            "ra-bmi": "",
            "ra-bp": "",
            "ra-smoker": "",
            "ra-inc-mult": "> 25",
            "ra-surg": "",
            "ra-med": "",
            "ra-occ": "",
            "ra-out-id": "\"RA_FINANCIAL_OVERINSURED\"",
            "ra-out-type": "\"DECLINE\"",
            "ra-out-debits": "999",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Sum assured exceeds 25x annual income\""
          },
          {
            "_id": "ra-5",
            "ra-age": "",
            "ra-bmi": "",
            "ra-bp": "",
            "ra-smoker": "",
            "ra-inc-mult": "",
            "ra-surg": "[1..6]",
            "ra-med": "",
            "ra-occ": "",
            "ra-out-id": "\"RA_RECENT_SURGERY\"",
            "ra-out-type": "\"POSTPONE\"",
            "ra-out-debits": "0",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Major surgery within last 6 months; postpone until recovery\""
          },
          {
            "_id": "ra-6",
            "ra-age": "",
            "ra-bmi": "",
            "ra-bp": "",
            "ra-smoker": "",
            "ra-inc-mult": "",
            "ra-surg": "",
            "ra-med": "contains($, \"THYROID_NODULE_BENIGN\")",
            "ra-occ": "",
            "ra-out-id": "\"RA_BENIGN_THYROID\"",
            "ra-out-type": "\"EXCLUSION\"",
            "ra-out-debits": "0",
            "ra-out-excl": "\"EXCL_THYROID_GLAND\"",
            "ra-out-reason": "\"TI-RADS 2/3 thyroid nodule requires thyroid exclusion rider\""
          },
          {
            "_id": "ra-7",
            "ra-age": "",
            "ra-bmi": "[25..28)",
            "ra-bp": "",
            "ra-smoker": "",
            "ra-inc-mult": "",
            "ra-surg": "",
            "ra-med": "",
            "ra-occ": "",
            "ra-out-id": "\"RA_MILD_OVERWEIGHT\"",
            "ra-out-type": "\"DEBIT\"",
            "ra-out-debits": "15",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Mild overweight (BMI 25.0-27.9)\""
          },
          {
            "_id": "ra-8",
            "ra-age": "",
            "ra-bmi": "[28..38)",
            "ra-bp": "",
            "ra-smoker": "",
            "ra-inc-mult": "",
            "ra-surg": "",
            "ra-med": "",
            "ra-occ": "",
            "ra-out-id": "\"RA_OBESITY_CLASS_1\"",
            "ra-out-type": "\"DEBIT\"",
            "ra-out-debits": "40",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Obesity Class I/II (BMI 28.0-37.9)\""
          },
          {
            "_id": "ra-9",
            "ra-age": "",
            "ra-bmi": "",
            "ra-bp": "[140..160)",
            "ra-smoker": "",
            "ra-inc-mult": "",
            "ra-surg": "",
            "ra-med": "",
            "ra-occ": "",
            "ra-out-id": "\"RA_HYPERTENSION_S1\"",
            "ra-out-type": "\"DEBIT\"",
            "ra-out-debits": "35",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Stage 1 Hypertension (140-159 mmHg)\""
          },
          {
            "_id": "ra-10",
            "ra-age": "",
            "ra-bmi": "",
            "ra-bp": "[160..180)",
            "ra-smoker": "",
            "ra-inc-mult": "",
            "ra-surg": "",
            "ra-med": "",
            "ra-occ": "",
            "ra-out-id": "\"RA_HYPERTENSION_S2\"",
            "ra-out-type": "\"DEBIT\"",
            "ra-out-debits": "80",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Stage 2 Hypertension (160-179 mmHg)\""
          },
          {
            "_id": "ra-11",
            "ra-age": "",
            "ra-bmi": "",
            "ra-bp": "[140..180)",
            "ra-smoker": "true",
            "ra-inc-mult": "",
            "ra-surg": "",
            "ra-med": "",
            "ra-occ": "",
            "ra-out-id": "\"RA_SMOKER_BP_SYNERGY\"",
            "ra-out-type": "\"UNCLEAN_DEBIT\"",
            "ra-out-debits": "30",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Synergistic cardiovascular risk: Smoker + Hypertension\""
          },
          {
            "_id": "ra-12",
            "ra-age": "",
            "ra-bmi": ">= 28",
            "ra-bp": "",
            "ra-smoker": "",
            "ra-inc-mult": "",
            "ra-surg": "",
            "ra-med": "contains($, \"FATTY_LIVER\")",
            "ra-occ": "",
            "ra-out-id": "\"RA_METABOLIC_COMORBIDITY\"",
            "ra-out-type": "\"UNCLEAN_DEBIT\"",
            "ra-out-debits": "0",
            "ra-out-excl": "null",
            "ra-out-reason": "\"Metabolic comorbidity: BMI >= 28 with Fatty Liver requires underwriter review\""
          }
        ]
      }
    },
    {
      "id": "node-step2-summary",
      "name": "2.5 Assessment Summary Formulas",
      "type": "expressionNode",
      "position": { "x": 860, "y": 240 },
      "content": {
        "expressions": [
          {
            "id": "sum-1",
            "key": "assessmentSummary.isSufficient",
            "value": "len(missingInfoMatches) == 0"
          },
          {
            "id": "sum-2",
            "key": "assessmentSummary.totalEmDebits",
            "value": "sum(assessmentMatches.map(x, x.debits))"
          },
          {
            "id": "sum-3",
            "key": "assessmentSummary.hasDeclineTrigger",
            "value": "some(assessmentMatches, #.outcome == \"DECLINE\")"
          },
          {
            "id": "sum-4",
            "key": "assessmentSummary.hasPostponeTrigger",
            "value": "some(assessmentMatches, #.outcome == \"POSTPONE\")"
          },
          {
            "id": "sum-5",
            "key": "assessmentSummary.hasExclusionTrigger",
            "value": "some(assessmentMatches, #.outcome == \"EXCLUSION\")"
          },
          {
            "id": "sum-6",
            "key": "assessmentSummary.hasComorbidityUncleanTrigger",
            "value": "some(assessmentMatches, #.outcome == \"UNCLEAN_DEBIT\")"
          }
        ],
        "passThrough": true
      }
    },
    {
      "id": "node-step3-classification",
      "name": "3. Risk Classification & 4. Decision Matrix",
      "type": "decisionTableNode",
      "position": { "x": 1140, "y": 240 },
      "content": {
        "hitPolicy": "first",
        "inputField": null,
        "outputField": "classificationResult",
        "passThrough": true,
        "inputs": [
          { "id": "rc-suff", "name": "Sufficient Info?", "field": "assessmentSummary.isSufficient" },
          { "id": "rc-dec", "name": "Has Decline?", "field": "assessmentSummary.hasDeclineTrigger" },
          { "id": "rc-post", "name": "Has Postpone?", "field": "assessmentSummary.hasPostponeTrigger" },
          { "id": "rc-excl", "name": "Has Exclusion?", "field": "assessmentSummary.hasExclusionTrigger" },
          { "id": "rc-debits", "name": "Total EM Debits", "field": "assessmentSummary.totalEmDebits" },
          { "id": "rc-unclean", "name": "Comorbidity Flag?", "field": "assessmentSummary.hasComorbidityUncleanTrigger" }
        ],
        "outputs": [
          { "id": "rc-out-class", "name": "3. Risk Class", "field": "riskClass" },
          { "id": "rc-out-table", "name": "Actuarial Rating", "field": "actuarialTableRating" },
          { "id": "rc-out-decision", "name": "4. Final Decision", "field": "finalDecision" },
          { "id": "rc-out-load", "name": "Loading %", "field": "loadingPct" },
          { "id": "rc-out-refer", "name": "Is Unclean Referral?", "field": "isUncleanReferral" }
        ],
        "rules": [
          {
            "_id": "rc-1",
            "rc-suff": "false",
            "rc-dec": "",
            "rc-post": "",
            "rc-excl": "",
            "rc-debits": "",
            "rc-unclean": "",
            "rc-out-class": "\"INCOMPLETE_INFO\"",
            "rc-out-table": "\"Pending Evidence\"",
            "rc-out-decision": "\"REQUEST_ADDITIONAL_INFO\"",
            "rc-out-load": "0",
            "rc-out-refer": "true"
          },
          {
            "_id": "rc-2",
            "rc-suff": "true",
            "rc-dec": "true",
            "rc-post": "",
            "rc-excl": "",
            "rc-debits": "",
            "rc-unclean": "",
            "rc-out-class": "\"UNINSURABLE\"",
            "rc-out-table": "\"Declined\"",
            "rc-out-decision": "\"DECLINE\"",
            "rc-out-load": "0",
            "rc-out-refer": "false"
          },
          {
            "_id": "rc-3",
            "rc-suff": "true",
            "rc-dec": "false",
            "rc-post": "",
            "rc-excl": "",
            "rc-debits": ">= 200",
            "rc-unclean": "",
            "rc-out-class": "\"UNINSURABLE\"",
            "rc-out-table": "\"Exceeds Max Table Rating (>=200 EM)\"",
            "rc-out-decision": "\"DECLINE\"",
            "rc-out-load": "0",
            "rc-out-refer": "false"
          },
          {
            "_id": "rc-4",
            "rc-suff": "true",
            "rc-dec": "false",
            "rc-post": "true",
            "rc-excl": "",
            "rc-debits": "",
            "rc-unclean": "",
            "rc-out-class": "\"TEMPORARY_DEFERRED\"",
            "rc-out-table": "\"Postponed\"",
            "rc-out-decision": "\"POSTPONE\"",
            "rc-out-load": "0",
            "rc-out-refer": "true"
          },
          {
            "_id": "rc-5",
            "rc-suff": "true",
            "rc-dec": "false",
            "rc-post": "false",
            "rc-excl": "true",
            "rc-debits": "<= 25",
            "rc-unclean": "",
            "rc-out-class": "\"STANDARD_WITH_EXCLUSION\"",
            "rc-out-table": "\"Standard + Specific Exclusion Rider\"",
            "rc-out-decision": "\"ACCEPT_WITH_EXCLUSIONS\"",
            "rc-out-load": "0",
            "rc-out-refer": "assessmentSummary.hasComorbidityUncleanTrigger"
          },
          {
            "_id": "rc-6",
            "rc-suff": "true",
            "rc-dec": "false",
            "rc-post": "false",
            "rc-excl": "",
            "rc-debits": "(25..50]",
            "rc-unclean": "",
            "rc-out-class": "\"SUBSTANDARD_TABLE_A\"",
            "rc-out-table": "\"Table A (+25% EM)\"",
            "rc-out-decision": "\"ACCEPT_WITH_LOADING\"",
            "rc-out-load": "25",
            "rc-out-refer": "assessmentSummary.hasComorbidityUncleanTrigger"
          },
          {
            "_id": "rc-7",
            "rc-suff": "true",
            "rc-dec": "false",
            "rc-post": "false",
            "rc-excl": "",
            "rc-debits": "(50..100]",
            "rc-unclean": "",
            "rc-out-class": "\"SUBSTANDARD_TABLE_B\"",
            "rc-out-table": "\"Table B (+50% EM)\"",
            "rc-out-decision": "\"ACCEPT_WITH_LOADING\"",
            "rc-out-load": "50",
            "rc-out-refer": "true"
          },
          {
            "_id": "rc-8",
            "rc-suff": "true",
            "rc-dec": "false",
            "rc-post": "false",
            "rc-excl": "",
            "rc-debits": "(100..200)",
            "rc-unclean": "",
            "rc-out-class": "\"SUBSTANDARD_TABLE_D\"",
            "rc-out-table": "\"Table D (+100% EM)\"",
            "rc-out-decision": "\"ACCEPT_WITH_LOADING\"",
            "rc-out-load": "100",
            "rc-out-refer": "true"
          },
          {
            "_id": "rc-9",
            "rc-suff": "true",
            "rc-dec": "false",
            "rc-post": "false",
            "rc-excl": "false",
            "rc-debits": "<= 25",
            "rc-unclean": "",
            "rc-out-class": "\"STANDARD\"",
            "rc-out-table": "\"Standard Rates (100% Mortality)\"",
            "rc-out-decision": "\"ACCEPT_AS_PER_APPLICATION\"",
            "rc-out-load": "0",
            "rc-out-refer": "false"
          }
        ]
      }
    },
    {
      "id": "node-step4-formatter",
      "name": "4. Final Underwriting Output Envelope",
      "type": "functionNode",
      "position": { "x": 1420, "y": 240 },
      "content": "export const handler = async (input) => {\n  const missingDocs = (input.missingInfoMatches || []).map(m => ({ docCode: m.missingDoc, reason: m.reason }));\n  const assessments = input.assessmentMatches || [];\n  const exclusions = assessments.filter(a => a.exclusionCode).map(a => a.exclusionCode);\n  const cls = input.classificationResult || {};\n  return {\n    applicantId: input.applicantId,\n    derivedMetrics: input.derived,\n    step1SufficientInfo: {\n      isSufficient: input.assessmentSummary.isSufficient,\n      missingDocuments: missingDocs\n    },\n    step2RiskAssessment: {\n      totalEmDebits: input.assessmentSummary.totalEmDebits,\n      exclusionCodes: exclusions,\n      hasDeclineTrigger: input.assessmentSummary.hasDeclineTrigger,\n      hasPostponeTrigger: input.assessmentSummary.hasPostponeTrigger,\n      hasComorbidityUncleanTrigger: input.assessmentSummary.hasComorbidityUncleanTrigger,\n      matchedAssessmentRules: assessments\n    },\n    step3RiskClassification: {\n      riskClass: cls.riskClass,\n      actuarialTableRating: cls.actuarialTableRating,\n      loadingPct: cls.loadingPct\n    },\n    step4UnderwritingDecision: {\n      finalDecision: cls.finalDecision,\n      isUncleanReferral: cls.isUncleanReferral,\n      loadingPct: cls.loadingPct,\n      exclusions: exclusions,\n      requestedAdditionalInfo: missingDocs\n    }\n  };\n};"
    },
    {
      "id": "node-output",
      "name": "Underwriting Response",
      "type": "outputNode",
      "position": { "x": 1680, "y": 240 }
    }
  ],
  "edges": [
    { "id": "e1", "sourceId": "node-input", "targetId": "node-formulas" },
    { "id": "e2", "sourceId": "node-formulas", "targetId": "node-step1-info-check" },
    { "id": "e3", "sourceId": "node-formulas", "targetId": "node-step2-risk-assessment" },
    { "id": "e4", "sourceId": "node-step1-info-check", "targetId": "node-step2-summary" },
    { "id": "e5", "sourceId": "node-step2-risk-assessment", "targetId": "node-step2-summary" },
    { "id": "e6", "sourceId": "node-step2-summary", "targetId": "node-step3-classification" },
    { "id": "e7", "sourceId": "node-step3-classification", "targetId": "node-step4-formatter" },
    { "id": "e8", "sourceId": "node-step4-formatter", "targetId": "node-output" }
  ]
}

```

---

## 6. Additional Feature Specifications for the Coding Agent

### 6.1 Excel (`.xlsx`) Upload to JDM JSON (`POST /api/rules/upload-excel`)

To demonstrate how business users can upload existing Excel tables into GoRules:

* Add an endpoint `POST /api/rules/upload-excel` in `gorules-ts-engine` using the `xlsx` npm package.
* When an underwriter uploads an Excel sheet representing the **2. Risk Assessment** table, the endpoint parses the worksheet rows, converts them into GoRules `node-step2-risk-assessment.content.rules` JSON format, updates the active JDM graph, and returns the updated JDM JSON to the Admin UI.


* Also generate a sample Excel file (`shared/sample-rules-upload.xlsx`) during setup so the user can test uploading it via the Admin UI immediately.

### 6.2 Rule Onboarding Showcase (Requirement 5)

In the Admin UI toolbar, provide a **"1-Click Onboard New Rule (Hazardous Occupation Class 4)"** button that appends a new row to **2. Risk Assessment**:

* `occupationClass == 4` $\rightarrow$ `ruleId: "RA_OCCUPATION_CLASS_4"`, `outcome: "UNCLEAN_DEBIT"`, `debits: 50`, `reason: "Class 4 hazardous occupation requires occupational questionnaire & +50 EM loading"`.

### 6.3 AI Copilot Extension for Step 1.1 & Step 4 (`uncleanCaseCopilot.ts`)

When `step4UnderwritingDecision.isUncleanReferral === true`, `uncleanCaseCopilot.ts` inspects the GoRules execution `trace` and branches into two specialized assistant modes matching the diagram:

1. Mode A — `REQUEST_ADDITIONAL_INFO` (Step 1.1 Assistant):


* Extracts `step1SufficientInfo.missingDocuments` from the trace.
* Generates a structured **Agent/Customer Follow-Up Request** explaining *why* the additional documents (e.g., `LIVER_ULTRASOUND` or `FINANCIAL_QUESTIONNAIRE`) are required based on the applicant's specific metrics (`derived.bmi = 33.2`, `sumAssured = 2,000,000`).


2. Mode B — `UNCLEAN_RISK_ASSESSMENT` (Step 2 $\rightarrow$ Step 4 Referral Copilot):


* Triggered when complex comorbidities or high table ratings (`Table B` / `Table D` / `POSTPONE`) occur.


* Synthesizes all matched rows from `node-step2-risk-assessment` and `node-step3-classification`, explaining the interaction of debits and recommending whether the human underwriter should approve as **Accept With Loading**, **Accept With Exclusions**, or **Postpone**.





---

## 7. Verification Checklist for the Coding Agent

1. **12-Case Canonical Test Suite (`shared/test-cases.json`):** Must include at least 2 cases for each of the 6 outcomes (`REQUEST_ADDITIONAL_INFO`, `ACCEPT_AS_PER_APPLICATION`, `ACCEPT_WITH_LOADING`, `ACCEPT_WITH_EXCLUSIONS`, `POSTPONE`, `DECLINE`).


2. **100% Shadow-Mode Parity (`npm run verify-parity`):** Both `legacy-java-service` (`:8080`) and `gorules-ts-engine` (`:3001`) must evaluate all 12 test cases and produce identical `derivedMetrics`, `step1SufficientInfo`, `totalEmDebits`, `riskClass`, and `finalDecision`.
3. **Visual Pipeline & Trace Highlight:** Opening `gorules-admin-ui` (`:5173`) and clicking **"Simulate"** on any test case must highlight the exact path across all 6 nodes in the JDM graph and render the 4-stage breakdown + AI Copilot card in the right-hand drawer.