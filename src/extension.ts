import * as vscode from 'vscode';
import { assert } from 'console';
import * as path from 'path';
import * as fs from 'fs';

import { IaCProjectDir } from './projects';
import { IaCWebviewManager } from './iacview';
import * as constants from './constants';
import { handleOpenSemgrepJson, handleStartSemgrepScan } from './util';
import * as util from './util';
import { IaCDiagnostics } from './diagnostics';
import { LocalDB } from './db';
import { RemoteDB } from './remote';
import * as comments from './comments';
import { IaCEncryption } from './encryption';

let db: LocalDB;
let rdb: RemoteDB;
let mComments: comments.IaCComments;
let pdb: IaCProjectDir;
let projectDisposables: vscode.Disposable[] = [];
let projectClosing: boolean = false;

export async function initLocalDb(dbDir: string, projectUuid: string) {
	// Create sqlite3 database in storage directory
	let dbFilename = path.basename(`/${constants.EXT_NAME}-${projectUuid}.db`);
	let dbPath = path.join(dbDir, dbFilename);
	db = new LocalDB(dbPath);
	await db.init();
}

function updateStatusBar(rdb: RemoteDB, remoteStatus: vscode.StatusBarItem) {
	remoteStatus.command = `${constants.EXT_NAME}.statusBarButton`;
	if (rdb.settingsEnabledAndConfigured()) {
		remoteStatus.text = '$(compass-dot) Remote DB: Enabled (disconnected)';
		if (rdb.isRemoteReady()) {
			remoteStatus.text = '$(compass-active) Remote DB: Enabled (connected)';
		}
		remoteStatus.tooltip = 'Click to disable remote database';
	}
	else {
		remoteStatus.text = '$(compass) Remote DB: Disabled';
		remoteStatus.tooltip = 'Click to enable remote database';
	}
	remoteStatus.show();
}

async function statusBarButtonPressed(context: vscode.ExtensionContext, rdb: RemoteDB, remoteStatus: vscode.StatusBarItem) {
	if (rdb.settingsEnabledAndConfigured()) {
		console.log("[IaC Main] Status bar button pressed: disabling remote database");
		await vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).update('collab.enabled', false, true);
		rdb.disable();
		updateStatusBar(rdb, remoteStatus);
	}
	else if (rdb.settingsConfigured()) {
		console.log("[IaC Main] Status bar button pressed: enabling remote database");
		await vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).update('collab.enabled', true, true);
		rdb.enable();
		updateStatusBar(rdb, remoteStatus);
	}
	else {
		console.log("[IaC Main] Status bar button pressed: opening settings page");
		// Open settings page
		vscode.commands.executeCommand('workbench.action.openSettings', `${constants.EXT_NAME}.collab`);
	}
}

export function initRemoteDB(context: vscode.ExtensionContext) {
	// Init status bar indicator for remote connection
	let remoteStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

	let rdb = new RemoteDB(context.secrets);

	// Register command for status bar button
	context.subscriptions.push(vscode.commands.registerCommand(`${constants.EXT_NAME}.statusBarButton`, () => {
		statusBarButtonPressed(context, rdb, remoteStatus);
	}));

	// Update status bar
	updateStatusBar(rdb, remoteStatus);
	rdb.onDisable(() => {
		// Update status bar
		updateStatusBar(rdb, remoteStatus);
	});
	rdb.onEnable(() => {
		// Update status bar
		updateStatusBar(rdb, remoteStatus);
	});

	rdb.onDbReady(() => {
		// Update status bar
		console.log("[IaC Main] Remote DB ready, updating status bar");
		updateStatusBar(rdb, remoteStatus);
	});

	return rdb;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	let storageUri = context.globalStorageUri;
	let iacPath = path.join(storageUri.fsPath, constants.IAC_FOLDER_NAME);
	console.log(iacPath);

	// Set context variable to hide / show sidebar views
	vscode.commands.executeCommand('setContext', 'iacAudit.isProjectOpen', false);
	vscode.commands.executeCommand('setContext', 'iacAudit.isProjectCreator', false);
	vscode.commands.executeCommand('setContext', 'iacAudit.isProjectEncrypted', false);

	// Check if number of workspace folders is 1
	if (vscode.workspace.workspaceFolders === undefined || vscode.workspace.workspaceFolders.length !== 1) {
		console.log('[IaC Main] Number of workspace folders is not 1, skipping activation');
		return;
	}

	// Ensure that the storage directory exists
	util.ensureDirExists(iacPath).then((res) => {
		if (res !== true) {
			console.log('[IaC Main] Could not create storage directory, skipping activation');
			return;
		}
		return init1(context, iacPath);
	});

	return;
}

async function init1(context: vscode.ExtensionContext, iacPath: string) {
	let iacUri = vscode.Uri.file(iacPath);
	pdb = new IaCProjectDir(context, iacUri);
	await pdb.init();
	let projectUuidList = (await pdb.listProjects())?.map((project: any) => project.uuid);

	// Check if a project is already open in the workspace
	let projectName = context.workspaceState.get('projectName', undefined);
	let projectUuid = context.workspaceState.get('projectUuid', undefined);
	if (!projectUuidList?.includes(projectUuid)) {
		projectUuid = undefined;
		projectName = undefined;
	}

	if (projectUuid !== undefined) {
		// Initialize remote database
		if (rdb === undefined) {
			rdb = initRemoteDB(context);
		}

		console.log('[IaC Main] Project already open in workspace');
		openProject(context, iacUri, projectUuid);
	}

	let ensureDbOk = () => {
		// Initialize remote database
		if (rdb === undefined) {
			rdb = initRemoteDB(context);
		}

		if (rdb.settingsEnabled() && !rdb.settingsConfigured()) {
			// Show notification
			vscode.window.showInformationMessage('Please configure the remote database settings first, or disable remote database.');

			// Open settings page
			vscode.commands.executeCommand('workbench.action.openSettings', `${constants.EXT_NAME}.collab`);
			return false;
		}
		return true;
	};

	// No project open
	// Register command to initialize project
	console.log(`[IaC Main] Registering ${constants.EXT_NAME}.initProject command`);
	context.subscriptions.push(vscode.commands.registerCommand(`${constants.EXT_NAME}.initProject`, () => {
		console.log("[IaC Main] Init project button pressed");
		if (!ensureDbOk()) {
			console.log('[IaC Main] Remote database not configured, cannot initialize project');
			return;
		}

		let cb = () => {
			// Ask for project name
			vscode.window.showInputBox({
				placeHolder: 'Please enter project name',
				prompt: 'Please enter project name',
				validateInput: (value: string) => {
					if (value === undefined || value === '') {
						return 'Project name cannot be empty';
					}
					return undefined;
				}
			}).then((projectName) => {
				if (projectName === undefined) {
					return;
				}
				// Quickselect "Do you want to encrypt the project?" dialog
				vscode.window.showQuickPick(['Yes', 'No'], {
					placeHolder: 'Do you want to encrypt the project?'
				}).then(async (value) => {
					if (value === undefined) {
						return;
					}
					let encrypt = value === 'Yes';
					// Push to local database
					let projectUuid = util.genUUID();
					let projectSecret = encrypt ? await IaCEncryption.genKey() : null;
					await pdb.pushProject(projectUuid, projectName, projectSecret);
					pdb.safeSyncProjects(rdb);

					openProject(context, iacUri, projectUuid);
				});
			});
		};

		if (rdb.settingsEnabled()) {
			rdb.onDbReadyOnce(() => { pdb.safeSyncProjects(rdb); cb(); });
		}
		else {
			cb();
		}
	}));

	// Register command to open an existing project
	context.subscriptions.push(vscode.commands.registerCommand(`${constants.EXT_NAME}.openProject`, async () => {
		console.log('[IaC Main] Open project button pressed');
		if (!ensureDbOk()) {
			console.log('[IaC Main] Remote database not configured, cannot open project');
			return;
		}

		let cb = async () => {
			console.log('[IaC Main] Open project ready, executing callback');

			// Show list of projects as quickpick
			let projectList = (await pdb.listProjects()) as {}[];
			let projectNames = projectList.map((project: any) => project.name + " $ " + project.uuid);
			console.log('[IaC Main] Open project got list of projects');
			if (projectNames.length === 0) {
				vscode.window.showInformationMessage('No projects found, please create a new project first.');
				return;
			}

			vscode.window.showQuickPick(projectNames, {
				placeHolder: 'Please select a project to open'
			}).then(async (choice) => {
				if (choice === undefined) {
					return;
				}
				let projectUuid = choice.split(' $ ')[1];
				let project = await pdb.getProject(projectUuid);
				assert(project !== null, "Project not found in local database");
				if (project === null) { return; };
				if (project[3] === null || project[2] !== null) {
					openProject(context, iacUri, projectUuid);
					return;
				}
				// Ask for project secret
				vscode.window.showInputBox({
					placeHolder: 'Please enter project secret',
					prompt: 'Please enter project secret',
					password: true,
					validateInput: (value: string) => {
						if (value === undefined || value === '') {
							return 'Project secret cannot be empty';
						}
						return undefined;
					}
				}).then((projectSecret) => {
					if (projectSecret === undefined) {
						return;
					}
					openProject(context, iacUri, projectUuid, projectSecret);
				});
			});
		};

		if (rdb.settingsEnabled()) {
			rdb.onDbReadyOnce(async () => { await pdb.safeSyncProjects(rdb); await cb(); });
		}
		else {
			await cb();
		}
	}));
}

async function openProject(context: vscode.ExtensionContext, storageUri: vscode.Uri, projectUuid: string, projectSecret: string | null = null) {
	let projectAttrs = await pdb.getProject(projectUuid);
	assert(projectAttrs !== null, "Project not found in local database (2)");
	if (projectAttrs === null) {
		return;
	}
	let [puuid, projectName, pkeys, jwt] = projectAttrs;

	let mIaCEncryption = new IaCEncryption();
	if (projectSecret === null) {
		projectSecret = pkeys;
	}
	await mIaCEncryption.setKey(projectSecret);
	if ((pkeys === "") || (pkeys === null)) { // If no key was in database
		// Check that key is correct and add to database
		if (await mIaCEncryption.checkKey(jwt) !== puuid) {
			vscode.window.showErrorMessage('Incorrect project secret');
			mIaCEncryption.dispose();
			return;
		}
		// Save key to database
		await pdb.pushProject(puuid, projectName, projectSecret);
	}
	projectDisposables.push(mIaCEncryption);
	// If key is in database, assume it's correct
	
	// Set workspaceState variables to remember project
	context.workspaceState.update('projectName', projectName);
	context.workspaceState.update('projectUuid', projectUuid);
	context.workspaceState.update('projectEncrypted', projectSecret !== null);

	// Set context variables to show / hide sidebar views
	vscode.commands.executeCommand('setContext', 'iacAudit.isProjectOpen', true);
	vscode.commands.executeCommand('setContext', 'iacAudit.isProjectCreator', true);
	vscode.commands.executeCommand('setContext', 'iacAudit.isProjectEncrypted', projectSecret !== null);

	rdb.setProjectUuid(projectUuid, projectSecret);

	await initLocalDb(storageUri.fsPath, projectUuid);

	// Continue with extension initialization
	mComments = new comments.IaCComments(context, db, rdb);

	// Init diagnostics
	let mIaCDiagnostics = new IaCDiagnostics(context, db, rdb);
	mIaCDiagnostics.loadDiagnostics(); // Do not await promise

	// Init IaC webview manager
	let mIacWebviewManager = new IaCWebviewManager(context, mIaCDiagnostics);

	// Commands to manually load Semgrep results
	let disposableCommand1 = vscode.commands.registerCommand(`${constants.EXT_NAME}.readSemgrepJson`, () => handleOpenSemgrepJson(context, mIaCDiagnostics));
	context.subscriptions.push(disposableCommand1); projectDisposables.push(disposableCommand1);

	let disposableCommand3 = vscode.commands.registerCommand(`${constants.EXT_NAME}.deleteAllDiagnostics`, async () => await mIaCDiagnostics.clearDiagnostics());
	context.subscriptions.push(disposableCommand3); projectDisposables.push(disposableCommand3);

	let disposableCommand4 = vscode.commands.registerCommand(`${constants.EXT_NAME}.runSemgrep`, () => handleStartSemgrepScan(context, mIaCDiagnostics));
	context.subscriptions.push(disposableCommand4); projectDisposables.push(disposableCommand4);

	// Generic command to open an arbitrary link
	let disponsableCommand5 = vscode.commands.registerCommand(`${constants.EXT_NAME}.openLink`, (link: string) => {
		vscode.env.openExternal(vscode.Uri.parse(link));
	});
	context.subscriptions.push(disponsableCommand5); projectDisposables.push(disponsableCommand5);

	// Register command to close current project
	let disposableCommand6 = vscode.commands.registerCommand(`${constants.EXT_NAME}.closeProject`, async () => {
		await closeProject(context, projectUuid, db, mIaCDiagnostics, mComments, mIacWebviewManager);
	});
	context.subscriptions.push(disposableCommand6); projectDisposables.push(disposableCommand6);

	// Register command to export current project
	let disposableCommand7 = vscode.commands.registerCommand(`${constants.EXT_NAME}.exportProject`, () => {
		let saveUri = vscode.Uri.file(`${projectName}.sqlite3`);
		vscode.window.showSaveDialog({ title: "Export to file", saveLabel: "Export project", defaultUri: saveUri }).then(fileInfos => {
			if (fileInfos === undefined) {
				return;
			}
			fs.copyFileSync(db.path, fileInfos.path);
		});
	});
	context.subscriptions.push(disposableCommand7); projectDisposables.push(disposableCommand7);

	// Register command to destroy current project
	let disposableCommand8 = vscode.commands.registerCommand(`${constants.EXT_NAME}.destroyProject`, async () => {
		vscode.window.showWarningMessage('Are you sure you want to destroy this project (remove also on remote)?', 'Yes', 'No').then(async (choice) => {
			if (await pdb.getProject(projectUuid) === null) { return; }
			if (choice === 'Yes') {
				await pdb.removeProject(projectUuid, rdb);
				await closeProject(context, projectUuid, db, mIaCDiagnostics, mComments, mIacWebviewManager);
			}
		});
	});
	context.subscriptions.push(disposableCommand8); projectDisposables.push(disposableCommand8);
	let disposableCommand9 = vscode.commands.registerCommand(`${constants.EXT_NAME}.destroyLocalProject`, async () => {
		vscode.window.showWarningMessage('Are you sure you want to destroy this project (remove only locally)?', 'Yes', 'No').then(async (choice) => {
			if (await pdb.getProject(projectUuid) === null) { return; }
			if (choice === 'Yes') {
				await pdb.removeProject(projectUuid, null);
				await closeProject(context, projectUuid, db, mIaCDiagnostics, mComments, mIacWebviewManager);
			}
		});
	});
	context.subscriptions.push(disposableCommand9); projectDisposables.push(disposableCommand9);

	// Register command to copy secret to the user's clipboard
	let disposableCommand10 = vscode.commands.registerCommand(`${constants.EXT_NAME}.copyKey`, () => {
		assert(projectSecret !== null, "Pressed copyKey on an unencrypted project");
		if (projectSecret === null) { return; }

		// Copy to clipboard and Notify user
		vscode.env.clipboard.writeText(projectSecret);
		vscode.window.showInformationMessage('Copied project secret to clipboard');
	});
	context.subscriptions.push(disposableCommand10); projectDisposables.push(disposableCommand10);
}

async function closeProject(context: vscode.ExtensionContext, projectUuid: string, db: LocalDB, mIaCDiagnostics: IaCDiagnostics, mComments: comments.IaCComments, mIacWebviewManager: IaCWebviewManager) {
	// Prevent race conditions
	if (projectClosing) { 
		console.log("[IaC Main] closeProject(): Project is already closing");
		return;
	}
	projectClosing = true;

	mIacWebviewManager.dispose();
	mComments.dispose();
	mIaCDiagnostics.dispose();
	
	// Dispose all project disposables
	projectDisposables.forEach((disposable) => {
		context.subscriptions.splice(context.subscriptions.indexOf(disposable), 1);
		disposable.dispose();
	});
	
	rdb.setProjectUuid(null);
	console.log("[IaC Main] closeProject(): Closing project " + projectUuid);
	await db.close();
	
	// Clear workspaceState variables
	context.workspaceState.update('projectName', undefined);
	context.workspaceState.update('projectUuid', undefined);
	context.workspaceState.update('projectEncrypted', undefined);
	
	// Set context variables to show / hide sidebar views
	vscode.commands.executeCommand('setContext', 'iacAudit.isProjectOpen', false);
	vscode.commands.executeCommand('setContext', 'iacAudit.isProjectCreator', false);
	vscode.commands.executeCommand('setContext', 'iacAudit.isProjectEncrypted', false);

	// Race condition prevention
	projectClosing = false;	
}

// This method is called when your extension is deactivated
export function deactivate() {
	db.close();
	// All disposables are automatically disposed when extension is deactivated
}