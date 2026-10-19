package com.poc.uw.service;

import com.poc.uw.model.ApplicantRequest;
import com.poc.uw.model.UnderwritingResponse;
import com.poc.uw.model.UnderwritingResponse.TriggeredRule;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * LEGACY hardcoded underwriting engine.
 *
 * <p>This is intentionally written as rigid, duplicated {@code if-else} blocks to
 * represent typical legacy technical debt. Each rule carries a machine-readable
 * {@code // UW_RULE <id> | <category> | <decision> | <loadingPct> | <reason>} marker
 * immediately above its {@code if} condition; that marker is what the deterministic
 * AST migrator ({@code astToJdmMigrator.ts}) scrapes to rebuild a GoRules decision table.
 *
 * <p>PARITY CONTRACT: to stay 100% behaviorally equivalent to the migrated GoRules JDM
 * (decision-table "collect" hit policy + aggregator function node), this service does NOT
 * short-circuit. It evaluates EVERY rule independently, collects all matches, de-duplicates
 * by ruleId (preserving table order), then resolves severity precedence
 * (DECLINE &gt; UNCLEAN &gt; CLEAN) and sums loadings (0 when the final decision is DECLINE).
 * Keep the rule ordering below in sync with {@code shared/rules/v1-migrated-rules.json}.
 */
@Service
public class HardcodedUnderwritingService {

    private static class Match {
        final String ruleId;
        final String category;
        final String decision;
        final int loadingPct;
        final String reason;

        Match(String ruleId, String category, String decision, int loadingPct, String reason) {
            this.ruleId = ruleId;
            this.category = category;
            this.decision = decision;
            this.loadingPct = loadingPct;
            this.reason = reason;
        }
    }

    public UnderwritingResponse underwrite(ApplicantRequest r) {
        int age = r.getAge();
        double bmi = r.getBmi();
        int systolicBp = r.getSystolicBp();
        boolean smoker = r.isSmoker();
        long sumAssured = r.getSumAssured();
        List<String> medicalConditions = r.getMedicalConditions() == null ? new ArrayList<>() : r.getMedicalConditions();

        List<Match> matches = new ArrayList<>();

        // ---- Knock-out (DECLINE) rules ----
        // UW_RULE RULE_AGE_KNOCKOUT | ELIGIBILITY | DECLINE | 0 | Applicant age outside insurable range 18-65
        if (age < 18 || age > 65) {
            matches.add(new Match("RULE_AGE_KNOCKOUT", "ELIGIBILITY", "DECLINE", 0, "Applicant age outside insurable range 18-65"));
        }
        // UW_RULE RULE_EXTREME_BMI | MEDICAL | DECLINE | 0 | Severe obesity BMI >= 38
        if (bmi >= 38.0) {
            matches.add(new Match("RULE_EXTREME_BMI", "MEDICAL", "DECLINE", 0, "Severe obesity BMI >= 38"));
        }
        // UW_RULE RULE_HYPERTENSIVE_CRISIS | MEDICAL | DECLINE | 0 | Systolic BP >= 180 uninsurable
        if (systolicBp >= 180) {
            matches.add(new Match("RULE_HYPERTENSIVE_CRISIS", "MEDICAL", "DECLINE", 0, "Systolic BP >= 180 uninsurable"));
        }

        // ---- Referral (UNCLEAN) rules (collect all) ----
        // UW_RULE RULE_BMI_COMORBIDITY | MEDICAL | UNCLEAN | 25 | BMI >= 28 combined with Fatty Liver requires medical review
        if (bmi >= 28.0 && medicalConditions.contains("FATTY_LIVER")) {
            matches.add(new Match("RULE_BMI_COMORBIDITY", "MEDICAL", "UNCLEAN", 25, "BMI >= 28 combined with Fatty Liver requires medical review"));
        }
        // UW_RULE RULE_BP_SMOKER_SYNERGY | MEDICAL | UNCLEAN | 50 | Elevated BP with smoking history requires cardiovascular assessment
        if (systolicBp >= 140 && systolicBp < 180 && smoker == true) {
            matches.add(new Match("RULE_BP_SMOKER_SYNERGY", "MEDICAL", "UNCLEAN", 50, "Elevated BP with smoking history requires cardiovascular assessment"));
        }
        // UW_RULE RULE_HIGH_SUM_ASSURED | FINANCIAL | UNCLEAN | 0 | High sum assured > 1M with sub-standard vitals requires senior referral
        if (sumAssured > 1000000 && (bmi >= 28.0 || systolicBp >= 140)) {
            matches.add(new Match("RULE_HIGH_SUM_ASSURED", "FINANCIAL", "UNCLEAN", 0, "High sum assured > 1M with sub-standard vitals requires senior referral"));
        }

        // ---- Auto-accept (CLEAN) rules ----
        // UW_RULE RULE_MILD_OVERWEIGHT_CLEAN | STANDARD | CLEAN | 10 | Mild overweight standard auto-loading
        if (bmi >= 25.0 && bmi < 28.0 && !smoker) {
            matches.add(new Match("RULE_MILD_OVERWEIGHT_CLEAN", "STANDARD", "CLEAN", 10, "Mild overweight standard auto-loading"));
        }

        // ---- Aggregation (mirrors the GoRules aggregator function node) ----
        Map<String, Match> unique = new LinkedHashMap<>();
        for (Match m : matches) {
            unique.putIfAbsent(m.ruleId, m);
        }
        List<Match> rules = new ArrayList<>(unique.values());

        boolean hasDecline = rules.stream().anyMatch(m -> "DECLINE".equals(m.decision));
        boolean hasUnclean = rules.stream().anyMatch(m -> "UNCLEAN".equals(m.decision));
        String decision = hasDecline ? "DECLINE" : hasUnclean ? "UNCLEAN" : "CLEAN";

        UnderwritingResponse resp = new UnderwritingResponse();
        resp.setDecision(decision);
        resp.setBasePremiumLoadingPct(hasDecline ? 0 : rules.stream().mapToInt(m -> m.loadingPct).sum());

        List<TriggeredRule> triggered = new ArrayList<>();
        for (Match m : rules) {
            triggered.add(new TriggeredRule(m.ruleId, m.category, m.reason));
        }
        if (triggered.isEmpty()) {
            triggered.add(new TriggeredRule("RULE_STANDARD_CLEAN", "STANDARD", "Standard clean acceptance"));
        }
        resp.setTriggeredRules(triggered);
        return resp;
    }
}
