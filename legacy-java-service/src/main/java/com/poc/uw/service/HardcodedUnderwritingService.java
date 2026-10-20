package com.poc.uw.service;

import com.poc.uw.model.ApplicantRequest;
import com.poc.uw.model.UnderwritingResponse;
import com.poc.uw.model.UnderwritingResponse.DerivedMetrics;
import com.poc.uw.model.UnderwritingResponse.MatchedAssessmentRule;
import com.poc.uw.model.UnderwritingResponse.MissingDocument;
import com.poc.uw.model.UnderwritingResponse.Step1SufficientInfo;
import com.poc.uw.model.UnderwritingResponse.Step2RiskAssessment;
import com.poc.uw.model.UnderwritingResponse.Step3RiskClassification;
import com.poc.uw.model.UnderwritingResponse.Step4UnderwritingDecision;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * LEGACY hardcoded underwriting engine (PRD v2 four-stage pipeline).
 *
 * <p>Intentionally written as rigid if-else technical debt. Every rule carries a
 * machine-readable marker that the deterministic AST migrator
 * ({@code astToJdmMigrator.ts}) scrapes to rebuild the GoRules JDM graph:
 * <pre>
 *   // UW_RULE s1 &lt;docCode&gt; | &lt;reason&gt;
 *   // UW_RULE s2 &lt;ruleId&gt; | &lt;outcome&gt; | &lt;debits&gt; | &lt;exclusionCode or -&gt; | &lt;reason&gt;
 *   // UW_RULE s3 &lt;riskClass&gt; | &lt;actuarialTableRating&gt; | &lt;finalDecision&gt; | &lt;loadingPct&gt; | &lt;refer(true|false|hasComorbidityUncleanTrigger)&gt;
 * </pre>
 *
 * <p>PARITY CONTRACT with the JDM graph:
 * <ul>
 *   <li>Stage 0 computes bmi / incomeMultiple rounded to 1 decimal, exactly like the
 *       Zen expression {@code round(x * 10) / 10} (Math.round = Zen round, half-up).</li>
 *   <li>Stage 1 and Stage 2 use "collect" semantics: every rule is evaluated
 *       independently (no short-circuit), matches are kept in table order.</li>
 *   <li>Stage 3/4 uses "first-hit" semantics: the priority matrix is evaluated as an
 *       ordered if / else-if chain matching row order rc-1 .. rc-9 of
 *       {@code shared/rules/v1-migrated-rules.json}.</li>
 * </ul>
 */
@Service
public class HardcodedUnderwritingService {

    private static class Match {
        final String ruleId;
        final String outcome;
        final int debits;
        final String exclusionCode;
        final String reason;

        Match(String ruleId, String outcome, int debits, String exclusionCode, String reason) {
            this.ruleId = ruleId;
            this.outcome = outcome;
            this.debits = debits;
            this.exclusionCode = exclusionCode;
            this.reason = reason;
        }
    }

    private static class Classification {
        final String riskClass;
        final String table;
        final String decision;
        final int loading;
        final boolean refer;

        Classification(String riskClass, String table, String decision, int loading, boolean refer) {
            this.riskClass = riskClass;
            this.table = table;
            this.decision = decision;
            this.loading = loading;
            this.refer = refer;
        }
    }

    /** Zen-compatible rounding: round(value * 10) / 10 with half-up semantics. */
    private static double round1(double value) {
        return Math.round(value * 10) / 10.0;
    }

    public UnderwritingResponse underwrite(ApplicantRequest r) {
        int age = r.getAge();
        double heightCm = r.getHeightCm();
        double weightKg = r.getWeightKg();
        boolean smoker = r.isSmoker();
        int systolicBp = r.getSystolicBp();
        double annualIncome = r.getAnnualIncome();
        long sumAssured = r.getSumAssured();
        int occupationClass = r.getOccupationClass();
        int recentSurgeryMonthsAgo = r.getRecentSurgeryMonthsAgo();
        List<String> medicalConditions = r.getMedicalConditions() == null ? new ArrayList<>() : r.getMedicalConditions();
        List<String> submittedDocuments = r.getSubmittedDocuments() == null ? new ArrayList<>() : r.getSubmittedDocuments();

        // ---------- Stage 0: Derived metrics (Formulas / Expression Node) ----------
        double bmi = round1(weightKg / (heightCm / 100 * (heightCm / 100)));
        double incomeMultiple = round1((double) sumAssured / annualIncome);

        // ---------- Stage 1: Information completeness (1.1 Request Additional Info) ----------
        List<MissingDocument> missingDocuments = new ArrayList<>();
        // UW_RULE s1 FINANCIAL_QUESTIONNAIRE | High sum assured > 1.5M requires signed Financial Questionnaire
        if (sumAssured > 1500000 && !submittedDocuments.contains("FINANCIAL_QUESTIONNAIRE")) {
            missingDocuments.add(new MissingDocument("FINANCIAL_QUESTIONNAIRE", "High sum assured > 1.5M requires signed Financial Questionnaire"));
        }
        // UW_RULE s1 LIVER_ULTRASOUND | Fatty liver with BMI >= 32 requires Liver Ultrasound report
        if (medicalConditions.contains("FATTY_LIVER") && bmi >= 32 && !submittedDocuments.contains("LIVER_ULTRASOUND")) {
            missingDocuments.add(new MissingDocument("LIVER_ULTRASOUND", "Fatty liver with BMI >= 32 requires Liver Ultrasound report"));
        }
        // UW_RULE s1 RESTING_ECG | Senior applicant >= 55 with SA >= 1M requires Resting ECG
        if (age >= 55 && sumAssured >= 1000000 && !submittedDocuments.contains("RESTING_ECG")) {
            missingDocuments.add(new MissingDocument("RESTING_ECG", "Senior applicant >= 55 with SA >= 1M requires Resting ECG"));
        }
        boolean isSufficient = missingDocuments.isEmpty();

        // ---------- Stage 2: Risk Assessment (collect all debits & flags) ----------
        List<Match> assessmentMatches = new ArrayList<>();
        // UW_RULE s2 RA_AGE_KNOCKOUT | DECLINE | 999 | - | Age outside insurable range 18-65
        if (age < 18 || age > 65) {
            assessmentMatches.add(new Match("RA_AGE_KNOCKOUT", "DECLINE", 999, null, "Age outside insurable range 18-65"));
        }
        // UW_RULE s2 RA_BP_CRISIS | DECLINE | 999 | - | Hypertensive crisis (Systolic BP >= 180)
        if (systolicBp >= 180) {
            assessmentMatches.add(new Match("RA_BP_CRISIS", "DECLINE", 999, null, "Hypertensive crisis (Systolic BP >= 180)"));
        }
        // UW_RULE s2 RA_EXTREME_BMI | DECLINE | 999 | - | Severe obesity BMI >= 38
        if (bmi >= 38) {
            assessmentMatches.add(new Match("RA_EXTREME_BMI", "DECLINE", 999, null, "Severe obesity BMI >= 38"));
        }
        // UW_RULE s2 RA_FINANCIAL_OVERINSURED | DECLINE | 999 | - | Sum assured exceeds 25x annual income
        if (incomeMultiple > 25) {
            assessmentMatches.add(new Match("RA_FINANCIAL_OVERINSURED", "DECLINE", 999, null, "Sum assured exceeds 25x annual income"));
        }
        // UW_RULE s2 RA_RECENT_SURGERY | POSTPONE | 0 | - | Major surgery within last 6 months; postpone until recovery
        if (recentSurgeryMonthsAgo > 0 && recentSurgeryMonthsAgo <= 6) {
            assessmentMatches.add(new Match("RA_RECENT_SURGERY", "POSTPONE", 0, null, "Major surgery within last 6 months; postpone until recovery"));
        }
        // UW_RULE s2 RA_BENIGN_THYROID | EXCLUSION | 0 | EXCL_THYROID_GLAND | TI-RADS 2/3 thyroid nodule requires thyroid exclusion rider
        if (medicalConditions.contains("THYROID_NODULE_BENIGN")) {
            assessmentMatches.add(new Match("RA_BENIGN_THYROID", "EXCLUSION", 0, "EXCL_THYROID_GLAND", "TI-RADS 2/3 thyroid nodule requires thyroid exclusion rider"));
        }
        // UW_RULE s2 RA_MILD_OVERWEIGHT | DEBIT | 15 | - | Mild overweight (BMI 25.0-27.9)
        if (bmi >= 25 && bmi < 28) {
            assessmentMatches.add(new Match("RA_MILD_OVERWEIGHT", "DEBIT", 15, null, "Mild overweight (BMI 25.0-27.9)"));
        }
        // UW_RULE s2 RA_OBESITY_CLASS_1 | DEBIT | 40 | - | Obesity Class I/II (BMI 28.0-37.9)
        if (bmi >= 28 && bmi < 38) {
            assessmentMatches.add(new Match("RA_OBESITY_CLASS_1", "DEBIT", 40, null, "Obesity Class I/II (BMI 28.0-37.9)"));
        }
        // UW_RULE s2 RA_HYPERTENSION_S1 | DEBIT | 35 | - | Stage 1 Hypertension (140-159 mmHg)
        if (systolicBp >= 140 && systolicBp < 160) {
            assessmentMatches.add(new Match("RA_HYPERTENSION_S1", "DEBIT", 35, null, "Stage 1 Hypertension (140-159 mmHg)"));
        }
        // UW_RULE s2 RA_HYPERTENSION_S2 | DEBIT | 80 | - | Stage 2 Hypertension (160-179 mmHg)
        if (systolicBp >= 160 && systolicBp < 180) {
            assessmentMatches.add(new Match("RA_HYPERTENSION_S2", "DEBIT", 80, null, "Stage 2 Hypertension (160-179 mmHg)"));
        }
        // UW_RULE s2 RA_SMOKER_BP_SYNERGY | UNCLEAN_DEBIT | 30 | - | Synergistic cardiovascular risk: Smoker + Hypertension
        if (smoker == true && systolicBp >= 140 && systolicBp < 180) {
            assessmentMatches.add(new Match("RA_SMOKER_BP_SYNERGY", "UNCLEAN_DEBIT", 30, null, "Synergistic cardiovascular risk: Smoker + Hypertension"));
        }
        // UW_RULE s2 RA_METABOLIC_COMORBIDITY | UNCLEAN_DEBIT | 0 | - | Metabolic comorbidity: BMI >= 28 with Fatty Liver requires underwriter review
        if (bmi >= 28 && medicalConditions.contains("FATTY_LIVER")) {
            assessmentMatches.add(new Match("RA_METABOLIC_COMORBIDITY", "UNCLEAN_DEBIT", 0, null, "Metabolic comorbidity: BMI >= 28 with Fatty Liver requires underwriter review"));
        }

        // ---------- Stage 2.5: Assessment summary (mirrors the Zen expression node) ----------
        int totalEmDebits = assessmentMatches.stream().mapToInt(m -> m.debits).sum();
        boolean hasDeclineTrigger = assessmentMatches.stream().anyMatch(m -> "DECLINE".equals(m.outcome));
        boolean hasPostponeTrigger = assessmentMatches.stream().anyMatch(m -> "POSTPONE".equals(m.outcome));
        boolean hasExclusionTrigger = assessmentMatches.stream().anyMatch(m -> "EXCLUSION".equals(m.outcome));
        boolean hasComorbidityUncleanTrigger = assessmentMatches.stream().anyMatch(m -> "UNCLEAN_DEBIT".equals(m.outcome));

        // ---------- Stage 3 & 4: Risk Classification & Decision (first-hit priority matrix) ----------
        Classification cls = null;
        // UW_RULE s3 INCOMPLETE_INFO | Pending Evidence | REQUEST_ADDITIONAL_INFO | 0 | true
        if (!isSufficient) {
            cls = new Classification("INCOMPLETE_INFO", "Pending Evidence", "REQUEST_ADDITIONAL_INFO", 0, true);
        }
        // UW_RULE s3 UNINSURABLE | Declined | DECLINE | 0 | false
        else if (hasDeclineTrigger) {
            cls = new Classification("UNINSURABLE", "Declined", "DECLINE", 0, false);
        }
        // UW_RULE s3 UNINSURABLE | Exceeds Max Table Rating (>=200 EM) | DECLINE | 0 | false
        else if (totalEmDebits >= 200) {
            cls = new Classification("UNINSURABLE", "Exceeds Max Table Rating (>=200 EM)", "DECLINE", 0, false);
        }
        // UW_RULE s3 TEMPORARY_DEFERRED | Postponed | POSTPONE | 0 | true
        else if (hasPostponeTrigger) {
            cls = new Classification("TEMPORARY_DEFERRED", "Postponed", "POSTPONE", 0, true);
        }
        // UW_RULE s3 STANDARD_WITH_EXCLUSION | Standard + Specific Exclusion Rider | ACCEPT_WITH_EXCLUSIONS | 0 | hasComorbidityUncleanTrigger
        else if (hasExclusionTrigger && totalEmDebits <= 25) {
            cls = new Classification("STANDARD_WITH_EXCLUSION", "Standard + Specific Exclusion Rider", "ACCEPT_WITH_EXCLUSIONS", 0, hasComorbidityUncleanTrigger);
        }
        // UW_RULE s3 SUBSTANDARD_TABLE_A | Table A (+25% EM) | ACCEPT_WITH_LOADING | 25 | hasComorbidityUncleanTrigger
        else if (totalEmDebits > 25 && totalEmDebits <= 50) {
            cls = new Classification("SUBSTANDARD_TABLE_A", "Table A (+25% EM)", "ACCEPT_WITH_LOADING", 25, hasComorbidityUncleanTrigger);
        }
        // UW_RULE s3 SUBSTANDARD_TABLE_B | Table B (+50% EM) | ACCEPT_WITH_LOADING | 50 | true
        else if (totalEmDebits > 50 && totalEmDebits <= 100) {
            cls = new Classification("SUBSTANDARD_TABLE_B", "Table B (+50% EM)", "ACCEPT_WITH_LOADING", 50, true);
        }
        // UW_RULE s3 SUBSTANDARD_TABLE_D | Table D (+100% EM) | ACCEPT_WITH_LOADING | 100 | true
        else if (totalEmDebits > 100 && totalEmDebits < 200) {
            cls = new Classification("SUBSTANDARD_TABLE_D", "Table D (+100% EM)", "ACCEPT_WITH_LOADING", 100, true);
        }
        // UW_RULE s3 STANDARD | Standard Rates (100% Mortality) | ACCEPT_AS_PER_APPLICATION | 0 | false
        else if (!hasExclusionTrigger && totalEmDebits <= 25) {
            cls = new Classification("STANDARD", "Standard Rates (100% Mortality)", "ACCEPT_AS_PER_APPLICATION", 0, false);
        } else {
            // Defensive fallback; unreachable for in-range inputs.
            cls = new Classification("TEMPORARY_DEFERRED", "Unmatched", "POSTPONE", 0, true);
        }

        // ---------- Envelope assembly ----------
        List<String> exclusionCodes = new ArrayList<>();
        for (Match m : assessmentMatches) {
            if (m.exclusionCode != null) exclusionCodes.add(m.exclusionCode);
        }

        UnderwritingResponse resp = new UnderwritingResponse();
        resp.setApplicantId(r.getApplicantId());
        resp.setDerivedMetrics(new DerivedMetrics(bmi, incomeMultiple));

        Step1SufficientInfo step1 = new Step1SufficientInfo();
        step1.setIsSufficient(isSufficient);
        step1.setMissingDocuments(missingDocuments);
        resp.setStep1SufficientInfo(step1);

        Step2RiskAssessment step2 = new Step2RiskAssessment();
        step2.setTotalEmDebits(totalEmDebits);
        step2.setExclusionCodes(exclusionCodes);
        step2.setHasDeclineTrigger(hasDeclineTrigger);
        step2.setHasPostponeTrigger(hasPostponeTrigger);
        step2.setHasComorbidityUncleanTrigger(hasComorbidityUncleanTrigger);
        for (Match m : assessmentMatches) {
            step2.getMatchedAssessmentRules().add(new MatchedAssessmentRule(m.ruleId, m.outcome, m.debits, m.exclusionCode, m.reason));
        }
        resp.setStep2RiskAssessment(step2);

        resp.setStep3RiskClassification(new Step3RiskClassification(cls.riskClass, cls.table, cls.loading));

        Step4UnderwritingDecision step4 = new Step4UnderwritingDecision();
        step4.setFinalDecision(cls.decision);
        step4.setIsUncleanReferral(cls.refer);
        step4.setLoadingPct(cls.loading);
        step4.setExclusions(exclusionCodes);
        step4.setRequestedAdditionalInfo(missingDocuments);
        resp.setStep4UnderwritingDecision(step4);

        return resp;
    }
}
