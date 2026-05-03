#!/usr/bin/env bun
/**
 * Print the effective `loadConfig()` result for the current install,
 * focused on `globalMcp:` resolution. Useful for verifying that the
 * source-shipped bundled config is being read correctly without
 * needing to spin up the server, hit it via Slack, and grep
 * CloudWatch logs.
 *
 * Usage:
 *   bun run scripts/check-config.ts                  # no repoPath
 *   bun run scripts/check-config.ts /path/to/repo    # with repoPath
 *
 * Run from any cwd — install dir is derived from `import.meta.dir`,
 * not `process.cwd()`. That's the same resolution the running server
 * uses, so this script is a faithful preview of production behavior.
 */
import { loadConfig, loadBundledConfig } from '../packages/core/src/config/config-loader.ts';
import {
  getInstallDir,
  getBundledConfigPath,
  getAppArchonBasePath,
  getArchonHome,
  getArchonConfigPath,
} from '../packages/paths/src/index.ts';

const repoPath = process.argv[2];

console.log('=== paths ===');
console.log('process.cwd():     ', process.cwd());
console.log('getInstallDir():   ', getInstallDir());
console.log('getAppArchonBasePath():', getAppArchonBasePath());
console.log('getArchonHome():   ', getArchonHome());
console.log('bundledConfigPath:', getBundledConfigPath());
console.log('globalConfigPath: ', getArchonConfigPath());
console.log('repoPath arg:     ', repoPath ?? '(none)');

console.log('\n=== bundled config (raw) ===');
const bundled = await loadBundledConfig();
console.log(JSON.stringify(bundled, null, 2));

console.log('\n=== merged config (relevant fields) ===');
const config = await loadConfig(repoPath);
console.log(
  JSON.stringify(
    {
      assistant: config.assistant,
      globalMcp: config.globalMcp,
      envVars: config.envVars,
      userEnvVars: config.userEnvVars ? Object.keys(config.userEnvVars) : undefined,
    },
    null,
    2
  )
);

if (!config.globalMcp || config.globalMcp.length === 0) {
  console.error('\nWARN: config.globalMcp is empty — no global MCPs will be merged at sendQuery.');
  process.exit(1);
}
console.log('\nOK:', config.globalMcp.length, 'global MCP file(s) configured.');
