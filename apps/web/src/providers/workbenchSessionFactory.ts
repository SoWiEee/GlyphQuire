import { NoteClient } from "../api/NoteClient.js";
import { NoteLock } from "../coordination/NoteLock.js";
import type { NoteScope } from "../coordination/TabChannel.js";
import type { EditorSessionLifecycle } from "../coordination/SessionLifecycleCoordinator.js";
import { DocumentWorkerClient } from "../editors/DocumentWorkerClient.js";
import { openEditorSession } from "../editors/EditorSession.js";
import type {
  DocumentAnalysisPort,
  DraftStore,
  EditorSession,
  EditorSessionDeps,
  NoteLockLike,
  NoteRemote,
} from "../editors/editor-session.types.js";
import type {
  WorkbenchNote,
  WorkbenchSessionFactory,
  WorkbenchSessionHandle,
} from "../components/workbench/types.js";

/** The narrow read the factory needs to load authoritative note content. */
export interface NoteReader {
  getNote(noteId: string): Promise<{ contentMarkdown: string; revision: number }>;
}

export interface WorkbenchSessionFactoryConfig {
  readonly userId: string;
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly accountLabel?: string;
}

/** Injectable seams — production defaults wire the real implementations. */
export interface WorkbenchSessionFactoryDeps {
  openSession: (deps: EditorSessionDeps) => Promise<EditorSession>;
  noteReader: NoteReader;
  noteRemote: NoteRemote;
  lifecycle: EditorSessionLifecycle;
  draftStore: DraftStore;
  documentAnalysis: DocumentAnalysisPort;
  makeLock: (scope: NoteScope) => NoteLockLike;
}

function defaultDeps(): Pick<
  WorkbenchSessionFactoryDeps,
  "openSession" | "noteReader" | "noteRemote" | "documentAnalysis" | "makeLock"
> {
  const client = new NoteClient();
  return {
    openSession: openEditorSession,
    noteReader: client,
    noteRemote: client,
    documentAnalysis: new DocumentWorkerClient(),
    makeLock: (scope) => new NoteLock(scope),
  };
}

/**
 * Builds one authenticated session factory. `lifecycle` and `draftStore` are
 * owned by the caller (one per authenticated session, shared across notes);
 * everything else defaults to the real implementation but is injectable for tests.
 */
export function createWorkbenchSessionFactory(
  config: WorkbenchSessionFactoryConfig,
  deps: Partial<WorkbenchSessionFactoryDeps> & Pick<WorkbenchSessionFactoryDeps, "lifecycle" | "draftStore">,
): WorkbenchSessionFactory {
  const defaults = defaultDeps();
  const openSession = deps.openSession ?? defaults.openSession;
  const noteReader = deps.noteReader ?? defaults.noteReader;
  const noteRemote = deps.noteRemote ?? defaults.noteRemote;
  const documentAnalysis = deps.documentAnalysis ?? defaults.documentAnalysis;
  const makeLock = deps.makeLock ?? defaults.makeLock;
  const { lifecycle, draftStore } = deps;

  return async (note: Readonly<WorkbenchNote>): Promise<WorkbenchSessionHandle> => {
    const loaded = await noteReader.getNote(note.id);
    const scope: NoteScope = {
      userId: config.userId,
      workspaceId: config.workspaceId,
      noteId: note.id,
    };
    const session = await openSession({
      userId: config.userId,
      workspaceId: config.workspaceId,
      noteId: note.id,
      initialRevision: loaded.revision,
      initialMarkdown: loaded.contentMarkdown,
      noteClient: noteRemote,
      draftStore,
      noteLock: makeLock(scope),
      sessionLifecycle: lifecycle,
      documentAnalysis,
    });
    return {
      session,
      context: {
        userId: config.userId,
        workspaceId: config.workspaceId,
        ...(config.workspaceName === undefined ? {} : { workspaceName: config.workspaceName }),
        ...(config.accountLabel === undefined ? {} : { accountLabel: config.accountLabel }),
      },
    };
  };
}
