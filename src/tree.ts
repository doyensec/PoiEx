import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

import * as projects from './projects';
import * as constants from './constants';
import * as remote from './remote';

export class ProjectTreeViewManager {
    private context: vscode.ExtensionContext;
    private pdb: projects.IaCProjectDir;
    private rdb: remote.RemoteDB | undefined;
    private projectTreeView: vscode.TreeView<ProjectItem> | undefined = undefined;
    private projectTreeDataProvider: ProjectSelectorProvider | undefined = undefined;
    private originalViewTitle: string | undefined = undefined;
    private _disposables: vscode.Disposable[] = [];
    private hideProgressBar: any = undefined;

    constructor(context: vscode.ExtensionContext, pbd: projects.IaCProjectDir, rdb: remote.RemoteDB | undefined) {
        this.context = context;
        this.pdb = pbd;
        this.rdb = rdb;

        this._disposables.push(vscode.commands.registerCommand('iacAudit.refreshProjectTree', async () => {
            if (this.hideProgressBar !== undefined) {
                console.log("[IaC Tree] Already refreshing project list");
                return;
            }

            vscode.window.withProgress({
                location: { viewId: 'iacAudit' }
            }, (progress, token) => {
                return new Promise<void>((resolve, reject) => {
                    this.hideProgressBar = resolve;
                });
            });

            try {
                await this.update();
            }
            catch (err: any) {
                console.error(`[IaC Tree] Error refreshing project list: ${err}`);
            }
            finally {
                if (this.hideProgressBar !== undefined) {
                    this.hideProgressBar();
                    this.hideProgressBar = undefined;
                }
            }
        }));

        this._disposables.push(vscode.commands.registerCommand('iacAudit.deleteTreeProject', async (project: ProjectItem) => {
            console.log(`[IaC Tree] Deleting project ${project.uuid}`);
            await this.pdb.removeProject(project.uuid, rdb);
            await this.update();
        }));
    }

    async show() {
        this.projectTreeDataProvider = new ProjectSelectorProvider([]);
        this.projectTreeView = vscode.window.createTreeView('iacAudit', {
            treeDataProvider: this.projectTreeDataProvider,
        });
        this.originalViewTitle = this.projectTreeView.title;
        this.projectTreeView.title = constants.PROJECT_TREE_VIEW_TITLE;
        this.projectTreeView.message = undefined;
        this.projectTreeView.onDidChangeSelection(async (e) => {
            if (e.selection.length !== 1) {
                console.log(`[IaC Tree] Invalid selection length: ${e.selection}`);
                return;
            }
            let project = e.selection[0];
            if (project instanceof ProjectItem) {
                console.log(`[IaC Tree] Opening project ${project.uuid}`);
                await vscode.commands.executeCommand(`${constants.EXT_NAME}.openProject`, project.uuid);
                return;
            }
            console.log(`[IaC Tree] Invalid selection: ${e.selection}`);
        });
    }

    async hide() {
        if (this.projectTreeView === undefined) {
            return;
        }
        this.projectTreeView.title = this.originalViewTitle || "";
        this.projectTreeView.message = undefined;
        await this.projectTreeView?.dispose();
    }

    async showDbError() {
        if (this.projectTreeView === undefined) {
            await this.show();
        }
        (this.projectTreeView as vscode.TreeView<ProjectItem>).message = constants.PROJECT_TREE_VIEW_DB_ERROR_MESSAGE;
    }

    private async syncRemoteDB(): Promise<boolean> {
        if (this.rdb === undefined) {
            return false;
        }

        if (this.rdb.settingsEnabled()) {
            // Promisify onDbReadyOnce
            let onDbReadyOnce = (): Promise<void> => {
                let rrdb = this.rdb;
                return new Promise(function(resolve, reject) {
                    if (rrdb === undefined) {
                        resolve();
                    }
                    else {
                        rrdb.onDbReadyOnce(resolve);
                    }
                });
            }

            try {
                await onDbReadyOnce();
                await this.pdb.safeSyncProjects(this.rdb);
            }
            catch (err) {
                console.error(`[IaC Tree] Error syncing remote DB: ${err}`);
                return false;
            }
            return true;
		}
		else {
            return false;
		}
    }

    async update(projectList: {}[] | null = null) {
        if (projectList == null) {
            await this.syncRemoteDB();
            projectList = (await this.pdb.listProjects()) as {}[];
        }
        if (this.projectTreeView !== undefined) {
            this.projectTreeDataProvider?.update(projectList);
            if (projectList.length === 0) {
                this.projectTreeView.message = constants.PROJECT_TREE_VIEW_NO_PROJECTS_MESSAGE;
            }
        }
    }

    async dispose() {
        await this.hide();

        this._disposables.forEach((disposable) => {
            disposable.dispose();
        });
    }
}

class ProjectSelectorProvider implements vscode.TreeDataProvider<ProjectItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ProjectItem | undefined | null | void> = new vscode.EventEmitter<ProjectItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ProjectItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private projectList: any[]) { }

    update(projectList: any[]) {
        this.projectList = projectList;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ProjectItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ProjectItem): Thenable<ProjectItem[]> {
        if (element) {
            return Promise.resolve([]);
        } else {
            return Promise.resolve(this.getProjects());
        }
    }

    private getProjects(): ProjectItem[] {
        return this.projectList.map(
            (project: any) =>
                new ProjectItem(project.uuid, project.name, vscode.TreeItemCollapsibleState.None)
        );
    }
}

class ProjectItem extends vscode.TreeItem {
    constructor(
        public uuid: string,
        private pname: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        const label = pname;
        super(label, collapsibleState);
        this.tooltip = `${this.label} $ ${this.uuid}`;
        this.description = this.uuid;
    }    

    // TODO: add icons for projects
    //iconPath = {
    //    light: path.join(__filename, '..', '..', 'resources', 'light', 'dependency.svg'),
    //    dark: path.join(__filename, '..', '..', 'resources', 'dark', 'dependency.svg')
    //};
}