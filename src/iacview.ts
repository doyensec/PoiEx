import * as vscode from 'vscode';
import * as which from 'which';
import * as child_process from "child_process";
import { assert } from 'console';
import * as path from 'path';
import { Uri } from "vscode";
import * as fs from 'fs';
import * as ssri from 'ssri';
import { getApi, FileDownloader } from "@microsoft/vscode-file-downloader-api";
import * as tar from 'tar';
import * as os from 'os';

import { IaCDiagnostics } from './diagnostics';
import * as constants from './constants';
import * as util from './util';
import { IaCPoIViewManager } from './poiview';
import { runSemgrepHcl } from './semgrep';


export class IaCWebviewManager {
    private context: vscode.ExtensionContext;
    private mIaCDiagnostics: IaCDiagnostics;
    private disposables: vscode.Disposable[] = [];
    private currentPanel: vscode.WebviewPanel | undefined = undefined;
    private diagnostics: Map<string, any> = new Map<string, any>();
    private disposed = false;
    private hideProgressBar: any = undefined;
    private inframapDownloading = false;
    private diagram: string | undefined = undefined;
    private resourceBlocks: Map<string, [string, number, number, number, number]> = new Map<string, [string, number, number, number, number]>;

    constructor(context: vscode.ExtensionContext, mIaCDiagnostics: IaCDiagnostics) {
        this.context = context;
        this.mIaCDiagnostics = mIaCDiagnostics;
        
        let disposableCommand1 = vscode.commands.registerCommand('poiex.showIaCwebview', () => {
            const options: vscode.OpenDialogOptions = {
                canSelectMany: false,
                openLabel: 'Select IaC definiton file',
                filters: {
                    'Terraform files': ['tf'],
                    'All files': ['*']
                }
            };
            
            vscode.window.showOpenDialog(options).then(
                fileUri => {
                    if (!(fileUri && fileUri[0])) {
                        return;
                    }
                    if (this.diagnostics.size > 0) {
                        return fileUri;
                    }
                    return vscode.window.showInformationMessage("No findings. Do you want to run Semgrep?", "Yes", "No").then(
                        async (ans) => {
                            if (ans == "No") {
                                return fileUri;
                            }
                            await util.handleStartSemgrepScan(context, mIaCDiagnostics);
                            return fileUri;
                        }
                    );
                }
            ).then(fileUri => {
                if (fileUri === undefined) return;
                if (fileUri === null) return;
                console.log('Selected file: ' + fileUri[0].fsPath);
                
                this.runInframap(fileUri[0].fsPath);
            });
        });
        context.subscriptions.push(disposableCommand1);
        this.disposables.push(disposableCommand1);
        mIaCDiagnostics.onDiagnosticsUpdate((diagnostics) => { this.diagnosticsUpdate(diagnostics); });
    }

    dispose() {
        this.disposed = true;
        for (let d of this.disposables) {
            this.context.subscriptions.splice(this.context.subscriptions.indexOf(d), 1);
            d.dispose();
        }
        if (this.currentPanel !== undefined) { this.currentPanel.dispose(); }
    }

    async downloadInframap(): Promise<undefined | vscode.Uri> {
        assert(this.inframapDownloading === false);
        if (this.inframapDownloading) { return undefined; }

        let inframapUrl = constants.INFRAMAP_RELEASES[process.platform].url;
        if (inframapUrl === undefined) {
            // Show notification to user
            vscode.window.showInformationMessage(
                `Unable to install Inframap for platform ${process.platform}. Please install Inframap to use ${constants.EXT_COMMON_NAME}.`,
            );
            return undefined;
        }

        this.inframapDownloading = true;
        const fileDownloader: FileDownloader = await getApi();


        const file: Uri = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Downloading Inframap...",
            cancellable: false
        }, async (progress, token) => {
            return await fileDownloader.downloadFile(
                Uri.parse(inframapUrl),
                `${util.genUUID()}.tar.gz`,
                this.context,
                undefined,
                (downloadedBytes: number | undefined, totalBytes: number | undefined) => {
                    if (downloadedBytes === undefined || totalBytes === undefined) {
                        return;
                    }
                    progress.report({ increment: (downloadedBytes / totalBytes) * 100 });
                }
            );
        });

        console.log(file);
        return file;
    }

    async inframapIntegrityCheck(inframapPath: string): Promise<boolean> {
        if (typeof inframapPath !== "string") { return false; }
        let integrity = constants.INFRAMAP_RELEASES[process.platform].integrity;
        try {
            let sri = await ssri.checkStream(fs.createReadStream(inframapPath), integrity);
            console.log(`[IaC View] Inframap integrity check passed: ${sri}`);
            return true;
        } catch (e) {
            console.log(`[IaC View] Inframap integrity check failed for ${inframapPath}`);
            return false;
        }
    }

    async getInframapPath(): Promise<string | undefined> {
        if (this.inframapDownloading) {
            // No need to alert the user, there is already a progress notification shown
            return undefined;
        }

        let pathSetting: string | undefined = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('inframapPath');
        if ((pathSetting !== undefined) && (pathSetting !== "")) {
            let res = which.sync(pathSetting, { nothrow: true });
            if ((res === undefined) || (res === null)) {
                const resp = vscode.window.showInformationMessage(
                    `Inframap not installed. Please install Inframap to use ${constants.EXT_COMMON_NAME}, or set Inframap path to empty.`,
                );
            } else {
                return res;
            }
        }

        let inframapDownloaded = this.context.globalState.get(constants.INFRAMAP_DOWNLOADED_STATENAME, undefined) !== undefined;
        if (inframapDownloaded) {
            let inframapPath: string | undefined = this.context.globalState.get(constants.INFRAMAP_DOWNLOADED_STATENAME, undefined);
            if ((inframapPath !== undefined) && (await this.inframapIntegrityCheck(inframapPath))) {
                return inframapPath;
            }
        }

        console.log(`[IaC View] Inframap not found, downloading...`);
        let res = await this.downloadInframap();
        if ((res === undefined) || (!await this.inframapIntegrityCheck(res.fsPath))) {
            vscode.window.showInformationMessage(
                `An error occurred while downloading Inframap. Please install Inframap to use ${constants.EXT_COMMON_NAME}.`,
            );
            return undefined;
        }
        this.context.globalState.update(constants.INFRAMAP_DOWNLOADED_STATENAME, res.fsPath);
        return res.fsPath;
    }

    async inframapCallback(error: any, stdout: any, stderr: any, semgrepPromise: Promise<string | null>): Promise<void> {
        let semgrepOutputJson = await semgrepPromise;

        if (this.hideProgressBar) {
            this.hideProgressBar();
            this.hideProgressBar = undefined;
        }

        if (semgrepOutputJson === null) {
            console.log(`[IaC View] semgrep output is null`);
            vscode.window.showErrorMessage(`Inframap error: Semgrep output is null`);
            return;
        }

        let semgrepOutput: any;
        try {
            semgrepOutput = JSON.parse(semgrepOutputJson);
        } catch (e) {
            console.log(`[IaC View] semgrep output is not JSON: ${semgrepOutputJson}`);
            vscode.window.showErrorMessage(`Inframap error: Semgrep output is not JSON`);
            return;
        }
        if (semgrepOutput === undefined) { assert(false, "semgrepOutputJson undefined"); return; }
        if (semgrepOutput.results === undefined) { assert(false, "semgrepOutputJson.results undefined"); return; }
        console.log(`[IaC View] Semgrep HCL parse found ${semgrepOutput.results.length} resource blocks`);

        // Convert results to a data structure. Map metavars $RT $RN to key = $RT.$RN Value = start line:start col, end line:end col
        let resourceBlocks: Map<string, [string, number, number, number, number]> = new Map();
        for (let result of semgrepOutput.results) {
            try {
                let startLine = result.start.line;
                let startCol = result.start.col;
                let endLine = result.end.line;
                let endCol = result.end.col;
                let filePath = result.path;
                let resourceName = result.extra.metavars.$RN.abstract_content;
                let resourceType = result.extra.metavars.$RT.abstract_content;
                let key = `${resourceType}.${resourceName}`;
                resourceBlocks.set(key, [filePath, startLine, startCol, endLine, endCol]);
            } catch (e) {
                console.log(`[IaC View] error: ${e}`);
            }
        }
        this.resourceBlocks = resourceBlocks;

        if (error) {
            console.log(`[IaC View] error: ${error.message}`);
            let timeoutFormatted = (constants.INFRAMAP_TIMEOUT_MS / 1000).toFixed(2);
            let msg = `Inframap timeout (${timeoutFormatted}s) exceeded or execution error. Error: ${error.message}`;
            vscode.window.showErrorMessage(msg);
            return;
        }
        if (stderr) {
            console.log(`[IaC View] stderr: ${stderr}`);
            vscode.window.showErrorMessage(`Inframap error: ${stderr}`);
            return;
        }
        console.log(`[IaC View] Inframap done, stdout: ${stdout}`);
        this.diagram = stdout;
        assert(this.diagram !== undefined);
        if (this.diagram === undefined) { return; }

        let localResourceRoots: Set<vscode.Uri> | vscode.Uri[] = new Set();
        let imagePaths = this.diagram?.matchAll(/image=\"(.*?)\"/g);
        for (let match of imagePaths) {
            let imagePath = match[1];
            let imageUri = vscode.Uri.file(path.dirname(imagePath));
            localResourceRoots.add(imageUri);
        }
        localResourceRoots.add(vscode.Uri.joinPath(this.context.extensionUri, 'res/'));
        localResourceRoots = Array.from(localResourceRoots);
        console.log(`[IaC View] localResourceRoots: ${localResourceRoots}`);

        this.currentPanel = vscode.window.createWebviewPanel(
            'iacDiagram',
            'IaC Analysis Diagram',
            vscode.ViewColumn.One, // Editor column to show the new webview panel in.
            { enableScripts: true, localResourceRoots: localResourceRoots } // Webview options.
        );

        this.currentPanel.onDidDispose(() => { this.currentPanel = undefined; }, null, this.disposables);

        this.currentPanel.webview.html = this.getWebviewContent();

        this.currentPanel.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'nodeClicked':
                    // Sanitize message.nodeId
                    if (message.nodeId === undefined) { return; }
                    assert(this.resourceBlocks !== undefined);
                    if (this.resourceBlocks === undefined) { return; }
                    let serviceName = message.nodeId.replace(/[^0-9a-zA-Z_\.\-]/g, "");
                    new IaCPoIViewManager(this.context, this.mIaCDiagnostics, serviceName, this.resourceBlocks);
                    return;
            }
        });
    }

    async runInframap(codePath: string): Promise<void> {
        let inframapPath = await this.getInframapPath();
        if (inframapPath === undefined) { return; }

        const filenames: string[] = [];
        await tar.t({
            file: inframapPath,
            onentry: entry => filenames.push(entry.path),
        });
        if (filenames.length === 0) { return; };
        let inframapExecName = filenames[0];

        // Create a temporary directory
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'inframap-'));

        await tar.x(
            {
                file: inframapPath,
                cwd: tmpDir
            },
            [inframapExecName]
        );
        inframapPath = path.join(tmpDir, inframapExecName);

        if (this.hideProgressBar) {
            vscode.window.showErrorMessage("Inframap is already running.");
            return;
        }

        vscode.window.withProgress({
            location: { viewId: 'iacAudit' }
        }, (progress, token) => {
            return new Promise<void>((resolve, reject) => {
                this.hideProgressBar = resolve;
            });
        });

        let codeDir = path.dirname(codePath);
        let inframapArgs = "generate --clean=false --hcl";
        let inframapArgsArray = inframapArgs.split(" ").concat(codeDir);
        console.log(`[IaC View] Running Inframap (${inframapPath}) with args: ${inframapArgsArray}`);

        // Start a Semgrep run to parse HCL files
        let semgrepPromise = util.handleStartSemgrepScan(this.context, null, codeDir);

        try {
            child_process.execFile(inframapPath,
                inframapArgsArray,
                { timeout: constants.INFRAMAP_TIMEOUT_MS },
                (error, stdout, stderr) => {
                    this.inframapCallback(error, stdout, stderr, semgrepPromise);
                }
            );
        } catch (error) {
            const resp = vscode.window.showInformationMessage(
                `Error while running Inframap.`,
            );
            return;
        }
        return;
    }


    diagnosticsUpdate(diagnostics: Map<string, any>) {
        if (this.disposed) { return; }
        this.diagnostics = diagnostics;
        if (this.currentPanel !== undefined) {
            this.currentPanel.webview.html = this.getWebviewContent();
        }
    }

    private getWebviewContent(): string {
        let diagram = "";
        if (this.diagram !== undefined) {
            diagram = this.diagram;
        }
        if ((this.currentPanel !== undefined) && (this.currentPanel.webview !== undefined)) {
            diagram = diagram.replace(/image=\"(.*?)\"/g, (match, capture) => {
                if (this.currentPanel === undefined) { return match; }
                return `image="${this.currentPanel.webview.asWebviewUri(vscode.Uri.file(capture))}"`;
            });
        }
        let formattedDiagram = diagram.replace(/\'/g, '').replace(/\n/g, '');
        console.log(`[IaC View] Diagram: ${diagram}`);

        // For each resource node, count how many PoIs there are
        let poiList = [];
        for (let [key, value] of this.diagnostics) {
            if (!value.message.includes(constants.IAC_POI_MESSAGE)) { continue; };
            poiList.push(value.message);
        }

        // For each resource node, count how many PoIs there are
        let findingsList = [];
        for (let [poiFilter, resourceBlock] of this.resourceBlocks) {
            let [path, startLine, startCol, endLine, endCol] = resourceBlock;
            // Semgrep lines are 1-indexed, vscode lines are 0-indexed
            startLine = startLine - 1;
            endLine = endLine - 1;
            for (let [key, value] of this.diagnostics) {
                if (value.path !== path) { continue; };
                if ((value.line > endLine) || (value.line < startLine)) { continue; }
                findingsList.push(poiFilter);
            }
        }
        
        let scriptUri = vscode.Uri.joinPath(this.context.extensionUri, 'res', 'iacView.js');
        let styleUri = vscode.Uri.joinPath(this.context.extensionUri, 'res', 'iacView.css');
        let scriptWebUri = "./res/iacView.js";
        let styleWebUri = "./res/iacView.css";
        if (this.currentPanel !== undefined) {
            scriptWebUri = this.currentPanel.webview.asWebviewUri(scriptUri).toString();
            styleWebUri = this.currentPanel.webview.asWebviewUri(styleUri).toString();
        }

        let res = `
        <html>
            <head>
                <link rel="stylesheet" type="text/css" href="${styleWebUri}">
                <script type="text/javascript" src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js" integrity="sha384-Ux6phic9PEHJ38YtrijhkzyJ8yQlH8i/+buBR8s3mAZOJrP1gwyvAcIYl3GWtpX1" crossorigin="anonymous"></script>
                <script type="text/javascript">
                    /* Dynamically generated constants */
                    const DOTstring = '${formattedDiagram}';
                    const resourceBlocks = '${this.resourceBlocks}';
                    const poiList = ${JSON.stringify(poiList)};
                    const findingsList = ${JSON.stringify(findingsList)};
                </script>
            </head>
            <body>
                <div id="diagram" style=></div>
                <script type="text/javascript" src="${scriptWebUri}"></script>
            </body>
        </html>
        `;
        return res;
    }
}