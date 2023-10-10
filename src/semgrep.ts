import { readFileSync } from "fs";
import * as path from 'path';
import { EXT_COMMON_NAME, SEMGREP_TIMEOUT_MS } from './constants';
import * as which from "which";
import * as child_process from "child_process";
import * as vscode from "vscode";
import * as constants from "./constants";
import { IaCDiagnostics } from "./diagnostics";
import * as util from "util";
import { assert } from "console";

export function getSemgrepPath(): string | undefined {
    let res = which.sync("semgrep", { nothrow: true });
    if ((res === undefined) || (res === null)) {
        const resp = vscode.window.showInformationMessage(
            `Semgrep not installed. Please install Semgrep to use ${EXT_COMMON_NAME}.`,
        );
        return undefined;
    } else {
        return res;
    }
}

let hideProgressBar: any = undefined;
let gmIaCDiagnostics: IaCDiagnostics;

export async function runSemgrep(context: vscode.ExtensionContext, path: string, mIaCDiagnostics: IaCDiagnostics): Promise<void> {
    let semgrepPath = getSemgrepPath();
    if (semgrepPath === undefined) { return; }
    if (hideProgressBar) {
        vscode.window.showErrorMessage("Semgrep is already running.");
        return;
    }

    vscode.window.withProgress({
        location: { viewId: 'iacAudit' }
    }, (progress, token) => {
        return new Promise<void>((resolve, reject) => {
            hideProgressBar = resolve;
        });
    });

    gmIaCDiagnostics = mIaCDiagnostics;
    // Load semgrepArgs from settings
    let semgrepArgs: string | undefined = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('semgrepArgs');
    if ((semgrepArgs === undefined) || (semgrepArgs.trim() === "")) {
        semgrepArgs = "--config auto";
    }
    let semgrepArgsArray = semgrepArgs.split(" ");
    if (vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('enableIaC')) {
        console.log(`[IaC Semgrep] Running Semgrep with IaC rules`);
        semgrepArgsArray = semgrepArgsArray.concat(["--config", context.asAbsolutePath("rules/")]);
    }
    else {
        console.log(`[IaC Semgrep] Running Semgrep WITHOUT IaC rules`);
    }
    semgrepArgsArray = ["--json", "--quiet"].concat(semgrepArgsArray).concat(["./"]);
    console.log(`[IaC Semgrep] Running Semgrep with args: ${semgrepArgsArray}`);

    // Load semgrepTimeout from settings
    let semgrepTimeout: number | undefined = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('semgrepTimeout');
    if ((semgrepTimeout === undefined) || (semgrepTimeout < 0)) {
        assert(false, `Invalid semgrepTimeout value: ${semgrepTimeout}`);
        console.error(`[IaC Semgrep] Invalid semgrepTimeout value: ${semgrepTimeout}`);
        return;
    }

    let execFile = util.promisify(child_process.execFile);
    try {
        let {stderr, stdout} = await execFile(semgrepPath, semgrepArgsArray, { timeout: semgrepTimeout * 1000, cwd: path, maxBuffer: 1024 * 1024 * 2 });
        if (stderr) {
            console.log(`[IaC Semgrep] stderr: ${stderr}`);
            vscode.window.showErrorMessage(`Semgrep error: ${stderr}`);
            return;
        }
        console.log(`[IaC Semgrep] Semgrep done, stdout: ${stdout}`);
    
        let jsonParsed = { parsed: JSON.parse(stdout), source: "semgrep-local" };
        await gmIaCDiagnostics.clearDiagnostics();
        await gmIaCDiagnostics.loadDiagnosticsFromSemgrep(jsonParsed);    
    }
    catch (error: any) {
        console.log(`[IaC Semgrep] error: ${error.message}`);
        let timeoutFormatted = (SEMGREP_TIMEOUT_MS / 1000).toFixed(2);
        let msg = `Semgrep timeout (${timeoutFormatted}s) exceeded or execution error. Error: ${error.message}`;
        vscode.window.showErrorMessage(msg);
    }
    finally {
        if (hideProgressBar) {
            hideProgressBar();
            hideProgressBar = undefined;
        }
    }
}

export async function runSemgrepHcl(context: vscode.ExtensionContext, wspath: string, iacpath: string): Promise<string | null> {
    let semgrepPath = getSemgrepPath();
    if (semgrepPath === undefined) { return null; }

    console.log(`[IaC Semgrep] Semgrep iacpath: ${iacpath}`);
    console.log(`[IaC Semgrep] Semgrep wspath: ${wspath}`);
    iacpath = path.relative(wspath, iacpath);
    console.log(`[IaC Semgrep] Semgrep CWD: ${iacpath}`);

    let semgrepArgsArray: string[] = ["--config", context.asAbsolutePath("tfparse_rules/")];
    semgrepArgsArray = ["--no-git-ignore", "--json", "--quiet"].concat(semgrepArgsArray).concat([iacpath]);
    console.log(`[IaC Semgrep] Running Semgrep with args: ${semgrepArgsArray}`);

    let execFile = util.promisify(child_process.execFile);

    try {
        let {stderr, stdout} = await execFile(semgrepPath, semgrepArgsArray, { timeout: SEMGREP_TIMEOUT_MS, cwd: wspath, maxBuffer: 1024 * 1024 * 2 });
        if (stderr) {
            console.log(`[IaC Semgrep] stderr: ${stderr}`);
            vscode.window.showErrorMessage(`Semgrep error: ${stderr}`);
            return null;
        }
        console.log(`[IaC Semgrep] Semgrep done, stdout: ${stdout}`);
        return stdout;
    }
    catch (error: any) {
        console.log(`[IaC Semgrep] error: ${error.message}`);
        let timeoutFormatted = (SEMGREP_TIMEOUT_MS / 1000).toFixed(2);
        let msg = `Semgrep timeout (${timeoutFormatted}s) exceeded or execution error. Error: ${error.message}`;
        vscode.window.showErrorMessage(msg);
        return null;
    }
}

export function parseSemgrep(jsonPath: any): any {
    let jsonString = readFileSync(jsonPath, { encoding: "utf8" });
    let jsonParsed = JSON.parse(jsonString);
    return { parsed: jsonParsed, path: path.dirname(jsonPath) + '/', source: "semgrep-imported" };
}