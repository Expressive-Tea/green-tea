// API report per export-map entry (CARD-22, D20). Reads the `.d.ts` that `tsup` emits, so run
// `npm run build` first. `npm run api:check` fails when a report in `api/` differs from what the
// build declares; `npm run api` rewrites them. A deliberate API change is a regenerated report in
// the same PR, which is what makes the change visible to a reviewer at all.
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const check = process.argv.includes('--check');
const root = resolve(import.meta.dirname, '..');
const entries = ['index', 'deno', 'bun', 'edge'];
let failed = false;

// An adapter's signatures name root types (`App`, `Logger`, …) that its own entry does not
// re-export. Those are nameable from `@green-tea/core`, so they pass; anything else still fails.
const rootExports = new Set(
  [...readFileSync(resolve(root, 'dist/index.d.ts'), 'utf8').matchAll(/export \{([^}]*)\}/g)]
    .flatMap((m) => m[1].split(','))
    .map((name) => name.trim().replace(/^type /, '').split(' as ').pop()),
);
const exportedByRoot = (message) =>
  message.messageId === 'ae-forgotten-export' && rootExports.has(/The symbol "([^"]+)"/.exec(message.text)?.[1]);

for (const entry of entries) {
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: root,
      mainEntryPointFilePath: `<projectFolder>/dist/${entry}.d.ts`,
      compiler: { tsconfigFilePath: '<projectFolder>/tsconfig.json' },
      apiReport: {
        enabled: true,
        reportFileName: `${entry}.api.md`,
        reportFolder: '<projectFolder>/api/',
        reportTempFolder: '<projectFolder>/node_modules/.cache/api-extractor/',
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        // The report records the surface; it is not a TSDoc linter. The one message that fails the
        // run is a public signature naming a type the entry does not export (D19).
        compilerMessageReporting: { default: { logLevel: 'warning' } },
        extractorMessageReporting: {
          default: { logLevel: 'none' },
          'ae-forgotten-export': { logLevel: 'error', addToApiReportFile: false },
        },
        tsdocMessageReporting: { default: { logLevel: 'none' } },
      },
    },
    configObjectFullPath: resolve(root, 'api-extractor.json'),
    packageJsonFullPath: resolve(root, 'package.json'),
  });

  const result = Extractor.invoke(config, {
    localBuild: !check,
    messageCallback: (message) => {
      if (entry !== 'index' && exportedByRoot(message)) message.logLevel = 'none';
    },
  });
  if (!result.succeeded) {
    failed = true;
    console.error(
      check && result.apiReportChanged
        ? `api/${entry}.api.md is out of date: run \`npm run build && npm run api\` and commit the report.`
        : `api report for ${entry} failed (${result.errorCount} error(s)).`,
    );
  }
}

process.exit(failed ? 1 : 0);
