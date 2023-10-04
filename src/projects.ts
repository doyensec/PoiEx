// IaC Project directory

import * as path from "path";
import * as vscode from "vscode";
import * as sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import assert = require("assert");

import { RemoteDB } from "./remote";
import { LocalDB } from "./db";
import { IaCEncryption } from "./encryption";
import * as constants from "./constants";

export class IaCProjectDir {
    private pdb: Database<sqlite3.Database, sqlite3.Statement> | null;
    private context: vscode.ExtensionContext;
    private currentSync: Promise<void> | undefined = undefined;
    private iacPath: vscode.Uri;

    constructor(context: vscode.ExtensionContext, iacPath: vscode.Uri) {
        // Create a new sqlite3 database in the global storage directory
        this.pdb = null;
        this.iacPath = iacPath;
        this.context = context;
    }

    async init(): Promise<void> {
        assert(this.pdb === null, "ProjectDB init called twice");
        console.log("[IaC ProjectDir] Init");
        if (this.pdb !== null) { return; }
        this.pdb = await this.initProjectDb(this.iacPath);
        return;
    }

    async initProjectDb(iacPath: vscode.Uri) {
        let relDbPath = constants.PROJECT_DIR_DB;
        let dbPath = iacPath.fsPath + '/' + relDbPath;
        let db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });
        await this.createDbTables(db);
        return db;
    }

    async createDbTables(db: any) {
        await db.exec(`CREATE TABLE IF NOT EXISTS projects (
            uuid TEXT NOT NULL PRIMARY KEY,
            name TEXT NOT NULL,
            keys TEXT NULL,
            jwt TEXT NULL DEFAULT NULL,
            deleted INTEGER DEFAULT 0
        )`);
    }

    async listProjects(): Promise<{}[]> {
        if (this.pdb === null) {
            return [];
        }
        let stmt = await this.pdb.prepare('SELECT uuid, name, keys FROM projects WHERE deleted = 0');
        let rows = await stmt.all({});
        await stmt.finalize();
        return rows as {}[];
    }

    async pushProject(uuid: string, name: string, keys: string | null, jwt: string | null = null) {
        if (this.pdb === null) {
            return;
        }
        if (jwt === null && keys !== null) {
            let mIaCEncryption = new IaCEncryption();
            await mIaCEncryption.setKey(keys);
            jwt = await mIaCEncryption.encrypt({ uuid: uuid });
        }

        let stmt = await this.pdb.prepare('INSERT OR REPLACE INTO projects (uuid, name, keys, jwt) VALUES (?, ?, ?, ?)');
        console.log(`[IaC Projects] pushProject(${uuid}, ${name}, ${keys})`);
        assert(uuid !== null);
        await stmt.run(uuid, name, keys, jwt);
        await stmt.finalize();
    }

    async removeProject(uuid: string, rdb: RemoteDB | null = null) {
        if (this.pdb === null) {
            return;
        }
        let stmt = await this.pdb.prepare('UPDATE projects SET deleted = 1, keys = NULL, jwt = NULL, name = \'\' WHERE uuid = ?');
        await stmt.run(uuid);
        await stmt.finalize();

        if (rdb !== null) {
            await this.syncProjects(rdb);
        }
    }

    async getProject(uuid: string): Promise<[string, string, string, string] | null> {
        if (this.pdb === null) {
            return null;
        }
        console.log(`[IaC Projects] getProject(${uuid})`);
        console.log(`[IaC Projects] list of projects:`);
        (await this.listProjects()).forEach((project: any) => {
            console.log(`[IaC Projects] ${project.uuid} ${project.name} ${project.keys}`);
        });


        let stmt = await this.pdb.prepare('SELECT uuid, name, keys, jwt FROM projects WHERE uuid = ? AND deleted = 0');
        let row: any = await stmt.get(uuid);
        await stmt.finalize();
        if (row === undefined || row === null) {
            return null;
        }
        return [row.uuid, row.name, row.keys, row.jwt];
    }

    async close() {
        if (this.pdb === null) {
            return;
        }
        await this.pdb.close();
    }

    async safeSyncProjects(rdb: RemoteDB) {
        if (this.currentSync !== undefined) {
            console.log("[IaC Projects] Sync already in progress, skipping");
            return;
        }
        this.currentSync = this.syncProjects(rdb).finally(() => {
            this.currentSync = undefined;
        });
        await this.currentSync;
    }

    async syncProjects(rdb: RemoteDB): Promise<void> {
        console.log(`[IaC Projects] syncProjects()`);
        if (!rdb.settingsEnabledAndConfigured()) { return; }
        if (this.pdb === null) { return; }
        let res = await rdb.listProjects();
        if (res === null) { return; }
        let [remoteProjects, remoteDeletedProjects] = res;
        remoteDeletedProjects = remoteDeletedProjects.map((row: any) => row.uuid);
        
        let remoteProjectUuids = remoteProjects.map((row: any) => row.uuid);
        console.log(`[IaC Projects] remoteProjects: ${remoteProjectUuids} total ${remoteProjects.length}`);

        let stmt = await this.pdb.prepare('SELECT uuid, name, jwt, deleted FROM projects');
        let rows = await stmt.all();
        await stmt.finalize();
        let localProjects = rows.filter((row: any) => row.deleted !== 1);
        let localDeletedProjects = rows.filter((row: any) => row.deleted === 1).map((row: any) => row.uuid);

        // Delete local projects that have been deleted remotely
        console.log(`[IaC Projects] remoteDeletedProjects: ${remoteDeletedProjects}`);
        for (let uuid of remoteDeletedProjects) {
            console.log(`[IaC Projects] uuid: ${uuid}`);
            if (localProjects.some((row: any) => row.uuid === uuid)) {
                await this.removeProject(uuid);
                // Remove the project from the local list so it doesn't get added again
                localProjects = localProjects.filter((row: any) => row.uuid !== uuid);
                // Remove local project database
                // TODO: remove duplicate code from main file
                let dbDir = path.join(this.context.globalStorageUri.fsPath, constants.IAC_FOLDER_NAME);
                let dbFilename = path.basename(`/${constants.EXT_NAME}-${uuid}.db`);
                let dbPath = path.join(dbDir, dbFilename);
                let db = new LocalDB(dbPath);
                await db.init();
                await db.dropAllTables();
                await db.close();
            } else if (rows.filter((row: any) => row.uuid === uuid).length === 0) {
                // If the project doesn't exist locally, add it as deleted
                console.log(`[IaC Projects] Adding remote project as deleted: ${uuid}`);
                await this.pushProject(uuid, "", null);
                await this.removeProject(uuid);
            }
        }

        // Delete remote projects that have been deleted locally
        for (let uuid of localDeletedProjects) {
            if (remoteProjects.some((proj: any) => proj.uuid === uuid) || (!remoteDeletedProjects.some((uuid2: any) => uuid2 === uuid))) {
                console.log(`[IaC Projects] Removing remote project ${uuid} as was deleted locally`);
                await rdb.pushProject(uuid, "", null, true);

                // Remove the project from the remote list so it doesn't get added again
                remoteProjects = remoteProjects.filter((proj: any) => proj.uuid !== uuid);
            }
        }

        // Push local projects that don't exist remotely
        for (let row of localProjects) {
            if (!remoteProjects.some((proj: any) => proj.uuid === row.uuid)) {
                console.log(`[IaC Projects] Pushing local project: ${row.uuid}`);
                await rdb.pushProject(row.uuid, row.name, row.jwt, false);
            }
        }

        // Pull remote projects that don't exist locally
        for (let proj of remoteProjects) {
            let uuid = proj.uuid;
            if (localProjects.some((row: any) => row.uuid === uuid)) {
                console.log(`[IaC Projects] Project already exists locally: ${uuid}`);
                continue;
            }
            console.log(`[IaC Projects] Pulling remote project into local db: ${uuid}`);
            await this.pushProject(proj.uuid, proj.name, null, proj.jwt);
        }

        console.log(`[IaC Projects] syncProjects() done`);

        return;
    }
}