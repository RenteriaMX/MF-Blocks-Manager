const { createBlockConfig } = require('../../shared/webpack.base');

module.exports = createBlockConfig({
  name: 'voltoSpacerBlock',
  exposes: { './SpacerBlock': './src/index.js' },
  blockDir: __dirname,
});
