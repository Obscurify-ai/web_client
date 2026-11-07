//! The Android app's document reader (`files.rs`, copied from obscurify-android by
//! scripts/vendor-docread.sh) for the browser. Used by static/js/chat/docread-worker.js.

// for_model and size are the app's; the page has its own in chat-files.js.
#[allow(dead_code)]
mod files;

use wasm_bindgen::prelude::*;

/// `{"ok": Doc}` or `{"err": "a sentence for the person who picked the file"}`.
#[wasm_bindgen]
pub fn read(name: &str, bytes: &[u8]) -> String {
    match files::read(name, bytes) {
        Ok(doc) => serde_json::json!({ "ok": doc }),
        Err(e) => serde_json::json!({ "err": e }),
    }
    .to_string()
}
