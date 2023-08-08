import * as vscode from 'vscode';
import * as path from 'path';
import { parseSemgrep, runSemgrep } from './semgrep';
import { IaCDiagnostics } from './diagnostics';
import { RemoteDB } from './remote';

export async function handleOpenSemgrepJson(context: vscode.ExtensionContext, mIaCDiagnostics: IaCDiagnostics) {
    let jsonFile = await chooseJsonFile();
    console.log("[Semgrep] " + jsonFile?.fsPath);
    if (!jsonFile) { return; }
    console.log("[Semgrep] OK1 ");
    let jsonParsed = parseSemgrep(jsonFile?.fsPath);
    console.log("[Semgrep] OK2 ");

    await mIaCDiagnostics.loadDiagnosticsFromSemgrep(jsonParsed);
    console.log("[Semgrep] OK3 ");
}

export async function handleStartSemgrepScan(context: vscode.ExtensionContext, mIaCDiagnostics: IaCDiagnostics) {
    console.log("Starting semgrep scan");
    // Run semgrep on current workspace
    // TODO: run on all workspace folders, not just first one
    if (vscode.workspace.workspaceFolders === undefined) {
        vscode.window.showErrorMessage("Cannot run Semgrep. No workspace folder is open.");
        return;
    }
    let wspath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    runSemgrep(context, wspath, mIaCDiagnostics);
}

async function chooseJsonFile(): Promise<vscode.Uri | undefined> {
    return vscode.window.showOpenDialog({
        openLabel: "Choose Semgrep result",
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { JsonFiles: ['json', 'txt'] }
    })
        .then((chosen) => chosen && chosen?.length > 0 ? chosen[0] : undefined);
}

export function genUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        let r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function relPathToAbs(relPath: string) {
    if (vscode.workspace.workspaceFolders === undefined) {
        return relPath;
    }

    const absPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, relPath);
    return absPath;
}

export function absPathToRel(absPath: string) {
    if (vscode.workspace.workspaceFolders === undefined) {
        return absPath;
    }

    const relPath = path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, absPath);
    return relPath;
}

export async function ensureDirExists(dirPath: string): Promise<boolean> {
    let dirUri = vscode.Uri.file(dirPath);
    
    return await vscode.workspace.fs.stat(dirUri).then(
        async () => {
            console.log('[IaC Utils] Storage directory exists');
            return true;
        },
        async () => {
            console.log('[IaC Utils] Storage directory does not exist');
            await vscode.workspace.fs.createDirectory(dirUri);

            return await vscode.workspace.fs.stat(dirUri).then(
                () => {
                    console.log('[IaC Main] Storage directory created');
                    return true;
                },
                () => {
                    console.log('[IaC Main] Storage directory could not be created');

                    // Show an error message
                    vscode.window.showErrorMessage('Storage directory could not be created');

                    return false;
                }
            );
        }
    );
}