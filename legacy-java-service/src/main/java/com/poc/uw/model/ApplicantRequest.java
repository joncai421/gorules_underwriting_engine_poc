package com.poc.uw.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.ArrayList;
import java.util.List;

/**
 * Canonical input payload shared across the legacy Java service and the GoRules TS
 * engine (see PRD section 3.1). Unknown properties are tolerated to keep contract
 * evolution (e.g. newly onboarded fields) non-breaking for the legacy baseline.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class ApplicantRequest {

    public String applicantId;
    public int age;
    public double bmi;
    public boolean smoker;
    public int systolicBp;
    public long sumAssured;
    public List<String> medicalConditions = new ArrayList<>();
    public int occupationClass;

    public String getApplicantId() { return applicantId; }
    public void setApplicantId(String applicantId) { this.applicantId = applicantId; }

    public int getAge() { return age; }
    public void setAge(int age) { this.age = age; }

    public double getBmi() { return bmi; }
    public void setBmi(double bmi) { this.bmi = bmi; }

    public boolean isSmoker() { return smoker; }
    public void setSmoker(boolean smoker) { this.smoker = smoker; }

    public int getSystolicBp() { return systolicBp; }
    public void setSystolicBp(int systolicBp) { this.systolicBp = systolicBp; }

    public long getSumAssured() { return sumAssured; }
    public void setSumAssured(long sumAssured) { this.sumAssured = sumAssured; }

    public List<String> getMedicalConditions() { return medicalConditions; }
    public void setMedicalConditions(List<String> medicalConditions) {
        this.medicalConditions = medicalConditions == null ? new ArrayList<>() : medicalConditions;
    }

    public int getOccupationClass() { return occupationClass; }
    public void setOccupationClass(int occupationClass) { this.occupationClass = occupationClass; }
}
