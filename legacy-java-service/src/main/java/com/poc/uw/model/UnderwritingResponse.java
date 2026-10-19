package com.poc.uw.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.ArrayList;
import java.util.List;

/**
 * Canonical output payload (see PRD section 3.2). The legacy service only emits the
 * deterministic core result; execution traces and AI copilot briefs are capabilities of
 * the GoRules TS engine, so those fields are intentionally absent here.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class UnderwritingResponse {

    public static class TriggeredRule {
        public String ruleId;
        public String category;
        public String reason;

        public TriggeredRule() {}

        public TriggeredRule(String ruleId, String category, String reason) {
            this.ruleId = ruleId;
            this.category = category;
            this.reason = reason;
        }

        public String getRuleId() { return ruleId; }
        public String getCategory() { return category; }
        public String getReason() { return reason; }
    }

    /** Strictly "CLEAN" | "UNCLEAN" | "DECLINE". */
    public String decision;
    public int basePremiumLoadingPct;
    public List<TriggeredRule> triggeredRules = new ArrayList<>();

    public String getDecision() { return decision; }
    public void setDecision(String decision) { this.decision = decision; }

    public int getBasePremiumLoadingPct() { return basePremiumLoadingPct; }
    public void setBasePremiumLoadingPct(int basePremiumLoadingPct) { this.basePremiumLoadingPct = basePremiumLoadingPct; }

    public List<TriggeredRule> getTriggeredRules() { return triggeredRules; }
    public void setTriggeredRules(List<TriggeredRule> triggeredRules) { this.triggeredRules = triggeredRules; }
}
