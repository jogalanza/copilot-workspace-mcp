// The built web UI (web/) as one HTML string; supplied by the esbuild plugin in scripts/build-standalone.mjs.
declare module 'virtual:ui-html' {
  const content: string;
  export default content;
}
