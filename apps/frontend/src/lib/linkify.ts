/**
 * Resolve references in summary markdown to clickable links.
 *
 * Repository-agnostic: detects hosting provider from remote_url and builds
 * links accordingly. Supports GitHub, GitLab, Bitbucket, and configurable
 * issue trackers (YouTrack, Jira, GitHub Issues).
 */

import type { IssueTrackerType } from '../types';

export interface RepoContext {
  remote_url: string;
  name: string;
}

interface HostInfo {
  type: 'github' | 'gitlab' | 'bitbucket' | 'unknown';
  baseUrl: string;
  org: string;
  repo: string;
}

// ── Configurable issue tracker ──

let _trackerType: IssueTrackerType = 'none';
let _trackerBaseUrl = '';

/**
 * Configure how PROJECT-123 references are linked.
 *
 * @param type  - 'youtrack' | 'jira' | 'github' | 'none'
 * @param url   - Base URL, e.g. https://youtrack.example.com
 *                YouTrack: links to {url}/issue/PROJECT-123
 *                Jira:     links to {url}/browse/PROJECT-123
 *                GitHub:   not used for PROJECT-N (uses repo context)
 */
export function configureIssueTracker(type: IssueTrackerType, url: string) {
  _trackerType = type;
  _trackerBaseUrl = url.replace(/\/+$/, '');
}

function issueTrackerUrl(project: string, number: string): string | null {
  if (_trackerType === 'none' || !_trackerBaseUrl) return null;

  switch (_trackerType) {
    case 'youtrack':
      return `${_trackerBaseUrl}/issue/${project}-${number}`;
    case 'jira':
      return `${_trackerBaseUrl}/browse/${project}-${number}`;
    case 'github':
      // GitHub doesn't use PROJECT-N format — skip
      return null;
    default:
      return null;
  }
}

// ── Host detection ──

function parseHostInfo(remoteUrl: string): HostInfo {
  const cleaned = remoteUrl.replace(/\.git$/, '');

  const sshMatch = cleaned.match(/^git@([\w.\-]+):([\w.\-]+)\/([\w.\-]+)$/);
  if (sshMatch) {
    const [, hostname, org, repo] = sshMatch;
    const baseUrl = `https://${hostname}/${org}/${repo}`;
    if (hostname.includes('github.com')) return { type: 'github', baseUrl, org, repo };
    if (hostname.includes('gitlab.com')) return { type: 'gitlab', baseUrl, org, repo };
    if (hostname.includes('bitbucket.org')) return { type: 'bitbucket', baseUrl, org, repo };
    return { type: 'unknown', baseUrl, org, repo };
  }

  try {
    const url = new URL(cleaned);
    const parts = url.pathname.replace(/^\//, '').split('/');
    const org = parts[0] ?? '';
    const repo = parts[1] ?? '';
    const baseUrl = `${url.origin}/${org}/${repo}`;

    if (url.hostname.includes('github.com')) return { type: 'github', baseUrl, org, repo };
    if (url.hostname.includes('gitlab.com') || url.hostname.includes('gitlab')) return { type: 'gitlab', baseUrl, org, repo };
    if (url.hostname.includes('bitbucket.org')) return { type: 'bitbucket', baseUrl, org, repo };
    return { type: 'unknown', baseUrl, org, repo };
  } catch {
    return { type: 'unknown', baseUrl: cleaned, org: '', repo: '' };
  }
}

// ── Main linkify function ──

/**
 * Resolve references in already-HTML-escaped summary text.
 * Called AFTER markdownToHtml(), so we operate on HTML strings.
 */
export function linkifyReferences(html: string, context: RepoContext | null): string {
  if (!context) return html;

  const host = parseHostInfo(context.remote_url);

  // 1. Commit short-hashes: [abc1234] → link to commit
  html = html.replace(
    /\[([0-9a-f]{7,})\]/g,
    (_match, hash: string) => {
      const url = commitUrl(host, hash);
      if (url) {
        return `<a href="${url}" target="_blank" rel="noopener" class="ref-link ref-commit" title="View commit ${hash}">[${hash}]</a>`;
      }
      return `[${hash}]`;
    },
  );

  // 2. Cross-repo refs: org/repo#N
  html = html.replace(
    /([\w.\-]+\/[\w.\-]+)#(\d+)/g,
    (_match, repoPath: string, num: string) => {
      const url = `${new URL(host.baseUrl).origin}/${repoPath}/issues/${num}`;
      return `<a href="${url}" target="_blank" rel="noopener" class="ref-link ref-issue">${repoPath}#${num}</a>`;
    },
  );

  // 3. PROJECT-123 refs (any uppercase letters followed by dash and digits)
  //    Only linked if an issue tracker is configured
  if (_trackerType !== 'none' && _trackerBaseUrl) {
    html = html.replace(
      /\b([A-Z][A-Z0-9]+)-(\d+)\b/g,
      (_match, project: string, num: string) => {
        const url = issueTrackerUrl(project, num);
        if (!url) return `${project}-${num}`;
        return `<a href="${url}" target="_blank" rel="noopener" class="ref-link ref-issue">${project}-${num}</a>`;
      },
    );
  }

  // 4. #N refs (GitHub/GitLab style issue/PR numbers)
  html = html.replace(
    /(?<!="|\/)(#(\d+))\b/g,
    (_match, full: string, num: string) => {
      const url = issueOrPrUrl(host, num);
      if (url) {
        return `<a href="${url}" target="_blank" rel="noopener" class="ref-link ref-issue" title="Issue/PR ${full}">${full}</a>`;
      }
      return full;
    },
  );

  return html;
}

function commitUrl(host: HostInfo, hash: string): string | null {
  switch (host.type) {
    case 'github':
      return `${host.baseUrl}/commit/${hash}`;
    case 'gitlab':
      return `${host.baseUrl}/-/commit/${hash}`;
    case 'bitbucket':
      return `${host.baseUrl}/commits/${hash}`;
    default:
      return `${host.baseUrl}/commit/${hash}`;
  }
}

function issueOrPrUrl(host: HostInfo, num: string): string | null {
  switch (host.type) {
    case 'github':
      return `${host.baseUrl}/issues/${num}`;
    case 'gitlab':
      return `${host.baseUrl}/-/issues/${num}`;
    case 'bitbucket':
      return `${host.baseUrl}/issues/${num}`;
    default:
      return `${host.baseUrl}/issues/${num}`;
  }
}
