// The page is the Vite app in web/. scripts/build-standalone.mjs builds it to one self-contained HTML file and
// resolves this virtual module to that file while bundling (scripts/dev-ui.mjs stubs it: Vite serves the page in dev).
import html from 'virtual:ui-html';

export const UI_HTML: string = html;
