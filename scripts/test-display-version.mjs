/**
 * The version a build shows (displayVersion, e.g. 3.12.2.2) and the version the
 * app runs with (package.json `version`) must stay consistent. electron-updater
 * refuses a version that is not semver, and the app then does not start.
 *
 *   node --test scripts/test-display-version.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import semver from 'semver';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const builderConfig = fs.readFileSync('electron-builder.yml', 'utf8');
const shown = packageJson.displayVersion || packageJson.version;

test('the app version stays semver, so the updater can start', () => {
  assert.ok(
    semver.valid(packageJson.version),
    `package.json version "${packageJson.version}" is not semver; put extra numbers in displayVersion`,
  );
});

test('the shown version extends the app version', () => {
  assert.ok(
    shown === packageJson.version ||
      shown.startsWith(`${packageJson.version}.`),
    `displayVersion "${shown}" does not start with "${packageJson.version}."`,
  );
});

test('installers and file metadata carry the shown version', () => {
  const buildVersion = builderConfig.match(/^buildVersion:\s*(\S+)\s*$/m)?.[1];
  assert.equal(buildVersion, shown, 'electron-builder.yml buildVersion');
  const names = [...builderConfig.matchAll(/artifactName:\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
  assert.equal(names.length, 3);
  for (const name of names) assert.match(name, /\$\{buildVersion\}/, name);
});
