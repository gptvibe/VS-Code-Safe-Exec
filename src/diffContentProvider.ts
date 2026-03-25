import * as path from "path";
import * as vscode from "vscode";

const DIFF_SCHEME = "safe-exec-review";

type DiffSide = "before" | "after";

interface DiffSessionContent {
  before: string;
  after: string;
  title: string;
}

export interface DiffSessionHandle extends vscode.Disposable {
  id: string;
  beforeUri: vscode.Uri;
  afterUri: vscode.Uri;
  title: string;
}

export interface CreateDiffSessionOptions {
  resource: vscode.Uri;
  title: string;
  before: string;
  after: string;
}

export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly sessions = new Map<string, DiffSessionContent>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this);
  }

  public dispose(): void {
    this.sessions.clear();
    this.onDidChangeEmitter.dispose();
  }

  public createSession(options: CreateDiffSessionOptions): DiffSessionHandle {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    this.sessions.set(id, {
      before: options.before,
      after: options.after,
      title: options.title
    });

    const fileName = path.basename(options.resource.fsPath || options.resource.path || "review.txt");
    const beforeUri = createDiffUri(id, "before", fileName);
    const afterUri = createDiffUri(id, "after", fileName);
    this.onDidChangeEmitter.fire(beforeUri);
    this.onDidChangeEmitter.fire(afterUri);

    return {
      id,
      beforeUri,
      afterUri,
      title: options.title,
      dispose: () => {
        this.sessions.delete(id);
      }
    };
  }

  public async openDiff(handle: DiffSessionHandle, preserveFocus = false): Promise<void> {
    await vscode.commands.executeCommand(
      "vscode.diff",
      handle.beforeUri,
      handle.afterUri,
      handle.title,
      {
        preview: false,
        preserveFocus
      }
    );
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const sessionId = uri.authority;
    const side = getSide(uri);
    const session = this.sessions.get(sessionId);

    if (!session) {
      return "Safe Exec review content is no longer available.";
    }

    return side === "before" ? session.before : session.after;
  }
}

function createDiffUri(id: string, side: DiffSide, fileName: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: DIFF_SCHEME,
    authority: id,
    path: `/${side}/${fileName}`
  });
}

function getSide(uri: vscode.Uri): DiffSide {
  const [, side] = uri.path.split("/");
  return side === "before" ? "before" : "after";
}
