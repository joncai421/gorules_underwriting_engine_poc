package com.poc.uw;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Entry point for the legacy underwriting service.
 *
 * This module intentionally contains rigid, hardcoded if-else business logic and
 * represents the "system of record" baseline that the GoRules TS engine is migrated
 * to and verified against (see parityVerifier.ts). Runs on port 8080.
 */
@SpringBootApplication
public class LegacyUwApplication {
    public static void main(String[] args) {
        SpringApplication.run(LegacyUwApplication.class, args);
    }
}
