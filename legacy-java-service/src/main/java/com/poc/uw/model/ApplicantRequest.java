package com.poc.uw.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.ArrayList;
import java.util.List;

/**
 * Canonical input payload (PRD v2 section 3.1) shared across the legacy Java service
 * and the GoRules TS engine. Raw biometric/financial values are supplied so BOTH engines
 * compute the derived metrics (bmi, incomeMultiple) with identical formulas in their
 * Stage-0 step. Unknown properties are tolerated; collections default to empty.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ApplicantRequest {

    public String applicantId;
    public int age;
    public double heightCm;
    public double weightKg;
    public boolean smoker;
    public int systolicBp;
    public double annualIncome;
    public long sumAssured;
    public int occupationClass;
    public int recentSurgeryMonthsAgo;
    public List<String> medicalConditions = new ArrayList<>();
    public List<String> submittedDocuments = new ArrayList<>();
    /** Optional (PRD v2 extension for the onboarded avocation rule). */
    public List<String> avocations = new ArrayList<>();

    public String getApplicantId() { return applicantId; }
    public void setApplicantId(String v) { this.applicantId = v; }

    public int getAge() { return age; }
    public void setAge(int v) { this.age = v; }

    public double getHeightCm() { return heightCm; }
    public void setHeightCm(double v) { this.heightCm = v; }

    public double getWeightKg() { return weightKg; }
    public void setWeightKg(double v) { this.weightKg = v; }

    public boolean isSmoker() { return smoker; }
    public void setSmoker(boolean v) { this.smoker = v; }

    public int getSystolicBp() { return systolicBp; }
    public void setSystolicBp(int v) { this.systolicBp = v; }

    public double getAnnualIncome() { return annualIncome; }
    public void setAnnualIncome(double v) { this.annualIncome = v; }

    public long getSumAssured() { return sumAssured; }
    public void setSumAssured(long v) { this.sumAssured = v; }

    public int getOccupationClass() { return occupationClass; }
    public void setOccupationClass(int v) { this.occupationClass = v; }

    public int getRecentSurgeryMonthsAgo() { return recentSurgeryMonthsAgo; }
    public void setRecentSurgeryMonthsAgo(int v) { this.recentSurgeryMonthsAgo = v; }

    public List<String> getMedicalConditions() { return medicalConditions; }
    public void setMedicalConditions(List<String> v) { this.medicalConditions = v == null ? new ArrayList<>() : v; }

    public List<String> getSubmittedDocuments() { return submittedDocuments; }
    public void setSubmittedDocuments(List<String> v) { this.submittedDocuments = v == null ? new ArrayList<>() : v; }

    public List<String> getAvocations() { return avocations; }
    public void setAvocations(List<String> v) { this.avocations = v == null ? new ArrayList<>() : v; }
}
