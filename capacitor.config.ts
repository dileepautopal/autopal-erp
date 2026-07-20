import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.autopal.app',
  appName: 'AUTOPAL',
  server: {
    androidScheme: 'http',
    cleartext: true,
  },
  webDir: 'dist',
};

export default config;
