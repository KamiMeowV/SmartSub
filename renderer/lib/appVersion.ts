import packageInfo from '../../package.json';

/**
 * The version people see. package.json `version` must stay valid semver (the
 * updater refuses anything else and the app would not start), so a build that
 * needs a fourth number, such as 3.12.2.2, sets `displayVersion` instead.
 */
export const appDisplayVersion: string =
  (packageInfo as { displayVersion?: string }).displayVersion ||
  packageInfo.version;
