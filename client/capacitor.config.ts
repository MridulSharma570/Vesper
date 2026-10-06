import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Vesper's native shell configuration.
 *
 * The web client is wrapped as-is: `npm run build` produces client/dist and
 * `npx cap sync` copies it into the native asset bundles. Because a packaged
 * WebView has no server of its own, native builds MUST be compiled with
 * VITE_VESPER_API pointing at the deployed API origin (see docs/PLATFORMS.md);
 * the web build leaves it empty and stays same-origin.
 */
const config: CapacitorConfig = {
  appId: 'app.vesper.anonymous',
  appName: 'Vesper',
  webDir: 'dist',
  android: {
    // https scheme keeps cookies, storage and CSP behaviour closest to web.
    androidScheme: 'https',
  },
  server: {
    // The API lives on the deployment origin, not inside the WebView.
    // allowNavigation stays empty on purpose: no in-app browsing of third
    // parties, ever.
    allowNavigation: [],
  },
  plugins: {
    SplashScreen: { launchShowDuration: 400, backgroundColor: '#0f1115' },
  },
};

export default config;
