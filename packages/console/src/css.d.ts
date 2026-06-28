// esbuild bundles `.css` imports as a side effect; declare them so tsc is happy.
declare module "*.css";
