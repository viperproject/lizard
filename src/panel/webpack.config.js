const path = require('path');
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = function(env, argv) {
    if (env === undefined) {
        env = {};
    }

    const production = !!env.production;
    const sourceMaps = !production;

    const plugins = [
        new HtmlWebpackPlugin({
            template: './resources/html/debugger.html',
            filename: './debugger.html'
        }),
        new MiniCssExtractPlugin({
            filename: '[name].css'
        }),
    ];

    return {
        // This is ugly having main.scss on both bundles, but if it is added separately it will generate a js bundle :(
        entry: {
            panel: [ './panel.ts', './resources/css/style.scss' ]
        },
        mode: production ? 'production' : 'development',
        output: {
            filename: '[name].js',
            path: path.resolve(__dirname, '../../', 'out/panel'),
            publicPath: '{{root}}/out/panel/'
        },
        resolve: {
            extensions: ['.ts', '.js'],
            modules: [path.resolve(__dirname), 'node_modules']
        },
        devtool: sourceMaps ? 'inline-source-map' : false,
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    use: [{ loader: 'ts-loader' }],
                    exclude: /node_modules/
                },
                {
                    test: /\.html$/,
                    use: [
                        {
                            loader: 'html-loader',
                            options: { minimize: false }
                        }
                    ]
                },
                {
                    test: /\.scss$/,
                    use: [
                        {
                            loader: MiniCssExtractPlugin.loader
                        },
                        {
                            loader: 'css-loader'
                        },
                        {
                            loader: 'sass-loader',
                            options: {
                                sourceMap: sourceMaps
                            }
                        }
                    ],
                    exclude: /node_modules/
                }
            ]
        },
        plugins: plugins,
        watchOptions: {
            aggregateTimeout: 300,
            poll: 1000,
            ignored: /node_modules/
        }
    };
};
