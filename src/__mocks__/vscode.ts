/**
 * VS Code API mock for unit testing
 */

// Event emitter mock
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => this.listeners = this.listeners.filter(l => l !== listener) };
  };

  fire(data: T): void {
    this.listeners.forEach(l => l(data));
  }

  dispose(): void {
    this.listeners = [];
  }
}

// URI mock
export class Uri {
  static file(path: string): Uri {
    return new Uri('file', '', path, '', '');
  }

  static parse(value: string): Uri {
    return new Uri('file', '', value, '', '');
  }

  constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string
  ) {}

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }

  toJSON(): unknown {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
}

// ConfigurationTarget enum
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3
}

// ProgressLocation enum
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

// Disposable mock
export class Disposable {
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => disposables.forEach(d => d.dispose()));
  }

  constructor(private callOnDispose: () => void) {}

  dispose(): void {
    this.callOnDispose();
  }
}

// Workspace configuration mock
const configValues: Map<string, unknown> = new Map();

export const workspace = {
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const fullKey = section ? `${section}.${key}` : key;
      const value = configValues.get(fullKey);
      return (value !== undefined ? value : defaultValue) as T | undefined;
    },
    update: jest.fn().mockResolvedValue(undefined),
    has: (key: string): boolean => {
      const fullKey = section ? `${section}.${key}` : key;
      return configValues.has(fullKey);
    },
    inspect: () => undefined,
  }),
  fs: {
    delete: jest.fn().mockResolvedValue(undefined),
    stat: jest.fn(),
  },
};

// CancellationToken mock
export class CancellationTokenSource {
  token = {
    isCancellationRequested: false,
    onCancellationRequested: new EventEmitter<void>().event,
  };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}

// Window mock
export const window = {
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showWarningMessage: jest.fn().mockResolvedValue(undefined),
  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  showInputBox: jest.fn().mockResolvedValue(undefined),
  showOpenDialog: jest.fn().mockResolvedValue(undefined),
  registerWebviewViewProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  registerCustomEditorProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withProgress: jest.fn().mockImplementation(async (_options: unknown, task: any) => {
    const progress = { report: jest.fn() };
    const token = { isCancellationRequested: false, onCancellationRequested: new EventEmitter<void>().event };
    return task(progress, token);
  }),
};

// Commands mock
export const commands = {
  registerCommand: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  executeCommand: jest.fn().mockResolvedValue(undefined),
};

// ExtensionContext mock
export function createMockExtensionContext(): {
  subscriptions: { dispose(): void }[];
  workspaceState: { get: jest.Mock; update: jest.Mock; keys: jest.Mock };
  globalState: { get: jest.Mock; update: jest.Mock; keys: jest.Mock; setKeysForSync: jest.Mock };
  extensionUri: Uri;
  extensionPath: string;
  asAbsolutePath: (relativePath: string) => string;
} {
  return {
    subscriptions: [],
    workspaceState: {
      get: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockReturnValue([]),
    },
    globalState: {
      get: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockReturnValue([]),
      setKeysForSync: jest.fn(),
    },
    extensionUri: Uri.file('/extension'),
    extensionPath: '/extension',
    asAbsolutePath: (relativePath: string) => `/extension/${relativePath}`,
  };
}

// Helper to set config values for testing
export function setMockConfig(key: string, value: unknown): void {
  configValues.set(key, value);
}

// Helper to clear all mock config values
export function clearMockConfig(): void {
  configValues.clear();
}

// Reset all mocks
export function resetAllMocks(): void {
  jest.clearAllMocks();
  configValues.clear();
}
