// chat-files.js — Documents attached to the next message: PDFs, spreadsheets (CSV, TSV, Excel,
// OpenDocument), Word, PowerPoint and OpenDocument text, and anything that is plain text. They are
// read in the browser by the Android app's parser (docread-worker.js) and sent as text, so the
// file itself never leaves the device and every model can use it. Owns attachedDocs; its chips
// share imagePreviewContainer with the image thumbnails.

const MAX_DOC_BYTES = 25 * 1024 * 1024; // files.rs MAX_BYTES
const MAX_DOC_CHARS = 120000;           // files.rs MAX_CHARS
const MAX_DOCS = 4;

let attachedDocs = [];
// Files still being read: {name}, shown as chips; sending waits for them.
const docsReading = [];
let docsReadingDone = Promise.resolve();

function readDocument(file) {
    return new Promise((resolve) => {
        if (file.size > MAX_DOC_BYTES) {
            resolve({ err: `${file.name} is over ${MAX_DOC_BYTES >> 20} MB.` });
            return;
        }
        const worker = new Worker('/static/js/chat/docread-worker.js?v=1');
        const finish = (result) => { worker.terminate(); resolve(result); };
        worker.onmessage = (e) => finish(e.data);
        worker.onerror = () => finish({ err: `Couldn't read ${file.name}.` });
        file.arrayBuffer().then(
            (buf) => worker.postMessage({ name: file.name, bytes: buf }, [buf]),
            () => finish({ err: `Couldn't read ${file.name}.` })
        );
    });
}

// Reads the files and adds them to the next message, at most MAX_DOCS.
function attachDocuments(files) {
    const errors = [];
    const reads = [];
    for (const file of files) {
        if (attachedDocs.length + docsReading.length >= MAX_DOCS) {
            errors.push(`At most ${MAX_DOCS} files per message.`);
            break;
        }
        const pending = { name: file.name };
        docsReading.push(pending);
        reads.push(readDocument(file).then((r) => {
            docsReading.splice(docsReading.indexOf(pending), 1);
            if (r.ok) attachedDocs.push(r.ok);
            else alert(r.err);
            updateImagePreviews();
        }));
    }
    if (errors.length) alert(errors.join('\n'));
    docsReadingDone = Promise.all([docsReadingDone].concat(reads));
    updateImagePreviews();
}

// "12k characters", as the app shows it.
function docSize(d) {
    const n = [...d.text].length;
    return n < 1000 ? `${n} characters` : `${Math.floor(n / 1000)}k characters`;
}

function docLabel(d) {
    return `📄 ${d.name}`;
}

function docDetail(d) {
    return ` · ${d.kind}, ${docSize(d)}${d.truncated ? ' (cut)' : ''}`;
}

// Chips for the composer, after the image thumbnails.
function renderDocChips(container) {
    attachedDocs.forEach((d, index) => {
        const chip = document.createElement('div');
        chip.className = 'doc-chip';
        chip.append(docLabel(d));
        const detail = document.createElement('span');
        detail.className = 'doc-chip-detail';
        detail.textContent = docDetail(d);
        chip.appendChild(detail);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'doc-chip-remove';
        remove.title = 'Remove';
        remove.innerHTML = '&times;';
        remove.onclick = () => { attachedDocs.splice(index, 1); updateImagePreviews(); };
        chip.appendChild(remove);
        container.appendChild(chip);
    });
    docsReading.forEach((p) => {
        const chip = document.createElement('div');
        chip.className = 'doc-chip doc-chip-reading';
        chip.append(`📄 ${p.name}`);
        const detail = document.createElement('span');
        detail.className = 'doc-chip-detail';
        detail.textContent = ' · reading…';
        chip.appendChild(detail);
        container.appendChild(chip);
    });
    return attachedDocs.length + docsReading.length;
}

// The files under a sent message.
function renderMessageDocs(messageEl, docs) {
    if (!Array.isArray(docs) || docs.length === 0) return;
    const list = document.createElement('div');
    list.className = 'message-docs';
    docs.forEach((d) => {
        const chip = document.createElement('div');
        chip.className = 'doc-chip';
        chip.append(docLabel(d));
        const detail = document.createElement('span');
        detail.className = 'doc-chip-detail';
        detail.textContent = docDetail(d);
        chip.appendChild(detail);
        list.appendChild(chip);
    });
    messageEl.appendChild(list);
}

// The message text as the model sees it, with the files after it (files.rs for_model).
function textWithFiles(text, docs) {
    let out = text || '';
    for (const d of docs) {
        out += `\n\n<file name="${d.name.replace(/"/g, "'")}" type="${d.kind}">\n${d.text}\n</file>`;
        if (d.truncated) out += `\n(Only the first ${MAX_DOC_CHARS} of its ${d.chars} characters are attached.)`;
    }
    return out;
}

// A stored user message's content for the API, its files folded into the text.
function contentWithFiles(content, docs) {
    if (!Array.isArray(docs) || docs.length === 0) return content;
    if (typeof content === 'string') return textWithFiles(content, docs);
    if (!Array.isArray(content)) return content;
    let done = false;
    const parts = content.map((p) => {
        if (done || p.type !== 'text') return p;
        done = true;
        return Object.assign({}, p, { text: textWithFiles(p.text, docs) });
    });
    return done ? parts : [{ type: 'text', text: textWithFiles('', docs) }].concat(parts);
}

// Images, files and their chips, all gone once a message is sent.
function clearAttachments() {
    base64Images = null;
    imageByteSizes = null;
    attachedDocs = [];
    updateImagePreviews();
}
