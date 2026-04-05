import { describe, it, expect, beforeAll } from 'vitest';
import { linkifyReferences, configureIssueTracker } from '../lib/linkify';

beforeAll(() => {
  configureIssueTracker('youtrack', 'https://tracker.example.com');
});

const github = { remote_url: 'https://github.com/org/repo.git', name: 'repo' };
const gitlab = { remote_url: 'https://gitlab.com/org/repo.git', name: 'repo' };

describe('linkifyReferences', () => {
  it('links commit hashes to GitHub', () => {
    const html = linkifyReferences('[abc1234] fixed bug', github);
    expect(html).toContain('href="https://github.com/org/repo/commit/abc1234"');
    expect(html).toContain('class="ref-link ref-commit"');
  });

  it('links commit hashes to GitLab', () => {
    const html = linkifyReferences('[def5678] update', gitlab);
    expect(html).toContain('href="https://gitlab.com/org/repo/-/commit/def5678"');
  });

  it('links #N issue refs to GitHub', () => {
    const html = linkifyReferences('Fixes #42 and #100', github);
    expect(html).toContain('href="https://github.com/org/repo/issues/42"');
    expect(html).toContain('href="https://github.com/org/repo/issues/100"');
  });

  it('links PROJECT-N refs to configured issue tracker', () => {
    const html = linkifyReferences('Fix PROJ-12345 timeout', github);
    expect(html).toContain('href="https://tracker.example.com/issue/PROJ-12345"');
  });

  it('links any PROJECT-N pattern', () => {
    const html = linkifyReferences('Fix TASK-42345 issue', github);
    expect(html).toContain('href="https://tracker.example.com/issue/TASK-42345"');
  });

  it('links cross-repo refs', () => {
    const html = linkifyReferences('See frontend/ui#15', github);
    expect(html).toContain('href="https://github.com/frontend/ui/issues/15"');
  });

  it('returns unmodified text when no context', () => {
    const html = linkifyReferences('Fix #42', null);
    expect(html).toBe('Fix #42');
  });

  it('does not break plain text', () => {
    const html = linkifyReferences('No refs here', github);
    expect(html).toBe('No refs here');
  });

  it('handles .git suffix in URL', () => {
    const ctx = { remote_url: 'https://github.com/user/project.git', name: 'project' };
    const html = linkifyReferences('[aaa1111] msg', ctx);
    expect(html).toContain('github.com/user/project/commit/aaa1111');
  });

  it('resolves SSH URLs to HTTPS links', () => {
    const ssh = { remote_url: 'git@github.com:org/repo.git', name: 'repo' };
    const html = linkifyReferences('[abc1234] fix #42', ssh);
    expect(html).toContain('href="https://github.com/org/repo/commit/abc1234"');
    expect(html).toContain('href="https://github.com/org/repo/issues/42"');
  });

  it('resolves GitLab SSH URLs', () => {
    const ssh = { remote_url: 'git@gitlab.com:team/project.git', name: 'project' };
    const html = linkifyReferences('[def5678] update', ssh);
    expect(html).toContain('href="https://gitlab.com/team/project/-/commit/def5678"');
  });

  it('links PROJECT-N using Jira format when configured', () => {
    configureIssueTracker('jira', 'https://jira.example.com');
    const html = linkifyReferences('Fix PROJ-99 bug', github);
    expect(html).toContain('href="https://jira.example.com/browse/PROJ-99"');
    // Reset for other tests
    configureIssueTracker('youtrack', 'https://tracker.example.com');
  });

  it('does not link PROJECT-N when tracker is none', () => {
    configureIssueTracker('none', '');
    const html = linkifyReferences('See PROJ-99', github);
    expect(html).not.toContain('<a');
    expect(html).toContain('PROJ-99');
    configureIssueTracker('youtrack', 'https://tracker.example.com');
  });
});
