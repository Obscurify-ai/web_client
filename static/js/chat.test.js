/**
 * Tests for chat.js functionality
 * Run with: node static/js/chat.test.js
 */

// Setup mocks before anything else
require('./test/setup');

// Load test suites
require('./test/sidebar.test');
require('./test/favorites.test');
require('./test/provider-picker.test');
require('./test/messages.test');
require('./test/misc.test');
require('./test/local-mode.test');
require('./test/thinking.test');
require('./test/delete-retry.test');

// Report results
const { counters } = require('./test/harness');

console.log('\n========================================');
console.log('Chat.js Test Results');
console.log('========================================');

console.log(`\n----------------------------------------`);
console.log(`Total: ${counters.passed + counters.failed} tests`);
console.log(`Passed: ${counters.passed}`);
console.log(`Failed: ${counters.failed}`);
console.log(`----------------------------------------\n`);

process.exit(counters.failed > 0 ? 1 : 0);
