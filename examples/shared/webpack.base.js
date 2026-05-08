const { ModuleFederationPlugin } = require('webpack').container;
const path = require('path');

/**
 * Genera una config webpack completa para un bloque MF.
 *
 * Los bloques solo dependen de React (compartido via MF).
 * NO importan componentes de Volto — el host maneja el sidebar.
 *
 * Uso en cada bloque:
 *   const { createBlockConfig } = require('../../shared/webpack.base');
 *   module.exports = createBlockConfig({
 *     name: 'voltoSpacerBlock',
 *     exposes: { './SpacerBlock': './src/index.js' },
 *   });
 */
function createBlockConfig({ name, exposes, blockDir }) {
  return {
    mode: 'production',
    entry: './src/index.js',

    output: {
      path: path.resolve(blockDir, 'dist'),
      uniqueName: name,
      publicPath: 'auto',
      clean: true,
    },

    module: {
      rules: [
        {
          test: /\.(js|jsx)$/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['@babel/preset-env', '@babel/preset-react'],
            },
          },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },

    resolve: {
      extensions: ['.js', '.jsx'],
    },

    plugins: [
      new ModuleFederationPlugin({
        name,
        filename: 'remoteEntry.js',
        exposes,
        shared: {
          react: { singleton: true, requiredVersion: '^18.0.0', eager: false },
          'react-dom': {
            singleton: true,
            requiredVersion: '^18.0.0',
            eager: false,
          },
        },
      }),
    ],
  };
}

module.exports = { createBlockConfig };
