const webpack = require('webpack');
const { ModuleFederationPlugin } = webpack.container;
const path = require('path');

/**
 * Emite mf-manifest.json en el dist: el contrato explicito del bundle
 * que el backend lee al instalar (en vez de parsear el remoteEntry.js
 * minificado con regex). Contiene {name, module, version}.
 */
class MFManifestPlugin {
  constructor(manifest) {
    this.manifest = manifest;
  }
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('MFManifestPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'MFManifestPlugin',
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          compilation.emitAsset(
            'mf-manifest.json',
            new webpack.sources.RawSource(
              JSON.stringify(this.manifest, null, 2),
            ),
          );
        },
      );
    });
  }
}

function readBlockVersion(blockDir) {
  try {
    return require(path.resolve(blockDir, 'package.json')).version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

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
      new MFManifestPlugin({
        name,
        module: Object.keys(exposes)[0],
        version: readBlockVersion(blockDir),
      }),
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
