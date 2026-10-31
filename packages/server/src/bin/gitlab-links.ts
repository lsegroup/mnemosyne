#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { notesProjectNames, syncGitLabLinks } from '../gitlab-links.js';

/**
 * Puts the "Mnemosyne Wiki" link (External wiki + badge) into every GitLab project. Dry run unless --apply.
 *   GITLAB_TOKEN=... node dist/bin/gitlab-links.js --gitlab-url https://gitlab.example.com --portal-url https://host:40000/mnemosyne --nodes ./nodes --apply
 * The token (api scope, Maintainer on the projects) is read from the environment only, never from the command line.
 */
const { values } = parseArgs({
  options: {
    'gitlab-url': { type: 'string' },
    'portal-url': { type: 'string' },
    nodes: { type: 'string', default: './nodes' },
    apply: { type: 'boolean', default: false },
    only: { type: 'string', multiple: true },
    'no-badge': { type: 'boolean', default: false },
    'no-wiki': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const env = process.env;
const gitlabUrl = values['gitlab-url'] ?? env.MNEMOSYNE_GITLAB_URL ?? env.CI_SERVER_URL;
const portalUrl = values['portal-url'] ?? (env.MNEMOSYNE_PUBLIC_URL ? `${env.MNEMOSYNE_PUBLIC_URL.replace(/\/+$/, '')}${env.MNEMOSYNE_BASE_PATH ?? '/mnemosyne'}` : undefined);
const token = env.GITLAB_TOKEN ?? env.GITLAB_PAT;

if (values.help || !gitlabUrl || !portalUrl || !token) {
  console.error(
    'usage: GITLAB_TOKEN=<api token> gitlab-links --gitlab-url <url> --portal-url <https://host:40000/mnemosyne> [--nodes ./nodes] [--only group/project]... [--no-badge] [--no-wiki] [--apply]\n' +
      'Without --apply nothing is changed: it only prints what would be done. Defaults: MNEMOSYNE_GITLAB_URL / CI_SERVER_URL, MNEMOSYNE_PUBLIC_URL + MNEMOSYNE_BASE_PATH.',
  );
  process.exit(values.help ? 0 : 2);
}

const result = await syncGitLabLinks({
  gitlabUrl,
  token,
  portalUrl,
  notesProjects: await notesProjectNames(values.nodes!),
  apply: values.apply!,
  only: values.only,
  badge: !values['no-badge'],
  wikiLink: !values['no-wiki'],
  log: (l) => console.log(l),
});
const c = (x: { create: number; update: number; ok: number }) => `${x.create} ${values.apply ? 'created' : 'to create'}, ${x.update} ${values.apply ? 'updated' : 'to update'}, ${x.ok} already right`;
console.log(`\n${values.apply ? 'APPLIED' : 'DRY RUN (nothing changed)'}: ${result.projects} projects | wiki link: ${c(result.wiki)} | badge: ${c(result.badge)} | failed: ${result.failed.length}`);
process.exit(result.failed.length ? 1 : 0);
