/** The version of this release. Keep it equal to the "version" of the package.json files (a test checks it). */
export const VERSION = '0.6.0';

/** How people see it: 0.6.0 is shown as "0.6", 0.6.1 stays "0.6.1". */
export function shownVersion(version: string = VERSION): string {
  return version.replace(/\.0$/, '');
}
