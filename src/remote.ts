import { MongoClient, MongoServerError, FindOptions } from 'mongodb';
import * as mongodb from 'mongodb';
import * as vscode from 'vscode';
import * as util from './util';
import * as constants from './constants';
import { assert, time } from 'console';
import { IaCEncryption } from './encryption';
var urlParser = require('url-parse');

export class RemoteDB {
    private dbName: string | null = null;
    private url: string | null = null;
    private onDbReadyList: (() => void)[] = [];
    private onDbReadyOnceList: (() => void)[] = [];
    private onDiagnosticChangesList: (([]) => void)[] = [];
    private onCommentChangesList: (() => void)[] = [];
    private onEnableList: (() => void)[] = [];
    private onDisableList: (() => void)[] = [];
    private secretStorage: vscode.SecretStorage;
    private remoteReady: boolean = false;
    private dbEnabled: boolean;
    private diagnosticsChangeStream: any;
    private projectUuid: string | null = null;
    private diagnosticsCollection: string | null = null;
    private commentsCollection: string | null = null;
    private commentsChangeStream: any;
    private encryptionManager: IaCEncryption = new IaCEncryption();
    private readonly UPDATE_EXPIRATIONS_EVERY_MS = 15 * 60 * 1000; // 15 minutes

    // TODO: prevent this from growing forever
    private uuidsToIgnore: string[] = [];

    // private mongoClientOptions = { tls: true, tlsCAFile: '/etc/ssl/certs/ca-certificates.crt' };
    private mongoClientOptions = {};

    settingsEnabled(): boolean {
        return vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('collab.enabled', false);
    }

    settingsConfigured(): boolean {
        let remoteUrl: string | null = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('collab.uri', null);
        let remoteDb = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('collab.database', null);
        return remoteUrl !== undefined && remoteUrl !== null && remoteDb !== undefined && remoteDb !== null;
    }

    settingsEnabledAndConfigured(): boolean {
        let remoteEnabled = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('collab.enabled', false);
        let remoteUrl: string | null = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('collab.uri', null);
        let remoteDb = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('collab.database', null);
        return remoteEnabled && remoteUrl !== undefined && remoteUrl !== null && remoteDb !== undefined && remoteDb !== null;
    }

    private fetchSettings() {
        this.url = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('collab.uri', null);
        this.dbName = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('collab.database', null);
    }

    getDbName(): string | null {
        this.fetchSettings();
        return this.dbName;
    }

    setProjectUuid(uuid: string | null, projectSecret: string | null = null) {
        this.projectUuid = uuid;
        this.encryptionManager.dispose();
        this.encryptionManager = new IaCEncryption();
        if (projectSecret !== null) {
            this.encryptionManager.setKey(projectSecret);
        }
        this.diagnosticsCollection = constants.DIAGNOSTICS_COLLECTION_PREFIX + uuid;
        this.commentsCollection = constants.COMMENTS_COLLECTION_PREFIX + uuid;
        if (uuid === null) {
            this.diagnosticsCollection = null;
            this.commentsCollection = null;
        }
        if (this.settingsEnabledAndConfigured()) {
            this.disable();
            this.enable();
        }
    }

    constructor(secretStorage: vscode.SecretStorage) {
        this.fetchSettings();
        this.secretStorage = secretStorage;

        if (this.settingsEnabledAndConfigured()) {
            this.enable();
            this.dbEnabled = true;
        }
        else {
            this.disable();
            this.dbEnabled = false;
        }

        vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
            if ((!e.affectsConfiguration(`${constants.EXT_NAME}.collab.enabled`)) && (!e.affectsConfiguration(`${constants.EXT_NAME}.collab.uri`)) && (!e.affectsConfiguration(`${constants.EXT_NAME}.collab.database`))) {
                return;
            }
            if (this.dbEnabled === this.settingsEnabledAndConfigured()) {
                return;
            }
            this.fetchSettings();
            if (this.settingsEnabledAndConfigured()) {
                this.enable();
            }
            else {
                this.disable();
            }
        });

        // Call updateAllExpirations every 15 minutes
        setInterval(() => this.updateAllExpirations(), this.UPDATE_EXPIRATIONS_EVERY_MS);
    }

    async startChangeListener() {
        assert(this.dbName !== null);
        if (this.dbName === null) {
            return;
        }
        let lDiagnosticsCollection = this.diagnosticsCollection;
        let lCommentsCollection = this.commentsCollection;
        if (lDiagnosticsCollection === null || lCommentsCollection === null) {
            return;
        }

        let callback = (next: any, cb2: any) => {
            const ignoreCond1 = next.fullDocument && next.fullDocument.ephemeral_uuid && this.uuidsToIgnore.includes(next.fullDocument.ephemeral_uuid);
            const ignoreCond2 = next.operationType === "delete" && this.uuidsToIgnore.includes(next.documentKey._id.toString());
            const ignoreCond3 = next.operationType === "update" && next.updateDescription.updatedFields && Object.keys(next.updateDescription.updatedFields).length === 1 && Object.keys(next.updateDescription.updatedFields).includes("expireAt");
            if (ignoreCond1 || ignoreCond2 || ignoreCond3) {
                if (ignoreCond3) { console.log("[IaC RemoteDB] Change detected, ignoring expiration update"); }
                else { console.log("[IaC RemoteDB] Change detected, ignoring change"); };
                console.log(next);

                // Drop from UUIDsToIgnore
                let key = next.fullDocument === undefined ? next.documentKey._id.toString() : next.fullDocument.ephemeral_uuid;
                this.uuidsToIgnore = this.uuidsToIgnore.filter((uuid: string) => uuid !== key);

                return;
            }
            console.log("[IaC RemoteDB] Change detected, processing change");
            console.log(next);
            cb2();
        };

        let client = await this.getMongoClient();
        await client.connect();
        const db = client.db(this.dbName);

        const collection = db.collection(lDiagnosticsCollection);
        this.diagnosticsChangeStream = collection.watch();
        this.diagnosticsChangeStream.on('change', (next: any) => {
            callback(next, () => this.diagnosticUpdate());
        });

        const commentsCollection = db.collection(lCommentsCollection);
        this.commentsChangeStream = commentsCollection.watch();
        this.commentsChangeStream.on('change', (next: any) => {
            callback(next, () => {
                this.commentUpdate();
            });
        });
    }

    async stopChangeListener() {
        if (this.diagnosticsChangeStream) {
            this.diagnosticsChangeStream.close();
        }
        if (this.commentsChangeStream) {
            this.commentsChangeStream.close();
        }
    }

    onDbReady(func: () => void) {
        if (this.remoteReady) {
            func();
        }
        else {
            this.onDbReadyList.push(func);
        }
    }

    onDbReadyOnce(func: () => void) {
        if (this.remoteReady) {
            func();
        }
        else {
            this.onDbReadyOnceList.push(func);
        }
    }

    onEnable(func: () => void) {
        if (this.dbEnabled) {
            func();
        }
        else {
            this.onEnableList.push(func);
        }
    }

    onDisable(func: () => void) {
        if (!this.dbEnabled) {
            func();
        }
        else {
            this.onDisableList.push(func);
        }
    }

    dbReady() {
        console.log("[IaC RemoteDB] Remote DB ready");
        if (this.remoteReady === true) { return; }
        this.remoteReady = true;
        for (let i = 0; i < this.onDbReadyList.length; i++) {
            this.onDbReadyList[i]();
        }
        for (let i = 0; i < this.onDbReadyOnceList.length; i++) {
            this.onDbReadyOnceList[i]();
        }
        this.onDbReadyOnceList = [];
    }

    isRemoteReady(): boolean {
        return this.remoteReady;
    }

    disable() {
        this.dbEnabled = false;
        this.remoteReady = false;
        this.stopChangeListener();
        for (let i = 0; i < this.onDisableList.length; i++) {
            this.onDisableList[i]();
        }
    }

    enable() {
        if (this.dbEnabled) { return; };
        this.dbEnabled = true;
        this.remoteCredsCheck();
        for (let i = 0; i < this.onEnableList.length; i++) {
            this.onEnableList[i]();
        }
    }

    onDiagnosticsUpdate(func: any) {
        this.onDiagnosticChangesList.push(func);
    }

    diagnosticUpdate() {
        this.getRemoteDiagnostics().then((diagnostics: any[]) => {
            for (let i = 0; i < this.onDiagnosticChangesList.length; i++) {
                this.onDiagnosticChangesList[i](diagnostics);
            }
        });
    }

    onCommentsUpdated(func: any) {
        this.onCommentChangesList.push(func);
    }

    commentUpdate() {
        for (let i = 0; i < this.onCommentChangesList.length; i++) {
            this.onCommentChangesList[i]();
        }
    }

    async pushComment(cid: string, tid: string, comment: string | null, userCreated: string | null, timestampModified: number | null, deleted: boolean): Promise<void> {
        assert(this.dbName !== null);
        if (this.dbName === null) {
            return;
        }
        let lCommentsCollection = this.commentsCollection;
        if (lCommentsCollection === null) { return; }
        assert(this.isRemoteReady());
        let client = await this.getMongoClient();
        await client.connect();
        const db = client.db(this.dbName);
        const collection = db.collection(lCommentsCollection);

        // Generate ephemeral UUID
        let ephemeralUuid = util.genUUID();
        this.uuidsToIgnore.push(ephemeralUuid);

        let commentObj = {
            type: "comment",
            cid: cid,
            tid: tid,
            comment: await this.encryptionManager.optionallyEncryptString(comment),
            userCreated: await this.encryptionManager.optionallyEncryptString(userCreated),
            timestampModified: timestampModified,
            deleted: deleted,
            ephemeral_uuid: ephemeralUuid,
            expireAt: await this.getDocumentExpireDate()
        };

        // Delete comments with the same cid, if any
        let commentsToDelete = await collection.find({ type: "comment", cid: cid }).toArray();
        let remoteUUIDs = commentsToDelete.map((comment: any) => comment._id);
        this.uuidsToIgnore = this.uuidsToIgnore.concat(remoteUUIDs.map((uuid: string) => uuid.toString()));
        // Use the UUIDs to make sure we don't delete any new comments
        await collection.deleteMany({ _id: { $in: remoteUUIDs } });

        await collection.insertOne(commentObj);
        await client.close();
    }

    async getDocumentExpireDate(): Promise<Date | undefined> {
        let ctime = await this.getRemoteTimestamp();
        // Get expiration date from config
        let expireSeconds = vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get('collab.expireAfter', null);

        if (expireSeconds === undefined || expireSeconds === null || expireSeconds <= 0) {
            return undefined;
        }
        let expireSecondsVal = parseInt(expireSeconds);
        if (isNaN(expireSecondsVal)) {
            return undefined;
        }

        let etime: number = (ctime + expireSecondsVal) * 1000;
        let expireDate = new Date(etime);

        return expireDate;
    }

    async updateAllExpirations(): Promise<void> {
        if (!this.isRemoteReady()) {
            return;
        }
        // Avoid race conditions as this is called periodically in the background
        let commentsCollection = this.commentsCollection;
        let diagnosticsCollection = this.diagnosticsCollection;
        if (commentsCollection === null || diagnosticsCollection === null) { return; }

        console.log("[IaC RemoteDB] Running aggregation pipeline to update all expirations");

        /*const AGGREGATION_PIPELINE = [{
            "$set": {
                "expireAt": {
                    "$dateFromParts": {
                        "year": 1970,
                        "millisecond": {
                            "$convert": {
                                "to": "long", "input": "$$NOW", "onError": 0
                            }
                        }
                    }
                }
            }
        }];*/

        assert(this.dbName !== null);
        if (this.dbName === null) {
            return;
        }

        let client = await this.getMongoClient();
        await client.connect();
        const db = client.db(this.dbName);

        // Preferred update method. Will randomly delete the entire collection
        //db.collection('comments').updateMany({}, AGGREGATION_PIPELINE);
        //db.collection('diagnostics').updateMany({}, AGGREGATION_PIPELINE);

        // Alternative method. Currently only supported method as we filter updates in the change listener
        let exp = await this.getDocumentExpireDate();
        db.collection(commentsCollection as string).updateMany({}, { "$set": { "expireAt": exp } });
        db.collection(diagnosticsCollection as string).updateMany({}, { "$set": { "expireAt": exp } });
    }

    async pushThread(tid: string, timestampModified: number | null, deleted: boolean, filePath: string | null, anchor: string | null): Promise<void> {
        assert(this.dbName !== null);
        if (this.dbName === null) {
            return;
        }
        let lCommentsCollection = this.commentsCollection;
        let lDiagnosticsCollection = this.diagnosticsCollection;
        if (lCommentsCollection === null || lDiagnosticsCollection === null) { return; }
        assert(this.isRemoteReady());
        let client = await this.getMongoClient();
        await client.connect();
        const db = client.db(this.dbName);
        const collection = db.collection(lCommentsCollection);

        // Generate ephemeral UUID
        let ephemeralUuid = util.genUUID();
        this.uuidsToIgnore.push(ephemeralUuid);

        let threadObj = {
            type: "thread",
            tid: tid,
            timestampModified: timestampModified,
            deleted: deleted,
            filePath: await this.encryptionManager.optionallyEncryptString(filePath),
            anchor: await this.encryptionManager.optionallyEncryptString(anchor),
            ephemeral_uuid: ephemeralUuid,
            expireAt: await this.getDocumentExpireDate()
        };

        // Delete threads with same tid, if any
        let threadsToDelete = await collection.find({ type: "thread", tid: tid }).toArray();
        let remoteUUIDs = threadsToDelete.map((diagnostic: any) => diagnostic._id);
        this.uuidsToIgnore = this.uuidsToIgnore.concat(remoteUUIDs.map((uuid: string) => uuid.toString()));
        // Use the UUIDs to make sure we don't delete any new threads
        await collection.deleteMany({ _id: { $in: remoteUUIDs } });

        await collection.insertOne(threadObj);
        await client.close();
    }

    async getComments(ts: number): Promise<[any[], any[]]> {
        assert(this.dbName !== null);
        if (this.dbName === null) {
            return [[], []];
        }
        let lCommentsCollection = this.commentsCollection;
        let lDiagnosticsCollection = this.diagnosticsCollection;
        if (lCommentsCollection === null || lDiagnosticsCollection === null) { return [[], []]; }
        assert(this.isRemoteReady());
        let client = await this.getMongoClient();
        await client.connect();
        const db = client.db(this.dbName);
        const collection = db.collection(lCommentsCollection);
        let updates = await collection.find({ timestampModified: { "$gt": ts }, deleted: false }).toArray();
        const projection: FindOptions['projection'] = { type: 1, tid: 1, cid: 1 };
        let deletes = await collection.find({ deleted: true }, { projection }).toArray();

        // Decrypt encrypted fields in comments and threads. Deletes have fields set to null so we don't need to decrypt
        for (let update of updates) {
            if (update.type === "thread") {
                update.filePath = await this.encryptionManager.optionallyDecryptString(update.filePath);
                update.anchor = await this.encryptionManager.optionallyDecryptString(update.anchor);
            } else if (update.type === "comment") {
                update.comment = await this.encryptionManager.optionallyDecryptString(update.comment);
                update.userCreated = await this.encryptionManager.optionallyDecryptString(update.userCreated);
            }
        }

        await client.close();
        return [updates, deletes];
    }

    async listProjects(): Promise<[any[], any[]] | null> {
        assert(this.dbName !== null);
        if (this.dbName === null) { return null; }
        if (!this.isRemoteReady()) { return null; }

        let client = await this.getMongoClient();
        await client.connect();

        const db = client.db(this.dbName);
        const collection = db.collection(constants.PROJECT_DIR_COLLECTION);
        let projects = await collection.find({ deleted: false }).toArray();
        let deletedProjects = await collection.find({ deleted: true }).toArray();

        await client.close();
        return [projects, deletedProjects];
    }

    async pushProject(uuid: string, name: string, jwt: string | null, deleted: boolean): Promise<boolean> {
        assert(this.dbName !== null);
        if (this.dbName === null) { return false; }
        if (!this.isRemoteReady()) { return false; }

        let client = await this.getMongoClient();
        await client.connect();

        const db = client.db(this.dbName);
        const collection = db.collection(constants.PROJECT_DIR_COLLECTION);
        await collection.updateOne({ uuid: uuid }, { $set: { name: name, jwt: jwt, deleted: deleted, uuid: uuid } }, { upsert: true });

        await client.close();
        return true;
    }

    async getRemoteDiagnostics(): Promise<any[]> {
        assert(this.dbName !== null);
        if (this.dbName === null) {
            return [];
        }
        let commentsCollection = this.commentsCollection;
        let diagnosticsCollection = this.diagnosticsCollection;
        if (commentsCollection === null || diagnosticsCollection === null) {
            return [];
        }
        assert(this.isRemoteReady());
        let client = await this.getMongoClient();
        await client.connect();
        const db = client.db(this.dbName);
        const collection = db.collection(diagnosticsCollection);
        let remoteDiagnostics = await collection.find({}).toArray();

        // Decrypt diagnostics
        for (let diagnostic of remoteDiagnostics) {
            diagnostic.diagnostic = await this.encryptionManager.optionallyDecryptString(diagnostic.diagnostic);
            diagnostic.anchor = await this.encryptionManager.optionallyDecryptString(diagnostic.anchor);
            diagnostic.file_path = await this.encryptionManager.optionallyDecryptString(diagnostic.file_path);
        }

        await client.close();
        return remoteDiagnostics;
    }

    async deleteDiagnostics(db: mongodb.Db | null = null, uuids: string[] | null = null): Promise<void> {
        assert(this.dbName !== null);
        if (this.dbName === null) {
            return;
        }
        let commentsCollection = this.commentsCollection;
        let diagnosticsCollection = this.diagnosticsCollection;
        if (commentsCollection === null || diagnosticsCollection === null) {
            return;
        }
        assert(this.isRemoteReady());
        if (db === null) {
            let client = await this.getMongoClient();
            await client.connect();
            db = client.db(this.dbName);
        }

        const collection = db.collection(diagnosticsCollection);

        // Get list of UUIDs of all diagnostics in remote DB
        let remoteDiagnostics = null;
        if (uuids !== null) {
            remoteDiagnostics = await collection.find({ id: { $in: uuids } }).toArray();
        }
        else {
            remoteDiagnostics = await collection.find({}).toArray();
        }
        let remoteUUIDs = remoteDiagnostics.map((diagnostic: any) => diagnostic._id);
        this.uuidsToIgnore = this.uuidsToIgnore.concat(remoteUUIDs.map((uuid: string) => uuid.toString()));

        // Delete all diagnostics in remote DB, use the UUIDs to make sure we don't delete any new diagnostics
        await collection.deleteMany({ _id: { $in: remoteUUIDs } });
    }

    async pushDiagnostics(diagnostics: any[], clearRemote: boolean = true): Promise<void> {
        assert(this.dbName !== null);
        if (this.dbName === null) {
            return;
        }
        let commentsCollection = this.commentsCollection;
        let diagnosticsCollection = this.diagnosticsCollection;
        if (commentsCollection === null || diagnosticsCollection === null) {
            return;
        }
        assert(this.isRemoteReady());
        console.log("[IaC RemoteDB] Pushing diagnostics");
        let client = await this.getMongoClient();
        await client.connect();
        const db = client.db(this.dbName);
        console.log("[IaC RemoteDB] this.diagnosticsCollection is " + diagnosticsCollection);
        const collection = db.collection(diagnosticsCollection);

        // Delete all diagnostics in remote DB
        if (clearRemote) {
            await this.deleteDiagnostics(db);
        }
        else {
            let uuids = diagnostics.map((diagnostic: any) => diagnostic.id);
            await this.deleteDiagnostics(db, uuids);
        }

        if (diagnostics.length > 0) {

            // Add an ephemeral UUID to each diagnostic
            for (let i = 0; i < diagnostics.length; i++) {
                diagnostics[i].expireAt = await this.getDocumentExpireDate();
                diagnostics[i].ephemeral_uuid = util.genUUID();

                // Encrypt the diagnostic fields: diagnostic, anchor, file_path
                diagnostics[i].diagnostic = await this.encryptionManager.optionallyEncryptString(diagnostics[i].diagnostic);
                diagnostics[i].anchor = await this.encryptionManager.optionallyEncryptString(diagnostics[i].anchor);
                diagnostics[i].file_path = await this.encryptionManager.optionallyEncryptString(diagnostics[i].file_path);

                this.uuidsToIgnore.push(diagnostics[i].ephemeral_uuid);
            }
            await collection.insertMany(diagnostics);
        }
        await client.close();
    }

    async syncDiagnostics(diagnostics: any[]): Promise<[undefined | any[], boolean]> {
        assert(this.isRemoteReady());
        let remoteDiagnostics: any[] = await this.getRemoteDiagnostics();

        // Get average timestamp
        let avgTimestamp = 0;
        for (let i = 0; i < diagnostics.length; i++) {
            avgTimestamp += diagnostics[i].timestamp;
        }
        avgTimestamp /= diagnostics.length;
        // Get remote average timestamp
        let remoteAvgTimestamp = 0;
        for (let i = 0; i < remoteDiagnostics.length; i++) {
            remoteAvgTimestamp += remoteDiagnostics[i].timestamp;
        }
        remoteAvgTimestamp /= remoteDiagnostics.length;
        // If the remote average timestamp is newer, then we need to sync
        const EPSILON = 0.5; // Half a second
        if (remoteAvgTimestamp > avgTimestamp + EPSILON) {
            return [remoteDiagnostics, true];
        }
        else if (remoteAvgTimestamp < avgTimestamp - EPSILON) {
            await this.pushDiagnostics(diagnostics);
            return [undefined, true];
        }

        // Sync flags only, based on flag_timestamp
        // if remote flag_timestamp is greater than local flag_timestamp, pull remote flag
        // if remote flag_timestamp is less than local flag_timestamp, push local flag
        // Create map of local diagnostics based on UUID
        let returnList = [];
        let localDiagnosticsMap = new Map();
        for (let i = 0; i < diagnostics.length; i++) {
            localDiagnosticsMap.set(diagnostics[i].id, diagnostics[i]);
        }
        for (let i = 0; i < remoteDiagnostics.length; i++) {
            let remoteDiagnostic = remoteDiagnostics[i];
            let localDiagnostic = localDiagnosticsMap.get(remoteDiagnostic.id);
            if (localDiagnostic === undefined) {
                // Push remote diagnostic
                await this.pushDiagnostics([remoteDiagnostic], false);
            }
            else {
                // Pull remote diagnostic
                if (remoteDiagnostic.flag_timestamp > localDiagnostic.flag_timestamp) {
                    localDiagnostic.flag = remoteDiagnostic.flag;
                    localDiagnostic.flag_timestamp = remoteDiagnostic.flag_timestamp;
                    returnList.push(localDiagnostic);
                }
            }
        }

        if (returnList.length > 0) {
            return [returnList, false];
        }

        return [undefined, false];
    }

    async areCredentialsStored(): Promise<boolean> {
        let username = await this.secretStorage.get('remoteUsername');
        let password = await this.secretStorage.get('remotePassword');
        let host = await this.secretStorage.get('remoteHost');
        return username !== undefined && password !== undefined && host != undefined;
    }

    async getMongoClient(): Promise<MongoClient> {
        let parsedUrl = new urlParser(this.url);

        let username = await this.secretStorage.get('remoteUsername');
        let password = await this.secretStorage.get('remotePassword');
        let host = await this.secretStorage.get('remoteHost');

        if (username === undefined || password === undefined || host !== this.url) {
            return new MongoClient(parsedUrl.toString(), this.mongoClientOptions);
        }

        parsedUrl.set("username", username);
        parsedUrl.set("password", password);

        return new MongoClient(parsedUrl.toString(), this.mongoClientOptions);
    }

    async isAuthOk(): Promise<number> {
        assert(this.dbName !== null);
        if (this.dbName === null) { return -1; }

        let client = await this.getMongoClient();
        try {
            await client.connect();
            console.log('[IaC RemoteDB] Connected successfully to server');
        }
        catch (e) {
            // Show error to the user
            vscode.window.showErrorMessage('MongoDB connection error: ' + (e as Error).message);
            return -1;
        }
        try {
            const db = client.db(this.dbName);
            // Ensure we have read/write access to the database
            const collection = db.collection(constants.RW_CHECK_COLLECTION);
            // Generate UUID
            const uuid = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
            await collection.insertOne({ uuid: uuid });
            let res = await collection.find({ uuid: uuid }).toArray();
            if (res.length !== 1) {
                console.log('[IaC RemoteDB] MongoDB RW check failed');
                return -1;
            }
            await collection.deleteOne({ uuid: uuid });
            console.log('[IaC RemoteDB] MongoDB RW check successful');
        } catch (e) {
            if (e instanceof MongoServerError) {
                console.log("[IaC RemoteDB] MongoDB authentication failed error: " + (e as MongoServerError).message);
                return 0;
            }
            vscode.window.showErrorMessage('MongoDB server error: ' + (e as Error).message);
            return -1;
        }
        return 1;
    }

    // Check that indexes are present and create them if needed
    async checkIndexes(): Promise<void> {
        assert(this.dbName !== null);
        if (this.dbName === null) { return; }
        let lCommentsCollection = this.commentsCollection;
        let lDiagnosticsCollection = this.diagnosticsCollection;
        if (lCommentsCollection === null || lDiagnosticsCollection === null) { return; }

        // Ensure that an index is set on expireAt, so that the TTL feature works
        let client = await this.getMongoClient();
        await client.connect();
        const db = client.db(this.dbName);

        const commentsCollection = db.collection(lCommentsCollection);
        await commentsCollection.createIndex({ "expireAt": 1 }, { expireAfterSeconds: 0 });

        const diagnosticsCollection = db.collection(lDiagnosticsCollection);
        await diagnosticsCollection.createIndex({ "expireAt": 1 }, { expireAfterSeconds: 0 });

        await client.close();
    }

    async requestCredentials() {
        let msg = 'MongoDB authentication required.';
        if (await this.areCredentialsStored()) {
            msg = 'MongoDB authentication failed with stored credentials. Provide new credentials?';
        }
        let selection = await vscode.window.showErrorMessage(msg, "Provide credentials", "Retry", "Cancel");
        if (selection === undefined || selection === "Cancel") {
            return false;
        }
        if (selection === "Retry") {
            return true;
        }

        const username = await vscode.window.showInputBox({
            prompt: 'MongoDB username',
        });
        const password = await vscode.window.showInputBox({
            prompt: 'MongoDB password',
        });
        if (username === undefined || password === undefined) {
            return false;
        }
        this.secretStorage.store('remoteUsername', username);
        this.secretStorage.store('remotePassword', password);

        let secretUrl = "";
        if (this.url !== null) {
            secretUrl = this.url;
        }
        this.secretStorage.store('remoteHost', secretUrl);
        return true;
    }

    async remoteCredsCheck(): Promise<boolean> {
        console.log("[IaC RemoteDB] Checking remote credentials");
        assert(this.settingsEnabledAndConfigured());
        console.log("[IaC RemoteDB] Settings enabled and configured");
        let authOk = await this.isAuthOk();
        if (authOk === -1) {
            console.log("[IaC RemoteDB] Mongodb error");
            return false;
        }
        if (authOk === 0) {
            console.log("[IaC RemoteDB] Mongodb credentials needed");
            let gotCreds = await this.requestCredentials();
            if (gotCreds !== true) {
                return false;
            }
            return await this.remoteCredsCheck();
        }

        await this.checkIndexes();

        console.log("[IaC RemoteDB] Mongodb credentials ok");
        if (this.remoteReady === false) {
            this.dbReady();
            await this.startChangeListener();
        }

        // Do now await this
        this.updateAllExpirations();

        return true;
    }

    // Get timestamp of remote server in s, or local time if remote is not reachable
    // TODO: cache this and do not query remote db every time
    async getRemoteTimestamp() {
        assert(this.dbName !== null);
        if (this.dbName === null) {
            return Date.now() / 1000;
        }

        if (!this.isRemoteReady()) {
            return Date.now() / 1000;
        }

        // Execute a query to get the cluster time
        let client = await this.getMongoClient();
        await client.connect();
        const db = client.db(this.dbName);
        const collection = db.collection(constants.RW_CHECK_COLLECTION);
        let timestampBson: mongodb.Timestamp;

        if (constants.IS_MONGO_4) {
            let uuid = util.genUUID();
            this.uuidsToIgnore.push(uuid);
            await collection.insertOne({ "ephemeralUuid": uuid });
            let res = await collection.aggregate([
                { "$match": { "ephemeralUuid": uuid } },
                { "$project": { "_id": 0, "dt": "$$CLUSTER_TIME" } }
            ]);
            let dtres = await res.toArray();
            if (dtres.length < 1) {
                return Date.now() / 1000;
            }
            timestampBson = dtres[0].dt;
            await collection.deleteOne({ "ephemeralUuid": uuid });
        }
        else {
            let res = db.aggregate([{ $documents: [{ "dt": "$$CLUSTER_TIME" }] }]);
            let nextdoc = await res.next();
            if (nextdoc === null) {
                return Date.now() / 1000;
            }
            timestampBson = nextdoc.dt;
        }

        let timestamp = timestampBson.high;
        console.log("[IaC RemoteDB] Got remote timestamp: " + timestamp);
        console.log("[IaC RemoteDB] Local timestamp: " + Date.now() / 1000);
        return timestamp;
    }
}