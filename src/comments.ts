import { LocalDB } from './db';
import { assert } from 'console';
import * as vscode from 'vscode';
import { ANCHOR_LINES, findClosestAnchor } from './anchor';
import { RemoteDB } from './remote';
import * as util from './util';
import * as constants from './constants';

let isProjectEncrypted: boolean | undefined = undefined;

interface OurThread extends vscode.CommentThread {
    id: string;
}

// NoteComment
class NoteComment implements vscode.Comment {
    id: string;
    label: string | undefined;
    savedBody: string | vscode.MarkdownString; // for the Cancel button
    lastModified: number;
    constructor(
        public body: string | vscode.MarkdownString,
        public mode: vscode.CommentMode,
        public author: vscode.CommentAuthorInformation,
        public parent?: vscode.CommentThread,
        public contextValue?: string
    ) {
        if (isProjectEncrypted === false) {
            this.label = "(not signed, not encrypted)";
        }
        else if (isProjectEncrypted === true) {
            this.label = "(not signed, encrypted)";
        }
        else {
            this.label = "(not signed, ???)";
        }
        this.id = util.genUUID();
        this.savedBody = this.body;
        this.lastModified = Date.now() / 1000;
    }
}

export class IaCComments {
    private db: LocalDB;
    private rdb: RemoteDB;
    private threads: OurThread[] = [];
    private threadIdMap: Map<vscode.CommentThread, string> = new Map();
    private commentController: vscode.CommentController;
    private lastRemoteSync: number = 0;
    private currentSync: undefined | Promise<void> = undefined;
    private disposables: vscode.Disposable[] = [];
    private disposed: boolean = false;
    private context: vscode.ExtensionContext;
    private nextSync: boolean = false;

    constructor(context: vscode.ExtensionContext, db: LocalDB, rdb: RemoteDB) {
        this.db = db;
        this.rdb = rdb;
        this.context = context;

        // Check if project is encrypted, update global
        isProjectEncrypted = this.context.workspaceState.get('projectEncrypted', undefined);

        // Create a comment controller
        this.commentController = vscode.comments.createCommentController(constants.EXT_NAME, 'IaC Comments');
        this.commentController.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument, token: vscode.CancellationToken) => {
                // Allow commenting on all lines
                return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
            }
        };

        context.subscriptions.push(this.commentController);
        this.disposables.push(this.commentController);

        // Create comment button, when comment thread is empty
        let disposableCommand1 = vscode.commands.registerCommand(`${constants.EXT_NAME}.create_note`, async (reply: vscode.CommentReply) => {
            await this.createComment(reply.text, reply.thread);
            this.safeSyncComments();
        });
        context.subscriptions.push(disposableCommand1);
        this.disposables.push(disposableCommand1);

        // Reply to comment, when comment thread is not empty
        let disposableCommand2 = vscode.commands.registerCommand(`${constants.EXT_NAME}.replyNote`, async (reply: vscode.CommentReply) => {
            await this.createComment(reply.text, reply.thread);
            this.safeSyncComments();
        });
        context.subscriptions.push(disposableCommand2);
        this.disposables.push(disposableCommand2);

        // Delete comment
        let disposableCommand3 = vscode.commands.registerCommand(`${constants.EXT_NAME}.deleteNoteComment`, async (comment: NoteComment) => {
            const thread = comment.parent;
            if (!thread) { return; }

            await this.deleteComment(thread, comment.id);
            this.safeSyncComments();
        });
        context.subscriptions.push(disposableCommand3);
        this.disposables.push(disposableCommand3);

        // Delete comment thread
        let disposableCommand4 = vscode.commands.registerCommand(`${constants.EXT_NAME}.deleteNote`, async (thread: vscode.CommentThread) => {
            // Delete from global thread list
            await this.deleteThread(thread);
            thread.dispose();
            this.safeSyncComments();
        });
        context.subscriptions.push(disposableCommand4);
        this.disposables.push(disposableCommand4);

        // Cancel editing comment without saving
        let disposableCommand5 = vscode.commands.registerCommand(`${constants.EXT_NAME}.cancelsaveNote`, (comment: NoteComment) => {
            if (!comment.parent) {
                return;
            }

            comment.parent.comments = comment.parent.comments.map(cmt => {
                if ((cmt as NoteComment).id === comment.id) {
                    cmt.body = (cmt as NoteComment).savedBody;
                    cmt.mode = vscode.CommentMode.Preview;
                }

                return cmt;
            });
        });
        context.subscriptions.push(disposableCommand5);
        this.disposables.push(disposableCommand5);

        // Save edited comment
        let disposableCommand6 = vscode.commands.registerCommand(`${constants.EXT_NAME}.saveNote`, async (comment: NoteComment) => {
            if (!comment.parent) {
                return;
            }

            await this.updateComment((comment.parent as OurThread), comment, comment.body.toString());
            this.safeSyncComments();
        });
        context.subscriptions.push(disposableCommand6);
        this.disposables.push(disposableCommand6);
            
        // Edit comment
        let disposableCommand7 = vscode.commands.registerCommand(`${constants.EXT_NAME}.editNote`, (comment: NoteComment) => {
            if (!comment.parent) {
                return;
            }

            comment.parent.comments = comment.parent.comments.map(cmt => {
                if ((cmt as NoteComment).id === comment.id) {
                    cmt.mode = vscode.CommentMode.Editing;
                }

                return cmt;
            });
        });
        context.subscriptions.push(disposableCommand7);
        this.disposables.push(disposableCommand7);
            
        // Delete all comments
        // TODO: add confirmation dialog
        let disposableCommand8 = vscode.commands.registerCommand(`${constants.EXT_NAME}.deleteAllNotes`, async () => {
            this.threads.forEach(async (thread) => await this.deleteThread(thread));
            // Never dispose of the comment controller
            // commentController.dispose();
        });
        context.subscriptions.push(disposableCommand8);
        this.disposables.push(disposableCommand8);

        // Load threads from local database
        this.initComments().then(() => {
            // Sync with remote, now or when db is ready
            this.rdb.onDbReady(async () => {
                if (this.disposed) { return; }
                this.safeSyncComments();
            });

            this.rdb.onCommentsUpdated(async () => {
                if (this.disposed) { return; }
                console.log("[IaC Comments] Comments updated");
                this.safeSyncComments();
            });
        });
    }

    // Will check if a sync is currently in progress, and if not, will start one
    private safeSyncComments() {
        if (this.disposed) { return; }
        if (this.currentSync !== undefined) {
            this.nextSync = true;
            console.log("[IaC Comments] Sync already in progress, syncing later");
            return;
        }
        this.currentSync = this.syncComments().finally(() => {
            this.currentSync = undefined;
            if (this.nextSync) {
                console.log("[IaC Comments] Sync done, doing next sync");
                this.nextSync = false;
                this.safeSyncComments();
            }
            else {
                console.log("[IaC Comments] Sync done");
            }
        });
    }

    private async createComment(text: string, thread: vscode.CommentThread, author?: string | undefined, id?: string | undefined, lastModified?: number | undefined) {
        let commentAuthor = author ? { name: author } : { name: vscode.workspace.getConfiguration(`${constants.EXT_NAME}`).get("authorName", "") };
        
        const newComment = new NoteComment(
            text,
            vscode.CommentMode.Preview,
            commentAuthor,
            thread,
            true ? 'canDelete' : undefined,
        );
        if (id) {
            newComment.id = id;
        }
        if (lastModified) {
            newComment.lastModified = lastModified;
        }
        else {
            lastModified = await this.rdb.getRemoteTimestamp();
        }
        thread.comments = [...thread.comments, newComment];

        // Update global thread list
        await this.updateThreadInLocalDb(thread);
    }

    private async updateComment(thread: OurThread, comment: NoteComment, text: string, lastModified?: number | undefined) {
        comment.body = text;
        comment.savedBody = text;
        if (lastModified === undefined) {
            lastModified = await this.rdb.getRemoteTimestamp();
        }

        // Update comment in the parent thread, not local object copy
        thread.comments = thread.comments.map(cmt => {
            if ((cmt as NoteComment).id !== comment.id) { return cmt; };
            (cmt as NoteComment).savedBody = cmt.body;
            cmt.body = text;
            (cmt as NoteComment).lastModified = (lastModified as number);
            return cmt;
        });

        // Update global thread list
        await this.updateThreadInLocalDb(thread);
    }

    async deleteComment(thread: vscode.CommentThread, commentId: string) {
        thread.comments = thread.comments.filter(cmt => (cmt as NoteComment).id !== commentId);

        // Update global thread list
        await this.updateThreadInLocalDb(thread);

        if (thread.comments.length === 0) {
            // Delete from global thread list
            this.deleteThread(thread);

            thread.dispose();
        }
    }

    private async createThread(id: string, anchorLine: number, filePath: string) {
        let commentThread = this.commentController.createCommentThread(
            vscode.Uri.file(filePath),
            new vscode.Range(anchorLine, 0, anchorLine, 0),
            []
        ) as OurThread;
        commentThread.id = id;
        console.log("[IaC Comments] Created thread with id " + id);
        await this.updateThreadInLocalDb(commentThread, false);
        return commentThread;
    }

    private anchor2anchorLine(rawAnchor: string, docdata: string) {
        let parsedAnchor = JSON.parse(rawAnchor);
        let anchorLineOrig = parsedAnchor["line"];
        let anchorText = parsedAnchor["text"];
        let numLinesInAnchor = parsedAnchor["num"];

        let anchorLine = findClosestAnchor(anchorText, docdata);
        if (anchorLine === -1) {
            anchorLine = anchorLineOrig;
        }
        else {
            anchorLine = anchorLine + numLinesInAnchor;
        }
        console.log("[IaC Comments] Closest anchor: " + anchorLine);
        return anchorLine;
    };

    private async initComments() {
        // Load database content into global thread list
        let [dbThreads, dbComments] = await this.db.dbGetThreads();
        dbThreads.forEach((row: any) => {
            console.log("[IaC Comments] Creating thread at line " + row.anchor + " in file " + row.file_path);
            // Create comment thread
            //console.log("Anchor has lines: " + anchorText.split(/\r\n|\r|\n/).length);
            //console.log("Anchor numLinesInAnchor: " + numLinesInAnchor);
            vscode.workspace.fs.readFile(vscode.Uri.file(row.file_path)).then(async (data) => {
                let anchorLine = this.anchor2anchorLine(row.anchor, data.toString());

                let commentThread = await this.createThread(row.id, anchorLine, row.file_path);

                // Load database content into comment thread
                let commentArr = dbComments.get(row.id);
                for (const comment of commentArr) {
                    console.log("[IaC Comments] Creating comment " + comment.comment + " by " + comment.user_created);
                    this.createComment(comment.comment, commentThread, comment.user_created, comment.id, comment.timestamp_updated);
                }
            });
        });
    }

    async updateThreadInLocalDb(thread: vscode.CommentThread, deleteEmptyThreads: boolean = true) {
        // Add thread to global list
        console.log("[IaC Comments] Updating thread in local db");
        if (!this.threadIdMap.has(thread)) {
            let tid = util.genUUID();
            let oThread = thread as OurThread;
            if (oThread.id) {
                tid = oThread.id;
            }
            console.log("[IaC Comments] Adding thread with id " + tid + " to global list");
            oThread.id = tid;
            this.threads.push(oThread);
            this.threadIdMap.set(thread, tid);
        }

        // Update thread in the database
        let tid = this.threadIdMap.get(thread);
        if (tid === undefined) {
            // This should never happen
            return;
        }

        let oThread = thread as OurThread;
        oThread.id = tid;

        let anchor = this.thread2anchor(thread);

        let filePath = oThread.uri.path;
        await this.db.createOrReplaceThread(tid, anchor, filePath);

        if (deleteEmptyThreads && thread.comments.length === 0) {
            await this.deleteThread(thread);
            return;
        }

        // Update comments in the database
        for (let comment of thread.comments) {
            let oComment = comment as NoteComment;
            await this.db.dbCreateOrReplaceComment(oComment.id, tid, oComment.body.toString(), oComment.author.name, oComment.lastModified);
            console.log("[IaC Comments] Inserting comment " + oComment.body + " by " + oComment.author.name + " into thread " + tid);
        }

        // Get a list of all comment ids in the thread from the database
        let commentIds: string[] = await this.db.getCommentsForThread(tid);
        // Filter only comment ids that are not in the thread.
        let newCommentIds = thread.comments.filter(comment => !commentIds.includes((comment as NoteComment).id)).map(comment => (comment as NoteComment).id);
        
        // Delete comments that are not in the thread
        if (newCommentIds.length > 0) {
            console.log("[IaC Comments] Deleting comments " + newCommentIds + " from thread " + tid + " because they are not in the thread");
            await this.db.dbDeleteComments(newCommentIds);
        }
    }

    private thread2anchor(oThread: vscode.CommentThread) {
        // Compute anchor
        let curDocument = vscode.workspace.textDocuments.find((doc) => doc.uri.path === oThread.uri.path);
        let anchorLine = oThread.range.start.line;
        let anchorText = "";
        let numLinesFromAnchor = 0;
        if (curDocument !== undefined) {
            let anchorTextLineBegin = Math.max(anchorLine - ANCHOR_LINES, 0);
            let anchorTextLineEnd = Math.min(anchorLine + ANCHOR_LINES, curDocument.lineCount);
            let anchorText1 = curDocument.getText(new vscode.Range(anchorTextLineBegin, 0, anchorLine, 0));
            let anchorText2 = curDocument.getText(new vscode.Range(anchorLine, 0, anchorTextLineEnd, 0));

            // Limit size of anchor text to 1000 characters
            anchorText1 = anchorText1.substring(Math.max(anchorText1.length - 500, 0));
            anchorText2 = anchorText2.substring(0, 500);
            numLinesFromAnchor = anchorText1.split(/\r\n|\r|\n/).length - 1;
            anchorText = anchorText1 + anchorText2;
        }
        let anchor = JSON.stringify({ "line": anchorLine, "text": anchorText, "num": numLinesFromAnchor });
        return anchor;
    }

    async deleteThread(thread: vscode.CommentThread) {
        // Remove thread from global list
        if (!this.threadIdMap.has(thread)) {
            return;
        }
        let tid = this.threadIdMap.get(thread);
        if (tid === undefined) {
            // This should never happen
            assert(false, "[IaC Comments] tid is undefined");
            return;
        }
        this.threads = this.threads.filter(t => t.id !== tid);

        await this.db.dbDeleteTid(tid);
    }

    async syncComments() {
        let deletedComments = await this.db.dbGetDeletedComments();
        let deletedThreads = await this.db.dbGetDeletedThreads();

        console.log("[IaC comments] syncComments();");
        if (!this.rdb.isRemoteReady()) {
            console.log("[IaC comments] Remote database not ready");
            return;
        }

        // Fetch comments from remote database
        let [remoteObjects, remoteDeletions] = await this.rdb.getComments(this.lastRemoteSync);

        // Push local deletions to remote database
        let remoteDeletedComments = remoteDeletions.filter((deletion: any) => deletion.type === "comment").map((deletion: any) => deletion.cid);
        let remoteDeletedThreads = remoteDeletions.filter((deletion: any) => deletion.type === "thread").map((deletion: any) => deletion.tid);
        let reloadRemote = false;
        for (const [cid, tid] of deletedComments) {
            if (remoteDeletedComments.includes(cid)) { continue; };
            await this.rdb.pushComment(cid, tid, null, null, null, true);
            reloadRemote = true;
        }
        for (const tid of deletedThreads) {
            if (remoteDeletedThreads.includes(tid)) { continue; };
            await this.rdb.pushThread(tid, null, true, null, null);
            reloadRemote = true;
        }
        if (reloadRemote) {
            [remoteObjects, remoteDeletions] = await this.rdb.getComments(this.lastRemoteSync);
        }

        // TODO: fix issues in case local clock is not in sync with remote clock
        this.lastRemoteSync = await this.rdb.getRemoteTimestamp();
        // Temporary fix: sync all comments all the time
        this.lastRemoteSync = 0;

        // If there are any deletions, delete them from the local database
        for (let deletion of remoteDeletions) {
            if (deletion.type === "thread") {
                // Get thread
                let thread = this.threads.find(t => t.id === deletion.tid);
                if (thread !== undefined) {
                    console.log("[IaC Comments] Remote deletion, deleting thread " + thread.id);
                    if (this.disposed) { return; }
                    await this.deleteThread(thread);
                }
            }
            else if (deletion.type === "comment") {
                // Get comment
                let thread = this.threads.find(t => t.id === deletion.tid);
                if (thread !== undefined) {
                    console.log("[IaC Comments] Remote deletion, deleting comment " + deletion.cid + " from thread " + thread.id);
                    if (this.disposed) { return; }
                    await this.deleteComment(thread, deletion.cid);
                }
            }
        }

        // If there is any new or edited comment or new thread, update the local database and the UI
        let remoteThreads = remoteObjects.filter((object: any) => object.type === "thread");
        let remoteComments = remoteObjects.filter((object: any) => object.type === "comment");

        for (const object of remoteThreads) {
            // Get thread
            let thread = this.threads.find(t => t.id === object.tid);
            if (thread === undefined) {
                // Create new thread
                const absPath = util.relPathToAbs(object.filePath);
                let data = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
                let anchorLine = this.anchor2anchorLine(object.anchor, data.toString());
                if (this.disposed) { return; }
                await this.createThread(object.tid, anchorLine, absPath);
                console.log("[IaC Comments] List of thread ids after createThread:" + this.threads.map(t => t.id));
            }
            else {
                // Update existing thread
                // TODO: update anchor
                // Thread id and file path are immutable and cannot be changed
            }
        }

        for (const object of remoteComments) {
            // Get thread
            let thread = this.threads.find(t => t.id === object.tid);
            if (thread === undefined) {
                console.error("[IaC Comments] This should never happen. Comment without thread. Remote database is corrupted.");
                console.log("[IaC Comments] List of thread ids:" + this.threads.map(t => t.id));
                console.log("[IaC Comments] Comment: " + object.tid);
                return;
            }

            // Get comment
            let comment = thread.comments.find(c => (c as NoteComment).id === object.cid);
            if (comment === undefined) {
                // Create new comment
                if (this.disposed) { return; }
                await this.createComment(object.comment, thread, object.userCreated, object.cid, object.timestampModified);

                // Notify user
                let relPath = util.absPathToRel(thread.uri.fsPath);

                // Show a notification with a "Jump to comment" button
                const showCommentAction = 'Show comment';
                vscode.window.showInformationMessage(`[${object.userCreated}] 📥 Added a comment on ${relPath}`, showCommentAction).then(
                    (selection) => {
                        if ((selection === showCommentAction) && (thread !== undefined)) {
                            // Jump to comment
                            vscode.window.showTextDocument(thread.uri).then((editor) => {
                                editor.revealRange((thread as OurThread).range, vscode.TextEditorRevealType.InCenter);
                            });
                        }
                    }
                );
            }
            else {
                // Update existing comment
                console.log("[IaC Comments] Remote comment updated an existing comment");
                console.log("[IaC Comments] Comment last modified: " + (comment as NoteComment).lastModified);
                console.log("[IaC Comments] Remote last modified: " + object.timestampModified);
                if ((comment as NoteComment).lastModified + 1 < object.timestampModified) {
                    console.log(`[IaC Comments] Updating comment ${object.cid} as it is newer than the local version`);
                    if (this.disposed) { return; }
                    await this.updateComment(thread, (comment as NoteComment), object.comment, object.timestampModified);

                    // Notify user
                    let relPath = util.absPathToRel(thread.uri.fsPath);

                    // Show a notification with a "Jump to comment" button
                    const showCommentAction = 'Show comment';
                    vscode.window.showInformationMessage(`[${object.userCreated}] ✍️ Updated a comment on ${relPath}`, showCommentAction).then(
                        (selection) => {
                            if ((selection === showCommentAction) && (thread !== undefined)) {
                                // Jump to comment
                                vscode.window.showTextDocument(thread.uri).then((editor) => {
                                    editor.revealRange((thread as OurThread).range, vscode.TextEditorRevealType.InCenter);
                                });
                            }
                        }
                    );
                }
            }
        }

        // Determine which comments and threads are not in the remote database or have been deleted or edited more recently than the remote database
        let localThreads = this.threads.filter((thread: vscode.CommentThread) => {
            let oThread = thread as OurThread;
            let remoteThread = remoteThreads.find((object: any) => object.tid === oThread.id);
            if (remoteThread === undefined) {
                return true;
            }
            // return remoteThread.last_modified < oThread.lastModified;
            // TODO: check if anchor has changed and update it
            return false;
        });

        let localComments = this.threads.map((thread: vscode.CommentThread) => {
            return thread.comments.filter((comment: vscode.Comment) => {
                let oComment = comment as NoteComment;
                let remoteComment = remoteComments.find((object: any) => object.cid === oComment.id);
                if (remoteComment === undefined) {
                    console.log(`[IaC Comments] Local comment ${oComment.id} not found in remote database, will push it`);
                    return true;
                }
                console.log(`[IaC Comments] ${remoteComment.timestampModified} < ${oComment.lastModified}`);
                if (remoteComment.timestampModified < oComment.lastModified) {
                    console.log(`[IaC Comments] Local comment ${oComment.id} is newer than remote version, will push it`);
                } else {
                    console.log(`[IaC Comments] Remote comment ${oComment.id} is newer than local version, will not push it`);
                }
                return remoteComment.timestampModified < oComment.lastModified;
            });
        }).reduce((a, b) => a.concat(b), []);

        // Push local changes to remote database
        for (const thread of localThreads) {
            let tid = this.threadIdMap.get(thread);
            if (tid === undefined) {
                // This should never happen
                assert(false, "[IaC Comments] tid is undefined");
                return;
            }
            console.log("[IaC Comments] Pushing thread " + tid + " to remote database");
            let anchor = this.thread2anchor(thread);
            let timestamp = await this.rdb.getRemoteTimestamp();
            this.rdb.pushThread(tid, timestamp, false, util.absPathToRel(thread.uri.fsPath), anchor);
        }

        for (const comment of localComments) {
            let oComment = comment as NoteComment;
            if (oComment.parent === undefined) {
                // This should never happen
                assert(false, "[IaC Comments] oComment.parent is undefined");
                return;
            }
            let tid = this.threadIdMap.get(oComment.parent);
            if (tid === undefined) {
                // This should never happen
                assert(false, "[IaC Comments] tid is undefined");
                return;
            }
            console.log("[IaC Comments] Pushing comment " + oComment.id + " to remote database");
            let timestamp = await this.rdb.getRemoteTimestamp();
            this.rdb.pushComment(oComment.id, tid, oComment.body.toString(), oComment.author.name, timestamp, false);
        }
    }

    async dispose() {
        for (const disposable of this.disposables) {
            this.context.subscriptions.splice(this.context.subscriptions.indexOf(disposable), 1);
            await disposable.dispose();
        }
        this.disposed = true;
    }
}
