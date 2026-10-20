package com.poc.uw.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.ArrayList;
import java.util.List;

/**
 * Canonical output envelope (PRD v2 section 3.2). Exposes every stage of the
 * underwriting pipeline: derived metrics (Stage 0), information sufficiency
 * (Stage 1 / 1.1), risk assessment debits & flags (Stage 2), actuarial risk
 * classification (Stage 3) and the terminal underwriting decision (Stage 4).
 *
 * The legacy service emits the deterministic core envelope only; execution traces
 * and AI copilot briefs are capabilities of the GoRules TS engine.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class UnderwritingResponse {

    public static class DerivedMetrics {
        public double bmi;
        public double incomeMultiple;

        public DerivedMetrics(double bmi, double incomeMultiple) {
            this.bmi = bmi;
            this.incomeMultiple = incomeMultiple;
        }

        public double getBmi() { return bmi; }
        public double getIncomeMultiple() { return incomeMultiple; }
    }

    public static class MissingDocument {
        public String docCode;
        public String reason;

        public MissingDocument(String docCode, String reason) {
            this.docCode = docCode;
            this.reason = reason;
        }

        public String getDocCode() { return docCode; }
        public String getReason() { return reason; }
    }

    public static class Step1SufficientInfo {
        public boolean isSufficient;
        public List<MissingDocument> missingDocuments = new ArrayList<>();

        public boolean getIsSufficient() { return isSufficient; }
        public void setIsSufficient(boolean v) { this.isSufficient = v; }
        public List<MissingDocument> getMissingDocuments() { return missingDocuments; }
        public void setMissingDocuments(List<MissingDocument> v) { this.missingDocuments = v; }
    }

    public static class MatchedAssessmentRule {
        public String ruleId;
        public String outcome;
        public int debits;
        public String exclusionCode;
        public String reason;

        public MatchedAssessmentRule(String ruleId, String outcome, int debits, String exclusionCode, String reason) {
            this.ruleId = ruleId;
            this.outcome = outcome;
            this.debits = debits;
            this.exclusionCode = exclusionCode;
            this.reason = reason;
        }

        public String getRuleId() { return ruleId; }
        public String getOutcome() { return outcome; }
        public int getDebits() { return debits; }
        public String getExclusionCode() { return exclusionCode; }
        public String getReason() { return reason; }
    }

    public static class Step2RiskAssessment {
        public int totalEmDebits;
        public List<String> exclusionCodes = new ArrayList<>();
        public boolean hasDeclineTrigger;
        public boolean hasPostponeTrigger;
        public boolean hasComorbidityUncleanTrigger;
        public List<MatchedAssessmentRule> matchedAssessmentRules = new ArrayList<>();

        public int getTotalEmDebits() { return totalEmDebits; }
        public void setTotalEmDebits(int v) { this.totalEmDebits = v; }
        public List<String> getExclusionCodes() { return exclusionCodes; }
        public void setExclusionCodes(List<String> v) { this.exclusionCodes = v; }
        public boolean isHasDeclineTrigger() { return hasDeclineTrigger; }
        public void setHasDeclineTrigger(boolean v) { this.hasDeclineTrigger = v; }
        public boolean isHasPostponeTrigger() { return hasPostponeTrigger; }
        public void setHasPostponeTrigger(boolean v) { this.hasPostponeTrigger = v; }
        public boolean isHasComorbidityUncleanTrigger() { return hasComorbidityUncleanTrigger; }
        public void setHasComorbidityUncleanTrigger(boolean v) { this.hasComorbidityUncleanTrigger = v; }
        public List<MatchedAssessmentRule> getMatchedAssessmentRules() { return matchedAssessmentRules; }
        public void setMatchedAssessmentRules(List<MatchedAssessmentRule> v) { this.matchedAssessmentRules = v; }
    }

    public static class Step3RiskClassification {
        public String riskClass;
        public String actuarialTableRating;
        public int loadingPct;

        public Step3RiskClassification(String riskClass, String actuarialTableRating, int loadingPct) {
            this.riskClass = riskClass;
            this.actuarialTableRating = actuarialTableRating;
            this.loadingPct = loadingPct;
        }

        public String getRiskClass() { return riskClass; }
        public String getActuarialTableRating() { return actuarialTableRating; }
        public int getLoadingPct() { return loadingPct; }
    }

    public static class Step4UnderwritingDecision {
        public String finalDecision;
        public boolean isUncleanReferral;
        public int loadingPct;
        public List<String> exclusions = new ArrayList<>();
        public List<MissingDocument> requestedAdditionalInfo = new ArrayList<>();

        public String getFinalDecision() { return finalDecision; }
        public void setFinalDecision(String v) { this.finalDecision = v; }
        public boolean getIsUncleanReferral() { return isUncleanReferral; }
        public void setIsUncleanReferral(boolean v) { this.isUncleanReferral = v; }
        public int getLoadingPct() { return loadingPct; }
        public void setLoadingPct(int v) { this.loadingPct = v; }
        public List<String> getExclusions() { return exclusions; }
        public void setExclusions(List<String> v) { this.exclusions = v; }
        public List<MissingDocument> getRequestedAdditionalInfo() { return requestedAdditionalInfo; }
        public void setRequestedAdditionalInfo(List<MissingDocument> v) { this.requestedAdditionalInfo = v; }
    }

    public String applicantId;
    public DerivedMetrics derivedMetrics;
    public Step1SufficientInfo step1SufficientInfo;
    public Step2RiskAssessment step2RiskAssessment;
    public Step3RiskClassification step3RiskClassification;
    public Step4UnderwritingDecision step4UnderwritingDecision;

    public String getApplicantId() { return applicantId; }
    public void setApplicantId(String v) { this.applicantId = v; }
    public DerivedMetrics getDerivedMetrics() { return derivedMetrics; }
    public void setDerivedMetrics(DerivedMetrics v) { this.derivedMetrics = v; }
    public Step1SufficientInfo getStep1SufficientInfo() { return step1SufficientInfo; }
    public void setStep1SufficientInfo(Step1SufficientInfo v) { this.step1SufficientInfo = v; }
    public Step2RiskAssessment getStep2RiskAssessment() { return step2RiskAssessment; }
    public void setStep2RiskAssessment(Step2RiskAssessment v) { this.step2RiskAssessment = v; }
    public Step3RiskClassification getStep3RiskClassification() { return step3RiskClassification; }
    public void setStep3RiskClassification(Step3RiskClassification v) { this.step3RiskClassification = v; }
    public Step4UnderwritingDecision getStep4UnderwritingDecision() { return step4UnderwritingDecision; }
    public void setStep4UnderwritingDecision(Step4UnderwritingDecision v) { this.step4UnderwritingDecision = v; }
}
