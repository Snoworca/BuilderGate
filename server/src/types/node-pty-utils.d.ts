// node-pty publishes no typings for its internal native loader.
declare module 'node-pty/lib/utils.js' {
  const utils: {
    loadNativeModule(name: string): { dir: string; module: unknown };
  };
  export default utils;
}
