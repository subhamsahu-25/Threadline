import fs from 'node:fs/promises';

// Reads the JSON report written by `vitest --reporter=json` and prints the
// numbers the docs cite, so nobody has to count tests by hand.
const path = process.argv[2] || 'test-results.json';
const report = JSON.parse(await fs.readFile(path, 'utf8'));

const suites = report.numTotalTestSuites ?? report.testResults?.length ?? 0;
const tests = report.numTotalTests ?? 0;
const failed = report.numFailedTests ?? 0;
const passed = report.numPassedTests ?? tests - failed;
const duration = Number(report.startTime && report.endTime ? report.endTime - report.startTime : 0);

console.log(
  `${suites} suites, ${tests} tests, ${passed} passed, ${failed} failed` +
    (duration > 0 ? `, ${(duration / 1000).toFixed(1)} s` : ''),
);
if (failed > 0) process.exitCode = 1;
