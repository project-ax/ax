// Type declarations for optional dependencies that may not be installed.
// These modules are dynamically imported with try/catch fallbacks.

declare module 'playwright' {
  const playwright: any;
  export default playwright;
  export const chromium: any;
}
