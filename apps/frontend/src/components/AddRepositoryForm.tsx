import { useState, useMemo, useRef } from 'react';

type Mode = 'remote' | 'local';

interface Props {
  onAddRemote: (url: string) => void;
  onAddLocal: (path: string) => void;
  disabled?: boolean;
}

// HTTPS: https://host/path (with or without .git)
const HTTPS_RE = /^https?:\/\/[\w.\-]+(:\d+)?\/[\w.\-/]+$/;
// SSH: git@host:user/repo (with or without .git)
const SSH_RE = /^git@[\w.\-]+:[\w.\-]+\/[\w.\-/]+$/;

function inferName(input: string, mode: Mode): string | null {
  try {
    if (mode === 'local') {
      const parts = input.replace(/\/+$/, '').split('/');
      return parts[parts.length - 1] || null;
    }
    // Handle SSH: git@github.com:user/repo.git → repo
    if (input.includes(':') && input.startsWith('git@')) {
      const afterColon = input.split(':')[1] ?? '';
      return afterColon.replace(/\.git$/, '').split('/').pop() || null;
    }
    const path = input.replace(/\.git$/, '').split('/').pop();
    return path || null;
  } catch {
    return null;
  }
}

function validateRemoteUrl(url: string): string | null {
  if (!url) return null;
  if (SSH_RE.test(url)) return null;
  if (HTTPS_RE.test(url)) return null;
  if (url.startsWith('git@')) {
    return 'SSH format: git@host:user/repo';
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return 'Enter a valid git URL (https://host/user/repo)';
  }
  return 'Enter an HTTPS or SSH URL';
}

function validateLocalPath(path: string): string | null {
  if (!path) return null;
  if (!path.startsWith('/')) {
    return 'Enter an absolute path (starting with /)';
  }
  if (path.length < 2) {
    return 'Path is too short';
  }
  return null;
}

/** Check if the modern File System Access API is available (Chrome/Edge). */
function hasDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export default function AddRepositoryForm({ onAddRemote, onAddLocal, disabled }: Props) {
  const [mode, setMode] = useState<Mode>('remote');
  const [input, setInput] = useState('');
  const [touched, setTouched] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trimmed = input.trim();
  const validate = mode === 'remote' ? validateRemoteUrl : validateLocalPath;
  const error = useMemo(() => (touched ? validate(trimmed) : null), [trimmed, touched, mode]);
  const name = useMemo(() => inferName(trimmed, mode), [trimmed, mode]);
  const valid = trimmed.length > 0 && !validate(trimmed);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setBrowseError(null);
    if (!valid) return;
    if (mode === 'remote') {
      onAddRemote(trimmed);
    } else {
      onAddLocal(trimmed);
    }
    setInput('');
    setTouched(false);
  }

  function switchMode(m: Mode) {
    setMode(m);
    setInput('');
    setTouched(false);
    setBrowseError(null);
  }

  async function handleBrowse() {
    setBrowseError(null);

    // Modern API: showDirectoryPicker (Chrome/Edge)
    if (hasDirectoryPicker()) {
      try {
        const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' });
        // The browser API returns a handle, but not the absolute filesystem path.
        // We can get the directory name, but need the user to confirm/edit the full path.
        const dirName = dirHandle.name;

        // Check if .git exists in the selected directory
        let hasGit = false;
        try {
          await dirHandle.getDirectoryHandle('.git');
          hasGit = true;
        } catch {
          // .git not found
        }

        if (!hasGit) {
          setBrowseError(
            `"${dirName}" does not appear to be a git repository (no .git folder found). ` +
            'The server will validate this — enter the full path below.'
          );
        }

        // The File System Access API doesn't expose the full absolute path for security.
        // Populate the input with the folder name and prompt the user to complete the path.
        setInput(dirName);
        setTouched(false);
        setBrowseError((prev) =>
          prev ?? `Selected "${dirName}". Please enter the full absolute path (e.g. /Users/you/projects/${dirName}).`
        );
        return;
      } catch (err: any) {
        if (err?.name === 'AbortError') return; // user cancelled
        // Fall through to fallback
      }
    }

    // Fallback: use hidden file input with webkitdirectory
    fileInputRef.current?.click();
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // webkitdirectory gives us files with webkitRelativePath like "dirname/file.txt"
    const firstPath = files[0].webkitRelativePath;
    if (firstPath) {
      const dirName = firstPath.split('/')[0];
      setInput(dirName);
      setBrowseError(
        `Selected "${dirName}". Browser security prevents reading the full path — ` +
        `please enter the complete absolute path (e.g. /Users/you/projects/${dirName}).`
      );
    }

    // Reset file input so the same folder can be selected again
    e.target.value = '';
  }

  return (
    <div className="add-repo-container">
      <div className="add-repo-tabs">
        <button
          type="button"
          className={`add-repo-tab${mode === 'remote' ? ' active' : ''}`}
          onClick={() => switchMode('remote')}
        >
          Remote URL
        </button>
        <button
          type="button"
          className={`add-repo-tab${mode === 'local' ? ' active' : ''}`}
          onClick={() => switchMode('local')}
        >
          Local Folder
        </button>
      </div>

      <form className="add-repo-form" onSubmit={handleSubmit}>
        <div className="add-repo-input-group">
          <div className="add-repo-input-row">
            <input
              type="text"
              className={`input${error ? ' input-error' : ''}`}
              placeholder={
                mode === 'remote'
                  ? 'https://host/user/repo or git@host:user/repo'
                  : '/path/to/local/repository'
              }
              value={input}
              onChange={(e) => { setInput(e.target.value); setBrowseError(null); }}
              onBlur={() => setTouched(true)}
              disabled={disabled}
            />
            {mode === 'local' && (
              <button
                type="button"
                className="btn btn-browse"
                onClick={handleBrowse}
                disabled={disabled}
                title="Browse for a folder"
              >
                Browse...
              </button>
            )}
          </div>
          {error && <span className="input-hint input-hint-error">{error}</span>}
          {browseError && <span className="input-hint input-hint-warn">{browseError}</span>}
          {!error && !browseError && name && trimmed && (
            <span className="input-hint">
              Will be added as <strong>{name}</strong>
              {mode === 'local' && (
                <> — git repo will be validated on the server</>
              )}
            </span>
          )}
        </div>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={disabled || !valid}
        >
          {mode === 'remote' ? 'Add Repository' : 'Open Local Repo'}
        </button>
      </form>

      {/* Hidden file input as fallback for browsers without showDirectoryPicker */}
      <input
        ref={fileInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />
    </div>
  );
}
