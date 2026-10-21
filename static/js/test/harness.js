/**
 * Minimal test harness with shared counters.
 */

const counters = { passed: 0, failed: 0 };

function assert(condition, message) {
    if (condition) {
        counters.passed++;
        console.log(`  ✓ ${message}`);
    } else {
        counters.failed++;
        console.log(`  ✗ ${message}`);
    }
}

function assertEqual(actual, expected, message) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    if (pass) {
        counters.passed++;
        console.log(`  ✓ ${message}`);
    } else {
        counters.failed++;
        console.log(`  ✗ ${message}`);
        console.log(`    Expected: ${JSON.stringify(expected)}`);
        console.log(`    Actual:   ${JSON.stringify(actual)}`);
    }
}

function describe(name, fn) {
    console.log(`\n${name}`);
    fn();
}

function it(name, fn) {
    try {
        fn();
    } catch (e) {
        counters.failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    Error: ${e.message}`);
    }
}

module.exports = { counters, assert, assertEqual, describe, it };
