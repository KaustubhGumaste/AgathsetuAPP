const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const networkSecurityConfig = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`;

function withLoopbackCleartext(config) {
  config = withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android manifest is missing its application element.');
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    application.$['android:usesCleartextTraffic'] = 'false';
    return modConfig;
  });

  return withDangerousMod(config, ['android', async (modConfig) => {
    const xmlDirectory = path.join(
      modConfig.modRequest.platformProjectRoot,
      'app',
      'src',
      'main',
      'res',
      'xml',
    );
    fs.mkdirSync(xmlDirectory, { recursive: true });
    fs.writeFileSync(path.join(xmlDirectory, 'network_security_config.xml'), networkSecurityConfig);
    return modConfig;
  }]);
}

module.exports = withLoopbackCleartext;
