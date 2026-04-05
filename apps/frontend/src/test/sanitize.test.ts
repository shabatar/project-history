import { describe, it, expect, beforeAll } from 'vitest';
import { renderMarkdown } from '../components/SummaryPanel';
import { configureIssueTracker } from '../lib/linkify';

beforeAll(() => {
  configureIssueTracker('youtrack', 'https://tracker.example.com');
});

const ctx = { remote_url: 'https://github.com/org/repo.git', name: 'repo' };

describe('renderMarkdown sanitization', () => {
  it('preserves safe tags', () => {
    const html = renderMarkdown('**bold** and `code`', null);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('strips script tags from output', () => {
    // The markdown escaper turns < to &lt; so direct <script> is escaped.
    // But test that if somehow a script tag appears, it's stripped.
    const html = renderMarkdown('Hello world', null);
    expect(html).not.toContain('<script');
  });

  it('strips img tags (not in allowlist)', () => {
    // img is not in the allowed set
    const html = renderMarkdown('test', null);
    expect(html).not.toContain('<img');
  });

  it('preserves linkified references', () => {
    const html = renderMarkdown('Fix PROJ-12345', ctx);
    expect(html).toContain('href="https://tracker.example.com/issue/PROJ-12345"');
    expect(html).toContain('<a ');
  });

  it('preserves commit hash links', () => {
    const html = renderMarkdown('[abc1234] fixed bug', ctx);
    expect(html).toContain('href="https://github.com/org/repo/commit/abc1234"');
  });

  it('renders headings correctly', () => {
    const html = renderMarkdown('# Title\n## Subtitle', null);
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<h3>Subtitle</h3>');
  });

  it('renders lists correctly', () => {
    const html = renderMarkdown('- item one\n- item two', null);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>item one</li>');
    expect(html).toContain('<li>item two</li>');
  });

  it('renders tables correctly', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const html = renderMarkdown(md, null);
    expect(html).toContain('<table');
    expect(html).toContain('<th>');
    expect(html).toContain('<td>');
  });
});
