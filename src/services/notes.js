const sql = require('./sql');
const options = require('./options');
const utils = require('./utils');
const sync_table = require('./sync_table');
const labels = require('./labels');
const repository = require('./repository');
const Note = require('../entities/note');
const NoteImage = require('../entities/note_image');
const NoteRevision = require('../entities/note_revision');
const Branch = require('../entities/branch');

async function getNewNotePosition(parentNoteId, noteOpts) {
    let newNotePos = 0;

    if (noteOpts.target === 'into') {
        const maxNotePos = await sql.getValue('SELECT MAX(notePosition) FROM branches WHERE parentNoteId = ? AND isDeleted = 0', [parentNoteId]);

        newNotePos = maxNotePos === null ? 0 : maxNotePos + 1;
    }
    else if (noteOpts.target === 'after') {
        const afterNote = await sql.getRow('SELECT notePosition FROM branches WHERE branchId = ?', [noteOpts.target_branchId]);

        newNotePos = afterNote.notePosition + 1;

        // not updating dateModified to avoig having to sync whole rows
        await sql.execute('UPDATE branches SET notePosition = notePosition + 1 WHERE parentNoteId = ? AND notePosition > ? AND isDeleted = 0',
            [parentNoteId, afterNote.notePosition]);

        await sync_table.addNoteReorderingSync(parentNoteId);
    }
    else {
        throw new Error('Unknown target: ' + noteOpts.target);
    }
    return newNotePos;
}

async function createNewNote(parentNoteId, noteOpts) {
    const newNotePos = await getNewNotePosition(parentNoteId, noteOpts);

    if (parentNoteId !== 'root') {
        const parent = await repository.getNote(parentNoteId);

        if (!noteOpts.type) {
            noteOpts.type = parent.type;
        }

        if (!noteOpts.mime) {
            noteOpts.mime = parent.mime;
        }
    }

    const note = new Note({
        noteId: utils.newNoteId(),
        title: noteOpts.title,
        content: noteOpts.content ? noteOpts.content : '',
        isProtected: noteOpts.isProtected,
        type: noteOpts.type ? noteOpts.type : 'text',
        mime: noteOpts.mime ? noteOpts.mime : 'text/html'
    });

    await note.save();

    const branch = new Branch({
        branchId: utils.newBranchId(),
        noteId: note.noteId,
        parentNoteId: parentNoteId,
        notePosition: newNotePos,
        isExpanded: 0,
        isDeleted: 0
    });

    await branch.save();

    return {
        noteId: note.noteId,
        note,
        branchId: branch.branchId,
        branch
    };
}

async function createNote(parentNoteId, title, content = "", extraOptions = {}) {
    if (!parentNoteId) throw new Error("Empty parentNoteId");
    if (!title) throw new Error("Empty title");

    const note = {
        title: title,
        content: extraOptions.json ? JSON.stringify(content, null, '\t') : content,
        target: 'into',
        isProtected: extraOptions.isProtected !== undefined ? extraOptions.isProtected : false,
        type: extraOptions.type,
        mime: extraOptions.mime
    };

    if (extraOptions.json && !note.type) {
        note.type = "code";
        note.mime = "application/json";
    }

    if (!note.type) {
        note.type = "text";
        note.mime = "text/html";
    }

    const {noteId} = await createNewNote(parentNoteId, note);

    if (extraOptions.labels) {
        for (const labelName in extraOptions.labels) {
            await labels.createLabel(noteId, labelName, extraOptions.labels[labelName]);
        }
    }

    return noteId;
}

async function protectNoteRecursively(note, protect) {
    await protectNote(note, protect);

    for (const child of await note.getChildNotes()) {
        await protectNoteRecursively(child, protect);
    }
}

async function protectNote(note, protect) {
    if (protect !== note.isProtected) {
        note.isProtected = protect;

        await repository.updateEntity(note);
    }

    await protectNoteRevisions(note);
}

async function protectNoteRevisions(note) {
    for (const revision of await note.getRevisions()) {
        if (note.isProtected !== revision.isProtected) {
            revision.isProtected = note.isProtected;

            await repository.updateEntity(revision);
        }
    }
}

async function saveNoteImages(note) {
    if (note.type !== 'text') {
        return;
    }

    const existingNoteImages = await note.getNoteImages();
    const foundImageIds = [];
    const re = /src="\/api\/images\/([a-zA-Z0-9]+)\//g;
    let match;

    while (match = re.exec(note.content)) {
        const imageId = match[1];
        const existingNoteImage = existingNoteImages.find(ni => ni.imageId === imageId);

        if (!existingNoteImage) {
            await repository.updateEntity(new NoteImage({
                noteImageId: utils.newNoteImageId(),
                noteId: note.noteId,
                imageId: imageId,
                isDeleted: 0
            }));
        }
        // else we don't need to do anything

        foundImageIds.push(imageId);
    }

    // marking note images as deleted if they are not present on the page anymore
    const unusedNoteImages = existingNoteImages.filter(ni => !foundImageIds.includes(ni.imageId));

    for (const unusedNoteImage of unusedNoteImages) {
        unusedNoteImage.isDeleted = 1;

        await repository.updateEntity(unusedNoteImage);
    }
}

async function saveNoteRevision(note) {
    const labelsMap = await note.getLabelMap();

    const now = new Date();
    const noteRevisionSnapshotTimeInterval = parseInt(await options.getOption('note_revision_snapshot_time_interval'));

    const revisionCutoff = utils.dateStr(new Date(now.getTime() - noteRevisionSnapshotTimeInterval * 1000));

    const existingnoteRevisionId = await sql.getValue(
        "SELECT noteRevisionId FROM note_revisions WHERE noteId = ? AND dateModifiedTo >= ?", [note.noteId, revisionCutoff]);

    const msSinceDateCreated = now.getTime() - utils.parseDateTime(note.dateCreated).getTime();

    if (note.type !== 'file'
        && labelsMap.disable_versioning !== 'true'
        && !existingnoteRevisionId
        && msSinceDateCreated >= noteRevisionSnapshotTimeInterval * 1000) {

        await repository.updateEntity(new NoteRevision({
            noteRevisionId: utils.newNoteRevisionId(),
            noteId: note.noteId,
            // title and text should be decrypted now
            title: note.title,
            content: note.content,
            isProtected: 0, // will be fixed in the protectNoteRevisions() call
            dateModifiedFrom: note.dateModified,
            dateModifiedTo: utils.nowDate()
        }));
    }
}

async function updateNote(noteId, noteUpdates) {
    const note = await repository.getNote(noteId);

    if (note.type === 'file') {
        // for update file, newNote doesn't contain file payloads
        noteUpdates.content = note.content;
    }

    await saveNoteRevision(note);

    note.title = noteUpdates.title;
    note.content = noteUpdates.content;
    note.isProtected = noteUpdates.isProtected;

    await repository.updateEntity(note);

    await saveNoteImages(note);

    await protectNoteRevisions(note);
}

async function deleteNote(branch) {
    if (!branch || branch.isDeleted === 1) {
        return;
    }

    branch.isDeleted = true;
    await branch.save();

    const note = await branch.getNote();
    const notDeletedBranches = await note.getBranches();

    if (notDeletedBranches.length === 0) {
        note.isDeleted = true;
        await note.save();

        for (const childBranch of await note.getChildBranches()) {
            await deleteNote(childBranch);
        }
    }
}

module.exports = {
    createNewNote,
    createNote,
    updateNote,
    deleteNote,
    protectNoteRecursively
};