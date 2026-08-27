const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

/** @type {import('webpack').Configuration} */
module.exports = {
  target: 'node',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: 'file:///[absolute-resource-path]',
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  optimization: {
    minimize: true,
    minimizer: [
      // Copied vendor assets (oxlint dist/*.js) are modern ESM and must not be
      // parsed/minified by Terser — only the extension bundle itself.
      new TerserPlugin({
        exclude: /vendor[\\/]/,
      }),
    ],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: [/node_modules/, /src[\\/]test[\\/]/],
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
  plugins: [
    // Bundle a complete, runnable oxlint into dist/vendor/oxlint so the
    // extension works with zero user-side installation. The oxlint package is
    // a Node ESM CLI (bin/oxlint + dist/*.js); its native binding lives in
    // scoped @oxlint/binding-* packages and is loaded via
    // require('@oxlint/binding-…'), so the binding packages must be placed at
    // dist/vendor/oxlint/node_modules/@oxlint/… for Node's resolution to find
    // them from dist/vendor/oxlint/dist/bindings.js.
    new CopyPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'node_modules/oxlint'),
          to: 'vendor/oxlint',
        },
        // Whichever platform bindings are installed (per-OS dev boxes/CI) get
        // shipped; missing ones are skipped silently.
        {
          from: path.resolve(__dirname, 'node_modules/@oxlint'),
          to: 'vendor/oxlint/node_modules/@oxlint',
          noErrorOnMissing: true,
        },
      ],
    }),
  ],
};
