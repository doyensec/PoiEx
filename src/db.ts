import * as sqlite3 from 'sqlite3';
import * as sqlite from 'sqlite';
import { assert } from 'console';

import * as util from './util';

// Create a class called LocalDB
export class LocalDB {
    // Create a private variable called db
    private db: sqlite.Database<sqlite3.Database, sqlite3.Statement> | null;
    path: string;

    // Create a constructor that takes a path to the database
    constructor(path: string) {
        // Create a new sqlite3 database
        this.db = null;
        this.path = path;
    }

    async init() {
        this.db = await sqlite.open({
            filename: this.path,
            driver: sqlite3.Database
        });
        await this.dbCreateTables();
    }

    // Create a function called close that closes the database
    async close() {
        if (this.db === null) {
            return;
        }
        console.log('[IaC LocalDB] Closing');
        let olddb = this.db;
        this.db = null;
        // Close, but not await. May at times create a memory leak
        // TODO: Fix memory leak
        olddb.close().then(() => {
            console.log('[IaC LocalDB] Closed');
        }).catch((err: any) => {
            console.log('[IaC LocalDB] FIXME Error closing db: ' + err);
        });
    }

    // Given a thread id, return a list of all comment ids that are children of that thread
    async getCommentsForThread(threadId: string): Promise<string[]> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return []; }

        let comments: string[] = [];
        let stmt = await this.db.prepare('SELECT id FROM comments WHERE thread_id = ?');
        let rows = await stmt.all(threadId);
        await stmt.finalize();
        rows.forEach((row: any) => {
            comments.push(row.id);
        });
        return comments;
    }

    async dropAllTables() {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return []; }

        let stmt1 = await this.db.prepare('DROP TABLE IF EXISTS comments');
        await stmt1.run();
        await stmt1.finalize();
        let stmt2 = await this.db.prepare('DROP TABLE IF EXISTS threads');
        await stmt2.run();
        await stmt2.finalize();
        let stmt3 = await this.db.prepare('DROP TABLE IF EXISTS diagnostics');
        await stmt3.run();
        await stmt3.finalize();
    }

    // DB
    async dbCreateTables() {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return []; }

        let stmt;
        stmt = await this.db.prepare('CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, thread_id TEXT, comment TEXT, timestamp_updated DATETIME DEFAULT CURRENT_TIMESTAMP, timestamp_created DATETIME DEFAULT CURRENT_TIMESTAMP, user_created TEXT, deleted INTEGER DEFAULT 0)');
        await stmt.run();
        await stmt.finalize();
        stmt = await this.db.prepare('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, anchor TEXT, file_path TEXT, deleted INTEGER DEFAULT 0)');
        await stmt.run();
        await stmt.finalize();
        stmt = await this.db.prepare('CREATE TABLE IF NOT EXISTS diagnostics (id TEXT PRIMARY KEY, diagnostic TEXT, flag INTEGER, flag_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, anchor TEXT, file_path TEXT, timestamp_created DATETIME DEFAULT CURRENT_TIMESTAMP)');
        await stmt.run();
        await stmt.finalize();
    }

    // DB
    async dbGetThreads(): Promise<[any[], Map<number, any>]> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return [[], new Map()]; }

        let threads: any[] = [];
        let comments: Map<number, any> = new Map();
        let stmt = await this.db.prepare('SELECT * FROM threads WHERE deleted = 0');
        let rows = await stmt.all();
        await stmt.finalize();
        rows.forEach((row: any) => {
            threads.push(row);
            comments.set(row.id, []);
        });
        stmt = await this.db.prepare('SELECT * FROM comments WHERE deleted = 0');
        rows = await stmt.all();
        rows.forEach((row: any) => {
            comments.get(row.thread_id).push(row);
        });
        return [threads, comments];
    }

    // DB
    async deleteOrphanComments(): Promise<void> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return; }

        // Delete comments that are not associated with a thread
        // let stmt = await this.db.prepare('DELETE FROM comments WHERE thread_id NOT IN (SELECT id FROM threads)');
        let stmt = await this.db.prepare('UPDATE comments SET comment = NULL, timestamp_updated = NULL, timestamp_created = NULL, user_created = NULL, deleted = 1 WHERE thread_id NOT IN (SELECT id FROM threads)');
        await stmt.run();
        await stmt.finalize();
    }

    // DB
    async createOrReplaceThread(tid: string, anchor: string, filePath: string): Promise<void> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return; }
        
        let stmt = await this.db.prepare('INSERT OR REPLACE INTO threads (id, anchor, file_path) VALUES (?, ?, ?)');
        await stmt.run(tid, anchor, filePath);
        await stmt.finalize();
    }

    // DB
   async dbCreateOrReplaceComment(cid: string, tid: string, comment: string, userCreated: string, lastModified: number | null = null): Promise<void> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return; }
    
        lastModified = lastModified === null ? (Date.now() / 1000) : lastModified;
        let stmt = await this.db.prepare('INSERT OR REPLACE INTO comments (id, thread_id, comment, user_created, timestamp_updated) VALUES (?, ?, ?, ?, ?)');
        await stmt.run(cid, tid, comment, userCreated, lastModified);
        await stmt.finalize();
    }

    // DB
    async dbDeleteComments(cids: string[]): Promise<void> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return; }

        // Delete comments from database
        // let stmt = await this.db.prepare('DELETE FROM comments WHERE id IN (?)');
        let stmt = await this.db.prepare('UPDATE comments SET comment = NULL, timestamp_updated = NULL, timestamp_created = NULL, user_created = NULL, deleted = 1 WHERE id IN (?)');
        await stmt.run(cids);
        await stmt.finalize();
    }

    // DB
    async dbDeleteTid(tid: string): Promise<void> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return; }

        // Delete thread from database
        // let stmt = this.db.prepare('DELETE FROM threads WHERE id = ?');
        let stmt = await this.db.prepare('UPDATE threads SET anchor = NULL, file_path = NULL, deleted = 1 WHERE id = ?');
        await stmt.run(tid);
        await stmt.finalize();
        
        // stmt = this.db.prepare('DELETE FROM comments WHERE thread_id = ?');
        stmt = await this.db.prepare('UPDATE comments SET comment = NULL, timestamp_updated = NULL, timestamp_created = NULL, user_created = NULL, deleted = 1 WHERE thread_id = ?');
        await stmt.run(tid);
        await stmt.finalize();

        // Delete orphan comments
        await this.deleteOrphanComments();
    }

    async dbGetDeletedThreads(): Promise<string[]> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return []; }

        let stmt = await this.db.prepare('SELECT id FROM threads WHERE deleted = 1');
        let res = await stmt.all();
        await stmt.finalize();
        return res.map((row: any) => row.id);
    }

    async dbGetDeletedComments(): Promise<[string, string][]> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return []; }

        let stmt = await this.db.prepare('SELECT id, thread_id FROM comments WHERE deleted = 1');
        let rows = await stmt.all();
        await stmt.finalize();
        return rows.map((row: any) => [row.id, row.thread_id]);
    }

    async dbClearDiagnostics(): Promise<void> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return; }

        let stmt = await this.db.prepare('DELETE FROM diagnostics');
        await stmt.run();
        await stmt.finalize();
    }

    async dbDeleteDiagnostic(uuid: string): Promise<void> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return; }

        let stmt = await this.db.prepare('DELETE FROM diagnostics WHERE id = ?');
        await stmt.run(uuid);
        await stmt.finalize();
    }

    async dbGetDiagnostics(): Promise<any[]> {
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return []; }

        let stmt = await this.db.prepare('SELECT id, diagnostic, flag, flag_timestamp, anchor, file_path, timestamp_created FROM diagnostics');
        let res = await stmt.all();
        await stmt.finalize();
        return res;
    }

    async dbCreateOrReplaceDiagnosticWithId(uuid: string, diagnostic: string, anchor: string, filePath: string, flag: number, lastModified: number | null = null): Promise<void> {
        assert(uuid !== null && uuid !== undefined, '[IaC LocalDB] uuid must be defined');
        assert(diagnostic !== null && diagnostic !== undefined, '[IaC LocalDB] diagnostic must be defined');
        assert(anchor !== null && anchor !== undefined, '[IaC LocalDB] anchor must be defined');
        assert(filePath !== null && filePath !== undefined, '[IaC LocalDB] filePath must be defined');
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return; }
        
        lastModified = lastModified === null ? (Date.now() / 1000) : lastModified;
        let stmt = await this.db.prepare('INSERT OR REPLACE INTO diagnostics (id, diagnostic, flag, flag_timestamp, anchor, file_path, timestamp_created) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)');
        console.log(`[IaC LocalDB] Binding sqlite parameters for diagnostic: ${uuid}, ${diagnostic}, ${anchor}, ${filePath}, ${lastModified}`);
        await stmt.run(uuid, diagnostic, flag, anchor, filePath, lastModified);
        await stmt.finalize();
    }

    async dbUpdateDiagnosticFlag(uuid: string, flag: number): Promise<void> {
        assert(uuid !== null && uuid !== undefined, '[IaC LocalDB] uuid must be defined');
        assert(flag !== null && flag !== undefined, '[IaC LocalDB] flag must be defined');
        assert(this.db !== null, '[IaC LocalDB] db is null');
        if (this.db === null) { return; }
        
        let stmt = await this.db.prepare('UPDATE diagnostics SET flag = ?, flag_timestamp = CURRENT_TIMESTAMP WHERE id = ?');
        await stmt.run(flag, uuid);
        await stmt.finalize();
    }

    async dbCreateOrReplaceDiagnostic(diagnostic: string, anchor: string, filePath: string, flag: number): Promise<string> {
        let uuid = util.genUUID();
        await this.dbCreateOrReplaceDiagnosticWithId(uuid, diagnostic, anchor, filePath, flag);
        return uuid;
    }
}