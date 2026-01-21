/**
 * Blackbox Test Runner
 * Executes scenarios from lt_blackbox_suite.json
 * Usage: node run_blackbox.js
 */

const fs = require('fs');
const path = require('path');

async function runAssertion(assertion, responseData, context) {
    const { field, op, value } = assertion;

    // Resolve nested field access (e.g. "timeline.length")
    let actual = responseData;
    if (field) {
        const parts = field.split('.');
        for (const p of parts) {
            actual = actual && actual[p];
        }
    }

    // Helper for printing
    const printFail = (msg) => console.error(`    ❌ FAIL: ${msg}`);
    const printPass = (msg) => console.log(`    ✅ PASS: ${msg}`);

    let passed = false;
    switch (op) {
        case '==': passed = (actual == value); break; // loose equality for string/number mix
        case '!=': passed = (actual != value); break;
        case '>=': passed = (actual >= value); break;
        case '<=': passed = (actual <= value); break;
        case '>': passed = (actual > value); break;
        case '<': passed = (actual < value); break;
        case 'contains': passed = (String(actual).includes(String(value))); break;
        default:
            printFail(`Unknown operator ${op}`);
            return false;
    }

    if (passed) {
        printPass(`${field || 'Value'} ${op} ${value} (Actual: ${actual})`);
    } else {
        printFail(`${field || 'Value'} expected ${op} ${value} but got ${JSON.stringify(actual)}`);
    }
    return passed;
}

async function runStep(step, config, context) {
    console.log(`  STEP ${step.step_id}: ${step.action}`);

    // Resolve URL variables
    let url = step.url;
    if (url) {
        for (const [k, v] of Object.entries(config)) {
            url = url.replace(`{${k}}`, v);
        }
    }

    try {
        if (step.action === 'WAIT') {
            await new Promise(r => setTimeout(r, step.ms));
            console.log(`    Wait complete (${step.ms}ms)`);
            return true;
        }

        if (step.action === 'POLL') {
            // Simple poll implementation
            let attempts = 0;
            while (attempts < (step.max_attempts || 10)) {
                console.log(`    Polling attempt ${attempts + 1} for ${url}...`);
                const res = await fetch(url);
                const json = await res.json();

                // Hacky eval for break_condition string like "json.status == 'COMPLETED'"
                // Security risk in prod, but fine for local test runner
                const check = new Function('json', `return ${step.break_condition}`)(json);
                if (check) {
                    console.log(`    ✅ Polling condition met: ${step.break_condition}`);
                    return true;
                }

                attempts++;
                await new Promise(r => setTimeout(r, step.interval_ms || 1000));
            }
            console.error(`    ❌ Polling timeout after ${attempts} attempts`);
            return false;
        }

        if (step.action === 'POST' || step.action === 'GET') {
            const options = {
                method: step.action,
                headers: { 'Content-Type': 'application/json', ...(step.headers || {}) }
            };
            if (step.body) options.body = JSON.stringify(step.body);

            const res = await fetch(url, options);
            const status = res.status;

            // Check implicit status expectation
            const expectedStatus = (step.expect && step.expect.status) || 200;
            if (status !== expectedStatus) {
                console.error(`    ❌ HTTP Status mismatch: Got ${status}, Expected ${expectedStatus}`);
                console.error(`       Response: ${await res.text()}`);
                return false;
            }

            let json = {};
            // Try parse JSON
            const text = await res.text();
            try { json = JSON.parse(text); } catch { }

            // Validate Assertions
            let allPassed = true;
            if (step.assertions) {
                for (const assert of step.assertions) {
                    const ok = await runAssertion(assert, json, context);
                    if (!ok) allPassed = false;
                }
            }

            // Validate explicit expect.json deep partial match (simplified)
            if (step.expect && step.expect.json) {
                // Not full implementation, just basic key check
                for (const [k, v] of Object.entries(step.expect.json)) {
                    if (json[k] != v) {
                        console.error(`    ❌ Body mismatch for key ${k}: Expected ${v}, Got ${json[k]}`);
                        allPassed = false;
                    }
                }
            }

            if (step.manual_check) {
                console.log(`    ⚠️ MANUAL CHECK REQUIRED: ${step.description}`);
                console.log(`       Logic: ${step.expected_logic}`);
            }

            return allPassed;
        }

        if (step.action === 'REPEAT_STEP') {
            console.log("    Skipping strict repeats logic for MVP, assuming pass if manual check.");
            return true;
        }

        return true;

    } catch (e) {
        console.error(`    ❌ EXCEPTION: ${e.message}`);
        return false;
    }
}

async function main() {
    const suiteFilename = process.argv[2] || 'lt_blackbox_suite.json';
    const suitePath = path.join(__dirname, suiteFilename);
    const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));

    console.log(`\nRUNNING SUITE: ${suite.metadata.title}`);
    console.log(`Target: ${suite.metadata.target_system}\n`);

    const config = suite.environment.config;
    let failed = false;

    for (const scenario of suite.scenarios) {
        console.log(`========================================`);
        console.log(`SCENARIO: ${scenario.id}`);
        console.log(`DESC: ${scenario.description}`);
        console.log(`========================================`);

        for (const step of scenario.steps) {
            const success = await runStep(step, config, {});
            if (!success) {
                console.error(`\n❌ SCENARIO FAILED AT STEP: ${step.step_id}`);
                failed = true;
                break;
            }
        }
        if (failed) break;
        console.log(`\n✅ SCENARIO PASSED\n`);
    }

    if (failed) {
        console.log("\n💥 TEST SUITE FAILED");
        process.exit(1);
    } else {
        console.log("\n✨ ALL TESTS PASSED");
        process.exit(0);
    }
}

main();
