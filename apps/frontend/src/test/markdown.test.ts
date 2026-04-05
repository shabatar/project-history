import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../components/SummaryPanel';

describe('renderMarkdown', () => {
  it('renders headings', () => {
    const html = renderMarkdown('## Title\n### Subtitle', null);
    expect(html).toContain('<h3>Title</h3>');
    expect(html).toContain('<h4>Subtitle</h4>');
  });

  it('renders bullet lists', () => {
    const html = renderMarkdown('- Item one\n- Item two', null);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Item one</li>');
    expect(html).toContain('<li>Item two</li>');
    expect(html).toContain('</ul>');
  });

  it('renders ordered lists', () => {
    const html = renderMarkdown('1. First\n2. Second', null);
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>First</li>');
  });

  it('renders bold and italic', () => {
    const html = renderMarkdown('**bold** and *italic*', null);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders inline code', () => {
    const html = renderMarkdown('Use `git log` command', null);
    expect(html).toContain('<code>git log</code>');
  });

  it('renders horizontal rules', () => {
    const html = renderMarkdown('Above\n---\nBelow', null);
    expect(html).toMatch(/<hr\s*\/?>/);
  });

  it('renders tables', () => {
    const md = '| Name | Value |\n| --- | --- |\n| A | 1 |\n| B | 2 |';
    const html = renderMarkdown(md, null);
    expect(html).toContain('<table');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td>A</td>');
    expect(html).toContain('<td>2</td>');
  });

  it('escapes HTML entities', () => {
    const html = renderMarkdown('Use <script> & "quotes"', null);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<script>');
  });

  it('handles empty input', () => {
    const html = renderMarkdown('', null);
    expect(html).toBe('');
  });

  it('renders paragraphs for plain text', () => {
    const html = renderMarkdown('Hello world', null);
    expect(html).toContain('<p>Hello world</p>');
  });

  it('integrates linkify for commit refs', () => {
    const ctx = { remote_url: 'https://github.com/org/repo.git', name: 'repo' };
    const html = renderMarkdown('[abc1234] Fixed bug', ctx);
    expect(html).toContain('href="https://github.com/org/repo/commit/abc1234"');
  });
});
