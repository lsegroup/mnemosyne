/** Lower-case, letters and digits only, one dash between words: how a project name or GitLab path is compared and keyed. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
