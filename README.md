# Obscurify web client

The browser client of [obscurify.ai](https://obscurify.ai): private AI chat with no email, username or
password, only a random account number. You pay with vouchers the server signs without seeing them,
so a payment can't be linked to the account it funds.

This repository is the code your browser runs: the page templates, the JavaScript and the styles.

## What's here

| Path | What |
|---|---|
| `static/js/chat/` | The chat: streaming, web search, image attachments, conversations kept in your browser, model picker |
| `static/js/chat/chat-local.js` | Local mode: models that run entirely in your browser (WebAssembly), with nothing sent to the server |
| `static/js/blind-voucher.js` | Blind-signed vouchers (RFC 9474, RSABSSA-SHA384-PSS-Deterministic), written with WebCrypto and BigInt |
| `static/js/account-vouchers.js` | Buying vouchers anonymously and adding them to your balance at random times |
| `static/vendor/BrowserAgentKit/` | The in-browser inference engine behind local mode (Apache-2.0) |
| `templates/` | Page templates, rendered by the server ([Askama](https://github.com/askama-rs/askama) syntax) |
| `static/styles/` | Styles and fonts |
| `static/js/test/`, `static/js/chat.test.js` | Tests |

The Android app is a separate repo: [Obscurify-ai/obscurify-android](https://github.com/Obscurify-ai/obscurify-android).

## Tests

```sh
node static/js/chat.test.js   # runs the suites in static/js/test/
node --test static/js/test/chat-local.test.js static/js/test/guest-model.test.js static/js/test/chat-stream.test.js
```

## License

GPL-3.0 for Obscurify's code; see [LICENSE](LICENSE). Bundled third-party code keeps its own license;
see [THIRD_PARTY.md](THIRD_PARTY.md).

Updates are synced from the code that runs obscurify.ai.
