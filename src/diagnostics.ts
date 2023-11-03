import * as vscode from 'vscode';
import * as path from 'path';
import { assert } from 'console';
import { LocalDB } from './db';
import { ANCHOR_LINES, findClosestAnchor } from './anchor';
import { RemoteDB } from './remote';
import * as util from './util';
import { DIAGNOSTICS_CODENAME } from './constants';
import * as constants from './constants';
import { cursorTo } from 'readline';

export class SastInfo implements vscode.CodeActionProvider {
    // Create a map of diagnostic to code action
    private _diagnosticCodeActions = new Map<vscode.Diagnostic, vscode.CodeAction[]>();

    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] {
        let codeActions: vscode.CodeAction[] = [];
        this._diagnosticCodeActions.forEach((value, key) => {
            if (context.diagnostics.includes(key)) {
                codeActions = codeActions.concat(value);
            }
        });
        console.log(codeActions.map((codeAction) => codeAction.title));
        return codeActions;
        /*return context.diagnostics
            .filter(diagnostic => diagnostic.code === DIAGNOSTICS_CODENAME)
            .filter(diagnostic => this._diagnosticCodeActions.has(diagnostic))
            .map(diagnostic => this._diagnosticCodeActions.get(diagnostic) as vscode.CodeAction);*/
    }
}

export class IaCDiagnostics {
    private _diagnostics: vscode.DiagnosticCollection;
    private _diagnosticsIds: Map<string, vscode.Diagnostic> = new Map();
    private _rawDiagnostics: Map<string, any> = new Map();
    private _sastInfo: any;
    private _db: LocalDB;
    private _rdb: RemoteDB | undefined;
    private _currentlyPulling: boolean = false;
    private _disposables: vscode.Disposable[] = [];
    private _context: vscode.ExtensionContext;
    private _disposed: boolean = false;
    private _onDiagnosticUpdateList: Array<(diagnostics: Map<string, any>) => void> = [];

    constructor(context: vscode.ExtensionContext, db: LocalDB, rdb: RemoteDB | undefined) {
        this._db = db;
        this._rdb = rdb;
        this._context = context;
        this._diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTICS_CODENAME);
        context.subscriptions.push(this._diagnostics);
        this._disposables.push(this._diagnostics);


        this._sastInfo = new SastInfo();
        let codeActionProvider = vscode.languages.registerCodeActionsProvider('*', this._sastInfo, {
            providedCodeActionKinds: SastInfo.providedCodeActionKinds
        });
        context.subscriptions.push(codeActionProvider);

        // Command to delete an arbitrary finding
        let disposableCommand = vscode.commands.registerCommand(`${constants.EXT_NAME}.deleteFinding`, (uuid: string) => {
            this.deleteFinding(uuid);
        });
        context.subscriptions.push(disposableCommand);
        this._disposables.push(disposableCommand);

        // Command to flag an arbitrary finding
        disposableCommand = vscode.commands.registerCommand(`${constants.EXT_NAME}.flagFinding`, (uuid: string, flag: number) => {
            this.flagFinding(uuid, flag);
        });
        context.subscriptions.push(disposableCommand);
        this._disposables.push(disposableCommand);

        if (this._rdb === undefined) {
            return;
        }
        this._rdb.onDbReady(async () => {
            if (this._disposed) { return; }
            await this.syncRdb();
        });
        this._rdb.onDiagnosticsUpdate(async (diagnosticsToStore: any[]) => {
            if (this._disposed) { return; }
            await this.safeRdbPull(diagnosticsToStore);
        });
    }

    public onDiagnosticsUpdate(callback: (diagnostics: Map<string, any>) => void): void {
        this._onDiagnosticUpdateList.push(callback);
        callback(this._rawDiagnostics);
    }

    private diagnosticsUpdate(): void {
        this._onDiagnosticUpdateList.forEach((callback) => {
            callback(this._rawDiagnostics);
        });
    }

    dispose() {
        this._diagnostics.clear();
        this._disposables.forEach((disposable) => {
            this._context.subscriptions.splice(this._context.subscriptions.indexOf(disposable), 1);
            disposable.dispose();
        });
        this._disposed = true;
    }

    // Will check if a sync is currently in progress, and if not, will start one
    private async safeRdbPull(arg: any) {
        if (this._currentlyPulling) {
            console.log("[IaC Diagnostics] Sync already in progress, skipping");
            return;
        }
        this._currentlyPulling = true;
        await this.rdbPull(arg);
        this._currentlyPulling = false;
    }

    private async rdbPull(diagnosticsToStore: any[], isReplaceAll: boolean = true): Promise<void> {
        console.log("rdbPull");
        // Clear and rewrite local sqlite database
        if (isReplaceAll) {
            await this._db.dbClearDiagnostics();
        }
        for (let i = 0; i < diagnosticsToStore.length; i++) {
            await this._db.dbCreateOrReplaceDiagnosticWithId(diagnosticsToStore[i].id, diagnosticsToStore[i].diagnostic, diagnosticsToStore[i].anchor, diagnosticsToStore[i].file_path, diagnosticsToStore[i].flag);
        }
        // Load diagnostics from DB
        this.loadDiagnosticsFromDB();
    }

    private async deleteFinding(uuid: string): Promise<void> {
        console.log(`deleteFinding(${uuid})`);
        await this._db.dbDeleteDiagnostic(uuid);
        if ((this._rdb === undefined) || (!this._rdb.isRemoteReady())) {
            await this.loadDiagnosticsFromDB();
            return;
        }
        await this._rdb.deleteDiagnostics(null, [uuid]);
        await this.loadDiagnosticsFromDB();
        return;
    }

    private async flagFinding(uuid: string, flag: number): Promise<void> {
        console.log(`flagFinding(${uuid}, ${flag})`);
        await this._db.dbUpdateDiagnosticFlag(uuid, flag);
        await this.syncRdb();
        await this.loadDiagnosticsFromDB();
        return;
    }

    private async syncRdb() {
        if (this._rdb === undefined) {
            return;
        }
        if (!this._rdb.isRemoteReady()) {
            return;
        }
        let diagnosticsToPush = await this._db.dbGetDiagnostics();
        console.log(`syncRdb(${diagnosticsToPush.length})`);
        let [diagnostics, isReplaceAll] = await this._rdb.syncDiagnostics(diagnosticsToPush);
        if (diagnostics === undefined) {
            return;
        }
        await this.rdbPull(diagnostics, isReplaceAll);
    }

    // TODO: This is quadratical, make it linear
    private async refreshDiagnostics(doc: vscode.TextDocument, semgrepParsed: any): Promise<void> {
        console.log("[Semgrep] OK4 ");

        const diagnostics: vscode.Diagnostic[] = [];

        // TODO: check these fields exists in the parsed json. Show error if not.
        for (let e of semgrepParsed["parsed"]["results"]) {
            if (vscode.workspace.workspaceFolders === undefined) {
                assert(false, "Workspace folder is undefined, but was checked before.");
                return;
            }
            const absPath = util.relPathToAbs(e["path"]);
            if (absPath !== doc.uri.fsPath) {
                continue;
            }
            let diagUuid = util.genUUID();

            const diagnostic = this.createDiagnostic(
                diagUuid,
                e["start"]["line"] - 1,
                e["start"]["col"] - 1,
                e["end"]["line"] - 1,
                e["end"]["col"] - 1,
                e["extra"]["message"],
                e["extra"]["metadata"]["source"],
                e["extra"]["metadata"]["severity"],
                e["extra"]["metadata"]["references"],
                semgrepParsed["source"],
                constants.FLAG_UNFLAGGED
            );
            diagnostics.push(diagnostic);
            console.log(e["path"]);

            let anchorLine = e["start"]["line"] - 1;
            let anchorText = "";
            let numLinesFromAnchor = 0;
            let anchorTextLineBegin = Math.max(anchorLine - ANCHOR_LINES, 0);
            let anchorTextLineEnd = Math.min(anchorLine + ANCHOR_LINES, doc.lineCount);
            let anchorText1 = doc.getText(new vscode.Range(anchorTextLineBegin, 0, anchorLine, 0));
            let anchorText2 = doc.getText(new vscode.Range(anchorLine, 0, anchorTextLineEnd, 0));

            // Limit size of anchor text to 1000 characters
            anchorText1 = anchorText1.substring(Math.max(anchorText1.length - 500, 0));
            anchorText2 = anchorText2.substring(0, 500);
            numLinesFromAnchor = anchorText1.split(/\r\n|\r|\n/).length - 1;
            anchorText = anchorText1 + anchorText2;
            let anchor = JSON.stringify({ "line": anchorLine, "text": anchorText, "num": numLinesFromAnchor });

            // Serialize diagnostic
            let serializedDiagnostic = JSON.stringify({
                "message": e["extra"]["message"],
                "severity": e["extra"]["metadata"]["severity"],
                "source": e["extra"]["metadata"]["source"],
                "relatedInformation": e["extra"]["metadata"]["references"]
            });

            await this._db.dbCreateOrReplaceDiagnosticWithId(diagUuid, serializedDiagnostic, anchor, e["path"], constants.FLAG_UNFLAGGED);
            this._diagnosticsIds.set(diagUuid, diagnostic);

            let rawDiagnostic = {
                "id": diagUuid,
                "path": e["path"],
                "line": anchorLine,
                "message": e["extra"]["message"],
                "source": e["extra"]["metadata"]["source"],
                "severity": e["extra"]["metadata"]["severity"],
                "references": e["extra"]["metadata"]["references"],
                "from": semgrepParsed["source"]
            };
            this._rawDiagnostics.set(diagUuid, rawDiagnostic);
        }

        this._diagnostics.set(doc.uri, diagnostics);
        this.diagnosticsUpdate();
        console.log("[Semgrep] OK5 ");
    }

    async clearLocalDiagnostics(): Promise<void> {
        this._diagnostics.clear();
        this._sastInfo._diagnosticCodeActions.clear();
        this._diagnosticsIds.clear();
        this._rawDiagnostics.clear();
        await this._db.dbClearDiagnostics();
        this.diagnosticsUpdate();
    }

    async clearDiagnostics(): Promise<void> {
        await this.clearLocalDiagnostics();
        await this.syncRdb();
    }

    async loadDiagnostics(): Promise<void> {
        await this.loadDiagnosticsFromDB();
        await this.syncRdb();
    }

    private msgToFlagId(msg: string): number {
        if (msg.startsWith("🆕")) {
            return constants.FLAG_UNFLAGGED;
        }
        else if (msg.startsWith("✅")) {
            return constants.FLAG_RESOLVED;
        }
        else if (msg.startsWith("❌")) {
            return constants.FLAG_FALSE;
        }
        else if (msg.startsWith("🔥")) {
            return constants.FLAG_HOT;
        }
        else {
            return constants.FLAG_UNFLAGGED;
        }
    }

    async loadDiagnosticsFromDB(): Promise<void> {
        let dbDiagnostics = await this._db.dbGetDiagnostics();
        let diagnosticsToClear = [...this._diagnosticsIds.keys()];

        console.log("[Diagnostics] Db has ");
        console.log(dbDiagnostics);
        for (let i = 0; i < dbDiagnostics.length; i++) {
            let dbDiagnostic = dbDiagnostics[i].diagnostic;
            let dbAnchor = dbDiagnostics[i].anchor;
            let dbPath = dbDiagnostics[i].file_path;
            let dbId = dbDiagnostics[i].id;
            let dbFlag = dbDiagnostics[i].flag;
            
            console.log("Diagnostic id: " + dbId);
            console.log("All diagnostic ids: " + [...this._diagnosticsIds.keys()]);
            if (this._diagnosticsIds.has(dbId)) {
                let diagMsg = this._diagnosticsIds.get(dbId)?.message;
                diagnosticsToClear = diagnosticsToClear.filter((e) => e !== dbId);
                if ((diagMsg == undefined) || (dbFlag == this.msgToFlagId(diagMsg))) {
                    console.log("Skipping updating an existing diagnostic");
                    continue;
                }
                else {
                    console.log("Updating an existing diagnostic");
                    await this.clearOneDiagnostic(this._diagnosticsIds.get(dbId) as vscode.Diagnostic, dbId);
                }
            }
            
            // Deserialize diagnostic
            let deserializedDiagnostic = JSON.parse(dbDiagnostic);
            let deserializedAnchor = JSON.parse(dbAnchor);

            const doc = await this.getDocumentFromSemgrepPath(dbPath);
            if (doc === undefined) {
                vscode.window.showWarningMessage('Semgrep result references a file that is not present in workspace.');
                return;
            }
            let anchorLine = findClosestAnchor(deserializedAnchor.text, doc.getText());
            if (anchorLine === -1) {
                anchorLine = deserializedAnchor.line;
            }
            else {
                anchorLine = anchorLine + deserializedAnchor.num;
            }
            console.log("Closest anchor: " + anchorLine);

            // Create diagnostic
            const diagnostic = this.createDiagnostic(
                dbId,
                deserializedAnchor.line,
                0,
                deserializedAnchor.line + 1,
                12345,
                deserializedDiagnostic.message,
                deserializedDiagnostic.source,
                deserializedDiagnostic.severity,
                deserializedDiagnostic.relatedInformation,
                "semgrep-remote",
                dbFlag
            );
            // Add diagnostic to collection
            let curDiag = this._diagnostics.get(doc.uri);
            if (curDiag !== undefined) {
                curDiag = curDiag.concat(diagnostic);
            }
            else {
                curDiag = [diagnostic];
            }
            this._diagnostics.set(doc.uri, curDiag);

            // Add diagnostic to SastInfo
            let action = this.makeCodeActions(dbId, deserializedDiagnostic.source, diagnostic, dbFlag);
            this._sastInfo._diagnosticCodeActions.set(diagnostic, action);
            // Add diagnostic to list of diagnostics

            this._diagnosticsIds.set(dbId, diagnostic);

            let rawDiagnostic = {
                "id": dbId,
                "path": dbPath,
                "line": deserializedAnchor.line,
                "message": deserializedDiagnostic.message,
                "source": deserializedDiagnostic.source,
                "severity": deserializedDiagnostic.severity,
                "references": deserializedDiagnostic.relatedInformation,
                "from": "semgrep-remote"
            };
            this._rawDiagnostics.set(dbId, rawDiagnostic);
        }

        // Clear diagnostics that are not in the db
        console.log("Diagnostics to clear: " + diagnosticsToClear);
        for (let i = 0; i < diagnosticsToClear.length; i++) {
            let diag = this._diagnosticsIds.get(diagnosticsToClear[i]);
            await this.clearOneDiagnostic(diag as vscode.Diagnostic, diagnosticsToClear[i]);
        }
        
        this.diagnosticsUpdate();
    }

    async clearOneDiagnostic(diag: vscode.Diagnostic, uuid: string): Promise<void> {
        console.log("Clearing diagnostic: " + diag);
        if (diag === undefined) {
            console.log("Diagnostic is undefined");
            return;
        }
        let diagnosticUri = null;
        this._diagnostics.forEach((key, value) => {
            if (value.includes(diag as vscode.Diagnostic)) {
                diagnosticUri = key;
            }
        });
        if (diagnosticUri !== null) {
            let diagnostics = this._diagnostics.get(diagnosticUri);
            if (diagnostics !== undefined) {
                console.log(`Removing diagnostic from collection ${diagnostics.length} > ${diagnostics.filter((e) => e !== diag).length}`);
                this._diagnostics.set(diagnosticUri, diagnostics.filter((e) => e !== diag));
            }
        }

        this._diagnosticsIds.delete(uuid);
        this._rawDiagnostics.delete(uuid);
        this._sastInfo._diagnosticCodeActions.delete(diag);
    }

    // TODO: fetch from all workspaces, not just the first one
    async getDocumentFromSemgrepPath(semgrepPath: string): Promise<vscode.TextDocument | undefined> {
        // Get document from path
        if (vscode.workspace.workspaceFolders === undefined) {
            return undefined;
        }
        console.log(vscode.workspace.workspaceFolders);
        const absPath = util.relPathToAbs(semgrepPath);

        // Match file only within workspace
        let relPattern = new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], semgrepPath);
        let uris = await vscode.workspace.findFiles(relPattern, null, 1);
        console.log(uris);

        if (uris.length === 0) {
            console.log(absPath);
            return undefined;
        }
        const doc = await vscode.workspace.openTextDocument(uris[0]);
        return doc;
    }

    async loadDiagnosticsFromSemgrep(semgrepParsed: any): Promise<void> {
        // Create set of paths
        const docs = new Set<vscode.TextDocument>();
        await Promise.all(semgrepParsed["parsed"]["results"].map(async (e: any) => {
            let doc = await this.getDocumentFromSemgrepPath(e["path"]);
            if (doc === undefined) {
                vscode.window.showWarningMessage('Semgrep result references a file that is not present in workspace.');
                return;
            }
            docs.add(doc);
        }));

        for (let doc of docs) {
            await this.refreshDiagnostics(doc, semgrepParsed);
        }
        await this.syncRdb();
    }

    private createDiagnostic(uuid: string, lineStart: number, colStart: number, lineEnd: number, colEnd: number, message: string, externalUrl: string, severity: string, references: string[], source: string, flag: number): vscode.Diagnostic {
        // create range that represents, where in the document the word is
        const range = new vscode.Range(lineStart, colStart, lineEnd, colEnd);

        // Convert severity to vscode.DiagnosticSeverity
        let severityVsc: vscode.DiagnosticSeverity;
        switch (severity) {
            case "ERROR":
                severityVsc = vscode.DiagnosticSeverity.Error;
                break;
            case "WARNING":
                severityVsc = vscode.DiagnosticSeverity.Warning;
                break;
            case "INFO":
                severityVsc = vscode.DiagnosticSeverity.Information;
                break;
            default:
                severityVsc = vscode.DiagnosticSeverity.Information;
                break;
        }

        // Add flag to message
        switch (flag) {
            case constants.FLAG_UNFLAGGED:
                message = "🆕 " + message;
                break;
            case constants.FLAG_RESOLVED:
                message = "✅ " + message;
                break;
            case constants.FLAG_FALSE:
                message = "❌ " + message;
                break;
            case constants.FLAG_HOT:
                message = "🔥 " + message;
                break;
            default:
                break;
        }

        const diagnostic = new vscode.Diagnostic(range, message, severityVsc);
        diagnostic.code = DIAGNOSTICS_CODENAME;
        switch (source) {
            case "semgrep-imported":
                diagnostic.source = "Semgrep [imported] ";
                break;
            case "semgrep-local":
                diagnostic.source = "Semgrep [local] ";
                break;
            case "semgrep-remote":
                diagnostic.source = "Semgrep [remote] ";
                break;
            default:
                diagnostic.source = "Unknown source ";
                break;
        }

        if (references === undefined) {
            references = [];
        }
        diagnostic.relatedInformation = references.map(ref => {
            return new vscode.DiagnosticRelatedInformation(
                new vscode.Location(vscode.Uri.parse(ref), new vscode.Position(0, 0)),
                'External reference (open in browser)'
            );
        });
        diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];

        // Add a code action
        let action = this.makeCodeActions(uuid, externalUrl, diagnostic, flag);
        this._sastInfo._diagnosticCodeActions.set(diagnostic, action);

        return diagnostic;
    }

    private makeCodeActions(diagUuid: string, externalUrl: string, diagnostic: vscode.Diagnostic, flag: number): vscode.CodeAction[] {
        const action = new vscode.CodeAction('Learn more on this finding', vscode.CodeActionKind.QuickFix);
        action.command = { arguments: [externalUrl], command: `${constants.EXT_NAME}.openLink`, title: 'Learn more about this finding', tooltip: 'This will open an external page.' };
        action.diagnostics = [diagnostic];
        action.isPreferred = true;

        const action2 = new vscode.CodeAction('Delete this finding', vscode.CodeActionKind.QuickFix);
        action2.command = { arguments: [diagUuid], command: `${constants.EXT_NAME}.deleteFinding`, title: 'Delete this finding', tooltip: 'This will delete this finding from the database.' };
        action2.diagnostics = [diagnostic];
        action2.isPreferred = false;

        if (flag == constants.FLAG_UNFLAGGED) {
            const action3 = new vscode.CodeAction('Mark this finding as ✅ resolved', vscode.CodeActionKind.QuickFix);
            action3.command = { arguments: [diagUuid, constants.FLAG_RESOLVED], command: `${constants.EXT_NAME}.flagFinding`, title: 'Mark this finding as resolved', tooltip: 'This will mark this finding as resolved.' };
            action3.diagnostics = [diagnostic];
            action3.isPreferred = false;

            const action4 = new vscode.CodeAction('Mark this finding as ❌ false positive', vscode.CodeActionKind.QuickFix);
            action4.command = { arguments: [diagUuid, constants.FLAG_FALSE], command: `${constants.EXT_NAME}.flagFinding`, title: 'Mark this finding as false positive', tooltip: 'This will mark this finding as false positive.' };
            action4.diagnostics = [diagnostic];
            action4.isPreferred = false;
            
            const action5 = new vscode.CodeAction('Mark this finding as 🔥 hot', vscode.CodeActionKind.QuickFix);
            action5.command = { arguments: [diagUuid, constants.FLAG_HOT], command: `${constants.EXT_NAME}.flagFinding`, title: 'Mark this finding as hot', tooltip: 'This will mark this finding as hot.' };
            action5.diagnostics = [diagnostic];
            action5.isPreferred = false;

            return [action, action2, action3, action4, action5];
        }
        else {
            const action3 = new vscode.CodeAction('Unmark ↩️ this finding', vscode.CodeActionKind.QuickFix);
            action3.command = { arguments: [diagUuid, constants.FLAG_UNFLAGGED], command: `${constants.EXT_NAME}.flagFinding`, title: 'Unmark this finding', tooltip: 'This will unmark this finding.' };
            action3.diagnostics = [diagnostic];
            action3.isPreferred = false;

            return [action, action2, action3];
        }
    }
}