import * as vscode from 'vscode';

import { IaCDiagnostics } from './diagnostics';
import * as constants from './constants';


export class IaCPoIViewManager {
    private context: vscode.ExtensionContext;
    private disposables: vscode.Disposable[] = [];
    private currentPanel: vscode.WebviewPanel | undefined = undefined;
    private diagnostics: Map<string, any> = new Map<string, any>();
    private disposed = false;
    private poiFilter;
    private mIaCDiagnostics: IaCDiagnostics;
    private resourceBlocks: Map<string, [string, number, number, number, number]>;

    constructor(context: vscode.ExtensionContext, mIaCDiagnostics: IaCDiagnostics, poiFilter: string, resourceBlocks: Map<string, [string, number, number, number, number]>) {
        this.context = context;
        this.poiFilter = poiFilter;
        this.resourceBlocks = resourceBlocks;
        this.mIaCDiagnostics = mIaCDiagnostics;
        mIaCDiagnostics.onDiagnosticsUpdate((diagnostics) => { this.diagnosticsUpdate(diagnostics); });

        this.currentPanel = vscode.window.createWebviewPanel(
            'poiView',
            `IaC PoI (${poiFilter})`,
            vscode.ViewColumn.One, // Editor column to show the new webview panel in.
            { enableScripts: true } // Webview options.
        );

        this.currentPanel.onDidDispose(() => { this.currentPanel = undefined; }, null, this.disposables);

        this.getWebviewContent().then( data => {
            if (this.currentPanel !== undefined) {
                this.currentPanel.webview.html = data;
            }
        })

        this.currentPanel.webview.onDidReceiveMessage(async message => {
            console.log(message);
            switch (message.command) {
                case 'openPoi':
                    let poiUUID = message.poiUUID;
                    let poi = this.diagnostics.get(poiUUID);
                    console.log(poi);
                    if (poi === undefined) {
                        vscode.window.showErrorMessage(`PoI ${poiUUID} not found`);
                        return;
                    }

                    // Go to the file and line
                    let doc = await mIaCDiagnostics.getDocumentFromSemgrepPath(poi.path);
                    if (doc === undefined) {
                        vscode.window.showErrorMessage(`File ${poi.path} not found`);
                        return;
                    }
                    let line = poi.line;
                    vscode.window.showTextDocument(doc).then((editor) => {
                        let range = new vscode.Range(line, 0, line, 100);
                        editor.selection = new vscode.Selection(range.start, range.end);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    });
                    break;
                case 'openIaC':
                    let resourceBlock = this.resourceBlocks.get(this.poiFilter);
                    if (resourceBlock === undefined) {
                        vscode.window.showErrorMessage(`No resource block found for ${this.poiFilter}`);
                        return;
                    }
                    let [path, startLine, startCol, endLine, endCol] = resourceBlock;
                    let doc2 = await mIaCDiagnostics.getDocumentFromSemgrepPath(path);
                    if (doc2 === undefined) {
                        vscode.window.showErrorMessage(`File ${path} not found`);
                        return;
                    }
                    let range = new vscode.Range(startLine - 1, startCol - 1, endLine - 1, endCol - 1);
                    vscode.window.showTextDocument(doc2).then((editor) => {
                        editor.selection = new vscode.Selection(range.start, range.end);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    });
                    break;
                default:
                    console.error(`[PoI View] Unknown command ${message.command}`);
                    break;
            }
        });
    }

    dispose() {
        this.disposed = true;
        for (let d of this.disposables) {
            this.context.subscriptions.splice(this.context.subscriptions.indexOf(d), 1);
            d.dispose();
        }
        if (this.currentPanel !== undefined) { this.currentPanel.dispose(); }
    }

    diagnosticsUpdate(diagnostics: Map<string, any>) {
        if (this.disposed) { return; }
        this.diagnostics = diagnostics;
        this.getWebviewContent().then( data => {
            if (this.currentPanel !== undefined) {
                this.currentPanel.webview.html = data;
            }
        })
    }

    private async getWebviewContent(): Promise<string> {
        let poiList = [];
        let providerFilter = "";
        let serviceFilter = "";
        let poiFilterParts = this.poiFilter.split("_");
        if (poiFilterParts.length >= 1) {
            providerFilter = this.poiFilter.split("_")[0];
        }
        if (poiFilterParts.length >= 2) {
            serviceFilter = this.poiFilter.split("_")[1];
        }

        // Filter Points of Intersections that are related to the selected cloud service
        for (let [key, value] of this.diagnostics) {
            if (!value.message.includes(constants.IAC_POI_MESSAGE)) { continue; };
            if (!value.message.toLowerCase().includes(providerFilter.toLowerCase())) { continue; }
            if (!value.message.toLowerCase().includes(serviceFilter.toLowerCase())) { continue; }
            poiList.push([key, value.message, value.path, value.line]);
        }
        // Filter diagnostics that match the currently selected resource block
        let resourceBlock = this.resourceBlocks.get(this.poiFilter);
        if (resourceBlock !== undefined) {
            let [path, startLine, startCol, endLine, endCol] = resourceBlock;
            // Semgrep lines are 1-indexed, vscode lines are 0-indexed
            startLine = startLine - 1;
            endLine = endLine - 1;
            for (let [key, value] of this.diagnostics) {
                if (value.path !== path) { continue; };
                if ((value.line > endLine) || (value.line < startLine)) { continue; }
                poiList.push([key, value.message, value.path, value.line]);
            }
            console.log(`[PoI View] Resource block found for ${this.poiFilter}`);
        }
        else {
            console.log(`[PoI View] No resource block found for ${this.poiFilter}`);
        }

        // Get IaC definition for selected resource block
        let iacDefinitionBlock: string | null = null;
        if (resourceBlock !== undefined) {
            let [path, startLine, startCol, endLine, endCol] = resourceBlock;
             
            // Document from semgrep path
            let doc = await this.mIaCDiagnostics.getDocumentFromSemgrepPath(path);
            if (doc === undefined) {
                vscode.window.showErrorMessage(`File ${path} not found`);
            }
            else {
                // Semgrep lines are 1-indexed, vscode lines are 0-indexed
                let r = new vscode.Range(startLine - 1, startCol - 1, endLine - 1, endCol - 1);
                iacDefinitionBlock = doc.getText(r);
            }
        }

        let scriptUri = vscode.Uri.joinPath(this.context.extensionUri, 'res', 'poiView.js');
        let styleUri = vscode.Uri.joinPath(this.context.extensionUri, 'res', 'poiView.css');
        let scriptWebUri = "./res/poiView.js";
        let styleWebUri = "./res/poiView.css";
        if (this.currentPanel !== undefined) {
            scriptWebUri = this.currentPanel.webview.asWebviewUri(scriptUri).toString();
            styleWebUri = this.currentPanel.webview.asWebviewUri(styleUri).toString();
        }

        let res = `
        <html>
            <head>
                <link rel="stylesheet" type="text/css" href="${styleWebUri}">
                <script type="text/javascript">
                    /* Dynamically generated constants */
                    const poiFilter = '${this.poiFilter}';
                    const poiList = ${JSON.stringify(poiList)};
                    const iacResource = ${JSON.stringify(iacDefinitionBlock)};
                </script>
            </head>
            <body>
                <div id="container"></div>
                <script type="text/javascript" src="${scriptWebUri}"></script>
            </body>
        </html>
        `;
        return res;
    }
}