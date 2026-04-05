import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mooja.autopost',
  appName: 'Mooja AutoPost',
  webDir: 'dist',
  server: {
    hostname: 'localhost',
    androidScheme: 'http',
    cleartext: true,
  },
};

export default config;
