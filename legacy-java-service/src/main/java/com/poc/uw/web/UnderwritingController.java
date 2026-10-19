package com.poc.uw.web;

import com.poc.uw.model.ApplicantRequest;
import com.poc.uw.model.UnderwritingResponse;
import com.poc.uw.service.HardcodedUnderwritingService;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Legacy REST surface. Runs on port 8080 (see application.properties). The parity
 * verifier posts the canonical ApplicantRequest payloads here and diffs the results
 * against the GoRules TS engine on port 3001.
 */
@RestController
@RequestMapping("/api/legacy")
public class UnderwritingController {

    private final HardcodedUnderwritingService service;

    public UnderwritingController(HardcodedUnderwritingService service) {
        this.service = service;
    }

    @PostMapping("/underwrite")
    public UnderwritingResponse underwrite(@RequestBody ApplicantRequest request) {
        return service.underwrite(request);
    }
}
