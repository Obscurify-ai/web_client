// The + button in each message box: one menu for attaching files, the tools switch and
// chat settings. The menu opens upward, closes on a tap outside or Escape, and stays open
// while the tools switch is flipped so the new state shows.

function composerMenus() {
    return [...document.querySelectorAll('[data-composer-menu]')];
}

function closeComposerMenus(except) {
    composerMenus().forEach((menu) => {
        if (menu === except) return;
        menu.querySelector('.composer-menu-panel').hidden = true;
        menu.querySelector('.composer-plus').setAttribute('aria-expanded', 'false');
    });
}

function toggleComposerMenu(menu) {
    const panel = menu.querySelector('.composer-menu-panel');
    const opening = panel.hidden;
    closeComposerMenus(menu);
    panel.hidden = !opening;
    menu.querySelector('.composer-plus').setAttribute('aria-expanded', String(opening));
}

document.addEventListener('DOMContentLoaded', () => {
    composerMenus().forEach((menu) => {
        menu.querySelector('.composer-plus').addEventListener('click', (e) => {
            e.preventDefault();
            toggleComposerMenu(menu);
        });
        // Attach: the label opens the file picker by itself; the menu gets out of the way.
        menu.querySelector('[data-composer-attach] input').addEventListener('click', () => closeComposerMenus());
        menu.querySelector('[data-composer-settings]').addEventListener('click', () => {
            closeComposerMenus();
            if (typeof openChatSettings === 'function') openChatSettings();
        });
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest || !e.target.closest('[data-composer-menu]')) closeComposerMenus();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeComposerMenus();
    });
});
