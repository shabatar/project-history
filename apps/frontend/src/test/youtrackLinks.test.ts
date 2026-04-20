import { describe, it, expect } from 'vitest';
import { userUrl, issueUrl, baseFromUrl } from '../lib/youtrackLinks';

describe('youtrackLinks', () => {
  describe('userUrl', () => {
    it('builds a /users/<login> URL', () => {
      expect(userUrl('https://youtrack.example.com', 'alice')).toBe(
        'https://youtrack.example.com/users/alice',
      );
    });

    it('strips trailing slashes from the base', () => {
      expect(userUrl('https://youtrack.example.com/', 'alice')).toBe(
        'https://youtrack.example.com/users/alice',
      );
    });

    it('url-encodes logins with special characters', () => {
      expect(userUrl('https://yt', 'a.b@c')).toBe('https://yt/users/a.b%40c');
    });

    it('returns null for missing pieces', () => {
      expect(userUrl(null, 'alice')).toBeNull();
      expect(userUrl('https://yt', null)).toBeNull();
      expect(userUrl('', 'alice')).toBeNull();
      expect(userUrl('https://yt', '')).toBeNull();
    });
  });

  describe('issueUrl', () => {
    it('builds a /issue/<id> URL', () => {
      expect(issueUrl('https://youtrack.example.com', 'PROJ-123')).toBe(
        'https://youtrack.example.com/issue/PROJ-123',
      );
    });

    it('returns null for missing pieces', () => {
      expect(issueUrl(null, 'PROJ-123')).toBeNull();
      expect(issueUrl('https://yt', '')).toBeNull();
    });
  });

  describe('baseFromUrl', () => {
    it('extracts the origin from a full URL', () => {
      expect(baseFromUrl('https://youtrack.example.com/agiles/123')).toBe(
        'https://youtrack.example.com',
      );
    });

    it('supports http', () => {
      expect(baseFromUrl('http://internal:8080/x')).toBe('http://internal:8080');
    });

    it('returns null for non-http input', () => {
      expect(baseFromUrl('ftp://foo')).toBeNull();
      expect(baseFromUrl('')).toBeNull();
      expect(baseFromUrl(null)).toBeNull();
    });
  });
});
