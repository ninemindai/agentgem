// Test fixture for build-client's extension seam (build.test.ts). Stands in for a
// downstream `extraPages` module: build-client's onResolve plugin redirects the
// `./extraPages.js` import to this file when AGENTGEM_CONSOLE_EXTRA points at it.
// The marker string must survive esbuild minification into the bundled output so
// the test can assert the override actually injected (vs. the empty stub).
export const extraPages = [{ route: "#/AGENTGEM_EXTRA_SEAM_SMOKE" }];
